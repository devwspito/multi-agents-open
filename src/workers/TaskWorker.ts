/**
 * Task Worker
 *
 * BullMQ worker that processes tasks from the queue.
 * Handles task execution, progress tracking, and failure management.
 *
 * Worker Features:
 * - Concurrent task processing
 * - Progress reporting via Socket.IO
 * - Automatic retry on failure
 * - Graceful shutdown
 */

import { Worker, Job } from 'bullmq';
import { redisService } from '../services/queue/RedisService.js';
import { QUEUE_NAMES, TaskJobData, CommitJobData } from '../services/queue/TaskQueue.js';
import { orchestratorV2 } from '../orchestration/OrchestratorV2.js';
import { postgresService } from '../database/postgres/PostgresService.js';
import { socketService } from '../services/realtime/SocketService.js';

// Worker concurrency (tasks processed in parallel)
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3');

class TaskWorkerService {
  private taskWorker: Worker<TaskJobData> | null = null;
  private priorityWorker: Worker<TaskJobData> | null = null;
  private commitWorker: Worker<CommitJobData> | null = null;
  private isShuttingDown = false;

  /**
   * Initialize all workers
   */
  async initialize(): Promise<void> {
    const connection = redisService.getWorkerClient();

    // Main task worker
    this.taskWorker = new Worker<TaskJobData>(
      QUEUE_NAMES.TASKS,
      async (job) => this.processTask(job),
      {
        connection,
        concurrency: CONCURRENCY,
        limiter: {
          max: 10,
          duration: 1000, // Max 10 jobs per second
        },
      }
    );

    // Priority task worker (higher concurrency for Pro users)
    this.priorityWorker = new Worker<TaskJobData>(
      QUEUE_NAMES.PRIORITY,
      async (job) => this.processTask(job),
      {
        connection,
        concurrency: Math.ceil(CONCURRENCY * 1.5), // 50% more capacity for priority
      }
    );

    // Commit worker (sequential to avoid git conflicts)
    this.commitWorker = new Worker<CommitJobData>(
      QUEUE_NAMES.COMMITS,
      async (job) => this.processCommit(job),
      {
        connection,
        concurrency: 1, // Sequential commits
      }
    );

    // Setup event handlers
    this.setupEventHandlers(this.taskWorker, 'task');
    this.setupEventHandlers(this.priorityWorker, 'priority');
    this.setupEventHandlers(this.commitWorker, 'commit');

    console.log(`[TaskWorker] Workers initialized (concurrency: ${CONCURRENCY})`);
  }

  /**
   * Process a task job
   */
  private async processTask(job: Job<TaskJobData>): Promise<any> {
    const { taskId, userId, workspacePath, repositories, approvalMode } = job.data;

    console.log(`[TaskWorker] Processing task ${taskId} (job ${job.id})`);
    console.log(`[TaskWorker] Phase approval mode: ${approvalMode}`);

    // Update task status in database
    await this.updateTaskStatus(taskId, 'running');

    // Notify client via Socket.IO
    socketService.emitToUser(userId, 'task:started', {
      taskId,
      jobId: job.id,
      timestamp: new Date().toISOString(),
    });

    try {
      // Report initial progress
      await job.updateProgress(5);

      // V2 Orchestrator has fixed 4-phase architecture: Analysis → Developer → Merge → GlobalScan
      const totalPhases = 4;
      let currentPhaseIndex = 0;

      // Execute the V2 pipeline
      const result = await orchestratorV2.execute(taskId, {
        projectPath: workspacePath,
        repositories,
        // Phase approval mode: 'manual' pauses between phases, 'automatic' continues
        phaseApprovalMode: approvalMode as 'manual' | 'automatic',
        onAnalysisComplete: (analysisResult) => {
          currentPhaseIndex = 1;
          job.updateProgress(25);
          socketService.emitToUser(userId, 'task:progress', {
            taskId,
            phase: 'Analysis',
            progress: 25,
            message: `Analysis complete: ${analysisResult.stories.length} stories`,
            timestamp: new Date().toISOString(),
          });
        },
        onStoryComplete: (storyIndex, story, success) => {
          socketService.emitToUser(userId, 'task:progress', {
            taskId,
            phase: 'Developer',
            message: `Story ${storyIndex + 1}: ${story.title} - ${success ? 'approved' : 'needs work'}`,
            timestamp: new Date().toISOString(),
          });
        },
        onDeveloperComplete: (developerResult) => {
          currentPhaseIndex = 2;
          job.updateProgress(60);
          socketService.emitToUser(userId, 'task:progress', {
            taskId,
            phase: 'Developer',
            progress: 60,
            message: `Developer complete: ${developerResult.totalCommits} commits`,
            timestamp: new Date().toISOString(),
          });
        },
        onPullRequestCreated: (prNumber, prUrl) => {
          currentPhaseIndex = 3;
          job.updateProgress(80);
          socketService.emitToUser(userId, 'task:progress', {
            taskId,
            phase: 'Merge',
            progress: 80,
            message: `PR #${prNumber} created`,
            prUrl,
            timestamp: new Date().toISOString(),
          });
        },
      });

      // Update progress to 100%
      await job.updateProgress(100);

      // Get session ID from result (V2 returns it in analysis/developer results)
      const sessionId = result.developer?.sessionId || result.analysis?.sessionId;
      if (sessionId) {
        this.storeSessionMapping(taskId, sessionId, userId);
      }

      // Update task status based on result
      await this.updateTaskStatus(taskId, result.success ? 'completed' : 'failed', result);

      // Notify client
      socketService.emitToUser(userId, 'task:completed', {
        taskId,
        sessionId,
        result: {
          success: result.success,
          prUrl: result.merge?.pullRequest?.url,
          prNumber: result.merge?.pullRequest?.number,
          merged: result.merge?.merged,
          storiesCompleted: result.developer?.stories.filter(s => s.verdict === 'approved').length,
          totalStories: result.analysis?.stories.length,
          vulnerabilities: result.globalScan?.summary.totalVulnerabilities,
        },
        timestamp: new Date().toISOString(),
      });

      console.log(`[TaskWorker] Task ${taskId} completed: success=${result.success}`);

      return { success: result.success, taskId, sessionId, result };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error(`[TaskWorker] Task ${taskId} failed:`, errorMessage);

      // Update task status
      await this.updateTaskStatus(taskId, 'failed', null, errorMessage);

      // Notify client
      socketService.emitToUser(userId, 'task:failed', {
        taskId,
        error: errorMessage,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts || 3,
        timestamp: new Date().toISOString(),
      });

      throw error; // Re-throw for BullMQ retry logic
    }
  }

