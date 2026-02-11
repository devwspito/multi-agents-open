/**
 * Task Repository
 *
 * Manages orchestration tasks (PostgreSQL)
 */

import { postgresService } from '../postgres/PostgresService.js';
import { Task, TaskStatus } from '../../types/index.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface CreateTaskParams {
  userId: string;
  projectId?: string;
  repositoryId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
}

export interface UpdateTaskParams {
  title?: string;
  description?: string;
  status?: TaskStatus;
}

interface TaskRow {
  id: string;
  user_id: string;
  project_id: string | null;
  repository_id: string | null;
  title: string;
  description: string | null;
  status: string;
  branch_name: string | null;
  analysis: any | null;
  stories: any | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: Date;
  updated_at: Date;
  // 🔥 RESUME fields
  completed_phases: string[] | null;
  current_phase: string | null;
  current_step: number | null;
  current_agent: string | null;
  last_completed_story_index: number | null;
  // 🔥 PLANNING: Store full planning result for ML training
  planning_result: any | null;
  // 🔥 COST tracking - persisted for recovery after server restart
  total_cost: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  // 🔥 Failure reason - shown to user when task fails
  failure_reason: string | null;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id || undefined,
    repositoryId: row.repository_id || undefined,
    title: row.title,
    description: row.description || undefined,
    status: row.status as TaskStatus,
    branchName: row.branch_name || undefined,
    analysis: row.analysis || undefined,
    stories: row.stories || undefined,
    prNumber: row.pr_number || undefined,
    prUrl: row.pr_url || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 🔥 RESUME fields
    completedPhases: row.completed_phases || undefined,
    currentPhase: row.current_phase || undefined,
    currentStep: row.current_step ?? undefined,
    currentAgent: row.current_agent || undefined,
    lastCompletedStoryIndex: row.last_completed_story_index ?? undefined,
    // 🔥 PLANNING: For ML training
    planningResult: row.planning_result || undefined,
    // 🔥 COST tracking - recoverable after server restart
    totalCost: row.total_cost ? parseFloat(row.total_cost) : undefined,
    totalInputTokens: row.total_input_tokens || undefined,
    totalOutputTokens: row.total_output_tokens || undefined,
    // 🔥 Failure reason
    failureReason: row.failure_reason || undefined,
  };
}

