/**
 * Approval Log Repository
 *
 * Stores audit trail for all approval decisions.
 * Used for compliance, debugging, and analytics.
 */

import { postgresService } from '../postgres/PostgresService.js';

// ============================================================================
// TYPES
// ============================================================================

export interface IApprovalLog {
  id: string;
  taskId: string;
  phase: string;
  action: 'approve' | 'reject' | 'timeout' | 'auto';
  userId?: string;
  clientId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface CreateApprovalLogInput {
  taskId: string;
  phase: string;
  action: 'approve' | 'reject' | 'timeout' | 'auto';
  userId?: string;
  clientId?: string;
  metadata?: Record<string, any>;
}

interface ApprovalLogRow {
  id: string;
  task_id: string;
  phase: string;
  action: string;
  user_id: string | null;
  client_id: string | null;
  metadata: Record<string, any> | null;
  created_at: Date;
}

// ============================================================================
// REPOSITORY
// ============================================================================

function mapRow(row: ApprovalLogRow): IApprovalLog {
  return {
    id: row.id,
    taskId: row.task_id,
    phase: row.phase,
    action: row.action as IApprovalLog['action'],
    userId: row.user_id || undefined,
    clientId: row.client_id || undefined,
    metadata: row.metadata || undefined,
    createdAt: new Date(row.created_at),
  };
}

export class ApprovalLogRepository {
  private static tableName = 'approval_logs';

  /**
   * Ensure table exists
   */
  static async initialize(): Promise<void> {
    try {
      await postgresService.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id VARCHAR(100) NOT NULL,
          phase VARCHAR(50) NOT NULL,
          action VARCHAR(20) NOT NULL,
          user_id VARCHAR(100),
          client_id VARCHAR(100),
          metadata JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Create indexes
      await postgresService.query(`
        CREATE INDEX IF NOT EXISTS idx_approval_logs_task_id
        ON ${this.tableName}(task_id)
      `);
      await postgresService.query(`
        CREATE INDEX IF NOT EXISTS idx_approval_logs_user_id
        ON ${this.tableName}(user_id)
      `);
      await postgresService.query(`
        CREATE INDEX IF NOT EXISTS idx_approval_logs_created_at
        ON ${this.tableName}(created_at)
      `);
    } catch (error) {
      console.warn('[ApprovalLogRepository] Table creation skipped:', error);
    }
  }

  /**
   * Log an approval decision
   */
  static async log(input: CreateApprovalLogInput): Promise<IApprovalLog | null> {
    try {
      const result = await postgresService.query<ApprovalLogRow>(
        `INSERT INTO ${this.tableName}
         (task_id, phase, action, user_id, client_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.taskId,
          input.phase,
          input.action,
          input.userId || null,
          input.clientId || null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ]
      );

      return mapRow(result.rows[0]);
    } catch (error) {
      console.error('[ApprovalLogRepository] Failed to log approval:', error);
      return null;
    }
  }

  /**
   * Get approval history for a task
   */
  static async getByTaskId(taskId: string): Promise<IApprovalLog[]> {
    try {
      const result = await postgresService.query<ApprovalLogRow>(
        `SELECT * FROM ${this.tableName}
         WHERE task_id = $1
         ORDER BY created_at ASC`,
        [taskId]
      );

      return result.rows.map(mapRow);
    } catch (error) {
      console.error('[ApprovalLogRepository] Failed to get logs:', error);
      return [];
    }
  }

  /**
   * Get approvals by user
   */
  static async getByUserId(userId: string, limit = 100): Promise<IApprovalLog[]> {
    try {
      const result = await postgresService.query<ApprovalLogRow>(
        `SELECT * FROM ${this.tableName}
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows.map(mapRow);
    } catch (error) {
      console.error('[ApprovalLogRepository] Failed to get logs by user:', error);
      return [];
    }
  }

  /**
   * Get recent approvals (for analytics)
   */
  static async getRecent(limit = 50): Promise<IApprovalLog[]> {
    try {
      const result = await postgresService.query<ApprovalLogRow>(
        `SELECT * FROM ${this.tableName}
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(mapRow);
    } catch (error) {
      console.error('[ApprovalLogRepository] Failed to get recent logs:', error);
      return [];
    }
  }

  /**
   * Get approval stats
   */
  static async getStats(since?: Date): Promise<{
    total: number;
    approved: number;
    rejected: number;
    auto: number;
    timeout: number;
    byPhase: Record<string, number>;
  }> {
    try {
      const sinceClause = since ? `WHERE created_at >= $1` : '';
      const params = since ? [since.toISOString()] : [];

      // Get counts by action
      const actionResult = await postgresService.query<{ action: string; count: number }>(
        `SELECT action, COUNT(*)::int as count
         FROM ${this.tableName}
         ${sinceClause}
         GROUP BY action`,
        params
      );

      const actionCounts: Record<string, number> = {};
      for (const row of actionResult.rows) {
        actionCounts[row.action] = row.count;
      }

      // Get counts by phase
      const phaseResult = await postgresService.query<{ phase: string; count: number }>(
        `SELECT phase, COUNT(*)::int as count
         FROM ${this.tableName}
         ${sinceClause}
         GROUP BY phase`,
        params
      );

      const byPhase: Record<string, number> = {};
      for (const row of phaseResult.rows) {
        byPhase[row.phase] = row.count;
      }

      const total = Object.values(actionCounts).reduce((a, b) => a + b, 0);

      return {
        total,
        approved: actionCounts['approve'] || 0,
        rejected: actionCounts['reject'] || 0,
        auto: actionCounts['auto'] || 0,
        timeout: actionCounts['timeout'] || 0,
        byPhase,
      };
    } catch (error) {
      console.error('[ApprovalLogRepository] Failed to get stats:', error);
      return { total: 0, approved: 0, rejected: 0, auto: 0, timeout: 0, byPhase: {} };
    }
  }
}

export default ApprovalLogRepository;
