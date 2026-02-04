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
import { RepositoryRepository } from '../../database/repositories/RepositoryRepository.js';
import { orchestrator, ApprovalMode } from '../../orchestration/index.js';
import { openCodeClient, openCodeEventBridge } from '../../services/opencode/index.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { WorkspaceService } from '../../services/workspace/index.js';
import { EnvService } from '../../services/env/EnvService.js';
import { RepositoryInfo } from '../../types/index.js';
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

  let task = TaskRepository.findById(req.params.taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Save the user's prompt as the task description
  task = TaskRepository.update(task.id, { description: prompt.trim() })!;

  const project = getProject(task.projectId!);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const githubToken = getUserGitHubToken(userId);

  // Create workspace directory
  const workspacePath = path.join(WORKSPACES_DIR, task.id);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // Get ALL repositories for this project
  const allRepos = RepositoryRepository.findByProjectId(task.projectId!);
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
    const repo = getRepository(task.repositoryId);
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

  // Validate pipeline exists BEFORE starting (Fix #2: avoid race condition)
  const pipelineName = project.settings?.defaultPipeline || 'full';
  const pipelineExists = orchestrator.getPipeline(pipelineName);
  if (!pipelineExists) {
    return res.status(400).json({
      error: `Pipeline '${pipelineName}' not found. Available: ${orchestrator.getAllPipelines().map(p => p.name).join(', ') || 'none'}`,
    });
  }

  // Track execution (sessionId will be updated by phases via callback)
  const execution: TaskExecution = {
    taskId: task.id,
    sessionId: '', // Will be set by onSessionCreated callback
    status: 'running',
    startedAt: new Date(),
  };
  executions.set(task.id, execution);

  // Update task status
  TaskRepository.updateStatus(task.id, 'running');

  // Emit to frontend
  socketService.toTask(task.id, 'task:started', { taskId: task.id });

  // Run orchestration in background
  const approvalMode = project.settings?.approvalMode || 'manual';

  orchestrator.execute(task.id, pipelineName, {
    projectPath: workspacePath,
    repositories,
    approvalMode: approvalMode as ApprovalMode,
    // Fix #1: Capture sessionId from phases
    onSessionCreated: (sessionId, phaseName) => {
      console.log(`[Tasks] Session created for phase ${phaseName}: ${sessionId}`);
      execution.sessionId = sessionId; // Update with latest session
    },
    onPhaseStart: (phase) => {
      execution.currentPhase = phase;
    },
    onPhaseComplete: async (phase, result) => {
      // Fix #3: Only commit repos that have actual changes
      if (['Development', 'Fixer'].includes(phase) && githubToken && repositories.length > 0) {
        const filesModified: string[] = result.output?.filesModified || [];

        for (const repo of repositories) {
          // Check if any modified files belong to this repo
          const repoHasChanges = filesModified.some(f => f.startsWith(repo.localPath));

          if (!repoHasChanges) {
            console.log(`[Tasks] Skipping commit for ${repo.name} - no changes`);
            continue;
          }

          try {
            await WorkspaceService.commitAndPush(
              repo.localPath,
              `[${phase}] ${task.title}`,
              githubToken
            );
            console.log(`[Tasks] Committed changes to ${repo.name}`);
          } catch (err: any) {
            // Only warn if it's not a "nothing to commit" error
            if (!err.message.includes('nothing to commit')) {
              console.warn(`[Tasks] Commit to ${repo.name} failed: ${err.message}`);
            }
          }
        }
      }
    },
  }).then(result => {
    execution.status = result.success ? 'completed' : 'failed';
    TaskRepository.updateStatus(task.id, result.success ? 'completed' : 'failed');
    socketService.toTask(task.id, 'task:complete', { taskId: task.id, result });
  }).catch(error => {
    execution.status = 'failed';
    TaskRepository.updateStatus(task.id, 'failed');
    socketService.toTask(task.id, 'task:error', { taskId: task.id, error: error.message });
  });

  res.json({ data: { taskId: task.id, status: 'running' } });
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

// ===========================================
// WORKSPACE ENDPOINTS
// ===========================================

/**
 * GET /api/tasks/:taskId/workspace/files
 * List all files in the task's workspace
 */
router.get('/:taskId/workspace/files', async (req: Request, res: Response) => {
  const task = TaskRepository.findById(req.params.taskId);
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
  const task = TaskRepository.findById(req.params.taskId);
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
 * Get git changes in workspace
 */
router.get('/:taskId/workspace/changes', async (req: Request, res: Response) => {
  const task = TaskRepository.findById(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const workspacePath = path.join(WORKSPACES_DIR, task.id);

  if (!fs.existsSync(workspacePath)) {
    return res.json({ success: true, data: { hasChanges: false, files: [] } });
  }

  try {
    const changes = await WorkspaceService.getChanges(workspacePath);
    res.json({ success: true, data: changes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