export class TaskRepository {
  /**
   * Create a new task
   */
  static async create(params: CreateTaskParams): Promise<Task> {
    const id = generateId();
    const status = params.status || 'pending';

    await postgresService.query(
      `INSERT INTO tasks (id, user_id, project_id, repository_id, title, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, params.userId, params.projectId || null, params.repositoryId || null, params.title, params.description || null, status]
    );

    const task = await this.findById(id);
    return task!;
  }

  /**
   * Find task by ID
   */
  static async findById(id: string): Promise<Task | null> {
    const result = await postgresService.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Find all tasks
   */
  static async findAll(options: {
    projectId?: string;
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<Task[]> {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options.projectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    }

    if (options.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    if (options.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }

    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await postgresService.query<TaskRow>(query, params);
    return result.rows.map(mapRow);
  }

  /**
   * Update task
   */
  static async update(id: string, params: UpdateTaskParams): Promise<Task | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updates: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let paramIndex = 1;

    if (params.title !== undefined) {
      updates.push(`title = $${paramIndex}`);
      values.push(params.title);
      paramIndex++;
    }

    if (params.description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(params.description);
      paramIndex++;
    }

    if (params.status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      values.push(params.status);
      paramIndex++;
    }

    values.push(id);

    await postgresService.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    return this.findById(id);
  }

  /**
   * Update task status
   */
  static async updateStatus(id: string, status: TaskStatus): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  /**
   * 🔥 Set task as failed with reason - shows user why it failed
   */
  static async setFailed(id: string, reason: string): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3',
      ['failed', reason, id]
    );
  }

  /**
   * Set branch name for task
   */
  static async setBranchName(id: string, branchName: string): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET branch_name = $1, updated_at = NOW() WHERE id = $2',
      [branchName, id]
    );
  }

  /**
   * Set analysis result for task
   */
  static async setAnalysis(id: string, analysis: any): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET analysis = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(analysis), id]
    );
  }

  /**
   * Set stories for task
   */
  static async setStories(id: string, stories: any[]): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET stories = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(stories), id]
    );
  }

  /**
   * 🔥 PLANNING: Save planning result for ML training (Sentinental + Specialists)
   * Stores uxFlows, plannedTasks, clarifications, enrichedPrompt
   */
  static async savePlanningResult(id: string, planningResult: any): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET planning_result = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(planningResult), id]
    );
  }

  /**
   * Set PR info for task
   */
  static async setPullRequest(id: string, prNumber: number, prUrl: string): Promise<void> {
    await postgresService.query(
      'UPDATE tasks SET pr_number = $1, pr_url = $2, updated_at = NOW() WHERE id = $3',
      [prNumber, prUrl, id]
    );
  }

  /**
   * Update orchestration data after analysis phase
   */
  static async updateAfterAnalysis(
    id: string,
    data: { branchName: string; analysis: any; stories: any[] }
  ): Promise<void> {
    await postgresService.query(
      `UPDATE tasks SET
        branch_name = $1,
        analysis = $2,
        stories = $3,
        updated_at = NOW()
       WHERE id = $4`,
      [data.branchName, JSON.stringify(data.analysis), JSON.stringify(data.stories), id]
    );
  }

  /**
   * 🔥 RESUME: Mark a phase as completed (for resume after restart)
   * Now stores approved data with each phase for display regardless of task status
   */
  static async markPhaseComplete(id: string, phase: string, approvedData?: Record<string, any>): Promise<void> {
    // 🔥 Store phase with its approved data as an object, not just a string
    const phaseEntry = {
      phase,
      completedAt: new Date().toISOString(),
      approvedData: approvedData || null,
    };

    await postgresService.query(
      `UPDATE tasks SET
        completed_phases = COALESCE(completed_phases, '[]'::jsonb) || $1::jsonb,
        current_phase = NULL,
        updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([phaseEntry]), id]
    );
  }

  /**
   * 🔥 RESUME: Set current phase being executed
   */
  static async setCurrentPhase(id: string, phase: string): Promise<void> {
    await postgresService.query(
      `UPDATE tasks SET
        current_phase = $1,
        updated_at = NOW()
       WHERE id = $2`,
      [phase, id]
    );
  }

  /**
   * 🔥 RESUME: Set current step and agent for precise resume
   * Allows resuming a phase at the exact step where it was interrupted
   */
  static async setCurrentStep(id: string, step: number, agent: string): Promise<void> {
    await postgresService.query(
      `UPDATE tasks SET
        current_step = $1,
        current_agent = $2,
        updated_at = NOW()
       WHERE id = $3`,
      [step, agent, id]
    );
  }

  /**
   * 🔥 RESUME: Set last completed story index (for Developer phase resume)
   */
  static async setLastCompletedStoryIndex(id: string, index: number): Promise<void> {
    await postgresService.query(
      `UPDATE tasks SET
        last_completed_story_index = $1,
        updated_at = NOW()
       WHERE id = $2`,
      [index, id]
    );
  }

  /**
   * 🔥 RESUME: Clear resume state when task completes or is cancelled
   * NOTE: We do NOT clear completed_phases - that's historical data for viewing!
   */
  static async clearResumeState(id: string): Promise<void> {
    await postgresService.query(
      `UPDATE tasks SET
        current_phase = NULL,
        current_step = NULL,
        current_agent = NULL,
        last_completed_story_index = NULL,
        updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Delete task
   */
  static async delete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM tasks WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get task statistics
   */
  static async getStats(): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  }> {
    const result = await postgresService.query<{
      total: string;
      pending: string;
      running: string;
      completed: string;
      failed: string;
    }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `);

    const row = result.rows[0];
    return {
      total: parseInt(row.total, 10) || 0,
      pending: parseInt(row.pending, 10) || 0,
      running: parseInt(row.running, 10) || 0,
      completed: parseInt(row.completed, 10) || 0,
      failed: parseInt(row.failed, 10) || 0,
    };
  }

  /**
   * Fix #4: Recover stale running tasks on server restart
   * Marks tasks that were 'running' or 'paused' as 'interrupted'
   * Should be called during server initialization
   */
  static async recoverStaleTasks(): Promise<number> {
    const result = await postgresService.query(`
      UPDATE tasks
      SET status = 'interrupted', updated_at = NOW()
      WHERE status IN ('running', 'paused')
    `);

    const changes = result.rowCount ?? 0;
    if (changes > 0) {
      console.log(`[TaskRepository] Recovered ${changes} stale task(s) from previous session`);
    }

    return changes;
  }

  // ============================================
  // ACTIVITY LOG METHODS
  // ============================================

  /**
   * Append an activity log entry to a task
   * Stores important events for replay when page refreshes
   */
  static async appendActivityLog(taskId: string, entry: {
    type: string;
    content: string;
    timestamp?: string;
    tool?: string;
    toolState?: string;
  }): Promise<void> {
    const logEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    await postgresService.query(`
      UPDATE tasks
      SET activity_log = COALESCE(activity_log, '[]'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
    `, [taskId, JSON.stringify([logEntry])]);
  }

  /**
   * Append multiple activity log entries at once (more efficient)
   */
  static async appendActivityLogs(taskId: string, entries: Array<{
    type: string;
    content: string;
    timestamp?: string;
    tool?: string;
    toolState?: string;
    toolInput?: any;  // Full tool input for ML training (old_string, new_string, file_path)
    toolOutput?: any; // Tool result/output
  }>): Promise<void> {
    if (entries.length === 0) return;

    const logEntries = entries.map(entry => ({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    }));

    await postgresService.query(`
      UPDATE tasks
      SET activity_log = COALESCE(activity_log, '[]'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
    `, [taskId, JSON.stringify(logEntries)]);
  }

  /**
   * Get activity logs for a task
   * Returns full event data including tool input/output for ML training
   */
  static async getActivityLog(taskId: string): Promise<Array<{
    type: string;
    content: string;
    timestamp: string;
    tool?: string;
    toolState?: string;
    toolInput?: any;   // Full tool input (old_string, new_string, file_path, command, etc.)
    toolOutput?: any;  // Tool result/output
  }>> {
    const result = await postgresService.query<{ activity_log: any }>(
      `SELECT activity_log FROM tasks WHERE id = $1`,
      [taskId]
    );
    return result.rows[0]?.activity_log || [];
  }

  /**
   * Clear activity logs for a task (e.g., when task is restarted)
   */
  static async clearActivityLog(taskId: string): Promise<void> {
    await postgresService.query(`
      UPDATE tasks SET activity_log = '[]'::jsonb, updated_at = NOW() WHERE id = $1
    `, [taskId]);
  }
}

export default TaskRepository;
