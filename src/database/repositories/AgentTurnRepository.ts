/**
 * Agent Turn Repository
 *
 * Tracks turn-by-turn data for ML training.
 * PostgreSQL implementation.
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

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

interface AgentTurnRow {
  id: string;
  execution_id: string;
  task_id: string;
  turn_number: number;
  turn_type: string;
  message_content: string | null;
  has_tool_calls: boolean;
  tool_calls_count: number;
  input_tokens: number;
  output_tokens: number;
  started_at: Date;
  completed_at: Date | null;
}

function mapRow(row: AgentTurnRow): IAgentTurn {
  return {
    id: row.id,
    executionId: row.execution_id,
    taskId: row.task_id,
    turnNumber: row.turn_number,
    turnType: row.turn_type as TurnType,
    messageContent: row.message_content || undefined,
    hasToolCalls: row.has_tool_calls,
    toolCallsCount: row.tool_calls_count || 0,
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
  };
}

export class AgentTurnRepository {
  /**
   * Create a new turn record
   */
  static async create(params: {
    executionId: string;
    taskId: string;
    turnNumber: number;
    turnType?: TurnType;
  }): Promise<IAgentTurn> {
    const id = generateId();

    await postgresService.query(
      `INSERT INTO agent_turns (id, execution_id, task_id, turn_number, turn_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, params.executionId, params.taskId, params.turnNumber, params.turnType || 'assistant']
    );

    const turn = await this.findById(id);
    return turn!;
  }

  /**
   * Find turn by ID
   */
  static async findById(id: string): Promise<IAgentTurn | null> {
    const result = await postgresService.query<AgentTurnRow>(
      `SELECT * FROM agent_turns WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Update turn with content and tokens
   */
  static async updateContent(id: string, content: string, tokens?: { input: number; output: number }): Promise<void> {
    await postgresService.query(
      `UPDATE agent_turns
       SET message_content = $1, input_tokens = $2, output_tokens = $3, completed_at = NOW()
       WHERE id = $4`,
      [content, tokens?.input || 0, tokens?.output || 0, id]
    );
  }

  /**
   * Update turn with tool call count
   */
  static async updateToolCalls(id: string, count: number): Promise<void> {
    await postgresService.query(
      `UPDATE agent_turns SET has_tool_calls = $1, tool_calls_count = $2 WHERE id = $3`,
      [count > 0, count, id]
    );
  }

  /**
   * Find all turns for an execution
   */
  static async findByExecutionId(executionId: string): Promise<IAgentTurn[]> {
    const result = await postgresService.query<AgentTurnRow>(
      `SELECT * FROM agent_turns WHERE execution_id = $1 ORDER BY turn_number ASC`,
      [executionId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Find all turns for a task
   */
  static async findByTaskId(taskId: string): Promise<IAgentTurn[]> {
    const result = await postgresService.query<AgentTurnRow>(
      `SELECT * FROM agent_turns WHERE task_id = $1 ORDER BY started_at ASC`,
      [taskId]
    );
    return result.rows.map(mapRow);
  }
}
