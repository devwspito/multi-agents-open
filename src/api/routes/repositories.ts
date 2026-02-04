/**
 * Repository Routes
 *
 * GitHub repository management per project.
 * Matches agents-software-arq pattern (without workspaceId - that's per task).
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, getUserGitHubToken } from './auth.js';
import { RepositoryRepository, type IRepository, type IEnvVariable } from '../../database/repositories/RepositoryRepository.js';
import { ProjectRepository } from '../../database/repositories/ProjectRepository.js';
import { EnvService } from '../../services/env/EnvService.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/repositories/github
 * Fetch user's GitHub repositories directly from GitHub API
 * Returns raw GitHub data for selection (doesn't save to DB)
 */
router.get('/github', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const githubToken = getUserGitHubToken(userId);

  if (!githubToken) {
    return res.status(401).json({ success: false, error: 'GitHub not connected' });
  }

  try {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `Bearer ${githubToken}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch repositories');
    }

    const repos = await response.json() as any[];

    // Transform GitHub response to frontend format
    const transformed = repos.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      html_url: repo.html_url,
      clone_url: repo.clone_url,
      default_branch: repo.default_branch,
      private: repo.private,
      description: repo.description,
      language: repo.language,
      updated_at: repo.updated_at,
    }));

    res.json({ success: true, data: transformed, count: transformed.length });
  } catch (error: any) {
    console.error('[Repositories] GitHub fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch repositories' });
  }
});

/**
 * GET /api/repositories/project/:projectId
 * Get repositories for a specific project
 */
router.get('/project/:projectId', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { projectId } = req.params;

  try {
    // Verify project belongs to user
    const project = ProjectRepository.findById(projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const repos = RepositoryRepository.findByProjectId(projectId);

    const transformed = repos.map(repo => ({
      _id: repo.id,
      name: repo.name,
      description: repo.description,
      githubRepoUrl: repo.githubRepoUrl,
      githubRepoName: repo.githubRepoName,
      githubBranch: repo.githubBranch,
      type: repo.type,
      pathPatterns: repo.pathPatterns,
      executionOrder: repo.executionOrder,
      dependencies: repo.dependencies,
      isActive: repo.isActive,
      lastSyncedAt: repo.lastSyncedAt,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    }));

    res.json({ success: true, data: transformed, count: transformed.length });
  } catch (error: any) {
    console.error('[Repositories] Fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch repositories' });
  }
});

/**
 * POST /api/repositories/project/:projectId
 * Add a repository to a project
 */
router.post('/project/:projectId', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { projectId } = req.params;
  const { name, description, githubRepoUrl, githubRepoName, githubBranch, type, pathPatterns, executionOrder, dependencies } = req.body;

  try {
    // Verify project belongs to user
    const project = ProjectRepository.findById(projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (!name || !githubRepoUrl || !githubRepoName) {
      return res.status(400).json({ success: false, error: 'name, githubRepoUrl, and githubRepoName are required' });
    }

    // Get default config based on type
    const repoConfig = RepositoryRepository.getDefaultConfig(type || 'backend', name);

    const repo = RepositoryRepository.create({
      name,
      description: description || `Repository ${name}`,
      projectId,
      githubRepoUrl,
      githubRepoName,
      githubBranch: githubBranch || 'main',
      type: type || 'backend',
      pathPatterns: pathPatterns || repoConfig.pathPatterns,
      executionOrder: executionOrder ?? repoConfig.executionOrder,
      dependencies: dependencies || [],
    });

    res.status(201).json({
      success: true,
      data: {
        _id: repo.id,
        name: repo.name,
        description: repo.description,
        githubRepoUrl: repo.githubRepoUrl,
        githubRepoName: repo.githubRepoName,
        githubBranch: repo.githubBranch,
        type: repo.type,
        pathPatterns: repo.pathPatterns,
        executionOrder: repo.executionOrder,
        isActive: repo.isActive,
        createdAt: repo.createdAt,
        updatedAt: repo.updatedAt,
      },
      message: 'Repository added successfully',
    });
  } catch (error: any) {
    console.error('[Repositories] Create error:', error);
    res.status(500).json({ success: false, error: 'Failed to create repository' });
  }
});

/**
 * GET /api/repositories/:id
 * Get repository by ID
 */
router.get('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    res.json({
      success: true,
      data: {
        _id: repo.id,
        name: repo.name,
        description: repo.description,
        projectId: repo.projectId,
        githubRepoUrl: repo.githubRepoUrl,
        githubRepoName: repo.githubRepoName,
        githubBranch: repo.githubBranch,
        type: repo.type,
        pathPatterns: repo.pathPatterns,
        executionOrder: repo.executionOrder,
        dependencies: repo.dependencies,
        envVariables: repo.envVariables,
        isActive: repo.isActive,
        lastSyncedAt: repo.lastSyncedAt,
        createdAt: repo.createdAt,
        updatedAt: repo.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('[Repositories] Fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch repository' });
  }
});

/**
 * PUT /api/repositories/:id
 * Update repository
 */
router.put('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    const { name, description, githubBranch, type, pathPatterns, executionOrder, dependencies, envVariables, isActive } = req.body;

    const updated = RepositoryRepository.update(req.params.id, {
      name,
      description,
      githubBranch,
      type,
      pathPatterns,
      executionOrder,
      dependencies,
      envVariables,
      isActive,
    });

    res.json({
      success: true,
      data: {
        _id: updated!.id,
        name: updated!.name,
        description: updated!.description,
        githubRepoUrl: updated!.githubRepoUrl,
        githubRepoName: updated!.githubRepoName,
        githubBranch: updated!.githubBranch,
        type: updated!.type,
        pathPatterns: updated!.pathPatterns,
        executionOrder: updated!.executionOrder,
        dependencies: updated!.dependencies,
        isActive: updated!.isActive,
        updatedAt: updated!.updatedAt,
      },
      message: 'Repository updated successfully',
    });
  } catch (error: any) {
    console.error('[Repositories] Update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update repository' });
  }
});

/**
 * DELETE /api/repositories/:id
 * Delete repository (soft delete)
 */
router.delete('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    RepositoryRepository.delete(req.params.id);

    res.json({ success: true, message: 'Repository deleted successfully' });
  } catch (error: any) {
    console.error('[Repositories] Delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete repository' });
  }
});

/**
 * POST /api/repositories/:id/reconnect
 * Test repository access via GitHub API
 */
router.post('/:id/reconnect', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const githubToken = getUserGitHubToken(userId);

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    if (!githubToken) {
      return res.status(401).json({ success: false, error: 'GitHub not connected' });
    }

    const response = await fetch(`https://api.github.com/repos/${repo.githubRepoName}`, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });

    if (!response.ok) {
      return res.status(403).json({ success: false, error: 'Cannot access repository' });
    }

    // Update last synced time
    RepositoryRepository.updateLastSynced(repo.id);

    res.json({
      success: true,
      data: {
        connected: true,
        repository: {
          _id: repo.id,
          name: repo.name,
          githubRepoName: repo.githubRepoName,
        },
      },
    });
  } catch (error) {
    console.error('[Repositories] Reconnect error:', error);
    res.status(500).json({ success: false, error: 'Connection test failed' });
  }
});

