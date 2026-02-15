/**
 * Task Routes
 *
 * Task CRUD + orchestration control (pause, resume, retry, approve).
 * Now uses BullMQ for task queuing and background processing.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, getUserGitHubToken } from './auth.js';
import { getProject } from './projects.js';
import { getRepository } from './repositories.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../../database/repositories/RepositoryRepository.js';
import { ProjectRepository } from '../../database/repositories/ProjectRepository.js';
import { orchestratorV2 } from '../../orchestration/index.js';
import { openCodeClient, openCodeEventBridge } from '../../services/opencode/index.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { costTracker } from '../../services/cost/index.js';
import { WorkspaceService } from '../../services/workspace/index.js';
import { EnvService } from '../../services/env/EnvService.js';
import { taskQueue, TaskJobData } from '../../services/queue/TaskQueue.js';
import { RepositoryInfo } from '../../types/index.js';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Always use queue mode (V2 architecture)

const router = Router();

// Workspaces directory - stores cloned repos OUTSIDE the project for security
// Default: ~/.open-multi-agents/workspaces
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || path.join(os.homedir(), '.open-multi-agents', 'workspaces');

interface TaskExecution {
  taskId: string;
  sessionId: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  currentPhase?: string;
  startedAt: Date;
  pausedAt?: Date;
}

// Track running executions
const executions = new Map<string, TaskExecution>();

router.use(authMiddleware);

/**
 * GET /api/tasks
 * List tasks
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { projectId, status } = req.query;

  let tasks = await TaskRepository.findAll();

  // Filter by user's projects
  if (projectId) {
    tasks = tasks.filter(t => t.projectId === projectId);
  }
  if (status) {
    tasks = tasks.filter(t => t.status === status);
  }

  res.json({ data: tasks });
});

/**
 * POST /api/tasks
 * Create new task
 */
router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { title, description, projectId, repositoryId } = req.body;

  if (!title || !projectId) {
    return res.status(400).json({ error: 'title and projectId required' });
  }

  const project = await getProject(projectId);
  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const task = await TaskRepository.create({
    userId,
    title,
    description,
    projectId,
    repositoryId,
    status: 'pending',
  });

  res.status(201).json({ data: task });
});

/**
 * GET /api/tasks/:taskId
 * Get task details (includes activity_log for page refresh recovery)
 */
router.get('/:taskId', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Get activity log for page refresh recovery
  const activityLog = await TaskRepository.getActivityLog(req.params.taskId);

  const execution = executions.get(task.id);
  res.json({
    data: {
      ...task,
      activityLog, // 🔥 Include activity log for console recovery
      execution: execution ? {
        status: execution.status,
        currentPhase: execution.currentPhase,
        startedAt: execution.startedAt,
        pausedAt: execution.pausedAt,
      } : null,
    },
  });
});

/**
 * GET /api/tasks/:taskId/activity-log
 * Get activity log for a task (for console recovery on page refresh)
 */
router.get('/:taskId/activity-log', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const activityLog = await TaskRepository.getActivityLog(req.params.taskId);

  res.json({
    success: true,
    data: {
      taskId: task.id,
      activityLog,
      count: activityLog.length,
    },
  });
});

/**
 * DELETE /api/tasks/:taskId
 * Delete task
 */
router.delete('/:taskId', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  await TaskRepository.delete(req.params.taskId);
  res.json({ success: true });
});

/**
 * POST /api/tasks/:taskId/start
 * Start task orchestration
 *
 * Body: { prompt: string } - The user's message describing the task
 */
