/**
 * Tool Call Repository
 *
 * Granular tracking of every tool call for ML training.
 * PostgreSQL implementation.
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface IToolCall {
  id: string;
  executionId: string;
  turnId: string;
  taskId: string;
  toolName: string;
  toolUseId?: string;
  toolInput: any;
  toolInputSummary?: string;
  toolOutput?: string;
  toolSuccess: boolean;
  toolError?: string;
  filePath?: string;
  bashCommand?: string;
  bashExitCode?: number;
  durationMs?: number;
  callOrder: number;
  startedAt: Date;
  completedAt?: Date;
}

interface ToolCallRow {
  id: string;
  execution_id: string;
  turn_id: string;
  task_id: string;
  tool_name: string;
  tool_use_id: string | null;
  tool_input: string;
  tool_input_summary: string | null;
  tool_output: string | null;
  tool_success: boolean;
  tool_error: string | null;
  file_path: string | null;
  bash_command: string | null;
  bash_exit_code: number | null;
  duration_ms: number | null;
  call_order: number;
  started_at: Date;
  completed_at: Date | null;
}

function mapRow(row: ToolCallRow): IToolCall {
  let toolInput: any;
  try {
    toolInput = JSON.parse(row.tool_input);
  } catch {
    toolInput = row.tool_input;
  }

  return {
    id: row.id,
    executionId: row.execution_id,
    turnId: row.turn_id,
    taskId: row.task_id,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id || undefined,
    toolInput,
    toolInputSummary: row.tool_input_summary || undefined,
    toolOutput: row.tool_output || undefined,
    toolSuccess: row.tool_success,
    toolError: row.tool_error || undefined,
    filePath: row.file_path || undefined,
    bashCommand: row.bash_command || undefined,
    bashExitCode: row.bash_exit_code || undefined,
    durationMs: row.duration_ms || undefined,
    callOrder: row.call_order || 0,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

export class ToolCallRepository {
  /**
   * Create a new tool call record
   */
  static async create(params: {
    executionId: string;
    turnId: string;
    taskId: string;
    toolName: string;
    toolUseId?: string;
    toolInput: any;
    callOrder: number;
  }): Promise<IToolCall> {
    const id = generateId();

    // Create input summary for large inputs
    const inputStr = JSON.stringify(params.toolInput);
    const inputSummary = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;

    // Extract file path and bash command from input
    const filePath = params.toolInput?.file_path || params.toolInput?.path || null;
    const bashCommand = params.toolName === 'Bash' ? params.toolInput?.command : null;

    await postgresService.query(
      `INSERT INTO tool_calls (
        id, execution_id, turn_id, task_id, tool_name, tool_use_id,
        tool_input, tool_input_summary, file_path, bash_command, call_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, params.executionId, params.turnId, params.taskId, params.toolName, params.toolUseId || null, inputStr, inputSummary, filePath, bashCommand, params.callOrder]
    );

    const toolCall = await this.findById(id);
    return toolCall!;
  }

  /**
   * Complete a tool call with result
   */
  static async complete(id: string, params: {
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): Promise<void> {
    const existing = await this.findById(id);
    const durationMs = existing ? Date.now() - existing.startedAt.getTime() : undefined;

    await postgresService.query(
      `UPDATE tool_calls
       SET tool_output = $1, tool_success = $2, tool_error = $3, bash_exit_code = $4,
           duration_ms = $5, completed_at = NOW()
       WHERE id = $6`,
      [params.toolOutput?.substring(0, 10000) || null, params.toolSuccess, params.toolError || null, params.bashExitCode || null, durationMs || null, id]
    );
  }

  /**
   * Get next call order for a turn
   */
  static async getNextCallOrder(turnId: string): Promise<number> {
    const result = await postgresService.query<{ max_order: string | null }>(
      `SELECT MAX(call_order) as max_order FROM tool_calls WHERE turn_id = $1`,
      [turnId]
    );
    const row = result.rows[0];
    return (parseInt(row?.max_order || '0', 10) || 0) + 1;
  }

  /**
   * Find tool call by ID
   */
  static async findById(id: string): Promise<IToolCall | null> {
    const result = await postgresService.query<ToolCallRow>(
      `SELECT * FROM tool_calls WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Find all tool calls for a task
   */
  static async findByTaskId(taskId: string): Promise<IToolCall[]> {
    const result = await postgresService.query<ToolCallRow>(
      `SELECT * FROM tool_calls WHERE task_id = $1 ORDER BY started_at ASC, call_order ASC`,
      [taskId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Find all tool calls for a turn
   */
  static async findByTurnId(turnId: string): Promise<IToolCall[]> {
    const result = await postgresService.query<ToolCallRow>(
      `SELECT * FROM tool_calls WHERE turn_id = $1 ORDER BY call_order ASC`,
      [turnId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Get tool call statistics for a task
   */
  static async getStats(taskId: string): Promise<{
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    byTool: Record<string, number>;
  }> {
    const result = await postgresService.query<{
      total: string;
      successful: string;
      failed: string;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN tool_success = true THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN tool_success = false THEN 1 ELSE 0 END) as failed
      FROM tool_calls WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];

    const toolResult = await postgresService.query<{ tool_name: string; count: string }>(
      `SELECT tool_name, COUNT(*) as count
       FROM tool_calls WHERE task_id = $1
       GROUP BY tool_name`,
      [taskId]
    );
    const byTool: Record<string, number> = {};
    for (const r of toolResult.rows) {
      byTool[r.tool_name] = parseInt(r.count, 10);
    }

    return {
      totalCalls: parseInt(row?.total, 10) || 0,
      successfulCalls: parseInt(row?.successful, 10) || 0,
      failedCalls: parseInt(row?.failed, 10) || 0,
      byTool,
    };
  }
}
