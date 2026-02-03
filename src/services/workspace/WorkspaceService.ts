/**
 * Workspace Service
 *
 * Handles git operations for agent workspaces.
 * Designed for host-side execution (backend manages auth, not OpenCode).
 *
 * Flow:
 * 1. Backend clones repo with user's token
 * 2. OpenCode agent works in workspace (local git only)
 * 3. Backend detects changes via git status
 * 4. Backend commits and pushes with user's token
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================
// GIT STATUS PARSER
// ============================================

export interface GitStatusEntry {
  statusCode: string;
  indexStatus: string;
  workTreeStatus: string;
  file: string;
  originalFile?: string;
}

export interface ParsedGitStatus {
  entries: GitStatusEntry[];
  modified: string[];
  untracked: string[];
  staged: string[];
  deleted: string[];
  added: string[];
  allChanges: string[];
  hasChanges: boolean;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasUntracked: boolean;
}

/**
 * Parse git status --porcelain output
 */
function parseGitStatus(output: string | null | undefined): ParsedGitStatus {
  const result: ParsedGitStatus = {
    entries: [],
    modified: [],
    untracked: [],
    staged: [],
    deleted: [],
    added: [],
    allChanges: [],
    hasChanges: false,
    hasStaged: false,
    hasUnstaged: false,
    hasUntracked: false,
  };

  if (!output?.trim()) return result;

  for (const line of output.trim().split('\n')) {
    if (line.length < 3) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const statusCode = line.substring(0, 2);
    let file = line.substring(3).trim();
    let originalFile: string | undefined;

    // Handle rename: R  old -> new
    if (file.includes(' -> ')) {
      const parts = file.split(' -> ');
      originalFile = parts[0];
      file = parts[1];
    }

    result.entries.push({ statusCode, indexStatus, workTreeStatus, file, originalFile });

    if (statusCode === '??') {
      result.untracked.push(file);
      result.hasUntracked = true;
    } else if (statusCode === '!!') {
      continue; // Ignored
    } else {
      // Staged changes
      if (indexStatus !== ' ' && indexStatus !== '?') {
        result.staged.push(file);
        result.hasStaged = true;
        if (indexStatus === 'A') result.added.push(file);
        else if (indexStatus === 'D') result.deleted.push(file);
        else if (indexStatus === 'M') result.modified.push(file);
      }

      // Unstaged changes
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        result.hasUnstaged = true;
        if (workTreeStatus === 'M' && !result.modified.includes(file)) {
          result.modified.push(file);
        } else if (workTreeStatus === 'D' && !result.deleted.includes(file)) {
          result.deleted.push(file);
        }
      }
    }
  }

  result.allChanges = [...new Set([
    ...result.modified,
    ...result.untracked,
    ...result.deleted,
    ...result.added,
  ])];
  result.hasChanges = result.allChanges.length > 0;

  return result;
}

// ============================================
// WORKSPACE SERVICE
// ============================================