router.post('/:taskId/start', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { prompt } = req.body;

  // Require prompt from user
  if (!prompt || prompt.trim().length < 5) {
    return res.status(400).json({
      error: 'prompt required - describe what you want the AI to do'
    });
  }

  let task = await TaskRepository.findById(req.params.taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Save the user's prompt as the task description
  task = (await TaskRepository.update(task.id, { description: prompt.trim() }))!;

  const project = await getProject(task.projectId!);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const githubToken = await getUserGitHubToken(userId);

  // Create workspace directory
  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // Get ALL repositories for this project
  const allRepos = await RepositoryRepository.findByProjectId(task.projectId!);
  const repositories: RepositoryInfo[] = [];

  // Clone ALL repositories
  if (githubToken && allRepos.length > 0) {
    console.log(`[Tasks] Cloning ${allRepos.length} repositories for project ${task.projectId}`);

    for (const repo of allRepos) {
      const repoDir = path.join(workspacePath, repo.name);

      if (!fs.existsSync(repoDir)) {
        console.log(`[Tasks] Cloning ${repo.name} (${repo.type}) to ${repoDir}`);
        await WorkspaceService.cloneWithToken(repo.githubRepoUrl, repoDir, githubToken);
      }

      // Generate .env file with decrypted environment variables
      if (repo.envVariables && repo.envVariables.length > 0) {
        console.log(`[Tasks] Generating .env for ${repo.name} (${repo.envVariables.length} vars)`);
        await EnvService.writeEnvFile(repoDir, repo.envVariables);
      }

      // Build RepositoryInfo for this repo
      repositories.push({
        id: repo.id,
        name: repo.name,
        type: repo.type,
        localPath: repoDir,
        githubUrl: repo.githubRepoUrl,
        branch: repo.githubBranch,
        description: repo.description,
        executionOrder: repo.executionOrder,
      });
    }

    console.log(`[Tasks] Repositories ready: ${repositories.map(r => `${r.name}(${r.type})`).join(', ')}`);
  } else if (task.repositoryId) {
    // Fallback: single repo from task.repositoryId
    const repo = await getRepository(task.repositoryId);
    if (repo && githubToken) {
      const repoDir = path.join(workspacePath, repo.name);
      if (!fs.existsSync(repoDir)) {
        await WorkspaceService.cloneWithToken(repo.githubRepoUrl, repoDir, githubToken);
      }

      // Generate .env file with decrypted environment variables
      if (repo.envVariables && repo.envVariables.length > 0) {
        console.log(`[Tasks] Generating .env for ${repo.name} (${repo.envVariables.length} vars)`);
        await EnvService.writeEnvFile(repoDir, repo.envVariables);
      }

      repositories.push({
        id: repo.id,
        name: repo.name,
        type: repo.type,
        localPath: repoDir,
        githubUrl: repo.githubRepoUrl,
        branch: repo.githubBranch,
        description: repo.description,
        executionOrder: repo.executionOrder,
      });
    }
  }

  // Connect to OpenCode (phases will create their own sessions)
  if (!openCodeClient.isConnected()) {
    await openCodeClient.connect();
  }

  // V2 uses 4-phase architecture (no pipelines needed)
  const pipelineName = 'v2'; // Legacy field kept for compatibility

  // Track execution (sessionId will be updated by phases via callback)
  const execution: TaskExecution = {
    taskId: task.id,
    sessionId: '', // Will be set by onSessionCreated callback
    status: 'running',
    startedAt: new Date(),
  };
  executions.set(task.id, execution);

  // Update task status
  await TaskRepository.updateStatus(task.id, 'running');

  // Emit to frontend
  socketService.toTask(task.id, 'task:started', { taskId: task.id });

  // 🔥 Emit user's initial prompt as activity so it shows in the terminal
  if (task.description) {
    socketService.toTask(task.id, 'agent:activity', {
      id: `user-${Date.now()}`,
      taskId: task.id,
      type: 'user',
      content: task.description,
      timestamp: new Date(),
    });
  }

  const approvalMode = project.settings?.approvalMode || 'manual';
  console.log(`[Tasks] 🔐 Task ${task.id} using approvalMode: ${approvalMode} (project.settings?.approvalMode: ${project.settings?.approvalMode || 'undefined'})`);

  // Add task to BullMQ queue (V2 architecture)
  const jobData: TaskJobData = {
      taskId: task.id,
      userId,
      projectId: task.projectId!,
      pipelineName,
      workspacePath,
      repositories,
      githubToken,
      approvalMode: approvalMode as 'manual' | 'automatic',
      priority: project.settings?.priority || 0,
    };

    // Determine if user has Pro subscription (higher priority queue)
    const isPro = project.settings?.isPro || false;

    try {
      const job = await taskQueue.addTask(jobData, {
        priority: jobData.priority,
        isPro,
      });

      // Get queue position
      const position = await taskQueue.getQueuePosition(task.id);
      const estimatedWait = await taskQueue.getEstimatedWaitTime(isPro);

      console.log(`[Tasks] Task ${task.id} queued (job ${job.id}, position: ${position})`);

      // Update task status to 'queued'
      await TaskRepository.updateStatus(task.id, 'queued');

      // Emit to frontend
      socketService.toTask(task.id, 'task:queued', {
        taskId: task.id,
        jobId: job.id,
        position,
        estimatedWaitSeconds: estimatedWait,
        isPro,
      });

      return res.json({
        data: {
          taskId: task.id,
          jobId: job.id,
          status: 'queued',
          position,
          estimatedWaitSeconds: estimatedWait,
          isPro,
        }
      });

    } catch (queueError: any) {
      console.error(`[Tasks] Failed to queue task ${task.id}:`, queueError.message);
      await TaskRepository.updateStatus(task.id, 'failed');
      return res.status(500).json({ error: `Failed to queue task: ${queueError.message}` });
    }
});

/**
 * POST /api/tasks/:taskId/resume
 * Resume an interrupted task from where it left off
 *
 * Uses stored progress (current_phase, last_completed_story_index, completed_phases)
 * to restart the task from the appropriate phase.
 */