  /**
   * Process a commit job
   */
  private async processCommit(job: Job<CommitJobData>): Promise<any> {
    const { taskId, repoPath, message, githubToken } = job.data;

    console.log(`[TaskWorker] Processing commit for task ${taskId}`);

    try {
      // Import git utilities dynamically to avoid circular deps
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check for changes
      const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });

      if (!status.trim()) {
        console.log(`[TaskWorker] No changes to commit in ${repoPath}`);
        return { success: true, skipped: true };
      }

      // Stage all changes
      await execAsync('git add -A', { cwd: repoPath });

      // Commit
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoPath });

      // Push if token available
      if (githubToken) {
        await execAsync('git push', { cwd: repoPath });
      }

      console.log(`[TaskWorker] Committed changes in ${repoPath}`);

      return { success: true, committed: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[TaskWorker] Commit failed for ${repoPath}:`, errorMessage);
      throw error;
    }
  }

  /**
   * Update task status in PostgreSQL
   */
  private async updateTaskStatus(
    taskId: string,
    status: string,
    result?: any,
    errorMessage?: string
  ): Promise<void> {
    const updates: string[] = ['status = $1', 'updated_at = NOW()'];
    const values: any[] = [status];
    let paramIndex = 2;

    if (status === 'running') {
      updates.push(`started_at = NOW()`);
    }

    if (status === 'completed' || status === 'failed') {
      updates.push(`completed_at = NOW()`);
    }

    if (result !== undefined) {
      updates.push(`result = $${paramIndex}`);
      values.push(JSON.stringify(result));
      paramIndex++;
    }

    if (errorMessage) {
      updates.push(`error_message = $${paramIndex}`);
      values.push(errorMessage);
      paramIndex++;
    }

    values.push(taskId);

    await postgresService.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * Store session mapping in Redis for quick lookup
   */
  private async storeSessionMapping(taskId: string, sessionId: string, userId: string): Promise<void> {
    const client = redisService.getClient();

    // Store mappings with 24h TTL
    await Promise.all([
      client.setex(`session:${sessionId}:task`, 86400, taskId),
      client.setex(`session:${sessionId}:user`, 86400, userId),
      client.setex(`task:${taskId}:session`, 86400, sessionId),
    ]);
  }

  /**
   * Setup event handlers for a worker
   */
  private setupEventHandlers(worker: Worker<any>, name: string): void {
    worker.on('completed', (job) => {
      console.log(`[TaskWorker:${name}] Job ${job.id} completed`);
    });

    worker.on('failed', (job, error) => {
      console.error(`[TaskWorker:${name}] Job ${job?.id} failed:`, error.message);
    });

    worker.on('error', (error) => {
      console.error(`[TaskWorker:${name}] Worker error:`, error.message);
    });

    worker.on('stalled', (jobId) => {
      console.warn(`[TaskWorker:${name}] Job ${jobId} stalled`);
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('[TaskWorker] Initiating graceful shutdown...');

    // Close workers (waits for active jobs to complete)
    await Promise.all([
      this.taskWorker?.close(),
      this.priorityWorker?.close(),
      this.commitWorker?.close(),
    ]);

    console.log('[TaskWorker] All workers shut down');
  }

  /**
   * Get worker statistics
   */
  async getStats(): Promise<{
    taskWorker: { active: number; completed: number; failed: number } | null;
    priorityWorker: { active: number; completed: number; failed: number } | null;
  }> {
    const getWorkerStats = async (worker: Worker<any> | null) => {
      if (!worker) return null;

      // Workers don't have direct stats, but we can check if they're running
      return {
        active: 0, // Would need to track this manually
        completed: 0,
        failed: 0,
      };
    };

    return {
      taskWorker: await getWorkerStats(this.taskWorker),
      priorityWorker: await getWorkerStats(this.priorityWorker),
    };
  }

  /**
   * Pause all workers
   */
  async pauseAll(): Promise<void> {
    await Promise.all([
      this.taskWorker?.pause(),
      this.priorityWorker?.pause(),
      this.commitWorker?.pause(),
    ]);
    console.log('[TaskWorker] All workers paused');
  }

  /**
   * Resume all workers
   */
  async resumeAll(): Promise<void> {
    this.taskWorker?.resume();
    this.priorityWorker?.resume();
    this.commitWorker?.resume();
    console.log('[TaskWorker] All workers resumed');
  }
}

export const taskWorker = new TaskWorkerService();
export default taskWorker;
