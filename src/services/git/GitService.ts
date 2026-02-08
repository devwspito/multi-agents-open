/**
 * Git Service
 *
 * Handles all Git operations for the orchestration system.
 * The HOST (our system) controls Git, not OpenCode.
 *
 * Responsibilities:
 * - Create feature branches for tasks
 * - Commit and push changes after each story
 * - Create Pull Requests
 * - Merge PRs to main
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BranchInfo {
  name: string;
  taskId: string;
  createdAt: Date;
}

export interface CommitInfo {
  hash: string;
  message: string;
  storyId?: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  body: string;
  branch: string;
}

class GitServiceClass {
  /**
   * Execute a git command in a specific directory
   */
  private async git(command: string, cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git ${command}`, { cwd });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`Git command failed: ${error.message}`);
    }
  }

  /**
   * Execute a gh (GitHub CLI) command
   */
  private async gh(command: string, cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`gh ${command}`, { cwd });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`GitHub CLI failed: ${error.message}`);
    }
  }

  /**
   * Create a feature branch for a task
   */
  async createBranch(
    taskId: string,
    directory: string,
    baseBranch = 'main'
  ): Promise<BranchInfo> {
    const branchName = `task/${taskId}`;

    // Fetch latest from remote
    await this.git('fetch origin', directory);

    // Create and checkout new branch from base
    await this.git(`checkout -b ${branchName} origin/${baseBranch}`, directory);

    console.log(`[GitService] Created branch: ${branchName}`);

    return {
      name: branchName,
      taskId,
      createdAt: new Date(),
    };
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(directory: string): Promise<string> {
    return this.git('rev-parse --abbrev-ref HEAD', directory);
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasChanges(directory: string): Promise<boolean> {
    const status = await this.git('status --porcelain', directory);
    return status.length > 0;
  }

  /**
   * Get list of changed files
   */
  async getChangedFiles(directory: string): Promise<string[]> {
    const status = await this.git('status --porcelain', directory);
    if (!status) return [];

    return status
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.substring(3).trim());
  }

  /**
   * Stage all changes
   */
  async stageAll(directory: string): Promise<void> {
    await this.git('add -A', directory);
  }

  /**
   * Commit changes with a message
   */
  async commit(
    directory: string,
    message: string,
    options?: { storyId?: string; storyTitle?: string }
  ): Promise<CommitInfo> {
    // Build commit message
    let fullMessage = message;
    if (options?.storyId && options?.storyTitle) {
      fullMessage = `[${options.storyId}] ${options.storyTitle}\n\n${message}`;
    }

    // Stage all changes
    await this.stageAll(directory);

    // Commit
    await this.git(`commit -m "${fullMessage.replace(/"/g, '\\"')}"`, directory);

    // Get commit hash
    const hash = await this.git('rev-parse HEAD', directory);

    console.log(`[GitService] Committed: ${hash.substring(0, 7)} - ${message.substring(0, 50)}`);

    return {
      hash,
      message: fullMessage,
      storyId: options?.storyId,
    };
  }

  /**
   * Push current branch to remote
   */
  async push(directory: string, branch?: string): Promise<void> {
    const currentBranch = branch || await this.getCurrentBranch(directory);
    await this.git(`push -u origin ${currentBranch}`, directory);
    console.log(`[GitService] Pushed to origin/${currentBranch}`);
  }

  /**
   * Commit and push in one operation
   */
  async commitAndPush(
    directory: string,
    message: string,
    options?: { storyId?: string; storyTitle?: string }
  ): Promise<CommitInfo> {
    const hasChanges = await this.hasChanges(directory);
    if (!hasChanges) {
      console.log('[GitService] No changes to commit');
      return { hash: '', message: 'No changes' };
    }

    const commitInfo = await this.commit(directory, message, options);
    await this.push(directory);
    return commitInfo;
  }

  /**
   * Create a Pull Request
   * Uses gh pr create and parses the URL from stdout (--json is not supported)
   */
  async createPullRequest(
    directory: string,
    options: {
      title: string;
      body: string;
      baseBranch?: string;
      draft?: boolean;
    }
  ): Promise<PullRequestInfo> {
    const currentBranch = await this.getCurrentBranch(directory);
    const baseBranch = options.baseBranch || 'main';

    // Ensure we've pushed
    await this.push(directory, currentBranch);

    // Escape title and body for shell command
    const titleEscaped = options.title.replace(/"/g, '\\"');
    const bodyEscaped = options.body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const draftFlag = options.draft ? '--draft' : '';

    // Create PR using GitHub CLI (note: --json is NOT supported for pr create)
    const output = await this.gh(
      `pr create --base ${baseBranch} --head ${currentBranch} --title "${titleEscaped}" --body "${bodyEscaped}" ${draftFlag}`,
      directory
    );

    // Parse the PR URL from stdout (gh pr create outputs the URL on success)
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    if (!urlMatch) {
      throw new Error(`Failed to parse PR URL from output: ${output}`);
    }

    const prUrl = urlMatch[0];

    // Extract PR number from URL (e.g., /pull/123)
    const numberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : 0;

    console.log(`[GitService] Created PR #${prNumber}: ${options.title}`);

    return {
      number: prNumber,
      url: prUrl,
      title: options.title,
      body: options.body,
      branch: currentBranch,
    };
  }

  /**
   * Merge a Pull Request
   */
  async mergePullRequest(
    directory: string,
    prNumber: number,
    options?: {
      method?: 'merge' | 'squash' | 'rebase';
      deleteAfterMerge?: boolean;
    }
  ): Promise<void> {
    const method = options?.method || 'squash';
    const deleteFlag = options?.deleteAfterMerge !== false ? '--delete-branch' : '';

    await this.gh(`pr merge ${prNumber} --${method} ${deleteFlag}`, directory);

    console.log(`[GitService] Merged PR #${prNumber} using ${method}`);
  }

  /**
   * Get PR status
   */
  async getPullRequestStatus(directory: string, prNumber: number): Promise<{
    state: 'open' | 'closed' | 'merged';
    mergeable: boolean;
    checks: { passed: number; failed: number; pending: number };
  }> {
    const result = await this.gh(
      `pr view ${prNumber} --json state,mergeable,statusCheckRollup`,
      directory
    );

    const data = JSON.parse(result);

    const checks = { passed: 0, failed: 0, pending: 0 };
    for (const check of data.statusCheckRollup || []) {
      if (check.conclusion === 'SUCCESS') checks.passed++;
      else if (check.conclusion === 'FAILURE') checks.failed++;
      else checks.pending++;
    }

    return {
      state: data.state.toLowerCase(),
      mergeable: data.mergeable === 'MERGEABLE',
      checks,
    };
  }

  /**
   * Update branch description (via PR body or branch notes)
   * We'll use the first commit message or update PR body
   */
  async setBranchDescription(
    directory: string,
    description: string
  ): Promise<void> {
    // Git doesn't have native branch descriptions, but we can:
    // 1. Store in git config
    // 2. Use as the PR body later
    const branch = await this.getCurrentBranch(directory);
    await this.git(`config branch.${branch}.description "${description.replace(/"/g, '\\"')}"`, directory);
    console.log(`[GitService] Set branch description for ${branch}`);
  }

  /**
   * Get branch description
   */
  async getBranchDescription(directory: string): Promise<string | null> {
    try {
      const branch = await this.getCurrentBranch(directory);
      return await this.git(`config branch.${branch}.description`, directory);
    } catch {
      return null;
    }
  }

  /**
   * Switch to a branch
   */
  async checkout(directory: string, branch: string): Promise<void> {
    await this.git(`checkout ${branch}`, directory);
    console.log(`[GitService] Switched to branch: ${branch}`);
  }

  /**
   * Pull latest changes
   */
  async pull(directory: string): Promise<void> {
    await this.git('pull', directory);
  }

  /**
   * Check if branch exists
   */
  async branchExists(directory: string, branch: string): Promise<boolean> {
    try {
      await this.git(`rev-parse --verify ${branch}`, directory);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a branch (local and remote)
   */
  async deleteBranch(directory: string, branch: string): Promise<void> {
    try {
      await this.git(`branch -D ${branch}`, directory);
    } catch {
      // Branch might not exist locally
    }

    try {
      await this.git(`push origin --delete ${branch}`, directory);
    } catch {
      // Branch might not exist on remote
    }

    console.log(`[GitService] Deleted branch: ${branch}`);
  }

  /**
   * Get diff summary (--stat) for uncommitted changes
   */
  async getDiffSummary(directory: string): Promise<string> {
    try {
      return await this.git('diff --stat HEAD', directory);
    } catch {
      // Might fail if no commits yet
      return '';
    }
  }

  /**
   * Get full unified diff for uncommitted changes
   * @param maxLines - Maximum lines to return (to avoid huge diffs)
   */
  async getFullDiff(directory: string, maxLines = 500): Promise<string> {
    try {
      const diff = await this.git('diff HEAD', directory);
      // Limit lines to avoid overwhelming the UI
      const lines = diff.split('\n');
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join('\n') + `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
      }
      return diff;
    } catch {
      return '';
    }
  }

  /**
   * Get diff for a specific file
   */
  async getFileDiff(directory: string, filePath: string): Promise<string> {
    try {
      return await this.git(`diff HEAD -- "${filePath}"`, directory);
    } catch {
      return '';
    }
  }

  /**
   * Create a checkpoint (stash) before a story starts
   * Returns the stash reference if changes were stashed
   */
  async createCheckpoint(directory: string, name: string): Promise<string | null> {
    try {
      const hasChanges = await this.hasChanges(directory);
      if (!hasChanges) {
        return null; // No changes to checkpoint
      }

      // Stage all changes first
      await this.stageAll(directory);

      // Create stash with a descriptive message
      const message = `checkpoint-${name}-${Date.now()}`;
      await this.git(`stash push -m "${message}"`, directory);

      console.log(`[GitService] Created checkpoint: ${message}`);
      return message;
    } catch (error) {
      console.error(`[GitService] Failed to create checkpoint: ${error}`);
      return null;
    }
  }

  /**
   * Restore a checkpoint (pop stash)
   * Used when a story is rejected to rollback changes
   */
  async restoreCheckpoint(directory: string, checkpointName: string): Promise<boolean> {
    try {
      // Find the stash with this name
      const stashList = await this.git('stash list', directory);
      const lines = stashList.split('\n');

      for (const line of lines) {
        if (line.includes(checkpointName)) {
          // Extract stash reference (e.g., stash@{0})
          const match = line.match(/^(stash@\{\d+\})/);
          if (match) {
            await this.git(`stash pop ${match[1]}`, directory);
            console.log(`[GitService] Restored checkpoint: ${checkpointName}`);
            return true;
          }
        }
      }

      console.warn(`[GitService] Checkpoint not found: ${checkpointName}`);
      return false;
    } catch (error) {
      console.error(`[GitService] Failed to restore checkpoint: ${error}`);
      return false;
    }
  }

  /**
   * Discard all uncommitted changes (hard reset)
   * Used when a story is rejected to rollback changes
   */
  async discardChanges(directory: string): Promise<void> {
    try {
      await this.git('reset --hard HEAD', directory);
      await this.git('clean -fd', directory);
      console.log(`[GitService] Discarded all uncommitted changes`);
    } catch (error) {
      console.error(`[GitService] Failed to discard changes: ${error}`);
    }
  }

  /**
   * Drop a checkpoint stash (when story is approved and committed)
   */
  async dropCheckpoint(directory: string, checkpointName: string): Promise<boolean> {
    try {
      const stashList = await this.git('stash list', directory);
      const lines = stashList.split('\n');

      for (const line of lines) {
        if (line.includes(checkpointName)) {
          const match = line.match(/^(stash@\{\d+\})/);
          if (match) {
            await this.git(`stash drop ${match[1]}`, directory);
            console.log(`[GitService] Dropped checkpoint: ${checkpointName}`);
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      console.error(`[GitService] Failed to drop checkpoint: ${error}`);
      return false;
    }
  }
}

export const gitService = new GitServiceClass();
export default gitService;