// ===========================================
// ENVIRONMENT VARIABLES ENDPOINTS
// ===========================================

/**
 * GET /api/repositories/:id/env
 * Get environment variables for a repository (decrypted)
 */
router.get('/:id/env', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Get decrypted env variables
    const envVariables = RepositoryRepository.getDecryptedEnvVariables(req.params.id);

    res.json({
      success: true,
      data: {
        envVariables: envVariables || [],
        count: envVariables?.length || 0,
      },
    });
  } catch (error: any) {
    console.error('[Repositories] Error getting env variables:', error);
    res.status(500).json({ success: false, error: 'Failed to get environment variables' });
  }
});

/**
 * PUT /api/repositories/:id/env
 * Update environment variables for a repository
 */
router.put('/:id/env', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { envVariables } = req.body;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Validate env variables format
    const validation = EnvService.validateEnvVariables(envVariables || []);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid environment variables',
        errors: validation.errors,
      });
    }

    // Encrypt secret values before saving
    const preparedEnvVars = EnvService.prepareForStorage(envVariables || []);

    // Update repository
    RepositoryRepository.update(req.params.id, {
      envVariables: preparedEnvVars,
    });

    console.log(`[Repositories] Updated ${preparedEnvVars.length} environment variables for: ${repo.name}`);

    res.json({
      success: true,
      message: `Updated ${preparedEnvVars.length} environment variable(s)`,
      data: {
        count: preparedEnvVars.length,
      },
    });
  } catch (error: any) {
    console.error('[Repositories] Error updating env variables:', error);
    res.status(500).json({ success: false, error: 'Failed to update environment variables' });
  }
});

/**
 * DELETE /api/repositories/:id/env
 * Clear all environment variables for a repository
 */
router.delete('/:id/env', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const repo = RepositoryRepository.findById(req.params.id);

    if (!repo) {
      return res.status(404).json({ success: false, error: 'Repository not found' });
    }

    // Verify project belongs to user
    const project = ProjectRepository.findById(repo.projectId);
    if (!project || project.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Clear env variables
    RepositoryRepository.update(req.params.id, {
      envVariables: [],
    });

    console.log(`[Repositories] Cleared environment variables for: ${repo.name}`);

    res.json({
      success: true,
      message: 'Environment variables cleared',
    });
  } catch (error: any) {
    console.error('[Repositories] Error clearing env variables:', error);
    res.status(500).json({ success: false, error: 'Failed to clear environment variables' });
  }
});

export default router;

/**
 * Get repository by ID (for other modules)
 */
export function getRepository(repoId: string): IRepository | undefined {
  return RepositoryRepository.findById(repoId) || undefined;
}
