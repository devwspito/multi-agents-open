/**
 * Task Queue Service
 *
 * BullMQ-based task queue for handling AI task execution.
 * Supports priority queuing, rate limiting, and job lifecycle management.
 *
 * Queue Features:
 * - Priority queuing (Pro users get higher priority)
 * - Rate limiting per user
 * - Automatic retries with exponential backoff
 * - Job progress tracking
 * - Dead letter queue for failed jobs
 */

import { Queue, QueueEvents, Job, JobsOptions } from 'bullmq';
import { redisService } from './RedisService.js';
import { RepositoryInfo } from '../../types/index.js';

// Queue names
export const QUEUE_NAMES = {
  TASKS: 'task-execution',
  PRIORITY: 'task-execution-priority',
  COMMITS: 'git-commits',
} as const;

// Job data types
export interface TaskJobData {
  taskId: string;
  userId: string;
  projectId: string;
  pipelineName: string;
  workspacePath: string;
  repositories: RepositoryInfo[];
  githubToken?: string;
  approvalMode: 'manual' | 'automatic';
  priority: number; // 0-100, higher = more priority
}

export interface CommitJobData {
  taskId: string;
  repoPath: string;
  message: string;
  githubToken: string;
}

// Queue configuration
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000, // 5s, 10s, 20s
  },
  removeOnComplete: {
    age: 24 * 3600, // Keep completed jobs for 24 hours
    count: 1000,    // Keep last 1000 completed jobs
  },
  removeOnFail: {
    age: 7 * 24 * 3600, // Keep failed jobs for 7 days
  },
};

class TaskQueueServiceClass {
  private taskQueue: Queue<TaskJobData> | null = null;
  private priorityQueue: Queue<TaskJobData> | null = null;
  private commitQueue: Queue<CommitJobData> | null = null;
  private queueEvents: QueueEvents | null = null;

  /**
   * Initialize all queues
   */
  async initialize(): Promise<void> {
    const connection = redisService.getClient();

    // Main task queue
    this.taskQueue = new Queue<TaskJobData>(QUEUE_NAMES.TASKS, {
      connection,
      defaultJobOptions,
    });

    // Priority queue for Pro users
    this.priorityQueue = new Queue<TaskJobData>(QUEUE_NAMES.PRIORITY, {
      connection,
      defaultJobOptions: {
        ...defaultJobOptions,
        priority: 1, // Higher priority
      },
    });

    // Commit queue (for git operations)
    this.commitQueue = new Queue<CommitJobData>(QUEUE_NAMES.COMMITS, {
      connection,
      defaultJobOptions: {
        ...defaultJobOptions,
        attempts: 2,
      },
    });

    // Queue events for monitoring
    this.queueEvents = new QueueEvents(QUEUE_NAMES.TASKS, { connection });

    console.log('[TaskQueue] Queues initialized');
  }

  /**
   * Add a task to the queue
   */
  async addTask(data: TaskJobData, options?: {
    priority?: number;
    delay?: number;
    isPro?: boolean;
  }): Promise<Job<TaskJobData>> {
    const queue = options?.isPro ? this.priorityQueue : this.taskQueue;
    if (!queue) throw new Error('Queue not initialized');

    const jobOptions: JobsOptions = {
      ...defaultJobOptions,
      priority: options?.priority || data.priority || 0,
      delay: options?.delay,
      jobId: data.taskId, // Use taskId as jobId for easy lookup
    };

    const job = await queue.add('execute-task', data, jobOptions);

    console.log(`[TaskQueue] Task ${data.taskId} added to queue (priority: ${jobOptions.priority}, isPro: ${options?.isPro})`);

    return job;
  }

  /**
   * Add a commit job
   */
  async addCommit(data: CommitJobData): Promise<Job<CommitJobData>> {
    if (!this.commitQueue) throw new Error('Commit queue not initialized');

    const job = await this.commitQueue.add('git-commit', data);
    console.log(`[TaskQueue] Commit job added for task ${data.taskId}`);

    return job;
  }

