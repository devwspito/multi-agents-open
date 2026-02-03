/**
 * Execution Tracker Service
 *
 * Coordinates granular tracking of agent executions.
 * Provider-agnostic - works with OpenCode, Ollama, DGX, etc.
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository.js';
import { AgentTurnRepository, IAgentTurn, TurnType } from '../../database/repositories/AgentTurnRepository.js';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository.js';

interface ActiveExecution {
  executionId: string;
  taskId: string;
  currentTurnId: string | null;
  currentTurnNumber: number;
  pendingToolCalls: Map<string, string>; // toolUseId -> toolCallId
}

class ExecutionTrackerService {
  private activeExecutions: Map<string, ActiveExecution> = new Map();

  /**
   * Start tracking a new agent execution
   */
  startExecution(params: {
    taskId: string;
    agentType: string;
    modelId: string;
    phaseName?: string;
    prompt: string;
  }): string {
    const execution = AgentExecutionRepository.create(params);

    this.activeExecutions.set(params.taskId, {
      executionId: execution.id,
      taskId: params.taskId,
      currentTurnId: null,
      currentTurnNumber: 0,
      pendingToolCalls: new Map(),
    });

    console.log(`[ExecutionTracker] Started execution ${execution.id} for task ${params.taskId}`);
    return execution.id;
  }

  /**
   * Record a new turn starting
   */
  startTurn(taskId: string, turnType: TurnType = 'assistant'): string | null {
    const active = this.activeExecutions.get(taskId);
    if (!active) {
      console.warn(`[ExecutionTracker] No active execution for task ${taskId}`);
      return null;
    }

    active.currentTurnNumber++;

    const turn = AgentTurnRepository.create({
      executionId: active.executionId,
      taskId,
      turnNumber: active.currentTurnNumber,
      turnType,
    });

    active.currentTurnId = turn.id;

    AgentExecutionRepository.updateProgress(active.executionId, active.currentTurnNumber);

    return turn.id;
  }

  /**
   * Update current turn with content
   */
  updateTurnContent(taskId: string, content: string, tokens?: { input: number; output: number }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) return;

    AgentTurnRepository.updateContent(active.currentTurnId, content, tokens);
  }

  /**
   * Record a tool call starting
   */
  startToolCall(taskId: string, params: {
    toolName: string;
    toolUseId: string;
    toolInput: any;
  }): string | null {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) {
      console.warn(`[ExecutionTracker] No active turn for task ${taskId}`);
      return null;
    }

    const callOrder = ToolCallRepository.getNextCallOrder(active.currentTurnId);

    const toolCall = ToolCallRepository.create({
      executionId: active.executionId,
      turnId: active.currentTurnId,
      taskId,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      toolInput: params.toolInput,
      callOrder,
    });

    active.pendingToolCalls.set(params.toolUseId, toolCall.id);

    const currentCount = active.pendingToolCalls.size;
    AgentTurnRepository.updateToolCalls(active.currentTurnId, currentCount);

    return toolCall.id;
  }

  /**
   * Record a tool call completing
   */
  completeToolCall(taskId: string, params: {
    toolUseId: string;
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    const toolCallId = active.pendingToolCalls.get(params.toolUseId);
    if (!toolCallId) {
      console.warn(`[ExecutionTracker] Unknown tool_use_id: ${params.toolUseId}`);
      return;
    }

    ToolCallRepository.complete(toolCallId, {
      toolOutput: params.toolOutput,
      toolSuccess: params.toolSuccess,
      toolError: params.toolError,
      bashExitCode: params.bashExitCode,
    });

    active.pendingToolCalls.delete(params.toolUseId);
  }

  /**
   * Complete an execution successfully
   */
  completeExecution(taskId: string, params: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    AgentExecutionRepository.complete(active.executionId, {
      ...params,
      turnsCompleted: active.currentTurnNumber,
    });

    this.activeExecutions.delete(taskId);
    console.log(`[ExecutionTracker] Completed execution ${active.executionId} - ${active.currentTurnNumber} turns`);
  }

  /**
   * Fail an execution
   */
  failExecution(taskId: string, errorMessage: string, errorType?: string): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    AgentExecutionRepository.fail(active.executionId, errorMessage, errorType);
    this.activeExecutions.delete(taskId);
    console.log(`[ExecutionTracker] Failed execution ${active.executionId}: ${errorMessage}`);
  }

  /**
   * Get the current execution ID for a task
   */
  getExecutionId(taskId: string): string | null {
    return this.activeExecutions.get(taskId)?.executionId || null;
  }

  /**
   * Get the current turn ID for a task
   */
  getCurrentTurnId(taskId: string): string | null {
    return this.activeExecutions.get(taskId)?.currentTurnId || null;
  }

  /**
   * Get execution statistics
   */
  getStats(taskId: string) {
    return {
      executions: AgentExecutionRepository.getStats(taskId),
      toolCalls: ToolCallRepository.getStats(taskId),
    };
  }

  /**
   * Get full execution history for a task
   */
  getExecutionHistory(taskId: string): {
    executions: IAgentExecution[];
    turns: IAgentTurn[];
    toolCalls: IToolCall[];
  } {
    return {
      executions: AgentExecutionRepository.findByTaskId(taskId),
      turns: AgentTurnRepository.findByTaskId(taskId),
      toolCalls: ToolCallRepository.findByTaskId(taskId),
    };
  }

  /**
   * Check if there's an active execution for a task
   */
  hasActiveExecution(taskId: string): boolean {
    return this.activeExecutions.has(taskId);
  }

  /**
   * Cancel/cleanup an active execution
   */
  cancelExecution(taskId: string): void {
    const active = this.activeExecutions.get(taskId);
    if (active) {
      AgentExecutionRepository.fail(active.executionId, 'Execution cancelled', 'cancelled');
      this.activeExecutions.delete(taskId);
    }
  }
}

export const executionTracker = new ExecutionTrackerService();
export default executionTracker;
