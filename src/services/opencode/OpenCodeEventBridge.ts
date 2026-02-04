/**
 * OpenCode Event Bridge
 *
 * Subscribes to OpenCode events and forwards them to the frontend
 * via WebSocket (socketService).
 *
 * This bridges the gap between:
 * - OpenCode SSE events (agent activity, tool calls, etc.)
 * - Frontend WebSocket (real-time UI updates)
 */

import { openCodeClient, OpenCodeEvent } from './OpenCodeClient.js';
import { socketService } from '../realtime/SocketService.js';

interface TaskSession {
  taskId: string;
  sessionId: string;
  startedAt: Date;
}

class OpenCodeEventBridgeService {
  private activeSessions: Map<string, TaskSession> = new Map(); // sessionId -> task info
  private eventLoopRunning = false;

  /**
   * Register a task's OpenCode session for event forwarding
   */
  registerSession(taskId: string, sessionId: string): void {
    this.activeSessions.set(sessionId, {
      taskId,
      sessionId,
      startedAt: new Date(),
    });

    console.log(`[EventBridge] Registered session ${sessionId} for task ${taskId}`);

    // Start event loop if not running
    if (!this.eventLoopRunning) {
      this.startEventLoop();
    }
  }

  /**
   * Unregister a session (task completed/cancelled)
   */
  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    console.log(`[EventBridge] Unregistered session ${sessionId}`);
  }

  /**
   * Start listening to OpenCode events and forwarding to frontend
   */
  private async startEventLoop(): Promise<void> {
    if (this.eventLoopRunning) return;
    this.eventLoopRunning = true;

    console.log('[EventBridge] Starting event loop...');

    try {
      console.log('[EventBridge] Subscribing to OpenCode events...');
      for await (const event of openCodeClient.subscribeToEvents()) {
        console.log(`[EventBridge] >>> RAW EVENT: ${event.type}`);
        this.handleEvent(event);
      }
      console.log('[EventBridge] Event stream ended');
    } catch (error: any) {
      console.error('[EventBridge] Event loop error:', error.message);
      this.eventLoopRunning = false;

      // Retry after delay if there are active sessions
      if (this.activeSessions.size > 0) {
        setTimeout(() => this.startEventLoop(), 5000);
      }
    }
  }

  /**
   * Handle an OpenCode event and forward to frontend
   */
  private handleEvent(event: OpenCodeEvent): void {
    // Log ALL events for debugging
    console.log(`[EventBridge] Event received: ${event.type}`, JSON.stringify(event.properties || {}).slice(0, 200));

    const sessionId = event.properties?.sessionID;
    if (!sessionId) {
      console.log(`[EventBridge] Event has no sessionID, skipping`);
      return;
    }

    const taskSession = this.activeSessions.get(sessionId);
    if (!taskSession) {
      console.log(`[EventBridge] Session ${sessionId} not tracked, skipping`);
      return;
    }

    const { taskId } = taskSession;
    console.log(`[EventBridge] Forwarding event ${event.type} to task ${taskId}`);

    // Transform OpenCode event to frontend-friendly format
    const frontendEvent = this.transformEvent(event, taskId);
    if (!frontendEvent) return;

    // Send as the specific event type
    socketService.toTask(taskId, frontendEvent.type, frontendEvent.data);

    // Also send as 'agent:activity' for the Activity tab (frontend compatibility)
    const activity = {
      id: `activity-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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
        // Tool use part
        if (part?.type === 'tool-invocation' || part?.type === 'tool-result') {
          return {
            type: 'agent_output',
            data: {
              taskId,
              content: `[${part.toolName || 'tool'}] ${part.state || ''}`,
              streaming: true,
              toolInfo: {
                name: part.toolName,
                state: part.state,
              },
            },
          };
        }
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

      default:
        // Unknown event type - log but don't forward
        if (process.env.NODE_ENV === 'development') {
          console.log(`[EventBridge] Unhandled event type: ${type}`, properties);
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
}

export const openCodeEventBridge = new OpenCodeEventBridgeService();
export default openCodeEventBridge;