router.post('/:taskId/resume', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const taskId = req.params.taskId;

  const task = await TaskRepository.findById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Only allow resuming interrupted tasks
  if (task.status !== 'interrupted') {
    return res.status(400).json({
      error: `Cannot resume task with status '${task.status}'`,
      hint: task.status === 'running' ? 'Task is already running' :
            task.status === 'completed' ? 'Task already completed' :
            'Use /start for pending tasks or /continue for paused tasks',
    });
  }

  const project = await getProject(task.projectId!);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const githubToken = await getUserGitHubToken(userId);

  // Workspace should still exist from previous run
  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  if (!fs.existsSync(workspacePath)) {
    return res.status(400).json({
      error: 'Workspace not found',
      hint: 'The workspace was deleted. Please start a new task instead.',
    });
  }

  // Get ALL repositories for this project
  const allRepos = await RepositoryRepository.findByProjectId(task.projectId!);
  const repositories: RepositoryInfo[] = allRepos.map(repo => ({
    id: repo.id,
    name: repo.name,
    type: repo.type,
    localPath: path.join(workspacePath, repo.name),
    githubUrl: repo.githubRepoUrl,
    branch: task.branchName || repo.githubBranch,
    description: repo.description,
    executionOrder: repo.executionOrder,
  }));

  // Connect to OpenCode (phases will create their own sessions)
  if (!openCodeClient.isConnected()) {
    await openCodeClient.connect();
  }

  // Determine which phase to start from
  let startFromPhase: 'Analysis' | 'Developer' | 'Merge' | 'GlobalScan' | undefined;
  let preserveAnalysis = false;
  let preserveStories = false;

  // Use the stored current_phase if available
  if (task.currentPhase) {
    startFromPhase = task.currentPhase as any;
    // If we're resuming Developer or later, preserve analysis
    if (task.currentPhase !== 'Analysis') {
      preserveAnalysis = true;
    }
    // If we're resuming Merge or GlobalScan, preserve stories too
    if (task.currentPhase === 'Merge' || task.currentPhase === 'GlobalScan') {
      preserveStories = true;
    }
  } else if (task.completedPhases && task.completedPhases.length > 0) {
    // Determine next phase based on completed phases
    const completedPhaseNames = task.completedPhases.map((p: any) =>
      typeof p === 'string' ? p : p.phase
    );

    if (completedPhaseNames.includes('GlobalScan')) {
      return res.status(400).json({
        error: 'Task already completed all phases',
        hint: 'Use /continue-with-context to start a new task with context from this one',
      });
    } else if (completedPhaseNames.includes('Merge')) {
      startFromPhase = 'GlobalScan';
      preserveAnalysis = true;
      preserveStories = true;
    } else if (completedPhaseNames.includes('Developer')) {
      startFromPhase = 'Merge';
      preserveAnalysis = true;
      preserveStories = true;
    } else if (completedPhaseNames.includes('Analysis')) {
      startFromPhase = 'Developer';
      preserveAnalysis = true;
    } else {
      startFromPhase = 'Analysis';
    }
  } else {
    // No phase info - start from the beginning
    startFromPhase = 'Analysis';
  }

  // Track execution
  const execution: TaskExecution = {
    taskId: task.id,
    sessionId: '',
    status: 'running',
    startedAt: new Date(),
  };
  executions.set(task.id, execution);

  // Update task status
  await TaskRepository.updateStatus(task.id, 'running');

  // Emit to frontend
  socketService.toTask(task.id, 'task:resumed', {
    taskId: task.id,
    resumeFromPhase: startFromPhase,
    lastCompletedStoryIndex: task.lastCompletedStoryIndex,
  });

  // Emit system message so user knows what's happening
  socketService.toTask(task.id, 'agent:activity', {
    id: `system-${Date.now()}`,
    taskId: task.id,
    type: 'system',
    content: `Resuming task from ${startFromPhase} phase...`,
    timestamp: new Date(),
  });

  const approvalMode = project.settings?.approvalMode || 'manual';
  console.log(`[Tasks] 🔐 Resume: project.settings=${JSON.stringify(project.settings)}, approvalMode=${approvalMode}`);
  console.log(`[Tasks] 🔄 Resuming task ${task.id} from ${startFromPhase} phase (lastStoryIndex: ${task.lastCompletedStoryIndex ?? 'none'})`);

  // Add task to BullMQ queue with resume options
  const jobData: TaskJobData = {
    taskId: task.id,
    userId,
    projectId: task.projectId!,
    pipelineName: 'v2',
    workspacePath,
    repositories,
    githubToken,
    approvalMode: approvalMode as 'manual' | 'automatic',
    priority: project.settings?.priority || 0,
    // Resume options
    startFromPhase: startFromPhase as any,
    preserveAnalysis,
    preserveStories,
  };

  const isPro = project.settings?.isPro || false;

  try {
    const job = await taskQueue.addTask(jobData, {
      priority: jobData.priority,
      isPro,
    });

    const position = await taskQueue.getQueuePosition(task.id);
    const estimatedWait = await taskQueue.getEstimatedWaitTime(isPro);

    console.log(`[Tasks] Task ${task.id} resumed and queued (job ${job.id}, position: ${position})`);

    // Update task status to 'queued'
    await TaskRepository.updateStatus(task.id, 'queued');

    // Emit to frontend
    socketService.toTask(task.id, 'task:queued', {
      taskId: task.id,
      jobId: job.id,
      position,
      estimatedWaitSeconds: estimatedWait,
      isPro,
      resumedFrom: startFromPhase,
    });

    return res.json({
      success: true,
      data: {
        taskId: task.id,
        jobId: job.id,
        status: 'queued',
        position,
        estimatedWaitSeconds: estimatedWait,
        isPro,
        resumedFrom: startFromPhase,
        preserveAnalysis,
        preserveStories,
        lastCompletedStoryIndex: task.lastCompletedStoryIndex,
      }
    });

  } catch (queueError: any) {
    console.error(`[Tasks] Failed to queue resumed task ${task.id}:`, queueError.message);
    await TaskRepository.updateStatus(task.id, 'failed');
    return res.status(500).json({ error: `Failed to queue task: ${queueError.message}` });
  }
});

/**
 * POST /api/tasks/:taskId/interrupt
 * Interrupt (abort) task execution - session persists for later continuation
 *
 * OpenCode SDK: session.abort()
 */
router.post('/:taskId/interrupt', async (req: Request, res: Response) => {
  const execution = executions.get(req.params.taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No running execution' });
  }

  if (execution.status !== 'running') {
    return res.status(400).json({ error: 'Task not running' });
  }

  // Interrupt OpenCode session (abort but keep session for later)
  await openCodeClient.abortSession(execution.sessionId);

  execution.status = 'paused';
  execution.pausedAt = new Date();

  await TaskRepository.updateStatus(req.params.taskId, 'paused');
  socketService.toTask(req.params.taskId, 'task:interrupted', { taskId: req.params.taskId });

  res.json({ data: { status: 'interrupted', pausedAt: execution.pausedAt } });
});

/**
 * POST /api/tasks/:taskId/continue
 * Continue an interrupted task with a new prompt (optionally with images)
 *
 * OpenCode SDK: session.prompt() or sendPromptWithImages() to existing session
 *
 * Body:
 *   - prompt: string - The text prompt
 *   - images?: Array<{ data: string, mime?: string, filename?: string }> - Base64 encoded images
 */
router.post('/:taskId/continue', async (req: Request, res: Response) => {
  const execution = executions.get(req.params.taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No execution found' });
  }

  if (execution.status !== 'paused') {
    return res.status(400).json({ error: 'Task not interrupted' });
  }

  const { prompt, images } = req.body;
  const continuePrompt = prompt || 'Continue with the task from where you left off.';

  // 🔥 Emit user message as activity so it shows in the terminal
  socketService.toTask(req.params.taskId, 'agent:activity', {
    id: `user-${Date.now()}`,
    taskId: req.params.taskId,
    type: 'user',
    content: continuePrompt,
    timestamp: new Date(),
    hasImages: !!(images?.length),
  });

  // Continue OpenCode session - with or without images
  if (images && Array.isArray(images) && images.length > 0) {
    // Convert base64 strings to the format expected by sendPromptWithImages
    const imageData = images.map((img: { data: string; mime?: string; filename?: string }) => ({
      data: img.data, // Already base64 string from frontend
      mime: img.mime || 'image/png',
      filename: img.filename,
    }));

    console.log(`[Tasks] Continuing session ${execution.sessionId} with ${images.length} image(s)`);
    await openCodeClient.sendPromptWithImages(execution.sessionId, continuePrompt, imageData);
  } else {
    await openCodeClient.sendPrompt(execution.sessionId, continuePrompt);
  }

  execution.status = 'running';
  execution.pausedAt = undefined;

  await TaskRepository.updateStatus(req.params.taskId, 'running');
  socketService.toTask(req.params.taskId, 'task:continued', {
    taskId: req.params.taskId,
    hasImages: !!(images?.length),
  });

  res.json({ data: { status: 'running' } });
});

