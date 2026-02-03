/**
 * Task Routes
 *
 * Task CRUD + orchestration control (pause, resume, retry, approve).
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, getUserGitHubToken } from './auth.js';
import { getProject } from './projects.js';
import { getRepository } from './repositories.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { orchestrator, ApprovalMode } from '../../orchestration/index.js';
import { openCodeClient, openCodeEventBridge } from '../../services/opencode/index.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { WorkspaceService } from '../../services/workspace/index.js';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();

const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/tmp/workspaces';

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
router.get('/', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { projectId, status } = req.query;

  let tasks = TaskRepository.findAll();

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
router.post('/', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { title, description, projectId, repositoryId } = req.body;

  if (!title || !projectId) {
    return res.status(400).json({ error: 'title and projectId required' });
  }

  const project = getProject(projectId);
  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const task = TaskRepository.create({
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
 * Get task details
 */
router.get('/:taskId', (req: Request, res: Response) => {
  const task = TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const execution = executions.get(task.id);
  res.json({
    data: {
      ...task,
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
 * DELETE /api/tasks/:taskId
 * Delete task
 */
router.delete('/:taskId', (req: Request, res: Response) => {
  const task = TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  TaskRepository.delete(req.params.taskId);
  res.json({ success: true });
});

/**
 * POST /api/tasks/:taskId/start
 * Start task orchestration
 */
router.post('/:taskId/start', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const task = TaskRepository.findById(req.params.taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const project = getProject(task.projectId!);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  // Get repository info
  const repo = task.repositoryId ? getRepository(task.repositoryId) : null;
  const githubToken = getUserGitHubToken(userId);

  // Create workspace directory
  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // Clone repository if specified
  if (repo && githubToken) {
    const repoDir = path.join(workspacePath, repo.name);
    if (!fs.existsSync(repoDir)) {
      await WorkspaceService.cloneWithToken(repo.cloneUrl, repoDir, githubToken);
    }
  }

  // Connect to OpenCode
  if (!openCodeClient.isConnected()) {
    await openCodeClient.connect();
  }

  // Create OpenCode session
  const sessionId = await openCodeClient.createSession({
    title: `Task: ${task.title}`,
  });

  // Track execution
  const execution: TaskExecution = {
    taskId: task.id,
    sessionId,
    status: 'running',
    startedAt: new Date(),
  };
  executions.set(task.id, execution);

  // Register session with event bridge for real-time activity forwarding
  openCodeEventBridge.registerSession(task.id, sessionId);

  // Update task status
  TaskRepository.updateStatus(task.id, 'running');

  // Emit to frontend
  socketService.toTask(task.id, 'task:started', { taskId: task.id, sessionId });

  // Run orchestration in background
  const pipeline = project.settings.defaultPipeline || 'full';
  const approvalMode = project.settings.approvalMode || 'manual';

  orchestrator.execute(task.id, pipeline, {
    projectPath: workspacePath,
    approvalMode: approvalMode as ApprovalMode,
    onPhaseStart: (phase) => {
      execution.currentPhase = phase;
    },
    onPhaseComplete: async (phase, result) => {
      // Commit changes after development phases
      if (['Development', 'Fixer'].includes(phase) && repo && githubToken) {
        const repoDir = path.join(workspacePath, repo.name);
        await WorkspaceService.commitAndPush(
          repoDir,
          `[${phase}] ${task.title}`,
          githubToken
        );
      }
    },
  }).then(result => {
    execution.status = result.success ? 'completed' : 'failed';
    TaskRepository.updateStatus(task.id, result.success ? 'completed' : 'failed');
    socketService.toTask(task.id, 'task:complete', { taskId: task.id, result });
    // Unregister from event bridge
    openCodeEventBridge.unregisterSession(sessionId);
  }).catch(error => {
    execution.status = 'failed';
    TaskRepository.updateStatus(task.id, 'failed');
    socketService.toTask(task.id, 'task:error', { taskId: task.id, error: error.message });
    // Unregister from event bridge
    openCodeEventBridge.unregisterSession(sessionId);
  });

  res.json({ data: { taskId: task.id, sessionId, status: 'running' } });
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

  TaskRepository.updateStatus(req.params.taskId, 'paused');
  socketService.toTask(req.params.taskId, 'task:interrupted', { taskId: req.params.taskId });

  res.json({ data: { status: 'interrupted', pausedAt: execution.pausedAt } });
});

/**
 * POST /api/tasks/:taskId/continue
 * Continue an interrupted task with a new prompt
 *
 * OpenCode SDK: session.prompt() to existing session
 */
router.post('/:taskId/continue', async (req: Request, res: Response) => {
  const execution = executions.get(req.params.taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No execution found' });
  }

  if (execution.status !== 'paused') {
    return res.status(400).json({ error: 'Task not interrupted' });
  }

  const { prompt } = req.body;
  const continuePrompt = prompt || 'Continue with the task from where you left off.';

  // Continue OpenCode session with new prompt
  await openCodeClient.sendPrompt(execution.sessionId, continuePrompt);

  execution.status = 'running';
  execution.pausedAt = undefined;

  TaskRepository.updateStatus(req.params.taskId, 'running');
  socketService.toTask(req.params.taskId, 'task:continued', { taskId: req.params.taskId });

  res.json({ data: { status: 'running' } });
});

/**
 * POST /api/tasks/:taskId/cancel
 * Cancel task execution
 */
router.post('/:taskId/cancel', async (req: Request, res: Response) => {
  const execution = executions.get(req.params.taskId);
  if (!execution) {
    return res.status(404).json({ error: 'No execution found' });
  }

  // Unregister from event bridge first
  openCodeEventBridge.unregisterSession(execution.sessionId);

  // Abort and delete OpenCode session
  await openCodeClient.abortSession(execution.sessionId);
  await openCodeClient.deleteSession(execution.sessionId);

  execution.status = 'failed';
  executions.delete(req.params.taskId);

  TaskRepository.updateStatus(req.params.taskId, 'cancelled');
  approvalService.cancelTask(req.params.taskId);
  socketService.toTask(req.params.taskId, 'task:cancelled', { taskId: req.params.taskId });

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

  TaskRepository.updateStatus(req.params.taskId, 'running');
  socketService.toTask(req.params.taskId, 'task:retrying', { taskId: req.params.taskId });

  res.json({ data: { status: 'running' } });
});

/**
 * POST /api/tasks/:taskId/approve/:phase
 * Approve a phase (for manual approval mode)
 */
router.post('/:taskId/approve/:phase', (req: Request, res: Response) => {
  const { taskId, phase } = req.params;

  socketService.toTask(taskId, 'phase:approve', { taskId, phase });

  res.json({ data: { approved: true, phase } });
});

/**
 * POST /api/tasks/:taskId/reject/:phase
 * Reject a phase
 */
router.post('/:taskId/reject/:phase', (req: Request, res: Response) => {
  const { taskId, phase } = req.params;
  const { reason } = req.body;

  socketService.toTask(taskId, 'phase:reject', { taskId, phase, reason });

  res.json({ data: { rejected: true, phase, reason } });
});

/**
 * GET /api/tasks/:taskId/status
 * Get task execution status
 */
router.get('/:taskId/status', (req: Request, res: Response) => {
  const task = TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const execution = executions.get(req.params.taskId);

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
    },
  });
});

export default router;
