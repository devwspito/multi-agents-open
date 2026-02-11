/**
 * Task Context Builder
 *
 * Extracts and formats context from a completed task to be injected
 * into a new task's prompt for continuation.
 *
 * OpenCode handles context compaction automatically when needed.
 */

import { Task } from '../../types/index.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';

export interface TaskContext {
  /** Original task ID for reference */
  originalTaskId: string;
  /** Original task description/prompt */
  originalPrompt: string;
  /** Stories generated during analysis */
  stories: Array<{
    id: string;
    title: string;
    status: string;
    description?: string;
  }>;
  /** Branch name created */
  branchName?: string;
  /** PR info if created */
  pr?: {
    number: number;
    url: string;
  };
  /** Summary of analysis results */
  analysisSummary?: string;
  /** Key files modified (extracted from activity log) */
  filesModified: string[];
  /** Final status */
  finalStatus: string;
}

/**
 * Build a structured context from a completed task
 */
export async function buildTaskContext(taskId: string): Promise<TaskContext | null> {
  const task = await TaskRepository.findById(taskId);
  if (!task) {
    return null;
  }

  // Extract stories summary
  const stories = (task.stories || []).map((story: any) => ({
    id: story.id || story.storyId,
    title: story.title || story.name,
    status: story.status || 'unknown',
    description: story.description?.substring(0, 200),
  }));

  // Extract files modified from activity log
  const activityLog = await TaskRepository.getActivityLog(taskId);
  const filesModified = extractFilesFromActivityLog(activityLog);

  // Build analysis summary
  const analysisSummary = task.analysis
    ? buildAnalysisSummary(task.analysis)
    : undefined;

  return {
    originalTaskId: task.id,
    originalPrompt: task.description || '',
    stories,
    branchName: task.branchName,
    pr: task.prNumber && task.prUrl
      ? { number: task.prNumber, url: task.prUrl }
      : undefined,
    analysisSummary,
    filesModified,
    finalStatus: task.status,
  };
}

/**
 * Format task context as a prompt prefix
 */
export function formatContextAsPrompt(context: TaskContext): string {
  const lines: string[] = [
    '## Previous Task Context',
    '',
    `**Original Task ID:** ${context.originalTaskId}`,
    `**Status:** ${context.finalStatus}`,
    '',
    '### Original Request',
    context.originalPrompt,
    '',
  ];

  // Add branch info
  if (context.branchName) {
    lines.push(`**Branch:** \`${context.branchName}\``);
  }

  // Add PR info
  if (context.pr) {
    lines.push(`**PR:** #${context.pr.number} - ${context.pr.url}`);
  }

  // Add stories summary
  if (context.stories.length > 0) {
    lines.push('', '### Stories Completed');
    for (const story of context.stories) {
      const status = story.status === 'completed' ? '✅' : story.status === 'failed' ? '❌' : '⏸️';
      lines.push(`- ${status} **${story.title}**`);
      if (story.description) {
        lines.push(`  ${story.description}`);
      }
    }
  }

  // Add analysis summary
  if (context.analysisSummary) {
    lines.push('', '### Analysis Summary', context.analysisSummary);
  }

  // Add files modified
  if (context.filesModified.length > 0) {
    lines.push('', '### Files Modified');
    // Limit to 20 files to avoid context bloat
    const files = context.filesModified.slice(0, 20);
    for (const file of files) {
      lines.push(`- \`${file}\``);
    }
    if (context.filesModified.length > 20) {
      lines.push(`- ... and ${context.filesModified.length - 20} more files`);
    }
  }

  lines.push('', '---', '');

  return lines.join('\n');
}

/**
 * Build a complete continuation prompt
 */
export function buildContinuationPrompt(context: TaskContext, userPrompt: string): string {
  const contextPrefix = formatContextAsPrompt(context);

  return `${contextPrefix}## New Instructions

${userPrompt}

---

Continue from where the previous task left off. You have access to the same workspace and branch.`;
}

/**
 * Extract file paths from activity log
 */
function extractFilesFromActivityLog(activityLog: any[]): string[] {
  const files = new Set<string>();

  for (const entry of activityLog) {
    // Extract from tool calls
    if (entry.tool === 'Edit' || entry.tool === 'Write') {
      if (entry.toolInput?.file_path) {
        files.add(entry.toolInput.file_path);
      }
    }

    // Extract from content if it mentions file paths
    if (entry.content && typeof entry.content === 'string') {
      // Match common file path patterns
      const pathMatches = entry.content.match(/(?:^|\s)((?:\.\/|\/)?[\w\-./]+\.\w{1,10})(?:\s|$|:)/g);
      if (pathMatches) {
        for (const match of pathMatches) {
          const path = match.trim().replace(/:$/, '');
          if (path.includes('/') && !path.startsWith('http')) {
            files.add(path);
          }
        }
      }
    }
  }

  return Array.from(files).sort();
}

/**
 * Build a summary from analysis results
 */
function buildAnalysisSummary(analysis: any): string {
  if (!analysis) return '';

  const parts: string[] = [];

  if (analysis.summary) {
    parts.push(analysis.summary);
  }

  if (analysis.approach) {
    parts.push(`**Approach:** ${analysis.approach}`);
  }

  if (analysis.risks && analysis.risks.length > 0) {
    parts.push(`**Risks identified:** ${analysis.risks.join(', ')}`);
  }

  if (analysis.dependencies && analysis.dependencies.length > 0) {
    parts.push(`**Dependencies:** ${analysis.dependencies.join(', ')}`);
  }

  return parts.join('\n');
}

export default {
  buildTaskContext,
  formatContextAsPrompt,
  buildContinuationPrompt,
};