/**
 * POST /api/tasks/:taskId/continue-with-context
 * Continue a completed/failed task with full context from previous execution
 *
 * This creates a NEW task that includes context from the original task.
 * The orchestrator runs completely fresh but with injected context.
 *
 * Body:
 *   - prompt: string - The new instructions from the user
 */
router.post('/:taskId/continue-with-context', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const originalTaskId = req.params.taskId;
  const { prompt } = req.body;

  if (!prompt || prompt.trim().length < 5) {
    return res.status(400).json({
      error: 'prompt required - describe what you want the AI to do next'
    });
  }

  // Get original task
  const originalTask = await TaskRepository.findById(originalTaskId);
  if (!originalTask) {
    return res.status(404).json({ error: 'Original task not found' });
  }

  // Only allow continuation of completed/failed tasks
  if (!['completed', 'failed', 'cancelled'].includes(originalTask.status)) {
    return res.status(400).json({
      error: `Cannot continue task with status '${originalTask.status}'. Use /continue for paused tasks.`,
    });
  }

  // Build context from original task
  const { buildTaskContext, buildContinuationPrompt } = await import('../../services/context/TaskContextBuilder.js');
  const context = await buildTaskContext(originalTaskId);

  if (!context) {
    return res.status(500).json({ error: 'Failed to build context from original task' });
  }

  // Build the continuation prompt with context
  const fullPrompt = buildContinuationPrompt(context, prompt.trim());

  // Create new task with context-enriched prompt
  const newTask = await TaskRepository.create({
    userId,
    title: `Continue: ${originalTask.title}`,
    description: fullPrompt,
    projectId: originalTask.projectId,
    repositoryId: originalTask.repositoryId,
    status: 'pending',
  });

  // Link to original task in metadata (stored in description for now)
  console.log(`[Tasks] Created continuation task ${newTask.id} from ${originalTaskId}`);

  // Get project for approval mode
  const project = await getProject(originalTask.projectId!);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const githubToken = await getUserGitHubToken(userId);

  // Reuse workspace from original task
  const workspacePath = path.join(WORKSPACES_DIR, originalTaskId);

  // Get repositories (same as original)
  const allRepos = await RepositoryRepository.findByProjectId(originalTask.projectId!);
  const repositories: RepositoryInfo[] = allRepos.map(repo => ({
    id: repo.id,
    name: repo.name,
    type: repo.type,
    localPath: path.join(workspacePath, repo.name),
    githubUrl: repo.githubRepoUrl,
    branch: originalTask.branchName || repo.githubBranch,
    description: repo.description,
    executionOrder: repo.executionOrder,
  }));

  // Connect to OpenCode
  if (!openCodeClient.isConnected()) {
    await openCodeClient.connect();
  }

  // Track execution
  const execution: TaskExecution = {
    taskId: newTask.id,
    sessionId: '',
    status: 'running',
    startedAt: new Date(),
  };
  executions.set(newTask.id, execution);

  // Update task status
  await TaskRepository.updateStatus(newTask.id, 'running');

  // Emit to frontend
  socketService.toTask(newTask.id, 'task:started', {
    taskId: newTask.id,
    continuedFrom: originalTaskId,
  });

  // Emit user's prompt as activity
  socketService.toTask(newTask.id, 'agent:activity', {
    id: `user-${Date.now()}`,
    taskId: newTask.id,
    type: 'user',
    content: prompt.trim(),
    timestamp: new Date(),
  });

  const approvalMode = project.settings?.approvalMode || 'manual';

  // Queue the task
  const jobData: TaskJobData = {
    taskId: newTask.id,
    userId,
    projectId: originalTask.projectId!,
    pipelineName: 'v2',
    workspacePath,
    repositories,
    githubToken,
    approvalMode: approvalMode as 'manual' | 'automatic',
    priority: project.settings?.priority || 0,
    // Pass context for phases to use
    continuedFromTaskId: originalTaskId,
  };

  try {
    const job = await taskQueue.addTask(jobData, {
      priority: jobData.priority,
      isPro: project.settings?.isPro || false,
    });

    const position = await taskQueue.getQueuePosition(newTask.id);

    console.log(`[Tasks] Continuation task ${newTask.id} queued (from ${originalTaskId})`);

    await TaskRepository.updateStatus(newTask.id, 'queued');

    socketService.toTask(newTask.id, 'task:queued', {
      taskId: newTask.id,
      jobId: job.id,
      position,
      continuedFrom: originalTaskId,
    });

    return res.json({
      success: true,
      data: {
        taskId: newTask.id,
        continuedFrom: originalTaskId,
        jobId: job.id,
        status: 'queued',
        position,
      }
    });
  } catch (queueError: any) {
    console.error(`[Tasks] Failed to queue continuation task:`, queueError.message);
    await TaskRepository.updateStatus(newTask.id, 'failed');
    return res.status(500).json({ error: `Failed to queue task: ${queueError.message}` });
  }
});

/**
 * POST /api/tasks/:taskId/cancel
 * Cancel task execution (works with both queue and direct mode)
 */
router.post('/:taskId/cancel', async (req: Request, res: Response) => {
  const taskId = req.params.taskId;

  // Try to cancel from queue
  const cancelled = await taskQueue.cancelTask(taskId);
  if (cancelled) {
    await TaskRepository.updateStatus(taskId, 'cancelled');
    socketService.toTask(taskId, 'task:cancelled', { taskId, fromQueue: true });
    return res.json({ data: { status: 'cancelled', fromQueue: true } });
  }

  // Fall back to execution cancellation (if task is running)
  const execution = executions.get(taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No execution found' });
  }

  // Unregister and abort session if we have one
  if (execution.sessionId) {
    openCodeEventBridge.unregisterSession(execution.sessionId);
    try {
      await openCodeClient.abortSession(execution.sessionId);
      await openCodeClient.deleteSession(execution.sessionId);
    } catch (err: any) {
      console.warn(`[Tasks] Failed to abort session: ${err.message}`);
    }
  }

  execution.status = 'failed';
  executions.delete(taskId);

  await TaskRepository.updateStatus(taskId, 'cancelled');
  approvalService.cancelTask(taskId);
  socketService.toTask(taskId, 'task:cancelled', { taskId });

  res.json({ data: { status: 'cancelled' } });
});

