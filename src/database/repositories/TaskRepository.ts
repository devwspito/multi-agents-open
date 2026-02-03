/**
 * Task Repository
 *
 * Manages orchestration tasks
 */

import { db, generateId } from '../index.js';
import { Task, TaskStatus } from '../../types/index.js';

export interface CreateTaskParams {
  projectId?: string;
  repositoryId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
}

export interface UpdateTaskParams {
  title?: string;
  description?: string;
  status?: TaskStatus;
}

export class TaskRepository {
  /**
   * Create a new task
   */
  static create(params: CreateTaskParams): Task {
    const id = generateId();
    const now = new Date().toISOString();
    const status = params.status || 'pending';

    const stmt = db.prepare(`
      INSERT INTO tasks (id, project_id, repository_id, title, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, params.projectId, params.repositoryId, params.title, params.description, status, now, now);

    return {
      id,
      projectId: params.projectId,
      repositoryId: params.repositoryId,
      title: params.title,
      description: params.description,
      status,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  /**
   * Find task by ID
   */
  static findById(id: string): Task | null {
    const stmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find all tasks
   */
  static findAll(options: {
    projectId?: string;
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  } = {}): Task[] {
    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params: any[] = [];

    if (options.projectId) {
      query += ` AND project_id = ?`;
      params.push(options.projectId);
    }

    if (options.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }

    query += ` ORDER BY created_at DESC`;

    if (options.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options.offset) {
      query += ` OFFSET ?`;
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Update task
   */
  static update(id: string, params: UpdateTaskParams): Task | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (params.title !== undefined) {
      updates.push('title = ?');
      values.push(params.title);
    }

    if (params.description !== undefined) {
      updates.push('description = ?');
      values.push(params.description);
    }

    if (params.status !== undefined) {
      updates.push('status = ?');
      values.push(params.status);
    }

    values.push(id);

    const stmt = db.prepare(`
      UPDATE tasks SET ${updates.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);
    return this.findById(id);
  }

  /**
   * Update task status
   */
  static updateStatus(id: string, status: TaskStatus): void {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(status, now, id);
  }

  /**
   * Delete task
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get task statistics
   */
  static getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `);
    const row = stmt.get() as any;

    return {
      total: row.total || 0,
      pending: row.pending || 0,
      running: row.running || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
    };
  }

  private static mapRow(row: any): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      repositoryId: row.repository_id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
