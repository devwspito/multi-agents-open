/**
 * Merge Phase V2
 *
 * Final phase - HOST operations only (no OpenCode).
 *
 * Flow:
 * 1. Create Pull Request with analysis as body
 * 2. Wait for user approval
 * 3. Merge PR to main
 *
 * User approval required before merge.
 */

import { Task } from '../../types/index.js';
import { gitService, PullRequestInfo } from '../../services/git/index.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { socketService } from '../../services/realtime/index.js';

export interface MergeResult {
  success: boolean;
  pullRequest?: PullRequestInfo;
  merged: boolean;
  error?: string;
}

export interface MergePhaseContext {
  task: Task;
  workingDirectory: string;
  branchName: string;
  analysisDescription: string;
  storiesCompleted: number;
  totalStories: number;
  /** Called to request user approval for merge */
  onMergeApprovalRequired?: (prInfo: PullRequestInfo) => Promise<boolean>;
  /** Auto-merge without approval */
  autoMerge?: boolean;
}

/**
 * Execute the Merge Phase
 */
export async function executeMergePhase(
  context: MergePhaseContext
): Promise<MergeResult> {
  const {
    task,
    workingDirectory,
    branchName,
    analysisDescription,
    storiesCompleted,
    totalStories,
    autoMerge = false,
  } = context;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[MergePhase] Starting for task: ${task.title}`);
  console.log(`[MergePhase] Branch: ${branchName}`);
  console.log(`${'='.repeat(60)}`);

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Merge',
    branchName,
  });

  // === STEP 1: Ensure all changes are pushed ===
  const hasChanges = await gitService.hasChanges(workingDirectory);
  if (hasChanges) {
    console.log(`[MergePhase] Pushing remaining changes...`);
    await gitService.commitAndPush(
      workingDirectory,
      `Final changes for ${task.title}`
    );
  }

  // === STEP 2: Create Pull Request ===
  console.log(`[MergePhase] Creating Pull Request...`);

  const prBody = buildPRBody(task, analysisDescription, storiesCompleted, totalStories);

  let pullRequest: PullRequestInfo;
  try {
    pullRequest = await gitService.createPullRequest(workingDirectory, {
      title: `[Task] ${task.title}`,
      body: prBody,
      baseBranch: 'main',
      draft: false,
    });

    console.log(`[MergePhase] PR created: ${pullRequest.url}`);

    // Save PR to database
    await TaskRepository.setPullRequest(task.id, pullRequest.number, pullRequest.url);
  } catch (error: any) {
    console.error(`[MergePhase] Failed to create PR: ${error.message}`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: false,
      error: error.message,
    });

    return {
      success: false,
      merged: false,
      error: `Failed to create PR: ${error.message}`,
    };
  }

  // Notify frontend about PR
  socketService.toTask(task.id, 'merge:pr_created', {
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    title: pullRequest.title,
    branchName,
  });

  // === STEP 3: Wait for approval (if not auto-merge) ===
  let approved = autoMerge;

  if (!autoMerge && context.onMergeApprovalRequired) {
    console.log(`[MergePhase] Waiting for user approval...`);

    socketService.toTask(task.id, 'merge:approval_required', {
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
    });

    approved = await context.onMergeApprovalRequired(pullRequest);
  }

  if (!approved) {
    console.log(`[MergePhase] Merge not approved - PR remains open`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: true,
      merged: false,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
    });

    return {
      success: true,
      pullRequest,
      merged: false,
    };
  }

  // === STEP 4: Merge PR ===
  console.log(`[MergePhase] Merging PR #${pullRequest.number}...`);

  try {
    // Check PR status first
    const status = await gitService.getPullRequestStatus(workingDirectory, pullRequest.number);

    if (status.state !== 'open') {
      throw new Error(`PR is already ${status.state}`);
    }

    if (!status.mergeable) {
      throw new Error('PR has merge conflicts');
    }

    if (status.checks.failed > 0) {
      console.warn(`[MergePhase] Warning: ${status.checks.failed} checks failed`);
    }

    // Merge with squash
    await gitService.mergePullRequest(workingDirectory, pullRequest.number, {
      method: 'squash',
      deleteAfterMerge: true,
    });

    console.log(`[MergePhase] PR #${pullRequest.number} merged successfully`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: true,
      merged: true,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
    });

    return {
      success: true,
      pullRequest,
      merged: true,
    };
  } catch (error: any) {
    console.error(`[MergePhase] Merge failed: ${error.message}`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: false,
      merged: false,
      error: error.message,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
    });

    return {
      success: false,
      pullRequest,
      merged: false,
      error: `Merge failed: ${error.message}`,
    };
  }
}

/**
 * Build the PR body with analysis and story summary
 */
function buildPRBody(
  task: Task,
  analysisDescription: string,
  storiesCompleted: number,
  totalStories: number
): string {
  return `## Summary
${task.description || task.title}

## Analysis
${analysisDescription}

## Stories Completed
✅ ${storiesCompleted}/${totalStories} stories implemented

## Checklist
- [ ] Code has been reviewed
- [ ] Tests pass
- [ ] No security issues
- [ ] Documentation updated (if needed)

---
*Generated by Open Multi-Agents*
`;
}

/**
 * Check PR status without merging
 */
export async function checkPRStatus(
  workingDirectory: string,
  prNumber: number
): Promise<{
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean;
  checks: { passed: number; failed: number; pending: number };
}> {
  return gitService.getPullRequestStatus(workingDirectory, prNumber);
}

/**
 * Manually trigger merge for a PR
 */
export async function triggerMerge(
  taskId: string,
  workingDirectory: string,
  prNumber: number
): Promise<boolean> {
  try {
    await gitService.mergePullRequest(workingDirectory, prNumber, {
      method: 'squash',
      deleteAfterMerge: true,
    });

    socketService.toTask(taskId, 'merge:completed', {
      prNumber,
      success: true,
    });

    return true;
  } catch (error: any) {
    socketService.toTask(taskId, 'merge:completed', {
      prNumber,
      success: false,
      error: error.message,
    });

    return false;
  }
}
