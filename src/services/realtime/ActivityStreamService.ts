/**
 * Activity Stream Service
 *
 * Real-time activity streaming to frontend with:
 * - Event batching (reduce WebSocket messages)
 * - Throttling (avoid flooding)
 * - Activity categorization
 * - History buffer for reconnecting clients
 */

import { socketService } from './SocketService.js';
import { SOCKET_EVENTS } from '../../constants.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';

// ============================================================================
// TYPES
// ============================================================================

export type ActivityType =
  | 'phase_start'
  | 'phase_complete'
  | 'phase_failed'
  | 'story_start'
  | 'story_complete'
  | 'story_failed'
  | 'tool_call'
  | 'tool_result'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command_run'
  | 'thinking'
  | 'output'
  | 'approval_required'
  | 'approval_received'
  | 'error'
  | 'warning'
  | 'info';

export interface Activity {
  id: string;
  taskId: string;
  type: ActivityType;
  phase?: string;
  storyId?: string;
  content: string;
  details?: Record<string, any>;
  timestamp: Date;
}

export interface ActivityBatch {
  taskId: string;
  activities: Activity[];
  batchedAt: Date;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Batch activities every N milliseconds
  BATCH_INTERVAL_MS: 100,
  // Max activities per batch
  MAX_BATCH_SIZE: 50,
  // History buffer size per task
  HISTORY_BUFFER_SIZE: 200,
  // Throttle high-frequency events (tool_call, thinking)
  HIGH_FREQ_THROTTLE_MS: 50,
};

// ============================================================================
// ACTIVITY STREAM SERVICE
// ============================================================================

class ActivityStreamServiceClass {
  // Pending activities per task (for batching)
  private pendingActivities: Map<string, Activity[]> = new Map();
  // Batch timers per task
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  // Activity history buffer per task (for reconnecting clients)
  private historyBuffer: Map<string, Activity[]> = new Map();
  // Last emit time per activity type (for throttling)
  private lastEmitTime: Map<string, number> = new Map();
  // Activity counter for generating IDs
  private activityCounter = 0;

  /**
   * Stream an activity to the frontend
   */
  stream(
    taskId: string,
    type: ActivityType,
    content: string,
    options: {
      phase?: string;
      storyId?: string;
      details?: Record<string, any>;
      immediate?: boolean; // Skip batching
    } = {}
  ): void {
    const activity: Activity = {
      id: `act-${Date.now()}-${++this.activityCounter}`,
      taskId,
      type,
      phase: options.phase,
      storyId: options.storyId,
      content,
      details: options.details,
      timestamp: new Date(),
    };

    // Check throttling for high-frequency events
    if (this.shouldThrottle(taskId, type)) {
      return;
    }

    // Add to history buffer
    this.addToHistory(taskId, activity);

    // Immediate emit for important events
    if (options.immediate || this.isHighPriorityEvent(type)) {
      this.emitActivities(taskId, [activity]);
      return;
    }

    // Add to batch
    if (!this.pendingActivities.has(taskId)) {
      this.pendingActivities.set(taskId, []);
    }
    this.pendingActivities.get(taskId)!.push(activity);

    // Schedule batch flush
    this.scheduleBatchFlush(taskId);
  }

  /**
   * Stream a phase start event
   */
  phaseStart(taskId: string, phase: string, details?: Record<string, any>): void {
    this.stream(taskId, 'phase_start', `Starting ${phase} phase`, {
      phase,
      details,
      immediate: true,
    });
  }

  /**
   * Stream a phase complete event
   */
  phaseComplete(taskId: string, phase: string, result?: Record<string, any>): void {
    this.stream(taskId, 'phase_complete', `${phase} phase completed`, {
      phase,
      details: result,
      immediate: true,
    });
  }

  /**
   * Stream a phase failed event
   */
  phaseFailed(taskId: string, phase: string, error: string): void {
    this.stream(taskId, 'phase_failed', `${phase} phase failed: ${error}`, {
      phase,
      details: { error },
      immediate: true,
    });
  }

  /**
   * Stream a story progress event
   */
  storyProgress(
    taskId: string,
    storyId: string,
    storyTitle: string,
    status: 'start' | 'complete' | 'failed',
    details?: Record<string, any>
  ): void {
    const type = status === 'start' ? 'story_start' : status === 'complete' ? 'story_complete' : 'story_failed';
    this.stream(taskId, type, `Story: ${storyTitle}`, {
      storyId,
      phase: 'Developer',
      details: { storyTitle, status, ...details },
      immediate: true,
    });
  }

  /**
   * Stream a tool call event
   */
  toolCall(taskId: string, toolName: string, phase?: string): void {
    this.stream(taskId, 'tool_call', `Calling ${toolName}`, {
      phase,
      details: { toolName },
    });
  }

  /**
   * Stream a tool result event
   */
  toolResult(taskId: string, toolName: string, success: boolean, phase?: string): void {
    this.stream(taskId, 'tool_result', `${toolName}: ${success ? 'success' : 'failed'}`, {
      phase,
      details: { toolName, success },
    });
  }

