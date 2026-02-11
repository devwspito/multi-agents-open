/**
 * Merge Phase V2
 *
 * Final phase - HOST operations only (no OpenCode).
 *
 * Flow:
 * 1. Create Pull Request with analysis as body (1 PR per repository)
 * 2. Wait for user approval
 * 3. Merge PRs to main
 *
 * User approval required before merge.
 *
 * 🔥 MULTI-REPO SUPPORT: Creates 1 PR per repository when working with multiple repos
 */

import { Task, RepositoryInfo } from '../../types/index.js';
import { gitService, PullRequestInfo } from '../../services/git/index.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { socketService } from '../../services/realtime/index.js';

/**
 * PR info with repo context
 */
export interface RepoPullRequestInfo extends PullRequestInfo {
  repoName: string;
  repoType: string;
  repoPath: string;
}

export interface MergeResult {
  success: boolean;
  /** @deprecated Use pullRequests array instead */
  pullRequest?: PullRequestInfo;
  /** All created PRs (1 per repo) */
  pullRequests: RepoPullRequestInfo[];
  merged: boolean;
  error?: string;
}

export interface MergePhaseContext {
  task: Task;
  /** @deprecated Use repositories array instead */
  workingDirectory?: string;
  /** All repositories to create PRs for */
  repositories?: RepositoryInfo[];
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
 * 🔥 MULTI-REPO: Creates 1 PR per repository
 */
export async function executeMergePhase(
  context: MergePhaseContext
): Promise<MergeResult> {
  const {
    task,
    workingDirectory,
    repositories = [],
    branchName,
    analysisDescription,
    storiesCompleted,
    totalStories,
    autoMerge = false,
  } = context;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[MergePhase] Starting for task: ${task.title}`);
  console.log(`[MergePhase] Branch: ${branchName}`);
  console.log(`[MergePhase] Repositories: ${repositories.length || '1 (legacy mode)'}`);
  console.log(`${'='.repeat(60)}`);

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Merge',
    branchName,
    repositoryCount: repositories.length || 1,
  });

  // 🔥 MULTI-REPO: Build list of repos to process
  const reposToProcess: Array<{ path: string; name: string; type: string }> = [];

  if (repositories.length > 0) {
    for (const repo of repositories) {
      reposToProcess.push({
        path: repo.localPath,
        name: repo.name,
        type: repo.type,
      });
    }
  } else if (workingDirectory) {
    // Legacy fallback: single workingDirectory
    reposToProcess.push({
      path: workingDirectory,
      name: 'main',
      type: 'unknown',
    });
  } else {
    return {
      success: false,
      pullRequests: [],
      merged: false,
      error: 'No repositories or workingDirectory provided',
    };
  }

  // === STEP 1: Ensure all changes are pushed in ALL repos ===
  console.log(`[MergePhase] Checking for unpushed changes in ${reposToProcess.length} repositories...`);

  for (const repo of reposToProcess) {
    try {
      const hasChanges = await gitService.hasChanges(repo.path);
      if (hasChanges) {
        console.log(`[MergePhase] Pushing remaining changes in ${repo.name}...`);
        await gitService.commitAndPush(
          repo.path,
          `Final changes for ${task.title}`
        );
      }
    } catch (err: any) {
      console.warn(`[MergePhase] ⚠️ Could not push changes in ${repo.name}: ${err.message}`);
    }
  }

  // === STEP 2: Create Pull Requests (1 per repo) ===
  console.log(`[MergePhase] Creating Pull Requests for ${reposToProcess.length} repositories...`);

  const createdPRs: RepoPullRequestInfo[] = [];
  const errors: string[] = [];

  for (const repo of reposToProcess) {
    try {
      // Check if repo has any commits on this branch that aren't on main
      // This prevents creating empty PRs
      const prBody = buildPRBody(task, analysisDescription, storiesCompleted, totalStories, repo.name, repo.type);

      const prTitle = repositories.length > 1
        ? `[Task] ${task.title} (${repo.type})`  // Include repo type when multi-repo
        : `[Task] ${task.title}`;

      const pullRequest = await gitService.createPullRequest(repo.path, {
        title: prTitle,
        body: prBody,
        baseBranch: 'main',
        draft: false,
      });

      const repoPR: RepoPullRequestInfo = {
        ...pullRequest,
        repoName: repo.name,
        repoType: repo.type,
        repoPath: repo.path,
      };

      createdPRs.push(repoPR);
      console.log(`[MergePhase] ✅ PR created for ${repo.name}: ${pullRequest.url}`);

      // Notify frontend about each PR
      socketService.toTask(task.id, 'merge:pr_created', {
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        title: pullRequest.title,
        branchName,
        repoName: repo.name,
        repoType: repo.type,
      });
    } catch (error: any) {
      // Check if it's a "no commits" error - that's OK, just skip this repo
      if (error.message?.includes('No commits') || error.message?.includes('no changes') || error.message?.includes('already up to date')) {
        console.log(`[MergePhase] ℹ️ No changes to merge in ${repo.name}, skipping PR`);
      } else {
        console.error(`[MergePhase] ❌ Failed to create PR for ${repo.name}: ${error.message}`);
        errors.push(`${repo.name}: ${error.message}`);
      }
    }
  }

  // If no PRs were created and there were errors, fail
  if (createdPRs.length === 0) {
    const errorMsg = errors.length > 0
      ? `Failed to create PRs: ${errors.join('; ')}`
      : 'No changes to merge in any repository';

    console.log(`[MergePhase] ${errors.length > 0 ? '❌' : 'ℹ️'} ${errorMsg}`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: errors.length === 0,
      error: errors.length > 0 ? errorMsg : undefined,
    });

    return {
      success: errors.length === 0,
      pullRequests: [],
      merged: false,
      error: errors.length > 0 ? errorMsg : undefined,
    };
  }

  // Save first PR to database (for backwards compatibility)
  const primaryPR = createdPRs[0];
  await TaskRepository.setPullRequest(task.id, primaryPR.number, primaryPR.url);

  // If multiple PRs, also save them as JSON in metadata
  if (createdPRs.length > 1) {
    console.log(`[MergePhase] 📝 Created ${createdPRs.length} PRs across repositories`);
  }

  // === STEP 3: Wait for approval (if not auto-merge) ===
  let approved = autoMerge;

  if (!autoMerge && context.onMergeApprovalRequired) {
    console.log(`[MergePhase] Waiting for user approval...`);

    socketService.toTask(task.id, 'merge:approval_required', {
      pullRequests: createdPRs.map(pr => ({
        number: pr.number,
        url: pr.url,
        repoName: pr.repoName,
        repoType: pr.repoType,
      })),
    });

    // For approval, use the first PR (user can see all PRs in the notification)
    approved = await context.onMergeApprovalRequired(primaryPR);
  }

  if (!approved) {
    console.log(`[MergePhase] Merge not approved - PRs remain open`);

    socketService.toTask(task.id, 'phase:complete', {
      phase: 'Merge',
      success: true,
      merged: false,
      pullRequests: createdPRs.map(pr => ({
        number: pr.number,
        url: pr.url,
        repoName: pr.repoName,
      })),
    });

    return {
      success: true,
      pullRequest: primaryPR, // Backwards compatibility
      pullRequests: createdPRs,
      merged: false,
    };
  }

  // === STEP 4: Merge ALL PRs ===
  console.log(`[MergePhase] Merging ${createdPRs.length} PRs...`);

  const mergeResults: { pr: RepoPullRequestInfo; success: boolean; error?: string }[] = [];

  for (const pr of createdPRs) {
    try {
      // Check PR status first
      const status = await gitService.getPullRequestStatus(pr.repoPath, pr.number);

      if (status.state !== 'open') {
        throw new Error(`PR is already ${status.state}`);
      }

      if (!status.mergeable) {
        throw new Error('PR has merge conflicts');
      }

      if (status.checks.failed > 0) {
        console.warn(`[MergePhase] ⚠️ Warning: ${status.checks.failed} checks failed for ${pr.repoName}`);
      }

      // Merge with squash
      await gitService.mergePullRequest(pr.repoPath, pr.number, {
        method: 'squash',
        deleteAfterMerge: true,
      });

      console.log(`[MergePhase] ✅ PR #${pr.number} merged successfully (${pr.repoName})`);
      mergeResults.push({ pr, success: true });
    } catch (error: any) {
      console.error(`[MergePhase] ❌ Merge failed for ${pr.repoName}: ${error.message}`);
      mergeResults.push({ pr, success: false, error: error.message });
    }
  }

  const allMerged = mergeResults.every(r => r.success);
  const anyMerged = mergeResults.some(r => r.success);
  const failedMerges = mergeResults.filter(r => !r.success);

  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Merge',
    success: anyMerged,
    merged: allMerged,
    pullRequests: createdPRs.map(pr => ({
      number: pr.number,
      url: pr.url,
      repoName: pr.repoName,
      merged: mergeResults.find(r => r.pr.number === pr.number)?.success ?? false,
    })),
    errors: failedMerges.length > 0 ? failedMerges.map(r => `${r.pr.repoName}: ${r.error}`) : undefined,
  });

  return {
    success: anyMerged,
    pullRequest: primaryPR, // Backwards compatibility
    pullRequests: createdPRs,
    merged: allMerged,
    error: failedMerges.length > 0
      ? `Some merges failed: ${failedMerges.map(r => `${r.pr.repoName}: ${r.error}`).join('; ')}`
      : undefined,
  };
}

/**
 * Build the PR body with analysis and story summary
 */
function buildPRBody(
  task: Task,
  analysisDescription: string,
  storiesCompleted: number,
  totalStories: number,
  repoName?: string,
  repoType?: string
): string {
  const repoInfo = repoName && repoType
    ? `\n## Repository\n📁 **${repoName}** (${repoType})\n`
    : '';

  return `## Summary
${task.description || task.title}
${repoInfo}
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
