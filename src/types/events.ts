/**
 * Shared Event Types
 *
 * This file defines the contract between backend and frontend for real-time events.
 * Both sides should use these types to ensure consistency.
 *
 * IMPORTANT: When modifying these types, update both:
 * - Backend: OpenCodeEventBridge.ts
 * - Frontend: ClaudeStyleConsole.jsx (or migrate to TypeScript)
 */

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * All possible activity event types
 */
export type ActivityEventType =
  // Lifecycle events (always shown, high priority)
  | 'phase_start'
  | 'phase_complete'
  | 'phase_failed'
  | 'story_start'
  | 'story_complete'
  | 'story_failed'
  | 'agent_completed'
  | 'agent_failed'
  // Tool events
  | 'tool'
  | 'tool_call'
  | 'tool_result'
  // Message events
  | 'user'
  | 'assistant'
  | 'agent_output'
  | 'agent_message'
  | 'orchestration'
  | 'system'
  // Status events
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  // Progress events
  | 'thinking'
  | 'agent_progress'
  | 'task_update'
  | 'step_finish';

/**
 * Tool state/status
 */
export type ToolState = 'running' | 'completed' | 'success' | 'error' | 'failed';

/**
 * Tools that should be shown in the console
 */
export const VISIBLE_TOOLS = ['bash', 'edit', 'write', 'read'] as const;
export type VisibleTool = (typeof VISIBLE_TOOLS)[number];

// ============================================================================
// EVENT INTERFACES
// ============================================================================

/**
 * Base activity event - all events extend this
 */
export interface BaseActivityEvent {
  id?: string;
  taskId: string;
  type: ActivityEventType;
  content?: string;
  timestamp?: string;
  streaming?: boolean;
}

/**
 * Tool activity event - for tool calls
 */
export interface ToolActivityEvent extends BaseActivityEvent {
  type: 'tool' | 'tool_call' | 'tool_result';
  tool: string;
  state: ToolState;
  /** File path - ALWAYS at top level for consistency */
  file_path?: string;
  /** Tool input parameters */
  input?: {
    file_path?: string;
    command?: string;
    pattern?: string;
    old_string?: string;
    new_string?: string;
    [key: string]: unknown;
  };
  /** Tool output/result */
  output?: string;
  result?: string;
  error?: string;
  /** Execution duration in ms */
  duration?: number;
}

/**
 * Phase activity event
 */
export interface PhaseActivityEvent extends BaseActivityEvent {
  type: 'phase_start' | 'phase_complete' | 'phase_failed';
  phase: string;
  duration?: string;
  error?: string;
}

/**
 * Story activity event
 */
export interface StoryActivityEvent extends BaseActivityEvent {
  type: 'story_start' | 'story_complete' | 'story_failed';
  storyId: string;
  storyTitle?: string;
}

/**
 * Message activity event
 */
export interface MessageActivityEvent extends BaseActivityEvent {
  type: 'user' | 'assistant' | 'agent_output' | 'agent_message' | 'orchestration' | 'system';
  content: string;
}

/**
 * Status activity event
 */
export interface StatusActivityEvent extends BaseActivityEvent {
  type: 'success' | 'error' | 'warning' | 'info';
  content: string;
  detail?: string;
}

/**
 * Union type for all activity events
 */
export type ActivityEvent =
  | ToolActivityEvent
  | PhaseActivityEvent
  | StoryActivityEvent
  | MessageActivityEvent
  | StatusActivityEvent
  | BaseActivityEvent;

// ============================================================================
// WEBSOCKET MESSAGE TYPES
// ============================================================================

/**
 * WebSocket message wrapper for activity events
 */
export interface ActivityWebSocketMessage {
  type: 'agent:activity';
  activity: ActivityEvent;
}

/**
 * WebSocket message for notifications
 */
export interface NotificationWebSocketMessage {
  type: 'notification';
  notification: {
    type: string;
    data?: {
      taskId?: string;
      [key: string]: unknown;
    };
  };
}

/**
 * Cost update WebSocket message
 */
export interface CostUpdateWebSocketMessage {
  type: 'cost:update';
  taskId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessionsCount: number;
  lastUpdated: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if an event type is a lifecycle event (high priority)
 */
export function isLifecycleEvent(type: ActivityEventType): boolean {
  const lifecycleTypes: ActivityEventType[] = [
    'phase_start',
    'phase_complete',
    'phase_failed',
    'story_start',
    'story_complete',
    'story_failed',
    'agent_completed',
    'agent_failed',
    'success',
    'error',
  ];
  return lifecycleTypes.includes(type);
}

/**
 * Check if a tool should be visible in the console
 */
export function isVisibleTool(toolName: string): boolean {
  return VISIBLE_TOOLS.includes(toolName.toLowerCase() as VisibleTool);
}

/**
 * Extract file path from various sources in an event
 * This is the canonical implementation - use this everywhere
 */
export function extractFilePath(event: Partial<ToolActivityEvent> | null | undefined): string {
  // Handle null/undefined
  if (!event) return '';

  // 1. Direct top-level property (preferred) - check multiple naming conventions
  const eventAny = event as Record<string, unknown>;
  const topLevelPath = event.file_path || eventAny.filePath || eventAny.path || eventAny.file;
  if (typeof topLevelPath === 'string' && topLevelPath) return topLevelPath;

  // 2. From input object
  const input = event.input;
  if (input && typeof input === 'object') {
    const inputAny = input as Record<string, unknown>;
    const inputPath = input.file_path || inputAny.filePath || inputAny.path || inputAny.file;
    if (typeof inputPath === 'string' && inputPath) return inputPath;
  }

  // 3. Parse from content string (fallback)
  const content = event.content;
  if (content) {
    const patterns = [
      /:\s*(\/[^\s,]+)/,        // ": /path/to/file"
      /\((\/[^\s,)]+)\)/,       // "(/path/to/file)"
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) return match[1];
    }
  }

  return '';
}

/**
 * Normalize a tool event to ensure consistent structure
 */
export function normalizeToolEvent(event: Partial<ToolActivityEvent>): ToolActivityEvent {
  const filePath = extractFilePath(event);

  return {
    id: event.id || `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    taskId: event.taskId || '',
    type: event.type || 'tool',
    tool: event.tool || 'unknown',
    state: event.state || 'running',
    content: event.content,
    timestamp: event.timestamp || new Date().toISOString(),
    // Ensure file_path is at top level
    file_path: filePath || undefined,
    input: event.input,
    output: event.output,
    result: event.result,
    error: event.error,
    duration: event.duration,
    streaming: event.streaming,
  };
}
