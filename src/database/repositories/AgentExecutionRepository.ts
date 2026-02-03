/**
 * Agent Execution Repository
 *
 * Tracks agent executions for:
 * - ML training data collection
 * - Cost tracking
 * - Performance monitoring
 */

import { db, generateId } from '../index.js';

export interface IAgentExecution {
  id: string;
  taskId: string;
  agentType: string;
  modelId: string;
  phaseName?: string;
  prompt: string;
  finalOutput?: string;
  status: 'running' | 'completed' | 'failed';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turnsCompleted: number;
  durationMs?: number;
  errorMessage?: string;
  errorType?: string;
  startedAt: Date;
  completedAt?: Date;
}

export class AgentExecutionRepository {
  /**
   * Create a new execution record
   */
  static create(params: {
    taskId: string;
    agentType: string;
    modelId: string;
    phaseName?: string;
    prompt: string;
  }): IAgentExecution {
    const id = generateId();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO agent_executions (id, task_id, agent_type, model_id, phase_name, prompt, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, params.taskId, params.agentType, params.modelId, params.phaseName, params.prompt, now);

    return {
      id,
      taskId: params.taskId,
      agentType: params.agentType,
      modelId: params.modelId,
      phaseName: params.phaseName,
      prompt: params.prompt,
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turnsCompleted: 0,
      startedAt: new Date(now),
    };
  }

  /**
   * Complete an execution successfully
   */
  static complete(id: string, params: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turnsCompleted: number;
  }): void {
    const now = new Date().toISOString();
    const startedAt = this.findById(id)?.startedAt;
    const durationMs = startedAt ? Date.now() - startedAt.getTime() : undefined;

    const stmt = db.prepare(`
      UPDATE agent_executions
      SET final_output = ?, status = 'completed', input_tokens = ?, output_tokens = ?,
          cost_usd = ?, turns_completed = ?, duration_ms = ?, completed_at = ?
      WHERE id = ?
    `);

    stmt.run(
      params.finalOutput,
      params.inputTokens,
      params.outputTokens,
      params.costUsd,
      params.turnsCompleted,
      durationMs,
      now,
      id
    );
  }

  /**
   * Mark execution as failed
   */
  static fail(id: string, errorMessage: string, errorType?: string): void {
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE agent_executions
      SET status = 'failed', error_message = ?, error_type = ?, completed_at = ?
      WHERE id = ?
    `);

    stmt.run(errorMessage, errorType, now, id);
  }

  /**
   * Update execution progress
   */
  static updateProgress(id: string, turnsCompleted: number): void {
    const stmt = db.prepare(`
      UPDATE agent_executions SET turns_completed = ? WHERE id = ?
    `);
    stmt.run(turnsCompleted, id);
  }

  /**
   * Find execution by ID
   */
  static findById(id: string): IAgentExecution | null {
    const stmt = db.prepare(`SELECT * FROM agent_executions WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find all executions for a task
   */
  static findByTaskId(taskId: string): IAgentExecution[] {
    const stmt = db.prepare(`
      SELECT * FROM agent_executions WHERE task_id = ? ORDER BY started_at ASC
    `);
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Get execution statistics for a task
   */
  static getStats(taskId: string): {
    totalExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    totalCost: number;
    totalTokens: number;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(cost_usd) as total_cost,
        SUM(input_tokens + output_tokens) as total_tokens
      FROM agent_executions WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as any;

    return {
      totalExecutions: row.total || 0,
      completedExecutions: row.completed || 0,
      failedExecutions: row.failed || 0,
      totalCost: row.total_cost || 0,
      totalTokens: row.total_tokens || 0,
    };
  }

  /**
   * Find executions for training export
   */
  static findForTraining(options: {
    startDate?: string;
    endDate?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): IAgentExecution[] {
    let query = `SELECT * FROM agent_executions WHERE 1=1`;
    const params: any[] = [];

    if (options.startDate) {
      query += ` AND started_at >= ?`;
      params.push(options.startDate);
    }
    if (options.endDate) {
      query += ` AND started_at <= ?`;
      params.push(options.endDate);
    }
    if (options.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }

    query += ` ORDER BY started_at ASC`;

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

  private static mapRow(row: any): IAgentExecution {
    return {
      id: row.id,
      taskId: row.task_id,
      agentType: row.agent_type,
      modelId: row.model_id,
      phaseName: row.phase_name,
      prompt: row.prompt,
      finalOutput: row.final_output,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      turnsCompleted: row.turns_completed,
      durationMs: row.duration_ms,
      errorMessage: row.error_message,
      errorType: row.error_type,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
}