/**
 * POST /api/tasks/:taskId/retry
 * Retry a failed/interrupted task - alias for continue with retry prompt
 *
 * OpenCode SDK: session.prompt() to existing session
 */
router.post('/:taskId/retry', async (req: Request, res: Response) => {
  const execution = executions.get(req.params.taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No execution found' });
  }

  const { prompt } = req.body;
  const retryPrompt = prompt || 'Please try again with the previous task.';

  // Retry = continue with new prompt
  await openCodeClient.sendPrompt(execution.sessionId, retryPrompt);

  execution.status = 'running';
  execution.pausedAt = undefined;

  await TaskRepository.updateStatus(req.params.taskId, 'running');
  socketService.toTask(req.params.taskId, 'task:retrying', { taskId: req.params.taskId });

  res.json({ data: { status: 'running' } });
});

/**
 * POST /api/tasks/:taskId/retry-from/:phase
 * Phase-selective retry - restart task from a specific phase
 *
 * Phases: Planning, Analysis, Developer, TestGeneration, Merge
 *
 * Body:
 * - options: Additional options for the phase execution
 */
router.post('/:taskId/retry-from/:phase', async (req: Request, res: Response) => {
  const { taskId, phase } = req.params;
  const userId = (req as any).userId;
  const { options = {} } = req.body;

  const task = await TaskRepository.findById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Validate phase name
  const validPhases = ['Planning', 'Analysis', 'Developer', 'TestGeneration', 'Merge', 'GlobalScan'];
  if (!validPhases.includes(phase)) {
    return res.status(400).json({
      error: `Invalid phase: ${phase}`,
      validPhases,
    });
  }

  // Check if task has required data for the phase
  if (phase === 'Developer' && (!task.stories || task.stories.length === 0)) {
    return res.status(400).json({
      error: 'Cannot retry from Developer phase - no stories from Analysis phase',
      suggestion: 'Retry from Analysis phase instead',
    });
  }

  if (phase === 'TestGeneration' && (!task.stories || task.stories.length === 0)) {
    return res.status(400).json({
      error: 'Cannot retry from TestGeneration phase - no stories available',
      suggestion: 'Retry from Analysis phase instead',
    });
  }

  if ((phase === 'Merge' || phase === 'GlobalScan') && !task.branchName) {
    return res.status(400).json({
      error: `Cannot retry from ${phase} phase - no branch created`,
      suggestion: 'Retry from Analysis phase instead',
    });
  }

  try {
    // Cancel any existing execution
    const existingExecution = executions.get(taskId);
    if (existingExecution) {
      openCodeEventBridge.unregisterSession(existingExecution.sessionId);
      try {
        await openCodeClient.abortSession(existingExecution.sessionId);
      } catch (err) {
        // Ignore abort errors
      }
      executions.delete(taskId);
    }

    // Get user's GitHub token
    const githubToken = await getUserGitHubToken(userId);

    // Get project repositories
    const project = task.projectId ? await getProject(task.projectId) : null;
    const projectRepos = project ? await RepositoryRepository.findByProjectId(project.id) : [];

    // Build repositories info
    const repositories: RepositoryInfo[] = projectRepos.map(repo => ({
      id: repo.id,
      name: repo.name,
      type: repo.type || 'backend',
      localPath: path.join(WORKSPACES_DIR, taskId, repo.name),
      githubUrl: repo.url,
      branch: task.branchName || 'main',
      description: repo.description,
    }));

    // Update task status
    await TaskRepository.updateStatus(taskId, 'running');

    // Notify frontend
    socketService.toTask(taskId, 'task:retry_from_phase', {
      taskId,
      phase,
      startedAt: new Date().toISOString(),
    });

    // Queue the task with startFromPhase option
    const jobId = await taskQueue.addTask({
      taskId,
      userId,
      title: task.title,
      description: task.description || '',
      projectId: task.projectId || undefined,
      repositoryIds: projectRepos.map(r => r.id),
      startFromPhase: phase as any,
      preserveAnalysis: phase !== 'Analysis' && phase !== 'Planning',
      preserveStories: phase === 'TestGeneration' || phase === 'Merge' || phase === 'GlobalScan',
      githubToken,
      ...options,
    });

    res.json({
      success: true,
      data: {
        taskId,
        retryFromPhase: phase,
        jobId,
        message: `Task will retry from ${phase} phase`,
      },
    });
  } catch (error: any) {
    console.error(`[Tasks] Phase-selective retry error:`, error);
    res.status(500).json({
      error: 'Failed to retry from phase',
      message: error.message,
    });
  }
});

/**
 * POST /api/tasks/:taskId/approve/:phase
 * Approve a phase (for manual approval mode)
 *
 * Body: { feedback?: string } - Optional feedback/clarification answers (JSON string)
 */
router.post('/:taskId/approve/:phase', (req: Request, res: Response) => {
  const { taskId, phase } = req.params;
  const { feedback } = req.body; // 🔥 FIX: Accept feedback for clarifications

  // 🔥 FIX: Use resolveWithAction to pass feedback (for clarification answers)
  const resolved = approvalService.resolveWithAction(taskId, phase, {
    action: 'approve',
    feedback, // May be undefined for regular approvals, JSON string for clarifications
  });

  if (!resolved) {
    console.warn(`[API] No pending approval found for ${taskId}:${phase}`);
  }

  // Also emit to frontend for UI update
  socketService.toTask(taskId, 'phase:approved', { taskId, phase });

  res.json({ data: { approved: true, phase, resolved, hasFeedback: !!feedback } });
});

/**
 * POST /api/tasks/:taskId/reject/:phase
 * Reject a phase
 */
router.post('/:taskId/reject/:phase', (req: Request, res: Response) => {
  const { taskId, phase } = req.params;
  const { reason } = req.body;

  // 🔥 Directly resolve the pending approval as rejected
  const resolved = approvalService.resolve(taskId, phase, false);

  if (!resolved) {
    console.warn(`[API] No pending approval found for ${taskId}:${phase}`);
  }

  // Also emit to frontend for UI update
  socketService.toTask(taskId, 'phase:rejected', { taskId, phase, reason });

  res.json({ data: { rejected: true, phase, reason, resolved } });
});

