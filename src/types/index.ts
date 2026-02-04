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
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Story status for tracking progress
 */
export type StoryStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Story - A small unit of work within a task
 * Each story should be implementable in ~5-20 lines of code
 */
export interface Story {
  id: string;
  title: string;
  description: string;
  status: StoryStatus;
  /** Files that need to be modified */
  filesToModify?: string[];
  /** Files that need to be created */
  filesToCreate?: string[];
  /** Files to read for context */
  filesToRead?: string[];
  /** Acceptance criteria */
  acceptanceCriteria?: string[];
  /** Development output after implementation */
  developmentOutput?: string;
  /** Judge verdict */
  judgeVerdict?: 'approved' | 'rejected' | 'needs_revision';
  /** Judge score 0-100 */
  judgeScore?: number;
  /** Issues found by judge */
  judgeIssues?: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    file: string;
    description: string;
    suggestion?: string;
  }>;
}

/**
 * Repository info for multi-repo support
 * Passed to phases so OpenCode knows about all repos and their types
 */
export interface RepositoryInfo {
  id: string;
  name: string;
  type: 'backend' | 'frontend' | 'shared' | 'infrastructure' | 'docs' | string;
  /** Local path where the repo is cloned (within task workspace) */
  localPath: string;
  /** GitHub URL for reference */
  githubUrl: string;
  /** Branch being used */
  branch: string;
  /** Description of what this repo contains */
  description?: string;
  /** Execution order (lower = first) */
  executionOrder?: number;
}

/**
 * Task definition
 */
export interface Task {
  id: string;
  userId?: string;
  projectId?: string;
  repositoryId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Stories broken down from the task */
  stories?: Story[];
  /** Current story index being processed */
  currentStoryIndex?: number;
  createdAt: Date;
  updatedAt: Date;
}
