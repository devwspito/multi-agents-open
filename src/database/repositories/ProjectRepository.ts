/**
 * Project Repository
 *
 * Database operations for projects (PostgreSQL)
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface IProject {
  id: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  userId: string;
  apiKey?: string;
  settings?: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  user_id: string;
  api_key: string | null;
  settings: Record<string, any> | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToProject(row: ProjectRow): IProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    type: row.type,
    status: row.status,
    userId: row.user_id,
    apiKey: row.api_key || undefined,
    settings: row.settings || undefined,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  /**
   * Find project by ID
   */
  static async findById(id: string, includeApiKey = false): Promise<IProject | null> {
    const result = await postgresService.query<ProjectRow>(
      'SELECT * FROM projects WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;

    const project = rowToProject(row);
    if (!includeApiKey) {
      delete project.apiKey;
    }
    return project;
  }

  /**
   * Find all projects for a user
   */
  static async findByUserId(userId: string): Promise<IProject[]> {
    const result = await postgresService.query<ProjectRow>(
      'SELECT * FROM projects WHERE user_id = $1 AND is_active = true ORDER BY updated_at DESC',
      [userId]
    );
    return result.rows.map(rowToProject);
  }

  /**
   * Create a new project
   */
  static async create(data: {
    name: string;
    description?: string;
    type?: string;
    userId: string;
    apiKey?: string;
    settings?: Record<string, any>;
  }): Promise<IProject> {
    const id = generateId();

    await postgresService.query(
      `INSERT INTO projects (
        id, name, description, type, status, user_id,
        api_key, settings, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        data.name,
        data.description || null,
        data.type || 'web-app',
        'planning',
        data.userId,
        data.apiKey || null,
        JSON.stringify(data.settings || {}),
        true,
      ]
    );

    const project = await this.findById(id);
    return project!;
  }

  /**
   * Update project
   */
  static async update(id: string, data: Partial<{
    name: string;
    description: string;
    type: string;
    status: string;
    apiKey: string;
    settings: Record<string, any>;
    isActive: boolean;
  }>): Promise<IProject | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    await postgresService.query(
      `UPDATE projects SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        type = COALESCE($3, type),
        status = COALESCE($4, status),
        api_key = COALESCE($5, api_key),
        settings = COALESCE($6, settings),
        is_active = COALESCE($7, is_active),
        updated_at = NOW()
      WHERE id = $8`,
      [
        data.name || null,
        data.description || null,
        data.type || null,
        data.status || null,
        data.apiKey || null,
        data.settings ? JSON.stringify(data.settings) : null,
        data.isActive !== undefined ? data.isActive : null,
        id,
      ]
    );

    return this.findById(id);
  }

  /**
   * Delete project (soft delete)
   */
  static async delete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'UPDATE projects SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Hard delete project
   */
  static async hardDelete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM projects WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get project settings
   */
  static async getSettings(id: string): Promise<Record<string, any> | null> {
    const project = await this.findById(id);
    return project?.settings || null;
  }

  /**
   * Update project settings (merge)
   */
  static async updateSettings(id: string, settings: Record<string, any>): Promise<IProject | null> {
    const project = await this.findById(id);
    if (!project) return null;

    const mergedSettings = { ...project.settings, ...settings };
    return this.update(id, { settings: mergedSettings });
  }
}

export default ProjectRepository;