  /**
   * Stream a file operation event
   */
  fileOperation(
    taskId: string,
    operation: 'read' | 'write' | 'edit',
    filePath: string,
    phase?: string
  ): void {
    const type = operation === 'read' ? 'file_read' : operation === 'write' ? 'file_write' : 'file_edit';
    const shortPath = filePath.split('/').slice(-2).join('/');
    this.stream(taskId, type, `${operation}: ${shortPath}`, {
      phase,
      details: { operation, filePath },
    });
  }

  /**
   * Stream a command run event
   */
  commandRun(taskId: string, command: string, phase?: string): void {
    const shortCommand = command.length > 50 ? command.substring(0, 47) + '...' : command;
    this.stream(taskId, 'command_run', `Running: ${shortCommand}`, {
      phase,
      details: { command },
    });
  }

  /**
   * Stream thinking/reasoning output
   */
  thinking(taskId: string, content: string, phase?: string): void {
    this.stream(taskId, 'thinking', content.substring(0, 200), {
      phase,
      details: { fullContent: content },
    });
  }

  /**
   * Stream general output
   */
  output(taskId: string, content: string, phase?: string): void {
    this.stream(taskId, 'output', content, { phase });
  }

  /**
   * Stream an error
   */
  error(taskId: string, error: string, phase?: string): void {
    this.stream(taskId, 'error', error, { phase, immediate: true });
  }

  /**
   * Stream a warning
   */
  warning(taskId: string, message: string, phase?: string): void {
    this.stream(taskId, 'warning', message, { phase });
  }

  /**
   * Stream info message
   */
  info(taskId: string, message: string, phase?: string): void {
    this.stream(taskId, 'info', message, { phase });
  }

  /**
   * Get activity history for a task (for reconnecting clients)
   */
  getHistory(taskId: string, limit?: number): Activity[] {
    const history = this.historyBuffer.get(taskId) || [];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Clear history for a completed task
   */
  clearHistory(taskId: string): void {
    this.historyBuffer.delete(taskId);
    this.pendingActivities.delete(taskId);
    const timer = this.batchTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(taskId);
    }
  }

  /**
   * Flush all pending activities for a task
   */
  flush(taskId: string): void {
    const pending = this.pendingActivities.get(taskId);
    if (pending && pending.length > 0) {
      this.emitActivities(taskId, pending);
      this.pendingActivities.set(taskId, []);
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private shouldThrottle(taskId: string, type: ActivityType): boolean {
    // Only throttle high-frequency events
    const highFreqTypes: ActivityType[] = ['tool_call', 'thinking', 'output'];
    if (!highFreqTypes.includes(type)) {
      return false;
    }

    const key = `${taskId}:${type}`;
    const now = Date.now();
    const lastTime = this.lastEmitTime.get(key) || 0;

    if (now - lastTime < CONFIG.HIGH_FREQ_THROTTLE_MS) {
      return true;
    }

    this.lastEmitTime.set(key, now);
    return false;
  }

  private isHighPriorityEvent(type: ActivityType): boolean {
    const highPriority: ActivityType[] = [
      'phase_start',
      'phase_complete',
      'phase_failed',
      'story_start',
      'story_complete',
      'story_failed',
      'approval_required',
      'approval_received',
      'error',
    ];
    return highPriority.includes(type);
  }

  private addToHistory(taskId: string, activity: Activity): void {
    if (!this.historyBuffer.has(taskId)) {
      this.historyBuffer.set(taskId, []);
    }
    const history = this.historyBuffer.get(taskId)!;
    history.push(activity);

    // Trim if exceeds buffer size
    if (history.length > CONFIG.HISTORY_BUFFER_SIZE) {
      history.splice(0, history.length - CONFIG.HISTORY_BUFFER_SIZE);
    }

    // 🔥 PERSIST: Save ALL activities to DB for page refresh recovery
    // No filtering - save everything for comprehensive history
    this.persistActivity(taskId, activity);
  }

  /**
   * 🔥 Persist activity to database for page refresh recovery
   */
  private persistActivity(taskId: string, activity: Activity): void {
    TaskRepository.appendActivityLog(taskId, {
      type: activity.type,
      content: activity.content.substring(0, 5000),
      timestamp: activity.timestamp.toISOString(),
      tool: activity.details?.toolName,
      toolInput: activity.details,
    }).catch(err => {
      console.warn(`[ActivityStream] Failed to persist activity: ${err.message}`);
    });
  }

  private scheduleBatchFlush(taskId: string): void {
    // Already scheduled
    if (this.batchTimers.has(taskId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.batchTimers.delete(taskId);
      const pending = this.pendingActivities.get(taskId) || [];

      if (pending.length > 0) {
        // Split into chunks if too large
        while (pending.length > 0) {
          const batch = pending.splice(0, CONFIG.MAX_BATCH_SIZE);
          this.emitActivities(taskId, batch);
        }
      }
    }, CONFIG.BATCH_INTERVAL_MS);

    this.batchTimers.set(taskId, timer);
  }

  private emitActivities(taskId: string, activities: Activity[]): void {
    if (activities.length === 0) return;

    const batch: ActivityBatch = {
      taskId,
      activities,
      batchedAt: new Date(),
    };

    // Emit batch to task room
    socketService.toTask(taskId, 'activity:batch', batch);

    // Also emit individual events for backward compatibility
    for (const activity of activities) {
      socketService.toTask(taskId, SOCKET_EVENTS.AGENT_ACTIVITY, activity);
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const activityStream = new ActivityStreamServiceClass();
export default activityStream;
