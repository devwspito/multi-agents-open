/**
 * Cost Tracker Service
 *
 * Accumulates costs from OpenCode step_finish events in real-time.
 * Tracks costs per task, session, and story.
 * Persists final costs to database when task completes.
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
import { postgresService } from '../../database/postgres/PostgresService.js';
import { logger } from '../logging/Logger.js';

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
    const prevCostCents = Math.floor((taskSummary.totalCost - cost) * 100);
    const newCostCents = Math.floor(taskSummary.totalCost * 100);
    if (newCostCents !== prevCostCents) {
      logger.cost(taskId, taskSummary.totalCost, taskSummary.totalInputTokens, taskSummary.totalOutputTokens);

      // 🔥 Persist to DB on every $0.01 increment to prevent data loss on server restart
      // This ensures cost is always recoverable even if server crashes
      this.persistCostToDb(taskId).catch(err => {
        logger.error('Failed to persist cost during update', err, { taskId, event: 'cost_persist_failed' });
      });
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
   * Save cost to database (call when task completes)
   */
  async persistCostToDb(taskId: string): Promise<void> {
    const taskSummary = this.taskCosts.get(taskId);
    if (!taskSummary) {
      return;
    }

    try {
      await postgresService.query(
        `UPDATE tasks SET
          total_cost = $1,
          total_input_tokens = $2,
          total_output_tokens = $3
         WHERE id = $4`,
        [
          taskSummary.totalCost,
          taskSummary.totalInputTokens,
          taskSummary.totalOutputTokens,
          taskId,
        ]
      );
      logger.info('Cost persisted to database', { taskId, cost: taskSummary.totalCost, event: 'cost_persisted' });
    } catch (error) {
      logger.error('Failed to persist cost', error as Error, { taskId, event: 'cost_persist_failed' });
    }
  }

  /**
   * Load cost from database (for completed tasks)
   */
  async loadCostFromDb(taskId: string): Promise<{
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } | null> {
    try {
      const result = await postgresService.query<{
        total_cost: string | null;
        total_input_tokens: number | null;
        total_output_tokens: number | null;
      }>(
        `SELECT total_cost, total_input_tokens, total_output_tokens FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        totalCost: parseFloat(row.total_cost || '0'),
        totalInputTokens: row.total_input_tokens || 0,
        totalOutputTokens: row.total_output_tokens || 0,
      };
    } catch (error) {
      logger.error('Failed to load cost from database', error as Error, { taskId, event: 'cost_load_failed' });
      return null;
    }
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
   * Checks memory first, then database
   */
  async getTaskCostDetailsAsync(taskId: string): Promise<{
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    sessions: SessionCostSummary[];
  } | null> {
    // First check in-memory (for running tasks)
    const taskSummary = this.taskCosts.get(taskId);
    if (taskSummary) {
      return {
        totalCost: taskSummary.totalCost,
        totalInputTokens: taskSummary.totalInputTokens,
        totalOutputTokens: taskSummary.totalOutputTokens,
        sessions: Array.from(taskSummary.sessions.values()),
      };
    }

    // Fall back to database (for completed tasks)
    const dbCost = await this.loadCostFromDb(taskId);
    if (dbCost) {
      return {
        ...dbCost,
        sessions: [], // Session details not persisted
      };
    }

    return null;
  }

  /**
   * Get all sessions costs for a task (synchronous version for backward compat)
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
   * Persists to DB before clearing from memory
   */
  async clearTask(taskId: string): Promise<void> {
    // Persist to database before clearing
    await this.persistCostToDb(taskId);
    this.taskCosts.delete(taskId);
  }

  /**
   * Get all active task costs (for debugging/admin)
   */
  getAllTaskCosts(): Map<string, TaskCostSummary> {
    return new Map(this.taskCosts);
  }
}

// Export class for testing
export { CostTrackerClass };

export const costTracker = new CostTrackerClass();
export default costTracker;
