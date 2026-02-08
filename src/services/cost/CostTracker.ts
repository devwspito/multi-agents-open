/**
 * Cost Tracker Service
 *
 * Accumulates costs from OpenCode step_finish events in real-time.
 * Tracks costs per task, session, and story.
 *
 * Data structure from OpenCode step_finish:
 * {
 *   cost: number,        // USD
 *   tokens: {
 *     input: number,
 *     output: number
 *   }
 * }
 */

import { socketService } from '../realtime/SocketService.js';

export interface CostData {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  lastUpdated: Date;
}

export interface TaskCostSummary {
  taskId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessions: Map<string, SessionCostSummary>;
  lastUpdated: Date;
}

export interface SessionCostSummary {
  sessionId: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  storyId?: string;
  phase?: string;
}

class CostTrackerClass {
  // taskId -> TaskCostSummary
  private taskCosts: Map<string, TaskCostSummary> = new Map();

  /**
   * Record a cost event from step_finish
   */
  recordCost(
    taskId: string,
    sessionId: string,
    costData: { cost?: number; tokens?: { input?: number; output?: number } },
    metadata?: { storyId?: string; phase?: string }
  ): void {
    const cost = costData.cost || 0;
    const inputTokens = costData.tokens?.input || 0;
    const outputTokens = costData.tokens?.output || 0;

    // Skip if no cost data
    if (cost === 0 && inputTokens === 0 && outputTokens === 0) {
      return;
    }

    // Get or create task summary
    let taskSummary = this.taskCosts.get(taskId);
    if (!taskSummary) {
      taskSummary = {
        taskId,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        sessions: new Map(),
        lastUpdated: new Date(),
      };
      this.taskCosts.set(taskId, taskSummary);
    }

    // Get or create session summary
    let sessionSummary = taskSummary.sessions.get(sessionId);
    if (!sessionSummary) {
      sessionSummary = {
        sessionId,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        storyId: metadata?.storyId,
        phase: metadata?.phase,
      };
      taskSummary.sessions.set(sessionId, sessionSummary);
    }

    // Accumulate costs
    sessionSummary.cost += cost;
    sessionSummary.inputTokens += inputTokens;
    sessionSummary.outputTokens += outputTokens;

    taskSummary.totalCost += cost;
    taskSummary.totalInputTokens += inputTokens;
    taskSummary.totalOutputTokens += outputTokens;
    taskSummary.lastUpdated = new Date();

    // Emit real-time update to frontend
    this.emitCostUpdate(taskId, taskSummary);

    // Log significant cost changes (every $0.01)
    if (Math.floor(taskSummary.totalCost * 100) !== Math.floor((taskSummary.totalCost - cost) * 100)) {
      console.log(`[CostTracker] Task ${taskId}: $${taskSummary.totalCost.toFixed(4)} (${taskSummary.totalInputTokens + taskSummary.totalOutputTokens} tokens)`);
    }
  }

  /**
   * Emit cost update to frontend via WebSocket
   */
  private emitCostUpdate(taskId: string, summary: TaskCostSummary): void {
    socketService.toTask(taskId, 'cost:update', {
      taskId,
      totalCost: summary.totalCost,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      sessionsCount: summary.sessions.size,
      lastUpdated: summary.lastUpdated.toISOString(),
    });
  }

  /**
   * Get cost summary for a task
   */
  getTaskCost(taskId: string): TaskCostSummary | null {
    return this.taskCosts.get(taskId) || null;
  }

  /**
   * Get cost summary for a session
   */
  getSessionCost(taskId: string, sessionId: string): SessionCostSummary | null {
    const taskSummary = this.taskCosts.get(taskId);
    if (!taskSummary) return null;
    return taskSummary.sessions.get(sessionId) || null;
  }

  /**
   * Get all sessions costs for a task (for API response)
   */
  getTaskCostDetails(taskId: string): {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    sessions: SessionCostSummary[];
  } | null {
    const taskSummary = this.taskCosts.get(taskId);
    if (!taskSummary) {
      return null;
    }

    return {
      totalCost: taskSummary.totalCost,
      totalInputTokens: taskSummary.totalInputTokens,
      totalOutputTokens: taskSummary.totalOutputTokens,
      sessions: Array.from(taskSummary.sessions.values()),
    };
  }

  /**
   * Clear cost data for a task (when task completes)
   */
  clearTask(taskId: string): void {
    this.taskCosts.delete(taskId);
  }

  /**
   * Get all active task costs (for debugging/admin)
   */
  getAllTaskCosts(): Map<string, TaskCostSummary> {
    return new Map(this.taskCosts);
  }
}

export const costTracker = new CostTrackerClass();
export default costTracker;