export const WorkspaceService = {
  /**
   * Get current git status (changes made by agent)
   */
  async getChanges(cwd: string): Promise<ParsedGitStatus> {
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 30000 });
      return parseGitStatus(stdout);
    } catch (error: any) {
      console.warn(`[Workspace] git status failed: ${error.message}`);
      return parseGitStatus(null);
    }
  },

  /**
   * Get git diff summary
   */
  async getDiff(cwd: string, staged = false): Promise<string> {
    try {
      const cmd = staged ? 'git diff --cached --stat' : 'git diff --stat';
      const { stdout } = await execAsync(cmd, { cwd, timeout: 30000 });
      return stdout.trim();
    } catch {
      return '';
    }
  },

  /**
   * Stage specific files
   */
  async stageFiles(cwd: string, files: string[]): Promise<boolean> {
    if (files.length === 0) return false;
    try {
      const fileList = files.map(f => `"${f}"`).join(' ');
      await execAsync(`git add ${fileList}`, { cwd, timeout: 60000 });
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git add failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Stage all changes
   */
  async stageAll(cwd: string): Promise<boolean> {
    try {
      await execAsync('git add -A', { cwd, timeout: 60000 });
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git add -A failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Commit staged changes
   */
  async commit(cwd: string, message: string): Promise<boolean> {
    try {
      // Check if there's anything to commit
      const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 30000 });
      if (!stdout.trim()) {
        console.log('[Workspace] Nothing to commit');
        return false;
      }

      // Escape message for shell
      const safeMessage = message.replace(/"/g, '\\"');
      await execAsync(`git commit -m "${safeMessage}"`, { cwd, timeout: 120000 });
      console.log(`[Workspace] Committed: ${message}`);
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git commit failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Push to remote with user's token (authenticated)
   */
  async pushWithToken(cwd: string, token: string, branch?: string): Promise<boolean> {
    try {
      // Get remote URL
      const { stdout: remoteUrl } = await execAsync('git remote get-url origin', { cwd, timeout: 10000 });
      const cleanUrl = remoteUrl.trim();

      // Build authenticated URL
      const authUrl = cleanUrl.replace('https://github.com/', `https://${token}@github.com/`);

      // Get current branch if not specified
      const targetBranch = branch || (await this.getCurrentBranch(cwd));

      // Push
      await execAsync(`git push ${authUrl} ${targetBranch}`, { cwd, timeout: 120000 });
      console.log(`[Workspace] Pushed to ${targetBranch}`);
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git push failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Get current branch name
   */
  async getCurrentBranch(cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 10000 });
      return stdout.trim();
    } catch {
      return 'main';
    }
  },

  /**
   * Create and checkout a new branch
   */
  async createBranch(cwd: string, branchName: string): Promise<boolean> {
    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd, timeout: 30000 });
      console.log(`[Workspace] Created branch: ${branchName}`);
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git checkout -b failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Clone repo with user's token
   */
  async cloneWithToken(
    repoUrl: string,
    targetDir: string,
    token: string,
    branch?: string
  ): Promise<boolean> {
    try {
      const authUrl = repoUrl.replace('https://github.com/', `https://${token}@github.com/`);
      const branchArg = branch ? `-b ${branch}` : '';

      await execAsync(`git clone ${branchArg} ${authUrl} "${targetDir}"`, { timeout: 300000 });

      // Remove token from remote URL after clone (security)
      await execAsync(`git remote set-url origin ${repoUrl}`, { cwd: targetDir, timeout: 10000 });

      console.log(`[Workspace] Cloned: ${repoUrl} -> ${targetDir}`);
      return true;
    } catch (error: any) {
      console.warn(`[Workspace] git clone failed: ${error.message}`);
      return false;
    }
  },

  /**
   * Full workflow: stage all, commit, push
   */
  async commitAndPush(
    cwd: string,
    message: string,
    token: string,
    branch?: string
  ): Promise<{ committed: boolean; pushed: boolean; changes: ParsedGitStatus }> {
    const changes = await this.getChanges(cwd);

    if (!changes.hasChanges) {
      return { committed: false, pushed: false, changes };
    }

    await this.stageAll(cwd);
    const committed = await this.commit(cwd, message);

    if (!committed) {
      return { committed: false, pushed: false, changes };
    }

    const pushed = await this.pushWithToken(cwd, token, branch);

    return { committed, pushed, changes };
  },

  /**
   * Get summary string for logging
   */
  formatSummary(status: ParsedGitStatus): string {
    const parts: string[] = [];
    if (status.modified.length > 0) parts.push(`${status.modified.length} modified`);
    if (status.added.length > 0) parts.push(`${status.added.length} added`);
    if (status.deleted.length > 0) parts.push(`${status.deleted.length} deleted`);
    if (status.untracked.length > 0) parts.push(`${status.untracked.length} untracked`);
    return parts.length > 0 ? parts.join(', ') : 'no changes';
  },
};

export default WorkspaceService;