/**
 * POST /api/tasks/:taskId/bypass
 * Bypass approval - force-approve current phase and optionally enable auto-approval
 */
router.post('/:taskId/bypass', async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { enableAutoApproval, enableForAllPhases } = req.body;

  const task = await TaskRepository.findById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Find and approve any pending phase
  const pendingPhases = ['Analysis', 'Developer', 'Merge'];
  let resolvedPhase: string | null = null;

  for (const phase of pendingPhases) {
    const resolved = approvalService.resolve(taskId, phase, true);
    if (resolved) {
      resolvedPhase = phase;
      console.log(`[API] Bypassed approval for ${taskId}:${phase}`);
      break;
    }
  }

  // If enableForAllPhases, update project settings to automatic mode
  if (enableForAllPhases && task.projectId) {
    await ProjectRepository.updateSettings(task.projectId, { approvalMode: 'automatic' });
    console.log(`[API] Updated project ${task.projectId} to automatic approval mode`);
  }

  // Emit to frontend
  socketService.toTask(taskId, 'phase:bypassed', {
    taskId,
    phase: resolvedPhase,
    enableForAllPhases,
  });

  res.json({
    data: {
      bypassed: true,
      phase: resolvedPhase,
      enableForAllPhases,
    },
  });
});

/**
 * GET /api/tasks/:taskId/status
 * Get task execution status
 */
router.get('/:taskId/status', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const execution = executions.get(req.params.taskId);

  // 🔥 Include pending approval info if exists
  const pendingApproval = approvalService.getPendingApprovalForTask(req.params.taskId);

  res.json({
    data: {
      taskId: task.id,
      taskStatus: task.status,
      execution: execution ? {
        sessionId: execution.sessionId,
        status: execution.status,
        currentPhase: execution.currentPhase,
        startedAt: execution.startedAt,
        pausedAt: execution.pausedAt,
      } : null,
      pendingApproval: pendingApproval || null,
    },
  });
});

/**
 * GET /api/tasks/:taskId/activities
 * Get activity history for a task (for reconnecting clients)
 *
 * Query params:
 * - limit: Number of activities to return (default 100)
 */
router.get('/:taskId/activities', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const limit = parseInt(req.query.limit as string) || 100;

  // Import activity stream service
  const { activityStream } = await import('../../services/realtime/ActivityStreamService.js');
  const activities = activityStream.getHistory(req.params.taskId, limit);

  res.json({
    success: true,
    data: {
      taskId: task.id,
      activities,
      count: activities.length,
    },
  });
});

/**
 * GET /api/tasks/:taskId/cost
 * Get real-time cost information for a task
 * Checks in-memory first (running tasks), then database (completed tasks)
 */
router.get('/:taskId/cost', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Use async version that checks both memory and database
  const costDetails = await costTracker.getTaskCostDetailsAsync(req.params.taskId);

  res.json({
    success: true,
    data: costDetails || {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      sessions: [],
    },
  });
});

/**
 * GET /api/tasks/:taskId/diff
 * Get the full unified diff for uncommitted changes in task workspace
 */
router.get('/:taskId/diff', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  // Check if workspace exists
  if (!fs.existsSync(workspacePath)) {
    return res.json({ success: true, data: { diff: '', files: [] } });
  }

  try {
    // Import gitService dynamically to avoid circular dependency
    const { gitService } = await import('../../services/git/GitService.js');

    // Get list of changed files and full diff
    const files = await gitService.getChangedFiles(workspacePath);
    const diff = await gitService.getFullDiff(workspacePath, 1000);
    const diffSummary = await gitService.getDiffSummary(workspacePath);

    res.json({
      success: true,
      data: {
        diff,
        diffSummary,
        files,
        fileCount: files.length,
      },
    });
  } catch (error: any) {
    console.error('[Tasks] Error getting diff:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get diff',
      message: error.message,
    });
  }
});

/**
 * GET /api/tasks/:taskId/diff/:filePath
 * Get diff for a specific file
 */
router.get('/:taskId/diff/:filePath(*)', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  const filePath = req.params.filePath;

  if (!fs.existsSync(workspacePath)) {
    return res.json({ success: true, data: { diff: '' } });
  }

  try {
    const { gitService } = await import('../../services/git/GitService.js');
    const diff = await gitService.getFileDiff(workspacePath, filePath);

    res.json({
      success: true,
      data: {
        filePath,
        diff,
      },
    });
  } catch (error: any) {
    console.error('[Tasks] Error getting file diff:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get file diff',
      message: error.message,
    });
  }
});

// ===========================================
// WORKSPACE ENDPOINTS
// ===========================================

/**
 * GET /api/tasks/:taskId/workspace/files
 * List all files in the task's workspace
 */
