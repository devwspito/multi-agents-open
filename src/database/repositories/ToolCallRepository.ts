/**
 * Tool Call Repository
 *
 * Granular tracking of every tool call for ML training
 */

import { db, generateId } from '../index.js';

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

export class ToolCallRepository {
  /**
   * Create a new tool call record
   */
  static create(params: {
    executionId: string;
    turnId: string;
    taskId: string;
    toolName: string;
    toolUseId?: string;
    toolInput: any;
    callOrder: number;
  }): IToolCall {
    const id = generateId();
    const now = new Date().toISOString();

    // Create input summary for large inputs
    const inputStr = JSON.stringify(params.toolInput);
    const inputSummary = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;

    // Extract file path and bash command from input
    const filePath = params.toolInput?.file_path || params.toolInput?.path;
    const bashCommand = params.toolName === 'Bash' ? params.toolInput?.command : undefined;

    const stmt = db.prepare(`
      INSERT INTO tool_calls (
        id, execution_id, turn_id, task_id, tool_name, tool_use_id,
        tool_input, tool_input_summary, file_path, bash_command, call_order, started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      params.executionId,
      params.turnId,
      params.taskId,
      params.toolName,
      params.toolUseId,
      inputStr,
      inputSummary,
      filePath,
      bashCommand,
      params.callOrder,
      now
    );

    return {
      id,
      executionId: params.executionId,
      turnId: params.turnId,
      taskId: params.taskId,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      toolInput: params.toolInput,
      toolInputSummary: inputSummary,
      filePath,
      bashCommand,
      toolSuccess: true,
      callOrder: params.callOrder,
      startedAt: new Date(now),
    };
  }

  /**
   * Complete a tool call with result
   */
  static complete(id: string, params: {
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): void {
    const now = new Date().toISOString();
    const startedAt = this.findById(id)?.startedAt;
    const durationMs = startedAt ? Date.now() - startedAt.getTime() : undefined;

    const stmt = db.prepare(`
      UPDATE tool_calls
      SET tool_output = ?, tool_success = ?, tool_error = ?, bash_exit_code = ?,
          duration_ms = ?, completed_at = ?
      WHERE id = ?
    `);

    stmt.run(
      params.toolOutput?.substring(0, 10000), // Limit output size
      params.toolSuccess ? 1 : 0,
      params.toolError,
      params.bashExitCode,
      durationMs,
      now,
      id
    );
  }

  /**
   * Get next call order for a turn
   */
  static getNextCallOrder(turnId: string): number {
    const stmt = db.prepare(`
      SELECT MAX(call_order) as max_order FROM tool_calls WHERE turn_id = ?
    `);
    const row = stmt.get(turnId) as any;
    return (row?.max_order || 0) + 1;
  }

  /**
   * Find tool call by ID
   */
  static findById(id: string): IToolCall | null {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find all tool calls for a task
   */
  static findByTaskId(taskId: string): IToolCall[] {
    const stmt = db.prepare(`
      SELECT * FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC, call_order ASC
    `);
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Find all tool calls for a turn
   */
  static findByTurnId(turnId: string): IToolCall[] {
    const stmt = db.prepare(`
      SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY call_order ASC
    `);
    const rows = stmt.all(turnId) as any[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Get tool call statistics for a task
   */
  static getStats(taskId: string): {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    byTool: Record<string, number>;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failed
      FROM tool_calls WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as any;

    const toolStmt = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_calls WHERE task_id = ?
      GROUP BY tool_name
    `);
    const toolRows = toolStmt.all(taskId) as any[];
    const byTool: Record<string, number> = {};
    for (const r of toolRows) {
      byTool[r.tool_name] = r.count;
    }

    return {
      totalCalls: row?.total || 0,
      successfulCalls: row?.successful || 0,
      failedCalls: row?.failed || 0,
      byTool,
    };
  }

  private static mapRow(row: any): IToolCall {
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
      toolUseId: row.tool_use_id,
      toolInput,
      toolInputSummary: row.tool_input_summary,
      toolOutput: row.tool_output,
      toolSuccess: Boolean(row.tool_success),
      toolError: row.tool_error,
      filePath: row.file_path,
      bashCommand: row.bash_command,
      bashExitCode: row.bash_exit_code,
      durationMs: row.duration_ms,
      callOrder: row.call_order,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
}
