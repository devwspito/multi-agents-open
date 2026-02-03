/**
 * Agent Executor Service
 *
 * Coordinates agent execution with granular tracking for ML training.
 * Provider-agnostic - works with DGX Spark, Ollama, etc.
 */

import { ILLMProvider, ProviderResponse } from '../providers/BaseProvider.js';
import { providerFactory } from '../providers/ProviderFactory.js';
import { executionTracker } from '../training/ExecutionTracker.js';
import {
  AgentExecutionRequest,
  AgentExecutionResponse,
  ToolDefinition,
  Message,
  ToolCallResult,
} from '../../types/index.js';

/**
 * Tool handler function type
 */
export type ToolHandler = (input: Record<string, any>) => Promise<{
  output: string;
  success: boolean;
  error?: string;
  bashExitCode?: number;
}>;

/**
 * Agent execution options
 */
export interface ExecutionOptions {
  /** Tool handlers for this execution */
  toolHandlers?: Map<string, ToolHandler>;
  /** Callback for turn events */
  onTurnStart?: (turnNumber: number) => void;
  /** Callback for content chunks (streaming) */
  onContent?: (content: string) => void;
  /** Callback for tool call events */
  onToolCall?: (toolName: string, input: any) => void;
  /** Callback for tool result events */
  onToolResult?: (toolName: string, result: any) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

class AgentExecutorServiceClass {
  /**
   * Execute an agent with full tracking
   */
  async execute(
    request: AgentExecutionRequest,
    options: ExecutionOptions = {}
  ): Promise<AgentExecutionResponse> {
    const startTime = Date.now();
    const {
      taskId,
      agentType,
      phaseName,
      prompt,
      systemPrompt,
      tools,
      maxTurns = 20,
      temperature,
    } = request;

    // Get provider
    const provider = await providerFactory.getDefault();

    // Start tracking
    const executionId = executionTracker.startExecution({
      taskId,
      agentType,
      modelId: provider.model,
      phaseName,
      prompt,
    });

    // Initialize conversation
    const messages: Message[] = [{ role: 'user', content: prompt }];
    const allToolCalls: ToolCallResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turn = 0;
    let finalOutput = '';

    try {
      while (turn < maxTurns) {
        turn++;

        // Check for abort
        if (options.signal?.aborted) {
          throw new Error('Execution aborted');
        }

        // Start tracking turn
        executionTracker.startTurn(taskId, 'assistant');
        options.onTurnStart?.(turn);

        // Call provider
        const response = await provider.chat({
          messages,
          systemPrompt,
          tools,
          maxTokens: 4096,
          temperature,
        });

        // Track token usage
        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;

        // Update turn content
        executionTracker.updateTurnContent(taskId, response.content, {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
        });

        // Add assistant message to conversation
        messages.push({ role: 'assistant', content: response.content });

        // If no tool calls, we're done
        if (response.toolCalls.length === 0) {
          finalOutput = response.content;
          break;
        }

        // Process tool calls
        for (const tc of response.toolCalls) {
          const tcStartTime = Date.now();

          // Track tool call start
          executionTracker.startToolCall(taskId, {
            toolName: tc.name,
            toolUseId: tc.id,
            toolInput: tc.input,
          });

          options.onToolCall?.(tc.name, tc.input);

          // Execute tool
          let result: { output: string; success: boolean; error?: string; bashExitCode?: number };

          const handler = options.toolHandlers?.get(tc.name);
          if (handler) {
            try {
              result = await handler(tc.input);
            } catch (error: any) {
              result = {
                output: '',
                success: false,
                error: error.message,
              };
            }
          } else {
            result = {
              output: `Tool ${tc.name} not implemented`,
              success: false,
              error: 'Tool handler not found',
            };
          }

          // Track tool call completion
          executionTracker.completeToolCall(taskId, {
            toolUseId: tc.id,
            toolOutput: result.output,
            toolSuccess: result.success,
            toolError: result.error,
            bashExitCode: result.bashExitCode,
          });

          options.onToolResult?.(tc.name, result);

          // Add to results
          allToolCalls.push({
            toolUseId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolOutput: result.output,
            success: result.success,
            error: result.error,
            durationMs: Date.now() - tcStartTime,
          });

          // Add tool result to conversation
          messages.push({
            role: 'tool_result',
            content: result.success ? result.output : `Error: ${result.error}`,
            toolUseId: tc.id,
            toolName: tc.name,
          });
        }

        // If it was end_turn or max_tokens, we're done
        if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') {
          finalOutput = response.content;
          break;
        }
      }

      // Calculate cost (local providers are free)
      const cost = provider.calculateCost(totalInputTokens, totalOutputTokens);
      const durationMs = Date.now() - startTime;

      // Complete tracking
      executionTracker.completeExecution(taskId, {
        finalOutput,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: cost,
      });

      return {
        executionId,
        finalOutput,
        turns: turn,
        toolCalls: allToolCalls,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
        },
        cost,
        durationMs,
      };
    } catch (error: any) {
      // Track failure
      executionTracker.failExecution(taskId, error.message, error.name);

      throw error;
    }
  }

  /**
   * Execute agent with streaming output
   */
  async *executeStream(
    request: AgentExecutionRequest,
    options: ExecutionOptions = {}
  ): AsyncGenerator<{
    type: 'turn_start' | 'content' | 'tool_start' | 'tool_result' | 'done' | 'error';
    data?: any;
  }> {
    const startTime = Date.now();
    const {
      taskId,
      agentType,
      phaseName,
      prompt,
      systemPrompt,
      tools,
      maxTurns = 20,
      temperature,
    } = request;

    const provider = await providerFactory.getDefault();

    const executionId = executionTracker.startExecution({
      taskId,
      agentType,
      modelId: provider.model,
      phaseName,
      prompt,
    });

    const messages: Message[] = [{ role: 'user', content: prompt }];
    const allToolCalls: ToolCallResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turn = 0;
    let finalOutput = '';

    try {
      while (turn < maxTurns) {
        turn++;

        if (options.signal?.aborted) {
          yield { type: 'error', data: { error: 'Execution aborted' } };
          return;
        }

        executionTracker.startTurn(taskId, 'assistant');
        yield { type: 'turn_start', data: { turn } };

        let responseContent = '';
        const toolCalls: ProviderResponse['toolCalls'] = [];

        // Stream response
        for await (const chunk of provider.chatStream({
          messages,
          systemPrompt,
          tools,
          maxTokens: 4096,
          temperature,
        })) {
          if (chunk.type === 'text' && chunk.content) {
            responseContent += chunk.content;
            yield { type: 'content', data: { content: chunk.content } };
          }

          if (chunk.type === 'tool_use') {
            toolCalls.push({
              id: chunk.toolUseId!,
              name: chunk.toolName!,
              input: chunk.toolInput || {},
            });
          }

          if (chunk.type === 'error') {
            yield { type: 'error', data: { error: chunk.error } };
            return;
          }
        }

        // Update tracking (estimate tokens for streaming)
        totalOutputTokens += Math.ceil(responseContent.length / 4);
        executionTracker.updateTurnContent(taskId, responseContent);

        messages.push({ role: 'assistant', content: responseContent });

        if (toolCalls.length === 0) {
          finalOutput = responseContent;
          break;
        }

        // Process tool calls
        for (const tc of toolCalls) {
          const tcStartTime = Date.now();

          executionTracker.startToolCall(taskId, {
            toolName: tc.name,
            toolUseId: tc.id,
            toolInput: tc.input,
          });

          yield { type: 'tool_start', data: { toolName: tc.name, input: tc.input } };

          let result: { output: string; success: boolean; error?: string; bashExitCode?: number };

          const handler = options.toolHandlers?.get(tc.name);
          if (handler) {
            try {
              result = await handler(tc.input);
            } catch (error: any) {
              result = { output: '', success: false, error: error.message };
            }
          } else {
            result = { output: '', success: false, error: 'Tool handler not found' };
          }

          executionTracker.completeToolCall(taskId, {
            toolUseId: tc.id,
            toolOutput: result.output,
            toolSuccess: result.success,
            toolError: result.error,
            bashExitCode: result.bashExitCode,
          });

          yield { type: 'tool_result', data: { toolName: tc.name, ...result } };

          allToolCalls.push({
            toolUseId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolOutput: result.output,
            success: result.success,
            error: result.error,
            durationMs: Date.now() - tcStartTime,
          });

          messages.push({
            role: 'tool_result',
            content: result.success ? result.output : `Error: ${result.error}`,
            toolUseId: tc.id,
            toolName: tc.name,
          });
        }
      }

      const cost = provider.calculateCost(totalInputTokens, totalOutputTokens);
      const durationMs = Date.now() - startTime;

      executionTracker.completeExecution(taskId, {
        finalOutput,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: cost,
      });

      yield {
        type: 'done',
        data: {
          executionId,
          finalOutput,
          turns: turn,
          toolCalls: allToolCalls,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
          },
          cost,
          durationMs,
        },
      };
    } catch (error: any) {
      executionTracker.failExecution(taskId, error.message, error.name);
      yield { type: 'error', data: { error: error.message } };
    }
  }

  /**
   * Cancel an active execution
   */
  cancel(taskId: string): void {
    executionTracker.cancelExecution(taskId);
  }

  /**
   * Check if there's an active execution for a task
   */
  hasActiveExecution(taskId: string): boolean {
    return executionTracker.hasActiveExecution(taskId);
  }

  /**
   * Get execution statistics
   */
  getStats(taskId: string) {
    return executionTracker.getStats(taskId);
  }

  /**
   * Get full execution history
   */
  getHistory(taskId: string) {
    return executionTracker.getExecutionHistory(taskId);
  }
}

export const agentExecutor = new AgentExecutorServiceClass();
export default agentExecutor;
