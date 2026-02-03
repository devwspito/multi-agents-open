/**
 * Shared Types for Open Multi-Agents
 */

/**
 * Provider types supported by the system
 */
export type ProviderType = 'opencode' | 'dgx-spark' | 'ollama';

/**
 * Tool call definition for agents
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

/**
 * Tool call result from agent execution
 */
export interface ToolCallResult {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, any>;
  toolOutput?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * Agent execution request
 */
export interface AgentExecutionRequest {
  taskId: string;
  agentType: string;
  phaseName?: string;
  prompt: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTurns?: number;
  temperature?: number;
}

/**
 * Agent execution response
 */
export interface AgentExecutionResponse {
  executionId: string;
  finalOutput: string;
  turns: number;
  toolCalls: ToolCallResult[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
  durationMs: number;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  type: ProviderType;
  host?: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Message format for agent conversations
 */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool_result';
  content: string;
  toolUseId?: string;
  toolName?: string;
}

/**
 * Task status for orchestration
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Task definition
 */
export interface Task {
  id: string;
  projectId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
}
