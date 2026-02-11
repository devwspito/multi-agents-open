/**
 * OpenCode Event Bridge
 *
 * Manages subscriptions to OpenCode events for multiple directories.
 * Each directory with active sessions gets its own event subscription.
 *
 * This bridges the gap between:
 * - OpenCode SSE events (agent activity, tool calls, etc.)
 * - Frontend WebSocket (real-time UI updates)
 * - Phase execution (waitForIdle)
 * - Training data tracking
 */

import { EventEmitter } from 'events';
import { openCodeClient, OpenCodeEvent } from './OpenCodeClient.js';
import { socketService } from '../realtime/SocketService.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { costTracker } from '../cost/index.js';
import {
  extractFilePath,
  type ToolActivityEvent,
} from '../../types/events.js';
import { logger } from '../logging/Logger.js';

interface TaskSession {
  taskId: string;
  sessionId: string;
  startedAt: Date;
  directory: string; // Working directory for event subscription
}

interface DirectorySubscription {
  directory: string;
  running: boolean;
  shouldStop: boolean;
  sessionCount: number;
}

interface WaitForIdleOptions {
  timeout?: number;
  onEvent?: (event: OpenCodeEvent) => void;
}

class OpenCodeEventBridgeService extends EventEmitter {
  private activeSessions: Map<string, TaskSession> = new Map(); // sessionId -> task info
  private directorySubscriptions: Map<string, DirectorySubscription> = new Map(); // directory -> subscription
  private collectedEvents: Map<string, OpenCodeEvent[]> = new Map(); // sessionId -> events

  // 🔥 Batching: Accumulate activity logs and flush periodically to reduce DB load
  // Includes full tool input (old_string, new_string, file_path) for ML training
  private pendingActivityLogs: Map<string, Array<{
    type: string;
    content: string;
    tool?: string;
    toolState?: string;
    toolInput?: any;  // Full tool input for ML training
    toolOutput?: any; // Tool result/output
  }>> = new Map(); // taskId -> pending log entries
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 2000; // Flush every 2 seconds
  private readonly MAX_BATCH_SIZE = 50; // Force flush if batch gets too large

  constructor() {
    super();
    // Increase max listeners since multiple phases may listen concurrently
    this.setMaxListeners(50);
    // Start the flush timer
    this.startFlushTimer();
  }

