/**
 * Session Repository
 *
 * Manages OpenCode sessions with approval modes and permissions.
 * Stores session state in PostgreSQL for persistence across restarts.
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Approval modes:
 * - manual: Requires user approval for each permission request
 * - work: Auto-approve all OpenCode tool permissions (edit, bash, etc.)
 * - all: Auto-approve OpenCode + auto-approve all orchestration phases
 */
export type ApprovalMode = 'manual' | 'work' | 'all';

/**
 * Permission settings for OpenCode
 */
export interface PermissionSettings {
  edit: 'ask' | 'allow' | 'deny';
  bash: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
  webfetch: 'ask' | 'allow' | 'deny';
  doom_loop?: 'ask' | 'allow' | 'deny';
  external_directory?: 'ask' | 'allow' | 'deny';
}

export interface IOpenCodeSession {
  id: string;
  sessionId: string;
  taskId: string;
  directory: string;
  phaseName?: string;
  approvalMode: ApprovalMode;
  permissions: PermissionSettings;
  status: 'active' | 'completed' | 'error' | 'paused';
  pendingPermissionId?: string;
  pendingPermissionData?: any;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRow {
  id: string;
  session_id: string;
  task_id: string;
  directory: string;
  phase_name: string | null;
  approval_mode: string;
  permissions: PermissionSettings;
  status: string;
  pending_permission_id: string | null;
  pending_permission_data: any;
  created_at: Date;
  updated_at: Date;
}

function rowToSession(row: SessionRow): IOpenCodeSession {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    directory: row.directory,
    phaseName: row.phase_name || undefined,
    approvalMode: row.approval_mode as ApprovalMode,
    permissions: row.permissions,
    status: row.status as IOpenCodeSession['status'],
    pendingPermissionId: row.pending_permission_id || undefined,
    pendingPermissionData: row.pending_permission_data || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionRepository {
  /**
   * Create a new OpenCode session record
   */
  static async create(data: {
    sessionId: string;
    taskId: string;
    directory: string;
    phaseName?: string;
    approvalMode?: ApprovalMode;
    permissions?: Partial<PermissionSettings>;
  }): Promise<IOpenCodeSession> {
    const id = generateId();
    const approvalMode = data.approvalMode || 'manual';

    // Default permissions based on approval mode
    const defaultPermissions: PermissionSettings = {
      edit: approvalMode === 'work' || approvalMode === 'all' ? 'allow' : 'ask',
      bash: approvalMode === 'work' || approvalMode === 'all' ? 'allow' : 'ask',
      webfetch: approvalMode === 'work' || approvalMode === 'all' ? 'allow' : 'ask',
    };

    const permissions = { ...defaultPermissions, ...data.permissions };

    await postgresService.query(
      `INSERT INTO opencode_sessions (
        id, session_id, task_id, directory, phase_name,
        approval_mode, permissions, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        data.sessionId,
        data.taskId,
        data.directory,
        data.phaseName || null,
        approvalMode,
        JSON.stringify(permissions),
        'active',
      ]
    );

    const session = await this.findById(id);
    return session!;
  }

  /**
   * Find session by internal ID
   */
  static async findById(id: string): Promise<IOpenCodeSession | null> {
    const result = await postgresService.query<SessionRow>(
      'SELECT * FROM opencode_sessions WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? rowToSession(row) : null;
  }

  /**
   * Find session by OpenCode session ID
   */
  static async findBySessionId(sessionId: string): Promise<IOpenCodeSession | null> {
    const result = await postgresService.query<SessionRow>(
      'SELECT * FROM opencode_sessions WHERE session_id = $1',
      [sessionId]
    );
    const row = result.rows[0];
    return row ? rowToSession(row) : null;
  }

  /**
   * Find all sessions for a task
   */
  static async findByTaskId(taskId: string): Promise<IOpenCodeSession[]> {
    const result = await postgresService.query<SessionRow>(
      'SELECT * FROM opencode_sessions WHERE task_id = $1 ORDER BY created_at DESC',
      [taskId]
    );
    return result.rows.map(rowToSession);
  }

  /**
   * Find active session for a task
   */
  static async findActiveByTaskId(taskId: string): Promise<IOpenCodeSession | null> {
    const result = await postgresService.query<SessionRow>(
      `SELECT * FROM opencode_sessions
       WHERE task_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? rowToSession(row) : null;
  }

  /**
   * Update approval mode for a session
   */
  static async updateApprovalMode(sessionId: string, mode: ApprovalMode): Promise<IOpenCodeSession | null> {
    // Update permissions based on mode
    const permissions: PermissionSettings = {
      edit: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
      bash: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
      webfetch: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
    };

    await postgresService.query(
      `UPDATE opencode_sessions
       SET approval_mode = $1, permissions = $2, updated_at = NOW()
       WHERE session_id = $3`,
      [mode, JSON.stringify(permissions), sessionId]
    );

    return this.findBySessionId(sessionId);
  }

  /**
   * Update approval mode for all active sessions of a task
   */
  static async updateApprovalModeByTaskId(taskId: string, mode: ApprovalMode): Promise<number> {
    const permissions: PermissionSettings = {
      edit: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
      bash: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
      webfetch: mode === 'work' || mode === 'all' ? 'allow' : 'ask',
    };

    const result = await postgresService.query(
      `UPDATE opencode_sessions
       SET approval_mode = $1, permissions = $2, updated_at = NOW()
       WHERE task_id = $3 AND status = 'active'`,
      [mode, JSON.stringify(permissions), taskId]
    );

    return result.rowCount || 0;
  }

  /**
   * Update permissions for a session
   */
  static async updatePermissions(sessionId: string, permissions: Partial<PermissionSettings>): Promise<IOpenCodeSession | null> {
    const existing = await this.findBySessionId(sessionId);
    if (!existing) return null;

    const mergedPermissions = { ...existing.permissions, ...permissions };

    await postgresService.query(
      `UPDATE opencode_sessions
       SET permissions = $1, updated_at = NOW()
       WHERE session_id = $2`,
      [JSON.stringify(mergedPermissions), sessionId]
    );

    return this.findBySessionId(sessionId);
  }

  /**
   * Set pending permission request
   */
  static async setPendingPermission(sessionId: string, permissionId: string, data: any): Promise<void> {
    await postgresService.query(
      `UPDATE opencode_sessions
       SET pending_permission_id = $1, pending_permission_data = $2, updated_at = NOW()
       WHERE session_id = $3`,
      [permissionId, JSON.stringify(data), sessionId]
    );
  }

  /**
   * Clear pending permission
   */
  static async clearPendingPermission(sessionId: string): Promise<void> {
    await postgresService.query(
      `UPDATE opencode_sessions
       SET pending_permission_id = NULL, pending_permission_data = NULL, updated_at = NOW()
       WHERE session_id = $1`,
      [sessionId]
    );
  }

  /**
   * Update session status
   */
  static async updateStatus(sessionId: string, status: IOpenCodeSession['status']): Promise<void> {
    await postgresService.query(
      `UPDATE opencode_sessions SET status = $1, updated_at = NOW() WHERE session_id = $2`,
      [status, sessionId]
    );
  }

  /**
   * Delete session
   */
  static async delete(sessionId: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM opencode_sessions WHERE session_id = $1',
      [sessionId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get all active sessions
   */
  static async findAllActive(): Promise<IOpenCodeSession[]> {
    const result = await postgresService.query<SessionRow>(
      `SELECT * FROM opencode_sessions WHERE status = 'active' ORDER BY created_at DESC`
    );
    return result.rows.map(rowToSession);
  }

  /**
   * Clean up stale sessions (mark as error)
   */
  static async cleanupStale(): Promise<number> {
    const result = await postgresService.query(
      `UPDATE opencode_sessions
       SET status = 'error', updated_at = NOW()
       WHERE status = 'active' AND updated_at < NOW() - INTERVAL '1 hour'`
    );
    return result.rowCount || 0;
  }
}

export default SessionRepository;