router.get('/:taskId/workspace/files', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  // Check if workspace exists
  if (!fs.existsSync(workspacePath)) {
    return res.json({ success: true, data: { files: [] } });
  }

  try {
    // Recursively get all files
    const files: string[] = [];

    const walkDir = (dir: string, prefix = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip .git and node_modules
        if (entry.name === '.git' || entry.name === 'node_modules') continue;

        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walkDir(path.join(dir, entry.name), relativePath);
        } else {
          files.push(relativePath);
        }
      }
    };

    walkDir(workspacePath);

    res.json({ success: true, data: { files } });
  } catch (error: any) {
    console.error('[Workspace] Error listing files:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/:taskId/workspace/file/*
 * Read a specific file from the workspace
 */
router.get('/:taskId/workspace/file/*', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Get file path from URL (everything after /file/)
  const filePath = req.params[0];
  if (!filePath) {
    return res.status(400).json({ error: 'File path required' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  const fullPath = path.join(workspacePath, filePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(workspacePath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }

    // Read file content
    const content = fs.readFileSync(fullPath, 'utf-8');

    res.json({
      success: true,
      data: {
        content,
        path: filePath,
        size: stat.size,
      }
    });
  } catch (error: any) {
    console.error('[Workspace] Error reading file:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/:taskId/workspace/changes
 * Get git changes in workspace - scans ALL repositories in the project
 */
router.get('/:taskId/workspace/changes', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  if (!fs.existsSync(workspacePath)) {
    return res.json({ success: true, data: { hasChanges: false, repositories: [] } });
  }

  try {
    // Get all repositories for this project
    const repos = task.projectId
      ? await RepositoryRepository.findByProjectId(task.projectId)
      : [];

    // Check changes in each repository folder
    const repositoryChanges: Array<{
      name: string;
      path: string;
      hasChanges: boolean;
      branch: string;
      modified: string[];
      untracked: string[];
      deleted: string[];
      added: string[];
      summary: string;
    }> = [];

    // If no repos defined, check for directories in workspace
    if (repos.length === 0) {
      const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const repoPath = path.join(workspacePath, entry.name);
          const gitPath = path.join(repoPath, '.git');
          if (fs.existsSync(gitPath)) {
            repos.push({ name: entry.name, localPath: repoPath } as any);
          }
        }
      }
    }

    for (const repo of repos) {
      const repoPath = path.join(workspacePath, repo.name);

      if (!fs.existsSync(repoPath)) {
        console.log(`[Workspace] Repo path not found: ${repoPath}`);
        continue;
      }

      const changes = await WorkspaceService.getChanges(repoPath);
      const branch = await WorkspaceService.getCurrentBranch(repoPath);

      repositoryChanges.push({
        name: repo.name,
        path: repoPath,
        hasChanges: changes.hasChanges,
        branch,
        modified: changes.modified,
        untracked: changes.untracked,
        deleted: changes.deleted,
        added: changes.added,
        summary: WorkspaceService.formatSummary(changes),
      });
    }

    // Aggregate for backward compatibility
    const hasChanges = repositoryChanges.some(r => r.hasChanges);
    const allModified = repositoryChanges.flatMap(r => r.modified.map(f => `${r.name}/${f}`));
    const allUntracked = repositoryChanges.flatMap(r => r.untracked.map(f => `${r.name}/${f}`));

    res.json({
      success: true,
      data: {
        hasChanges,
        modified: allModified,
        untracked: allUntracked,
        repositories: repositoryChanges,
        // Legacy single-repo format for backward compatibility
        branch: repositoryChanges[0]?.branch || 'main',
        summary: repositoryChanges.map(r => `${r.name}: ${r.summary}`).join(', '),
      }
    });
  } catch (error: any) {
    console.error('[Workspace] Error getting changes:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:taskId/workspace/commit
 * Commit changes in workspace repositories
 */
router.post('/:taskId/workspace/commit', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { message, files, repositories: repoNames } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Commit message required' });
  }

  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  if (!fs.existsSync(workspacePath)) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  try {
    // Get all repositories for this project
    let repos = task.projectId
      ? await RepositoryRepository.findByProjectId(task.projectId)
      : [];

    // If no repos defined, check for directories in workspace
    if (repos.length === 0) {
      const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const repoPath = path.join(workspacePath, entry.name);
          const gitPath = path.join(repoPath, '.git');
          if (fs.existsSync(gitPath)) {
            repos.push({ name: entry.name, localPath: repoPath } as any);
          }
        }
      }
    }

    // Filter to specific repos if requested
    if (repoNames && Array.isArray(repoNames) && repoNames.length > 0) {
      repos = repos.filter(r => repoNames.includes(r.name));
    }

    const results: Array<{ name: string; committed: boolean; error?: string }> = [];

    for (const repo of repos) {
      const repoPath = path.join(workspacePath, repo.name);

      if (!fs.existsSync(repoPath)) {
        results.push({ name: repo.name, committed: false, error: 'Path not found' });
        continue;
      }

      try {
        // Stage all changes
        await WorkspaceService.stageAll(repoPath);

        // Commit
        const committed = await WorkspaceService.commit(repoPath, message.trim());
        results.push({ name: repo.name, committed });

        if (committed) {
          console.log(`[Workspace] Committed to ${repo.name}: ${message.trim()}`);
        }
      } catch (error: any) {
        results.push({ name: repo.name, committed: false, error: error.message });
      }
    }

    const anyCommitted = results.some(r => r.committed);

    res.json({
      success: true,
      data: {
        committed: anyCommitted,
        results,
        message: anyCommitted
          ? `Committed to ${results.filter(r => r.committed).length} repository(ies)`
          : 'No changes to commit',
      }
    });
  } catch (error: any) {
    console.error('[Workspace] Error committing:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/:taskId/workspace/push
 * Push changes to remote
 */
router.post('/:taskId/workspace/push', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { branch, repositories: repoNames } = req.body;

  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  if (!fs.existsSync(workspacePath)) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  // Get user's GitHub token
  const githubToken = await getUserGitHubToken(userId);
  if (!githubToken) {
    return res.status(400).json({ error: 'GitHub token not available' });
  }

  try {
    // Get all repositories for this project
    let repos = task.projectId
      ? await RepositoryRepository.findByProjectId(task.projectId)
      : [];

    // If no repos defined, check for directories in workspace
    if (repos.length === 0) {
      const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const repoPath = path.join(workspacePath, entry.name);
          const gitPath = path.join(repoPath, '.git');
          if (fs.existsSync(gitPath)) {
            repos.push({ name: entry.name, localPath: repoPath } as any);
          }
        }
      }
    }

    // Filter to specific repos if requested
    if (repoNames && Array.isArray(repoNames) && repoNames.length > 0) {
      repos = repos.filter(r => repoNames.includes(r.name));
    }

    const results: Array<{ name: string; pushed: boolean; branch?: string; error?: string }> = [];

    for (const repo of repos) {
      const repoPath = path.join(workspacePath, repo.name);

      if (!fs.existsSync(repoPath)) {
        results.push({ name: repo.name, pushed: false, error: 'Path not found' });
        continue;
      }

      try {
        const repoBranch = branch || await WorkspaceService.getCurrentBranch(repoPath);
        const pushed = await WorkspaceService.pushWithToken(repoPath, githubToken, repoBranch);
        results.push({ name: repo.name, pushed, branch: repoBranch });

        if (pushed) {
          console.log(`[Workspace] Pushed ${repo.name} to ${repoBranch}`);
        }
      } catch (error: any) {
        results.push({ name: repo.name, pushed: false, error: error.message });
      }
    }

    const anyPushed = results.some(r => r.pushed);

    res.json({
      success: true,
      data: {
        pushed: anyPushed,
        results,
        branch: results.find(r => r.pushed)?.branch,
        message: anyPushed
          ? `Pushed ${results.filter(r => r.pushed).length} repository(ies)`
          : 'Nothing to push',
      }
    });
  } catch (error: any) {
    console.error('[Workspace] Error pushing:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// QUEUE ENDPOINTS
// ===========================================

/**
 * GET /api/tasks/queue/stats
 * Get queue statistics
 */
router.get('/queue/stats', async (req: Request, res: Response) => {
  try {
    const stats = await taskQueue.getStats();
    res.json({
      success: true,
      data: {
        ...stats,
        mode: 'queue',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/:taskId/queue/position
 * Get queue position for a specific task
 */
router.get('/:taskId/queue/position', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.taskId;
    const position = await taskQueue.getQueuePosition(taskId);
    const job = await taskQueue.getJob(taskId);

    if (!job) {
      return res.status(404).json({ error: 'Task not in queue' });
    }

    const state = await job.getState();
    const progress = job.progress as number;

    res.json({
      success: true,
      data: {
        taskId,
        jobId: job.id,
        position,
        state,
        progress,
        attemptsMade: job.attemptsMade,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/tasks/queue/wait-time
 * Get estimated wait time
 */
router.get('/queue/wait-time', async (req: Request, res: Response) => {
  try {
    const isPro = req.query.isPro === 'true';
    const estimatedWaitSeconds = await taskQueue.getEstimatedWaitTime(isPro);

    res.json({
      success: true,
      data: {
        isPro,
        estimatedWaitSeconds,
        estimatedWaitFormatted: formatWaitTime(estimatedWaitSeconds),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/queue/pause
 * Pause all queues (admin only)
 */
router.post('/queue/pause', async (req: Request, res: Response) => {
  // TODO: Add admin check
  try {
    await taskQueue.pauseAll();
    res.json({ success: true, message: 'All queues paused' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/tasks/queue/resume
 * Resume all queues (admin only)
 */
router.post('/queue/resume', async (req: Request, res: Response) => {
  // TODO: Add admin check
  try {
    await taskQueue.resumeAll();
    res.json({ success: true, message: 'All queues resumed' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper: Format wait time in human-readable format
 */
function formatWaitTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}

// ===========================================
// TASK EXPORT ENDPOINTS
// ===========================================

/**
 * GET /api/tasks/:taskId/export
 * Export task data as JSON or ZIP
 *
 * Query params:
 * - format: 'json' (default) | 'zip'
 * - include: comma-separated list: 'task,phases,approval,cost,diff,workspace'
 */
router.get('/:taskId/export', async (req: Request, res: Response) => {
  const task = await TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const format = (req.query.format as string) || 'json';
  const includeStr = (req.query.include as string) || 'task,phases,approval,cost';
  const includes = new Set(includeStr.split(','));

  try {
    // Import required repositories dynamically
    const { ApprovalLogRepository } = await import('../../database/repositories/ApprovalLogRepository.js');
    const { AgentExecutionRepository } = await import('../../database/repositories/AgentExecutionRepository.js');

    const exportData: Record<string, any> = {
      exportedAt: new Date().toISOString(),
      version: '2.0',
    };

    // Task metadata
    if (includes.has('task')) {
      exportData.task = {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        branchName: task.branchName,
        prNumber: task.prNumber,
        prUrl: task.prUrl,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    }

    // Phase results (analysis, stories)
    if (includes.has('phases')) {
      exportData.phases = {
        analysis: task.analysis,
        stories: task.stories,
        currentStoryIndex: task.currentStoryIndex,
      };

      // Include execution history
      const executions = await AgentExecutionRepository.findByTaskId(task.id);
      exportData.executions = executions.map(exec => ({
        id: exec.id,
        phase: exec.phase,
        status: exec.status,
        startedAt: exec.startedAt,
        completedAt: exec.completedAt,
        result: exec.result,
      }));
    }

    // Approval history
    if (includes.has('approval')) {
      const approvalLogs = await ApprovalLogRepository.getByTaskId(task.id);
      exportData.approvalHistory = approvalLogs;
    }

    // Cost data
    if (includes.has('cost')) {
      const costDetails = await costTracker.getTaskCostDetailsAsync(task.id);
      exportData.cost = costDetails;
    }

    // Diff data
    if (includes.has('diff')) {
      const workspacePath = path.join(WORKSPACES_DIR, task.id);
      if (fs.existsSync(workspacePath)) {
        const { gitService } = await import('../../services/git/GitService.js');
        const diff = await gitService.getFullDiff(workspacePath, 2000);
        const files = await gitService.getChangedFiles(workspacePath);
        exportData.diff = { content: diff, files };
      }
    }

    // Return JSON format
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="task-${task.id}-export.json"`);
      return res.json(exportData);
    }

    // ZIP format - include workspace files
    if (format === 'zip') {
      const archiver = await import('archiver').catch(() => null);
      if (!archiver) {
        return res.status(501).json({
          error: 'ZIP export not available',
          message: 'Install archiver package: npm install archiver',
        });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="task-${task.id}-export.zip"`);

      const archive = archiver.default('zip', { zlib: { level: 9 } });
      archive.pipe(res);

      // Add export data as JSON
      archive.append(JSON.stringify(exportData, null, 2), { name: 'export.json' });

      // Add workspace files if requested
      if (includes.has('workspace')) {
        const workspacePath = path.join(WORKSPACES_DIR, task.id);
        if (fs.existsSync(workspacePath)) {
          archive.directory(workspacePath, 'workspace', {
            // Exclude .git and node_modules for smaller exports
            ignore: (entryPath: string) =>
              entryPath.includes('node_modules') ||
              entryPath.includes('.git/objects'),
          });
        }
      }

      await archive.finalize();
      return;
    }

    res.status(400).json({ error: `Unknown format: ${format}` });
  } catch (error: any) {
    console.error('[Tasks] Export error:', error);
    res.status(500).json({
      error: 'Export failed',
      message: error.message,
    });
  }
});

export default router;
