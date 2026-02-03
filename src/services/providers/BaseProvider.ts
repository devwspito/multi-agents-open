/**
 * Base Provider Interface
 *
 * Abstract interface for LLM providers (OpenCode, DGX Spark, Ollama, etc.)
 * Provider-agnostic design for flexibility.
 */

import { ToolDefinition, Message, ProviderConfig } from '../../types/index.js';

/**
 * Streaming response chunk from provider
 */
export interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  error?: string;
}

/**
 * Complete response from provider
 */
export interface ProviderResponse {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, any>;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

/**
 * Base provider interface that all providers must implement
 */
export interface ILLMProvider {
  /**
   * Provider type identifier
   */
  readonly type: string;

  /**
   * Model being used
   */
  readonly model: string;

  /**
   * Initialize the provider (connect, warm up, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Send a message and get a response
   */
  chat(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderResponse>;

  /**
   * Send a message and stream the response
   */
  chatStream(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<StreamChunk>;

  /**
   * Calculate cost for token usage
   */
  calculateCost(inputTokens: number, outputTokens: number): number;

  /**
   * Check if provider is healthy/available
   */
  healthCheck(): Promise<boolean>;

  /**
   * Cleanup/disconnect
   */
  dispose(): Promise<void>;
}

/**
 * Abstract base class with common functionality
 */
export abstract class BaseProvider implements ILLMProvider {
  abstract readonly type: string;
  abstract readonly model: string;

  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;

  abstract chat(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderResponse>;

  abstract chatStream(params: {
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<StreamChunk>;

  abstract healthCheck(): Promise<boolean>;

  abstract dispose(): Promise<void>;

  /**
   * Default cost calculation (override in specific providers)
   */
  calculateCost(inputTokens: number, outputTokens: number): number {
    // Default: free (local inference)
    return 0;
  }

  /**
   * Utility: Convert tool definitions to provider format
   */
  protected formatTools(tools: ToolDefinition[]): any[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
