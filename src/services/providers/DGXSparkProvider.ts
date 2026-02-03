/**
 * DGX Spark Provider
 *
 * Connects to NVIDIA DGX Spark for local inference.
 * Supports vLLM, TensorRT-LLM, or any OpenAI-compatible server.
 */

import {
  BaseProvider,
  ProviderResponse,
  StreamChunk,
} from './BaseProvider.js';
import { ToolDefinition, Message, ProviderConfig } from '../../types/index.js';

interface DGXConfig extends ProviderConfig {
  host: string;
  model: string;
  maxTokens?: number;
}

export class DGXSparkProvider extends BaseProvider {
  readonly type = 'dgx-spark';
  readonly model: string;

  private host: string;
  private maxTokens: number;

  constructor(config: DGXConfig) {
    super(config);
    this.host = config.host || 'http://localhost:8000';
    this.model = config.model;
    this.maxTokens = config.maxTokens || 4096;
  }

  async initialize(): Promise<void> {
    console.log(`[DGXSparkProvider] Connecting to ${this.host}...`);

    // Test connection
    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error(`[DGXSparkProvider] Cannot connect to ${this.host}`);
    }

    console.log(`[DGXSparkProvider] Connected. Model: ${this.model}`);
  }

  async chat(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderResponse> {
    const { messages, systemPrompt, tools, maxTokens, temperature } = params;

    // Build request for OpenAI-compatible API (vLLM, TensorRT-LLM)
    const requestMessages = this.buildMessages(messages, systemPrompt);

    const body: any = {
      model: this.model,
      messages: requestMessages,
      max_tokens: maxTokens || this.maxTokens,
      temperature: temperature ?? 0.7,
      stream: false,
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      body.tools = this.formatToolsForOpenAI(tools);
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.host}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[DGXSparkProvider] API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return this.parseResponse(data);
  }

  async *chatStream(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<StreamChunk> {
    const { messages, systemPrompt, tools, maxTokens, temperature } = params;

    const requestMessages = this.buildMessages(messages, systemPrompt);

    const body: any = {
      model: this.model,
      messages: requestMessages,
      max_tokens: maxTokens || this.maxTokens,
      temperature: temperature ?? 0.7,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = this.formatToolsForOpenAI(tools);
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.host}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      yield { type: 'error', error: `API Error: ${response.status}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              yield { type: 'done' };
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.content) {
                yield { type: 'text', content: delta.content };
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  yield {
                    type: 'tool_use',
                    toolUseId: tc.id,
                    toolName: tc.function?.name,
                    toolInput: tc.function?.arguments
                      ? JSON.parse(tc.function.arguments)
                      : {},
                  };
                }
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/v1/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    console.log('[DGXSparkProvider] Disconnected');
  }

  /**
   * Override cost calculation - DGX Spark is local, so free
   */
  calculateCost(inputTokens: number, outputTokens: number): number {
    // Local inference has no API cost
    // Could calculate electricity/GPU cost if needed
    return 0;
  }

  // ==================== Private Helpers ====================

  private buildMessages(
    messages: Message[],
    systemPrompt?: string
  ): Array<{ role: string; content: string; tool_call_id?: string }> {
    const result: Array<{ role: string; content: string; tool_call_id?: string }> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'tool_result') {
        result.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolUseId,
        });
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }

  private formatToolsForOpenAI(tools: ToolDefinition[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private parseResponse(data: any): ProviderResponse {
    const choice = data.choices?.[0];
    const message = choice?.message;

    const toolCalls: ProviderResponse['toolCalls'] = [];

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function?.name || '',
          input: tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {},
        });
      }
    }

    const stopReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';

    return {
      content: message?.content || '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      stopReason,
    };
  }
}
