/**
 * Repository Routes
 *
 * GitHub repository management.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, getUserGitHubToken } from './auth.js';
import { v4 as uuid } from 'uuid';

const router = Router();

interface Repository {
  id: string;
  userId: string;
  githubId: number;
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  description?: string;
}

// In-memory store
const repositories = new Map<string, Repository>();

router.use(authMiddleware);

/**
 * GET /api/repositories/github
 * Get user's GitHub repositories
 */
router.get('/github', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const githubToken = getUserGitHubToken(userId);

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  try {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `Bearer ${githubToken}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch repositories');
    }

    const repos = await response.json() as any[];

    // Transform and cache repos
    const transformed = repos.map(repo => {
      const repoData: Repository = {
        id: `repo_${repo.id}`,
        userId,
        githubId: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch,
        private: repo.private,
        description: repo.description,
      };
      repositories.set(repoData.id, repoData);
      return repoData;
    });

    res.json({ data: transformed });
  } catch (error: any) {
    console.error('[Repositories] GitHub fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

/**
 * GET /api/repositories/:id
 * Get repository by ID
 */
router.get('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const repo = repositories.get(req.params.id);

  if (!repo || repo.userId !== userId) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  res.json({ data: repo });
});

/**
 * POST /api/projects/:projectId/repositories/:repositoryId/reconnect
 * Test repository access
 */
router.post('/:repositoryId/reconnect', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const repo = repositories.get(req.params.repositoryId);
  const githubToken = getUserGitHubToken(userId);

  if (!repo || repo.userId !== userId) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  try {
    // Test access
    const response = await fetch(`https://api.github.com/repos/${repo.fullName}`, {
      headers: { Authorization: `Bearer ${githubToken}` },
    });

    if (!response.ok) {
      return res.status(403).json({ error: 'Cannot access repository' });
    }

    res.json({ data: { connected: true, repository: repo } });
  } catch (error) {
    res.status(500).json({ error: 'Connection test failed' });
  }
});

export default router;

// Export for other modules
export function getRepository(repoId: string): Repository | undefined {
  return repositories.get(repoId);
}
