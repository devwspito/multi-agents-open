/**
 * Execution Tracker Service
 *
 * Coordinates granular tracking of agent executions.
 * Provider-agnostic - works with OpenCode, Ollama, DGX, etc.
 *
 * Now includes ML Security Analyzer integration for:
 * - Tool call chain tracking
 * - Prompt classification
 * - Git context capture
 * - Error recovery patterns
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository.js';
import { AgentTurnRepository, IAgentTurn, TurnType } from '../../database/repositories/AgentTurnRepository.js';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository.js';

// Lazy import to avoid circular dependencies
let mlAnalyzer: any = null;
const getMLAnalyzer = async () => {
  if (!mlAnalyzer) {
    const module = await import('./MLSecurityAnalyzer.js');
    mlAnalyzer = module.mlSecurityAnalyzer;
  }
  return mlAnalyzer;
};

interface ActiveExecution {
  executionId: string;
  taskId: string;
  currentTurnId: string | null;
  currentTurnNumber: number;
  pendingToolCalls: Map<string, string>; // toolUseId -> toolCallId
  // ML tracking
  workspacePath?: string;
  agentType?: string;
  lastError?: string;
  lastErrorType?: string;
}

class ExecutionTrackerService {
  private activeExecutions: Map<string, ActiveExecution> = new Map();

  /**
   * Start tracking a new agent execution
   */
  async startExecution(params: {
    taskId: string;
    agentType: string;
    modelId: string;
    phaseName?: string;
    prompt: string;
    workspacePath?: string;
  }): Promise<string> {
    const execution = await AgentExecutionRepository.create(params);

    this.activeExecutions.set(params.taskId, {
      executionId: execution.id,
      taskId: params.taskId,
      currentTurnId: null,
      currentTurnNumber: 0,
      pendingToolCalls: new Map(),
      workspacePath: params.workspacePath,
      agentType: params.agentType,
    });

    console.log(`[ExecutionTracker] Started execution ${execution.id} for task ${params.taskId}`);

    // ML: Record prompt classification and git context (async, non-blocking)
    this.recordMLContextAsync(params.taskId, execution.id, params.prompt, params.workspacePath);

    return execution.id;
  }

  /**
   * Record ML context (prompt classification + git context)
   */
  private async recordMLContextAsync(
    taskId: string,
    executionId: string,
    prompt: string,
    workspacePath?: string
  ): Promise<void> {
    try {
      const analyzer = await getMLAnalyzer();

      // Classify prompt
      analyzer.recordPromptClassification({ taskId, executionId, prompt });

      // Capture git context if workspace available
      if (workspacePath) {
        await analyzer.recordGitContext({ taskId, executionId, workspacePath });
      }
    } catch (error: any) {
      console.warn(`[ExecutionTracker] ML context error: ${error.message}`);
    }
  }

  /**
   * Record a new turn starting
   */
  async startTurn(taskId: string, turnType: TurnType = 'assistant'): Promise<string | null> {
    const active = this.activeExecutions.get(taskId);
    if (!active) {
      console.warn(`[ExecutionTracker] No active execution for task ${taskId}`);
      return null;
    }

    active.currentTurnNumber++;

    const turn = await AgentTurnRepository.create({
      executionId: active.executionId,
      taskId,
      turnNumber: active.currentTurnNumber,
      turnType,
    });

    active.currentTurnId = turn.id;

    await AgentExecutionRepository.updateProgress(active.executionId, active.currentTurnNumber);

    return turn.id;
  }

  /**
   * Update current turn with content
   */
  async updateTurnContent(taskId: string, content: string, tokens?: { input: number; output: number }): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) return;

    await AgentTurnRepository.updateContent(active.currentTurnId, content, tokens);
  }

  /**
   * Record a tool call starting
   */
  async startToolCall(taskId: string, params: {
    toolName: string;
    toolUseId: string;
    toolInput: any;
  }): Promise<string | null> {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) {
      console.warn(`[ExecutionTracker] No active turn for task ${taskId}`);
      return null;
    }

    const callOrder = await ToolCallRepository.getNextCallOrder(active.currentTurnId);

    const toolCall = await ToolCallRepository.create({
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
    await AgentTurnRepository.updateToolCalls(active.currentTurnId, currentCount);

    // ML: Track tool sequence for chain analysis (async, non-blocking)
    this.trackToolCallMLAsync(taskId, active.executionId, params.toolName, params.toolInput);

    return toolCall.id;
  }

  /**
   * Track tool call for ML chain analysis
   */
  private async trackToolCallMLAsync(
    taskId: string,
    executionId: string,
    toolName: string,
    toolInput: any
  ): Promise<void> {
    try {
      const analyzer = await getMLAnalyzer();
      analyzer.trackToolCall({ taskId, executionId, toolName, toolInput });
    } catch (error: any) {
      console.warn(`[ExecutionTracker] ML tool tracking error: ${error.message}`);
    }
  }

  /**
   * Record a tool call completing
   */
  async completeToolCall(taskId: string, params: {
    toolUseId: string;
    toolName?: string;
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    const toolCallId = active.pendingToolCalls.get(params.toolUseId);
    if (!toolCallId) {
      console.warn(`[ExecutionTracker] Unknown tool_use_id: ${params.toolUseId}`);
      return;
    }

    await ToolCallRepository.complete(toolCallId, {
      toolOutput: params.toolOutput,
      toolSuccess: params.toolSuccess,
      toolError: params.toolError,
      bashExitCode: params.bashExitCode,
    });

    // ML: Track errors for recovery pattern analysis
    if (!params.toolSuccess && params.toolError) {
      active.lastError = params.toolError;
      active.lastErrorType = params.toolName || 'unknown';
    }

    active.pendingToolCalls.delete(params.toolUseId);
  }

  /**
   * Update turn content - also checks for error recovery
   */
  async updateTurnContentWithRecovery(taskId: string, content: string, tokens?: { input: number; output: number }): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) return;

    await AgentTurnRepository.updateContent(active.currentTurnId, content, tokens);

    // ML: Track error recovery if there was a previous error
    if (active.lastError && content.length > 0) {
      this.trackErrorRecoveryMLAsync(
        taskId,
        active.executionId,
        active.lastError,
        active.lastErrorType || 'unknown',
        content
      );
      active.lastError = undefined;
      active.lastErrorType = undefined;
    }
  }

  /**
   * Track error recovery attempt
   */
  private async trackErrorRecoveryMLAsync(
    taskId: string,
    executionId: string,
    error: string,
    errorType: string,
    recoveryContent: string
  ): Promise<void> {
    try {
      const analyzer = await getMLAnalyzer();
      const recoveryMatch = recoveryContent.match(/(?:let me|I'll|I will)\s+(?:try|use|run)\s+(\w+)/i);
      const recoveryTool = recoveryMatch ? recoveryMatch[1] : 'text_response';

      analyzer.trackErrorRecovery({
        taskId,
        executionId,
        error,
        errorType,
        recoveryAction: recoveryContent.substring(0, 200),
        recoveryToolName: recoveryTool,
        successful: true,
      });
    } catch (error: any) {
      console.warn(`[ExecutionTracker] ML recovery tracking error: ${error.message}`);
    }
  }

  /**
   * Complete an execution successfully
   */
  async completeExecution(taskId: string, params: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    await AgentExecutionRepository.complete(active.executionId, {
      ...params,
      turnsCompleted: active.currentTurnNumber,
    });

    // ML: Clear tracking state
    this.clearMLTrackingAsync(active.executionId);

    this.activeExecutions.delete(taskId);
    console.log(`[ExecutionTracker] Completed execution ${active.executionId} - ${active.currentTurnNumber} turns`);
  }

  /**
   * Clear ML tracking state for an execution
   */
  private async clearMLTrackingAsync(executionId: string): Promise<void> {
    try {
      const analyzer = await getMLAnalyzer();
      analyzer.clearExecution(executionId);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Fail an execution
   */
  async failExecution(taskId: string, errorMessage: string, errorType?: string): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    await AgentExecutionRepository.fail(active.executionId, errorMessage, errorType);

    // ML: Clear tracking state
    this.clearMLTrackingAsync(active.executionId);

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
  async getStats(taskId: string) {
    return {
      executions: await AgentExecutionRepository.getStats(taskId),
      toolCalls: await ToolCallRepository.getStats(taskId),
    };
  }

  /**
   * Get full execution history for a task
   */
  async getExecutionHistory(taskId: string): Promise<{
    executions: IAgentExecution[];
    turns: IAgentTurn[];
    toolCalls: IToolCall[];
  }> {
    return {
      executions: await AgentExecutionRepository.findByTaskId(taskId),
      turns: await AgentTurnRepository.findByTaskId(taskId),
      toolCalls: await ToolCallRepository.findByTaskId(taskId),
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
  async cancelExecution(taskId: string): Promise<void> {
    const active = this.activeExecutions.get(taskId);
    if (active) {
      await AgentExecutionRepository.fail(active.executionId, 'Execution cancelled', 'cancelled');
      this.activeExecutions.delete(taskId);
    }
  }
}

export const executionTracker = new ExecutionTrackerService();
export default executionTracker;
