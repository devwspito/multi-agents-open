/**
 * Agent Execution Repository
 *
 * Tracks agent executions for:
 * - ML training data collection
 * - Cost tracking
 * - Performance monitoring
 *
 * PostgreSQL implementation.
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

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

interface AgentExecutionRow {
  id: string;
  task_id: string;
  agent_type: string;
  model_id: string;
  phase_name: string | null;
  prompt: string;
  final_output: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns_completed: number;
  duration_ms: number | null;
  error_message: string | null;
  error_type: string | null;
  started_at: Date;
  completed_at: Date | null;
}

function mapRow(row: AgentExecutionRow): IAgentExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    agentType: row.agent_type,
    modelId: row.model_id,
    phaseName: row.phase_name || undefined,
    prompt: row.prompt,
    finalOutput: row.final_output || undefined,
    status: row.status as 'running' | 'completed' | 'failed',
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    costUsd: row.cost_usd || 0,
    turnsCompleted: row.turns_completed || 0,
    durationMs: row.duration_ms || undefined,
    errorMessage: row.error_message || undefined,
    errorType: row.error_type || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

export class AgentExecutionRepository {
  /**
   * Create a new execution record
   */
  static async create(params: {
    taskId: string;
    agentType: string;
    modelId: string;
    phaseName?: string;
    prompt: string;
  }): Promise<IAgentExecution> {
    const id = generateId();

    await postgresService.query(
      `INSERT INTO agent_executions (id, task_id, agent_type, model_id, phase_name, prompt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, params.taskId, params.agentType, params.modelId, params.phaseName || null, params.prompt]
    );

    const execution = await this.findById(id);
    return execution!;
  }

  /**
   * Complete an execution successfully
   */
  static async complete(id: string, params: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turnsCompleted: number;
  }): Promise<void> {
    const existing = await this.findById(id);
    const durationMs = existing?.startedAt ? Date.now() - existing.startedAt.getTime() : undefined;

    await postgresService.query(
      `UPDATE agent_executions
       SET final_output = $1, status = 'completed', input_tokens = $2, output_tokens = $3,
           cost_usd = $4, turns_completed = $5, duration_ms = $6, completed_at = NOW()
       WHERE id = $7`,
      [params.finalOutput || null, params.inputTokens, params.outputTokens, params.costUsd, params.turnsCompleted, durationMs || null, id]
    );
  }

  /**
   * Mark execution as failed
   */
  static async fail(id: string, errorMessage: string, errorType?: string): Promise<void> {
    await postgresService.query(
      `UPDATE agent_executions
       SET status = 'failed', error_message = $1, error_type = $2, completed_at = NOW()
       WHERE id = $3`,
      [errorMessage, errorType || null, id]
    );
  }

  /**
   * Update execution progress
   */
  static async updateProgress(id: string, turnsCompleted: number): Promise<void> {
    await postgresService.query(
      `UPDATE agent_executions SET turns_completed = $1 WHERE id = $2`,
      [turnsCompleted, id]
    );
  }

  /**
   * Find execution by ID
   */
  static async findById(id: string): Promise<IAgentExecution | null> {
    const result = await postgresService.query<AgentExecutionRow>(
      `SELECT * FROM agent_executions WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Find all executions for a task
   */
  static async findByTaskId(taskId: string): Promise<IAgentExecution[]> {
    const result = await postgresService.query<AgentExecutionRow>(
      `SELECT * FROM agent_executions WHERE task_id = $1 ORDER BY started_at ASC`,
      [taskId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Get execution statistics for a task
   */
  static async getStats(taskId: string): Promise<{
    totalExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    totalCost: number;
    totalTokens: number;
  }> {
    const result = await postgresService.query<{
      total: string;
      completed: string;
      failed: string;
      total_cost: string;
      total_tokens: string;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM agent_executions WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];

    return {
      totalExecutions: parseInt(row.total, 10) || 0,
      completedExecutions: parseInt(row.completed, 10) || 0,
      failedExecutions: parseInt(row.failed, 10) || 0,
      totalCost: parseFloat(row.total_cost) || 0,
      totalTokens: parseInt(row.total_tokens, 10) || 0,
    };
  }

  /**
   * Find executions for training export
   */
  static async findForTraining(options: {
    startDate?: string;
    endDate?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<IAgentExecution[]> {
    let query = `SELECT * FROM agent_executions WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (options.startDate) {
      query += ` AND started_at >= $${paramIndex}`;
      params.push(options.startDate);
      paramIndex++;
    }
    if (options.endDate) {
      query += ` AND started_at <= $${paramIndex}`;
      params.push(options.endDate);
      paramIndex++;
    }
    if (options.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }

    query += ` ORDER BY started_at ASC`;

    if (options.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }
    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await postgresService.query<AgentExecutionRow>(query, params);
    return result.rows.map(mapRow);
  }
}
