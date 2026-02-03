/**
 * Agent Turn Repository
 *
 * Tracks turn-by-turn data for ML training
 */

import { db, generateId } from '../index.js';

export type TurnType = 'user' | 'assistant' | 'tool_result';

export interface IAgentTurn {
  id: string;
  executionId: string;
  taskId: string;
  turnNumber: number;
  turnType: TurnType;
  messageContent?: string;
  hasToolCalls: boolean;
  toolCallsCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date;
  completedAt?: Date;
}

export class AgentTurnRepository {
  /**
   * Create a new turn record
   */
  static create(params: {
    executionId: string;
    taskId: string;
    turnNumber: number;
    turnType?: TurnType;
  }): IAgentTurn {
    const id = generateId();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO agent_turns (id, execution_id, task_id, turn_number, turn_type, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, params.executionId, params.taskId, params.turnNumber, params.turnType || 'assistant', now);

    return {
      id,
      executionId: params.executionId,
      taskId: params.taskId,
      turnNumber: params.turnNumber,
      turnType: params.turnType || 'assistant',
      hasToolCalls: false,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: new Date(now),
    };
  }

  /**
   * Update turn with content and tokens
   */
  static updateContent(id: string, content: string, tokens?: { input: number; output: number }): void {
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE agent_turns
      SET message_content = ?, input_tokens = ?, output_tokens = ?, completed_at = ?
      WHERE id = ?
    `);

    stmt.run(content, tokens?.input || 0, tokens?.output || 0, now, id);
  }

  /**
   * Update turn with tool call count
   */
  static updateToolCalls(id: string, count: number): void {
    const stmt = db.prepare(`
      UPDATE agent_turns SET has_tool_calls = ?, tool_calls_count = ? WHERE id = ?
    `);
    stmt.run(count > 0 ? 1 : 0, count, id);
  }

  /**
   * Find all turns for an execution
   */
  static findByExecutionId(executionId: string): IAgentTurn[] {
    const stmt = db.prepare(`
      SELECT * FROM agent_turns WHERE execution_id = ? ORDER BY turn_number ASC
    `);
    const rows = stmt.all(executionId) as any[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Find all turns for a task
   */
  static findByTaskId(taskId: string): IAgentTurn[] {
    const stmt = db.prepare(`
      SELECT * FROM agent_turns WHERE task_id = ? ORDER BY started_at ASC
    `);
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRow(row));
  }

  private static mapRow(row: any): IAgentTurn {
    return {
      id: row.id,
      executionId: row.execution_id,
      taskId: row.task_id,
      turnNumber: row.turn_number,
      turnType: row.turn_type,
      messageContent: row.message_content,
      hasToolCalls: Boolean(row.has_tool_calls),
      toolCallsCount: row.tool_calls_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
}