  /**
   * Get job by task ID
   */
  async getJob(taskId: string): Promise<Job<TaskJobData> | undefined> {
    if (!this.taskQueue) return undefined;

    // Try main queue first
    let job = await this.taskQueue.getJob(taskId);
    if (job) return job;

    // Try priority queue
    if (this.priorityQueue) {
      job = await this.priorityQueue.getJob(taskId);
    }

    return job;
  }

  /**
   * Get queue position for a task
   */
  async getQueuePosition(taskId: string): Promise<number | null> {
    const job = await this.getJob(taskId);
    if (!job) return null;

    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed') return null;

    // Get all waiting jobs
    if (!this.taskQueue) return null;

    const waiting = await this.taskQueue.getWaiting();
    const index = waiting.findIndex(j => j.id === taskId);

    return index >= 0 ? index + 1 : null;
  }

  /**
   * Cancel a task (remove from queue)
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const job = await this.getJob(taskId);
    if (!job) return false;

    const state = await job.getState();

    // Can only cancel waiting/delayed jobs
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      console.log(`[TaskQueue] Task ${taskId} removed from queue`);
      return true;
    }

    // If active, move to failed
    if (state === 'active') {
      await job.moveToFailed(new Error('Cancelled by user'), 'cancelled');
      console.log(`[TaskQueue] Active task ${taskId} marked as cancelled`);
      return true;
    }

    return false;
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    priorityWaiting: number;
  }> {
    if (!this.taskQueue || !this.priorityQueue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, priorityWaiting: 0 };
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.taskQueue.getWaitingCount(),
      this.taskQueue.getActiveCount(),
      this.taskQueue.getCompletedCount(),
      this.taskQueue.getFailedCount(),
      this.taskQueue.getDelayedCount(),
    ]);

    const priorityWaiting = await this.priorityQueue.getWaitingCount();

    return { waiting, active, completed, failed, delayed, priorityWaiting };
  }

  /**
   * Get estimated wait time (in seconds)
   */
  async getEstimatedWaitTime(isPro: boolean = false): Promise<number> {
    const stats = await this.getStats();

    // Average task duration (from config or default)
    const avgTaskDuration = parseInt(process.env.AVG_TASK_DURATION || '180'); // 3 minutes default

    // Concurrent capacity
    const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '3');

    if (isPro) {
      // Pro users only wait for priority queue
      return Math.ceil(stats.priorityWaiting / concurrency) * avgTaskDuration;
    }

    // Regular users wait for priority queue to drain first
    const totalAhead = stats.priorityWaiting + stats.waiting;
    return Math.ceil(totalAhead / concurrency) * avgTaskDuration;
  }

  /**
   * Pause all queues (for maintenance)
   */
  async pauseAll(): Promise<void> {
    await Promise.all([
      this.taskQueue?.pause(),
      this.priorityQueue?.pause(),
      this.commitQueue?.pause(),
    ]);
    console.log('[TaskQueue] All queues paused');
  }

  /**
   * Resume all queues
   */
  async resumeAll(): Promise<void> {
    await Promise.all([
      this.taskQueue?.resume(),
      this.priorityQueue?.resume(),
      this.commitQueue?.resume(),
    ]);
    console.log('[TaskQueue] All queues resumed');
  }

  /**
   * Drain all queues (remove all waiting jobs)
   */
  async drainAll(): Promise<void> {
    await Promise.all([
      this.taskQueue?.drain(),
      this.priorityQueue?.drain(),
      this.commitQueue?.drain(),
    ]);
    console.log('[TaskQueue] All queues drained');
  }

  /**
   * Close all queues
   */
  async close(): Promise<void> {
    await Promise.all([
      this.taskQueue?.close(),
      this.priorityQueue?.close(),
      this.commitQueue?.close(),
      this.queueEvents?.close(),
    ]);
    console.log('[TaskQueue] All queues closed');
  }

  /**
   * Get queue events emitter (for real-time monitoring)
   */
  getEvents(): QueueEvents | null {
    return this.queueEvents;
  }

  /**
   * Get the main task queue
   */
  getTaskQueue(): Queue<TaskJobData> | null {
    return this.taskQueue;
  }

  /**
   * Get the priority queue
   */
  getPriorityQueue(): Queue<TaskJobData> | null {
    return this.priorityQueue;
  }
}

export const taskQueue = new TaskQueueServiceClass();
export default taskQueue;
