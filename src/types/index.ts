/**
 * Shared Types for Open Multi-Agents
 *
 * Core types used across the system.
 * OpenCode SDK handles LLM-specific types internally.
 */

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
