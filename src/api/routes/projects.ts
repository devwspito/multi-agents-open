/**
 * Project Routes
 *
 * CRUD for projects.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from './auth.js';
import { v4 as uuid } from 'uuid';

const router = Router();

interface Project {
  id: string;
  userId: string;
  name: string;
  description?: string;
  repositories: string[]; // repository IDs
  settings: {
    approvalMode: 'manual' | 'automatic';
    defaultPipeline: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

// In-memory store (replace with DB)
const projects = new Map<string, Project>();

// Apply auth to all routes
router.use(authMiddleware);

/**
 * GET /api/projects
 * List all projects for user
 */
router.get('/', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const userProjects = Array.from(projects.values())
    .filter(p => p.userId === userId)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  res.json({ data: userProjects });
});

/**
 * POST /api/projects
 * Create new project
 */
router.post('/', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  const project: Project = {
    id: uuid(),
    userId,
    name,
    description,
    repositories: [],
    settings: {
      approvalMode: 'manual',
      defaultPipeline: 'full',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  projects.set(project.id, project);
  res.status(201).json({ data: project });
});

/**
 * GET /api/projects/:id
 * Get project by ID
 */
router.get('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.id);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json({ data: project });
});

/**
 * PUT /api/projects/:id
 * Update project
 */
router.put('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.id);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { name, description } = req.body;
  if (name) project.name = name;
  if (description !== undefined) project.description = description;
  project.updatedAt = new Date();

  res.json({ data: project });
});

/**
 * DELETE /api/projects/:id
 * Delete project
 */
router.delete('/:id', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.id);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  projects.delete(req.params.id);
  res.json({ success: true });
});

/**
 * POST /api/projects/:projectId/repositories
 * Add repositories to project
 */
router.post('/:projectId/repositories', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.projectId);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { repositoryIds } = req.body;
  if (!Array.isArray(repositoryIds)) {
    return res.status(400).json({ error: 'repositoryIds array required' });
  }

  project.repositories = [...new Set([...project.repositories, ...repositoryIds])];
  project.updatedAt = new Date();

  res.json({ data: project });
});

/**
 * GET /api/projects/:projectId/settings
 * Get project settings
 */
router.get('/:projectId/settings', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.projectId);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  res.json({ data: project.settings });
});

/**
 * PATCH /api/projects/:projectId/settings
 * Update project settings
 */
router.patch('/:projectId/settings', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const project = projects.get(req.params.projectId);

  if (!project || project.userId !== userId) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { approvalMode, defaultPipeline } = req.body;
  if (approvalMode) project.settings.approvalMode = approvalMode;
  if (defaultPipeline) project.settings.defaultPipeline = defaultPipeline;
  project.updatedAt = new Date();

  res.json({ data: project.settings });
});

export default router;

// Export for other routes
export function getProject(projectId: string): Project | undefined {
  return projects.get(projectId);
}