  /**
   * Start the periodic flush timer for activity logs
   */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushAllActivityLogs();
    }, this.FLUSH_INTERVAL_MS);
    logger.debug(`[EventBridge] Activity log flush timer started (interval: ${this.FLUSH_INTERVAL_MS}ms)`);
  }

  /**
   * Stop the flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Flush all pending activity logs to the database
   */
  private async flushAllActivityLogs(): Promise<void> {
    if (this.pendingActivityLogs.size === 0) return;

    const tasksToFlush = Array.from(this.pendingActivityLogs.entries());
    this.pendingActivityLogs.clear();

    // Flush each task's logs in parallel
    const flushPromises = tasksToFlush.map(async ([taskId, entries]) => {
      if (entries.length === 0) return;
      try {
        await TaskRepository.appendActivityLogs(taskId, entries);
        logger.debug(`[EventBridge] Flushed ${entries.length} activity logs for task ${taskId}`);
      } catch (err: any) {
        logger.warn(`[EventBridge] Failed to flush ${entries.length} activity logs for task ${taskId}: ${err.message}`);
      }
    });

    await Promise.all(flushPromises);
  }

  /**
   * Queue an activity log entry for batch saving
   */
  private queueActivityLog(taskId: string, entry: {
    type: string;
    content: string;
    tool?: string;
    toolState?: string;
    toolInput?: any;  // Full tool input for ML training (old_string, new_string, file_path, etc.)
    toolOutput?: any; // Tool result/output
  }): void {
    if (!this.pendingActivityLogs.has(taskId)) {
      this.pendingActivityLogs.set(taskId, []);
    }
    const logs = this.pendingActivityLogs.get(taskId)!;
    logs.push(entry);

    // Force flush if batch is too large
    if (logs.length >= this.MAX_BATCH_SIZE) {
      logger.debug(`[EventBridge] Batch size limit reached for task ${taskId}, forcing flush`);
      const entriesToFlush = [...logs];
      this.pendingActivityLogs.set(taskId, []);
      TaskRepository.appendActivityLogs(taskId, entriesToFlush).catch(err => {
        logger.warn(`[EventBridge] Failed to flush activity logs: ${err.message}`);
      });
    }
  }

  /**
   * 🔥 ML TRAINING: Only save high-value events for training
   *
   * What's valuable:
   * - Tool calls (edit, bash, write, read) when COMPLETED with full input/output
   * - Questions asked/answered
   *
   * What's NOISE (skip):
   * - Streaming content chunks
   * - "thinking" / "running" status updates
   * - Glob/grep (too many, low value)
   * - Session lifecycle events
   */
  private saveForTrainingIfValuable(taskId: string, frontendEvent: { type: string; data: any }): void {
    const { type, data } = frontendEvent;

    // 🔥 HIGH VALUE: Tool calls - but ONLY completed ones for important tools
    if (type === 'tool_call') {
      const toolName = (data.tool || '').toLowerCase();
      const toolState = data.state || data.status;

      // Only valuable tools
      const valuableTools = ['edit', 'bash', 'write', 'read'];
      if (!valuableTools.includes(toolName)) {
        return; // Skip glob, grep, todowrite, etc.
      }

      // Only completed (with results)
      if (toolState !== 'completed' && toolState !== 'success') {
        return; // Skip "running" states
      }

      // Must have meaningful input
      if (!data.input) {
        return;
      }

      // 🔥 Save with full tool data
      this.queueActivityLog(taskId, {
        type: 'tool_completed',
        content: `${toolName}: ${this.summarizeToolInput(toolName, data.input)}`,
        tool: toolName,
        toolState: 'completed',
        toolInput: data.input,
        toolOutput: data.output || data.result,
      });
      return;
    }

    // 🔥 HIGH VALUE: Questions (agent asking for clarification)
    if (type === 'question_asked') {
      this.queueActivityLog(taskId, {
        type: 'question',
        content: data.question || '',
        toolInput: { question: data.question, options: data.options },
      });
      return;
    }

    if (type === 'question_answered') {
      this.queueActivityLog(taskId, {
        type: 'answer',
        content: data.answer || '',
        toolOutput: { answer: data.answer },
      });
      return;
    }

    // 🔥 MEDIUM VALUE: Final agent message (non-streaming)
    if ((type === 'agent_message' || type === 'agent_output') && data.streaming !== true) {
      const content = data.content || '';
      // Only save substantial messages (not just "OK" or status updates)
      if (content.length > 50) {
        this.queueActivityLog(taskId, {
          type: 'agent_response',
          content: content.substring(0, 2000), // Limit size
        });
      }
      return;
    }

    // Everything else is NOISE - don't save
    // - streaming chunks
    // - thinking/progress
    // - session lifecycle
    // - glob/grep results
  }

  /**
   * Summarize tool input for human-readable content field
   */
  private summarizeToolInput(toolName: string, input: any): string {
    if (!input) return '';

    switch (toolName) {
      case 'edit':
        return input.file_path || 'file';
      case 'write':
        return input.file_path || 'file';
      case 'read':
        return input.file_path || 'file';
      case 'bash':
        const cmd = input.command || '';
        return cmd.substring(0, 80) + (cmd.length > 80 ? '...' : '');
      default:
        return JSON.stringify(input).substring(0, 50);
    }
  }

  /**
   * Register a task's OpenCode session for event forwarding
   * @param directory - The working directory where the session was created (REQUIRED for event subscription)
   */
  registerSession(taskId: string, sessionId: string, directory: string): void {
    if (!directory) {
      logger.error(`[EventBridge] Cannot register session without directory!`);
      return;
    }

    this.activeSessions.set(sessionId, {
      taskId,
      sessionId,
      startedAt: new Date(),
      directory,
    });

    logger.debug(`[EventBridge] Registered session ${sessionId} for task ${taskId} (dir: ${directory}, active: ${this.activeSessions.size})`);

    // Start event loop for this directory if not already running
    const existingSub = this.directorySubscriptions.get(directory);
    if (existingSub) {
      existingSub.sessionCount++;
      logger.debug(`[EventBridge] Directory ${directory} already subscribed (sessions: ${existingSub.sessionCount})`);
    } else {
      // Create new subscription for this directory
      const sub: DirectorySubscription = {
        directory,
        running: false,
        shouldStop: false,
        sessionCount: 1,
      };
      this.directorySubscriptions.set(directory, sub);
      logger.debug(`[EventBridge] Starting subscription for directory: ${directory}`);
      this.startDirectoryEventLoop(directory, sub);
    }
  }

  /**
   * Unregister a session (task completed/cancelled)
   */
  unregisterSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const { directory } = session;
    this.activeSessions.delete(sessionId);

    // Clean up collected events for this session
    this.collectedEvents.delete(sessionId);

    // Remove any lingering listeners for this session
    this.removeAllListeners(`event:${sessionId}`);
    this.removeAllListeners(`session:idle:${sessionId}`);
    this.removeAllListeners(`session:error:${sessionId}`);

    logger.debug(`[EventBridge] Unregistered session ${sessionId} (remaining: ${this.activeSessions.size})`);

    // Decrement directory subscription count
    const sub = this.directorySubscriptions.get(directory);
    if (sub) {
      sub.sessionCount--;
      if (sub.sessionCount <= 0) {
        logger.debug(`[EventBridge] No more sessions for directory ${directory}, stopping subscription`);
        sub.shouldStop = true;
        this.directorySubscriptions.delete(directory);
      }
    }
  }

  /**
   * Start listening to OpenCode events for a specific directory
   */
  private async startDirectoryEventLoop(directory: string, sub: DirectorySubscription): Promise<void> {
    if (sub.running) return;
    sub.running = true;
    sub.shouldStop = false;

    logger.debug(`[EventBridge] Starting event loop for directory: ${directory}`);

    try {
      logger.debug(`[EventBridge] Subscribing to OpenCode events for: ${directory}`);
      let eventCount = 0;

      for await (const event of openCodeClient.subscribeToEvents(directory)) {
        // Check if we should stop
        if (sub.shouldStop) {
          logger.debug(`[EventBridge] Stopping event loop for ${directory}`);
          break;
        }

        eventCount++;
        if (eventCount <= 10 || eventCount % 50 === 0) {
          logger.debug(`[EventBridge][${directory}] Event #${eventCount}: ${event.type}`);
        }

        // Pass directory so we can match events without sessionID
        this.handleEvent(event, directory);
      }
      logger.debug(`[EventBridge] Event stream ended for ${directory} after ${eventCount} events`);
    } catch (error: any) {
      if (sub.shouldStop) {
        logger.debug(`[EventBridge] Event loop stopped intentionally for ${directory}`);
      } else {
        logger.error('Event loop error', error as Error, { directory });
      }
    } finally {
      sub.running = false;

      // Retry after delay if there are still sessions for this directory
      if (sub.sessionCount > 0 && !sub.shouldStop) {
        logger.debug(`[EventBridge] Reconnecting in 5s for ${directory}...`);
        setTimeout(() => this.startDirectoryEventLoop(directory, sub), 5000);
      }
    }
  }

  /**
   * Handle an OpenCode event and forward to frontend + emit for listeners
   * @param event - The OpenCode event
   * @param directory - The directory this event came from (for matching sessions without sessionID)
   */
  private handleEvent(event: OpenCodeEvent, directory: string): void {
    // Try to get sessionID from event properties
    // 🔥 FIX: message.part.updated events have sessionID INSIDE the part object!
    // session.status/idle/diff have: event.properties.sessionID
    // message.part.updated has: event.properties.part.sessionID
    // message.updated has: event.properties.info.sessionID
    const props = event.properties as any;
    let sessionId = props?.sessionID
      || props?.sessionId
      || props?.part?.sessionID   // For message.part.updated
      || props?.part?.sessionId
      || props?.info?.sessionID   // For message.updated
      || props?.info?.sessionId;
    const eventSessionId = sessionId; // Keep original for logging

    // If no sessionID in event, find session by directory
    if (!sessionId) {
      // Find the session registered for this directory
      for (const [sid, session] of this.activeSessions.entries()) {
        if (session.directory === directory) {
          sessionId = sid;
          break;
        }
      }
    }

    // Skip if still no session found (truly global events)
    if (!sessionId) {
      // 🔥 DEBUG: Log dropped events that have no session match
      if (event.type.startsWith('message.')) {
        console.warn(`[EventBridge] DROPPED message event (no session): ${event.type}, eventSessionId: ${eventSessionId}, dir: ${directory}`);
        console.warn(`[EventBridge] Active sessions: ${[...this.activeSessions.keys()].join(', ')}`);
      }
      return;
    }

    const taskSession = this.activeSessions.get(sessionId);
    if (!taskSession) {
      // 🔥 DEBUG: Log when session ID doesn't match registered sessions
      if (event.type.startsWith('message.')) {
        console.warn(`[EventBridge] DROPPED message event (session not found): ${event.type}, sessionId: ${sessionId}`);
        console.warn(`[EventBridge] Looking for: ${sessionId}, Have: ${[...this.activeSessions.keys()].join(', ')}`);
      }
      return;
    }

    logger.debug(`[EventBridge] Processing event for task ${taskSession.taskId}: ${event.type}`);

    const { taskId } = taskSession;

    // Store event for this session (for waitForSessionIdle to collect)
    if (!this.collectedEvents.has(sessionId)) {
      this.collectedEvents.set(sessionId, []);
    }
    this.collectedEvents.get(sessionId)!.push(event);

    // Emit raw event for waitForSessionIdle and other listeners
    this.emit('event', sessionId, event);
    this.emit(`event:${sessionId}`, event);

    // Emit specific lifecycle events
    if (event.type === 'session.idle') {
      this.emit('session:idle', sessionId, event);
      this.emit(`session:idle:${sessionId}`, event);
    } else if (event.type === 'session.error') {
      this.emit('session:error', sessionId, event);
      this.emit(`session:error:${sessionId}`, event);
    }

    // Transform OpenCode event to frontend-friendly format
    const frontendEvent = this.transformEvent(event, taskId);
    if (!frontendEvent) return;

    // 🔥 COST TRACKING: Record costs from step_finish events
    if (frontendEvent.type === 'step_finish' && frontendEvent.data) {
      costTracker.recordCost(taskId, sessionId, {
        cost: frontendEvent.data.cost,
        tokens: frontendEvent.data.tokens,
      });
    }

    // 🔥 Debug: Log what we're sending (sampled at 2%)
    if (Math.random() < 0.02) {
      logger.debug('Sending event to task', {
        taskId,
        eventType: frontendEvent.type,
        preview: (frontendEvent.data.content || frontendEvent.data.tool || '').substring(0, 80),
      });
    }

    // Send as the specific event type
    socketService.toTask(taskId, frontendEvent.type, frontendEvent.data);

    // Also send as 'agent:activity' for the Activity tab (frontend compatibility)
    const activity = {
      id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId,
      type: frontendEvent.type,
      timestamp: new Date(),
      ...frontendEvent.data,
    };
    socketService.toTask(taskId, 'agent:activity', activity);

    // Also broadcast as notification for Chat messages
    socketService.toTask(taskId, 'notification', {
      type: frontendEvent.type,
      notification: {
        type: this.mapToNotificationType(frontendEvent.type),
        data: frontendEvent.data,
      },
    });

    // 🔥 ML TRAINING: Only save HIGH-VALUE events
    // CRITICAL: Be very selective to avoid noise in training data
    // We want: (tool, input, output) tuples for learning code actions
    this.saveForTrainingIfValuable(taskId, frontendEvent);
  }

  /**
   * Wait for a session to become idle (finished processing)
   * Uses the centralized event stream - NO additional subscription created
   *
   * 🔥 NOTE: OpenCode handles its own internal timeouts. This timeout is just
   * a safety net for truly stuck sessions. Set very high to let agents work.
   *
   * @param sessionId - The session to wait for
   * @param options.timeout - Timeout in ms (default 30 minutes - safety net only)
   * @param options.onEvent - Callback for each event received
   * @returns All events collected for this session
   */
  waitForSessionIdle(sessionId: string, options?: WaitForIdleOptions): Promise<OpenCodeEvent[]> {
    // 🔥 30 minutes default - let agents work, OpenCode handles its own limits
    const timeout = options?.timeout || 1800000;

    return new Promise((resolve, reject) => {
      // Timeout handler
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Session ${sessionId} timed out after ${timeout}ms`));
      }, timeout);

      // Event handler
      const onEvent = (event: OpenCodeEvent) => {
        options?.onEvent?.(event);
      };

      // Idle handler
      const onIdle = () => {
        cleanup();
        const events = this.collectedEvents.get(sessionId) || [];
        resolve(events);
      };

      // Error handler
      const onError = (event: OpenCodeEvent) => {
        cleanup();
        // 🔥 FIX: Properly serialize error object (was showing [object Object])
        const errorData = event.properties?.error;
        let errorMessage: string;
        if (typeof errorData === 'string') {
          errorMessage = errorData;
        } else if (errorData && typeof errorData === 'object') {
          // Try to extract meaningful error info
          errorMessage = (errorData as any).message || (errorData as any).error || JSON.stringify(errorData);
        } else {
          errorMessage = 'Unknown session error';
        }
        logger.error(`[EventBridge] Session error for ${sessionId}:`, errorData);
        reject(new Error(`Session error: ${errorMessage}`));
      };

      // Cleanup function
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.off(`event:${sessionId}`, onEvent);
        this.off(`session:idle:${sessionId}`, onIdle);
        this.off(`session:error:${sessionId}`, onError);
      };

      // Register listeners
      this.on(`event:${sessionId}`, onEvent);
      this.once(`session:idle:${sessionId}`, onIdle);
      this.once(`session:error:${sessionId}`, onError);

      logger.debug(`[EventBridge] Waiting for session ${sessionId} to become idle (timeout: ${timeout}ms)`);
    });
  }

  /**
   * Get collected events for a session (useful for getting events that arrived before waitForSessionIdle was called)
   */
  getSessionEvents(sessionId: string): OpenCodeEvent[] {
    return this.collectedEvents.get(sessionId) || [];
  }

  /**
   * Clear collected events for a session (call after processing)
   */
  clearSessionEvents(sessionId: string): void {
    this.collectedEvents.delete(sessionId);
  }

  /**
   * Map internal event types to frontend notification types
   */
  private mapToNotificationType(type: string): string {
    const mapping: Record<string, string> = {
      'task_update': 'task_update',
      'agent_completed': 'agent_completed',
      'agent_failed': 'agent_failed',
      'agent_progress': 'agent_progress',
      'agent_output': 'agent_message',
      'agent_message': 'agent_message',
      'tool_call': 'agent_progress',
      'tool_result': 'agent_progress',
      'tool_error': 'agent_failed',
      'file_activity': 'agent_progress',
      'command_running': 'agent_progress',
      'command_output': 'agent_progress',
      'command_complete': 'agent_progress',
    };
    return mapping[type] || 'agent_progress';
  }

  /**
   * Transform OpenCode events to frontend-friendly format
   */
  private transformEvent(event: OpenCodeEvent, taskId: string): { type: string; data: any } | null {
    const { type, properties } = event;

    switch (type) {
      // Session lifecycle
      case 'session.start':
        return {
          type: 'task_update',
          data: {
            taskId,
            status: 'running',
            message: 'Agent started working...',
          },
        };

      case 'session.idle':
        return {
          type: 'agent_completed',
          data: {
            taskId,
            message: 'Agent finished processing',
          },
        };

      case 'session.error':
        return {
          type: 'agent_failed',
          data: {
            taskId,
            error: properties?.error || 'Unknown error',
          },
        };

      // Message/response events (OpenCode SDK v2)
      case 'message.start':
        return {
          type: 'agent_progress',
          data: {
            taskId,
            phase: 'thinking',
            message: 'Agent is thinking...',
          },
        };

      // OpenCode SDK v2 uses message.part.updated for streaming content
      case 'message.part.updated':
        const part = properties?.part;

        // Debug: Log FULL part structure for tool events to understand OpenCode format
        if (part && part.type !== 'text') {
          logger.debug('Full tool part structure', { partType: part.type, part: JSON.stringify(part, null, 2).substring(0, 500) });
        }

        if (part?.type === 'text') {
          return {
            type: 'agent_output',
            data: {
              taskId,
              content: part.text || '',
              streaming: true,
            },
          };
        }
        // Tool use part - handle various possible type names
        // OpenCode sends: { type: 'tool', tool: 'glob', state: { status: 'running', input: {...} } }
        if (part?.type === 'tool-invocation' || part?.type === 'tool-result' ||
            part?.type === 'tool-use' || part?.type === 'tool_use' ||
            part?.type === 'tool' || // 🔥 Added 'tool' type
            part?.toolName || part?.tool) {
          const toolName = part.toolName || part.tool || part.name || 'tool';

          // 🔥 Handle state as object or string
          let toolStatus = '';
          let toolInput: any = {};

          if (typeof part.state === 'object' && part.state !== null) {
            // OpenCode format: state: { status: 'running', input: {...} }
            toolStatus = part.state.status || '';
            // Try multiple input locations
            toolInput = part.state.input || part.state.args || part.input || part.args || {};
          } else {
            // Legacy format: state is a string
            toolStatus = part.state || part.status || '';
            toolInput = part.input || part.args || {};
          }

          // 🔥 Use shared extractFilePath for consistent extraction across backend/frontend
          const extractedFilePath = extractFilePath({
            file_path: part.file_path || part.filePath || part.path || part.file,
            input: toolInput,
            content: part.content,
          } as Partial<ToolActivityEvent>);

          // 🔥 Normalize toolInput to always be an object with file_path for frontend
          if (extractedFilePath && (typeof toolInput !== 'object' || !toolInput.file_path)) {
            toolInput = typeof toolInput === 'object'
              ? { ...toolInput, file_path: extractedFilePath }
              : { file_path: extractedFilePath, raw: toolInput };
          }

          // Format tool info nicely
          let content = `🔧 ${toolName}`;
          if (toolStatus) content += ` (${toolStatus})`;

          // 🔥 Format input - prioritize extracted file path for file-related tools
          if (extractedFilePath && ['read', 'edit', 'write'].includes(toolName.toLowerCase())) {
            content += `: ${extractedFilePath}`;
          } else if (toolInput && typeof toolInput === 'object') {
            // For objects, show key info based on tool type
            if (toolName === 'glob' && toolInput.pattern) {
              content += `: ${toolInput.pattern}`;
            } else if (toolName === 'grep' && toolInput.pattern) {
              content += `: ${toolInput.pattern}`;
            } else if (toolName === 'bash' && toolInput.command) {
              content += `: ${toolInput.command.substring(0, 100)}`;
            } else if (toolName === 'question' && toolInput.questions) {
              content += `: ${toolInput.questions[0]?.question || 'asking...'}`;
            } else if (!extractedFilePath) {
              // Generic: show first key-value (skip if we already have file_path)
              const firstKey = Object.keys(toolInput).filter(k => k !== 'file_path' && k !== 'raw')[0];
              if (firstKey) {
                const val = toolInput[firstKey];
                const valStr = typeof val === 'string' ? val : JSON.stringify(val);
                content += `: ${valStr.substring(0, 100)}`;
              }
            }
          } else if (toolInput && typeof toolInput === 'string' && !extractedFilePath) {
            content += `: ${toolInput.substring(0, 150)}${toolInput.length > 150 ? '...' : ''}`;
          }

          return {
            type: 'tool_call',
            data: {
              taskId,
              content,
              tool: toolName,
              state: toolStatus,
              input: toolInput,
              // 🔥 Explicit file_path at top level for frontend
              file_path: extractedFilePath || undefined,
              streaming: true,
            },
          };
        }

        // step-finish contains cost/token info - useful for tracking
        if (part?.type === 'step-finish') {
          return {
            type: 'step_finish',
            data: {
              taskId,
              reason: part.reason,
              cost: part.cost,
              tokens: part.tokens,
            },
          };
        }

        // Unknown part type - skip silently (most are internal)
        return null;

      case 'message.delta':
      case 'message.chunk':
        return {
          type: 'agent_output',
          data: {
            taskId,
            content: properties?.content || properties?.text || '',
            streaming: true,
          },
        };

      case 'message.complete':
        return {
          type: 'agent_message',
          data: {
            taskId,
            content: properties?.content || '',
            role: 'assistant',
          },
        };

      // Tool usage (OpenCode SDK v2)
      case 'tool.execute.before':
      case 'tool.start':
        return {
          type: 'tool_call',
          data: {
            taskId,
            tool: properties?.tool || properties?.name,
            status: 'running',
            input: properties?.args || properties?.input,
          },
        };

      case 'tool.execute.after':
      case 'tool.complete':
        return {
          type: 'tool_result',
          data: {
            taskId,
            tool: properties?.tool || properties?.name,
            status: 'completed',
            output: properties?.result || properties?.output,
            success: properties?.success !== false,
          },
        };

      case 'tool.error':
        return {
          type: 'tool_error',
          data: {
            taskId,
            tool: properties?.tool || properties?.name,
            error: properties?.error,
          },
        };

      // File operations
      case 'file.read':
        return {
          type: 'file_activity',
          data: {
            taskId,
            action: 'read',
            path: properties?.path,
          },
        };

      case 'file.write':
      case 'file.edit':
        return {
          type: 'file_activity',
          data: {
            taskId,
            action: properties?.action || 'write',
            path: properties?.path,
          },
        };

      // Bash/command execution
      case 'bash.start':
      case 'command.start':
        return {
          type: 'command_running',
          data: {
            taskId,
            command: properties?.command,
          },
        };

      case 'bash.output':
      case 'command.output':
        return {
          type: 'command_output',
          data: {
            taskId,
            output: properties?.output || properties?.stdout,
            stderr: properties?.stderr,
          },
        };

      case 'bash.complete':
      case 'command.complete':
        return {
          type: 'command_complete',
          data: {
            taskId,
            exitCode: properties?.exitCode || properties?.exit_code,
          },
        };

      // 🔥 Question events - OpenCode is asking the user something
      case 'question.asked':
        return {
          type: 'question_asked',
          data: {
            taskId,
            questionId: properties?.questionId || properties?.id,
            question: properties?.question || properties?.text,
            options: properties?.options,
            required: properties?.required ?? true,
          },
        };

      case 'question.answered':
        return {
          type: 'question_answered',
          data: {
            taskId,
            questionId: properties?.questionId || properties?.id,
            answer: properties?.answer,
          },
        };

      // Heartbeat - ignore silently (no spam)
      case 'server.heartbeat':
        return null;

      // Session lifecycle events - ignore silently (handled elsewhere)
      case 'session.status':
      case 'session.updated':
      case 'session.diff':
        return null;

      // Message lifecycle events - ignore silently
      case 'message.updated':
      case 'message.part.added':
      case 'message.created':
        // These are usually followed by message.part.updated with actual content
        return null;

      default:
        // Unknown event type - log for debugging (but don't spam)
        if (type && !type.startsWith('server.') && !type.startsWith('session.')) {
          logger.debug(`[EventBridge] ⚠️ Unknown event type: ${type}`);
        }
        return null;
    }
  }

  /**
   * Get active sessions count
   */
  getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Check if a task has an active session
   */
  hasActiveSession(taskId: string): boolean {
    for (const session of this.activeSessions.values()) {
      if (session.taskId === taskId) return true;
    }
    return false;
  }

  /**
   * Unregister all sessions for a task (called when task completes/fails/cancels)
   */
  unregisterTaskSessions(taskId: string): void {
    const sessionsToRemove: string[] = [];
    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (session.taskId === taskId) {
        sessionsToRemove.push(sessionId);
      }
    }
    for (const sessionId of sessionsToRemove) {
      this.unregisterSession(sessionId);
    }
    if (sessionsToRemove.length > 0) {
      logger.debug(`[EventBridge] Unregistered ${sessionsToRemove.length} session(s) for task ${taskId}`);
    }
  }

  /**
   * Force stop all event loops (for shutdown)
   */
  async stop(): Promise<void> {
    // Stop the flush timer
    this.stopFlushTimer();

    // Flush any remaining activity logs before shutdown
    await this.flushAllActivityLogs();

    for (const sub of this.directorySubscriptions.values()) {
      sub.shouldStop = true;
    }
    this.directorySubscriptions.clear();
    this.activeSessions.clear();
    this.pendingActivityLogs.clear();
    console.log('[EventBridge] Forced stop (flushed pending logs)');
  }
}

export const openCodeEventBridge = new OpenCodeEventBridgeService();
export default openCodeEventBridge;
