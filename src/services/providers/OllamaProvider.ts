/**
 * Ollama Provider
 *
 * Connects to local Ollama instance for inference.
 * Useful for development and smaller models.
 */

import {
  BaseProvider,
  ProviderResponse,
  StreamChunk,
} from './BaseProvider.js';
import { ToolDefinition, Message, ProviderConfig } from '../../types/index.js';

interface OllamaConfig extends ProviderConfig {
  host?: string;
  model: string;
}

export class OllamaProvider extends BaseProvider {
  readonly type = 'ollama';
  readonly model: string;

  private host: string;

  constructor(config: OllamaConfig) {
    super(config);
    this.host = config.host || 'http://localhost:11434';
    this.model = config.model;
  }

  async initialize(): Promise<void> {
    console.log(`[OllamaProvider] Connecting to ${this.host}...`);

    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error(`[OllamaProvider] Cannot connect to ${this.host}`);
    }

    // Check if model is available
    const modelsResponse = await fetch(`${this.host}/api/tags`);
    const models = await modelsResponse.json() as { models?: Array<{ name: string }> };
    const available = models.models?.some(
      (m) => m.name === this.model || m.name.startsWith(this.model + ':')
    );

    if (!available) {
      console.warn(`[OllamaProvider] Model ${this.model} not found. Available models:`,
        models.models?.map((m) => m.name));
    }

    console.log(`[OllamaProvider] Connected. Model: ${this.model}`);
  }

  async chat(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderResponse> {
    const { messages, systemPrompt, tools, maxTokens, temperature } = params;

    const body: any = {
      model: this.model,
      messages: this.buildMessages(messages, systemPrompt),
      stream: false,
      options: {
        temperature: temperature ?? 0.7,
        num_predict: maxTokens || 4096,
      },
    };

    // Ollama supports tools in newer versions
    if (tools && tools.length > 0) {
      body.tools = this.formatToolsForOllama(tools);
    }

    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OllamaProvider] API Error: ${response.status} - ${errorText}`);
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

    const body: any = {
      model: this.model,
      messages: this.buildMessages(messages, systemPrompt),
      stream: true,
      options: {
        temperature: temperature ?? 0.7,
        num_predict: maxTokens || 4096,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = this.formatToolsForOllama(tools);
    }

    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);

            if (parsed.message?.content) {
              yield { type: 'text', content: parsed.message.content };
            }

            if (parsed.message?.tool_calls) {
              for (const tc of parsed.message.tool_calls) {
                yield {
                  type: 'tool_use',
                  toolUseId: tc.id || `tool_${Date.now()}`,
                  toolName: tc.function?.name,
                  toolInput: tc.function?.arguments || {},
                };
              }
            }

            if (parsed.done) {
              yield { type: 'done' };
              return;
            }
          } catch {
            // Skip invalid JSON
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
      const response = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    console.log('[OllamaProvider] Disconnected');
  }

  // ==================== Private Helpers ====================

  private buildMessages(
    messages: Message[],
    systemPrompt?: string
  ): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      result.push({
        role: msg.role === 'tool_result' ? 'user' : msg.role,
        content: msg.role === 'tool_result'
          ? `Tool result for ${msg.toolName}: ${msg.content}`
          : msg.content,
      });
    }

    return result;
  }

  private formatToolsForOllama(tools: ToolDefinition[]): any[] {
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
    const message = data.message;

    const toolCalls: ProviderResponse['toolCalls'] = [];
    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        toolCalls.push({
          id: tc.id || `tool_${Date.now()}`,
          name: tc.function?.name || '',
          input: tc.function?.arguments || {},
        });
      }
    }

    return {
      content: message?.content || '',
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }
}
