/**
 * Enhanced GitHub Integration Service
 *
 * Features:
 * - Auto-create PRs with AI-generated descriptions
 * - Auto-link issues (closes #123)
 * - Branch naming conventions
 * - PR templates by type
 * - Commit message formatting
 */

// Use dynamic import to avoid hard dependency if @octokit/rest not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OctokitType = any;

// ============================================================================
// TYPES
// ============================================================================

export interface BranchConfig {
  prefix: 'feature' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore';
  taskId: string;
  title: string;
  issueNumber?: number;
}

export interface PRConfig {
  owner: string;
  repo: string;
  head: string; // Source branch
  base: string; // Target branch (main/master)
  title: string;
  body?: string;
  issueNumbers?: number[];
  labels?: string[];
  reviewers?: string[];
  draft?: boolean;
}

export interface PRDescription {
  summary: string;
  changes: string[];
  testPlan: string[];
  breakingChanges?: string[];
  issueLinks: string[];
}

export interface CommitConfig {
  type: 'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore' | 'style' | 'perf';
  scope?: string;
  description: string;
  body?: string;
  issueNumber?: number;
  breaking?: boolean;
}

export interface CreatedPR {
  number: number;
  url: string;
  title: string;
  state: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const BRANCH_PREFIXES: Record<string, string> = {
  feature: 'feat',
  fix: 'fix',
  refactor: 'refactor',
  docs: 'docs',
  test: 'test',
  chore: 'chore',
};

const PR_TEMPLATE = `## Summary
{{summary}}

## Changes
{{changes}}

## Test Plan
{{testPlan}}

{{breakingChanges}}

{{issueLinks}}

---
🤖 Generated with [Open Multi-Agents](https://github.com/your-org/open-multi-agents)
`;

// ============================================================================
// GITHUB ENHANCED SERVICE
// ============================================================================

class GitHubEnhancedServiceClass {
  private octokit: OctokitType | null = null;
  private token: string | null = null;
  private OctokitClass: any = null;

  /**
   * Initialize with GitHub token
   */
  async init(token: string): Promise<void> {
    this.token = token;
    try {
      // Dynamic import to avoid hard dependency
      // @ts-ignore - dynamic import may not have types
      const octokitModule = await import('@octokit/rest');
      this.OctokitClass = octokitModule.Octokit;
      this.octokit = new this.OctokitClass({ auth: token });
      console.log('[GitHubEnhanced] Initialized with token');
    } catch (err) {
      console.warn('[GitHubEnhanced] @octokit/rest not installed, some features disabled');
    }
  }

  /**
   * Generate branch name following conventions
   *
   * Format: {prefix}/{task-id}-{kebab-title}
   * Example: feat/TASK-123-add-user-authentication
   */
  generateBranchName(config: BranchConfig): string {
    const prefix = BRANCH_PREFIXES[config.prefix] || config.prefix;

    // Convert title to kebab-case
    const kebabTitle = config.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-') // Spaces to hyphens
      .replace(/-+/g, '-') // Multiple hyphens to single
      .slice(0, 50); // Limit length

    // Build branch name
    let branchName = `${prefix}/${config.taskId}`;

    if (config.issueNumber) {
      branchName += `-issue-${config.issueNumber}`;
    }

    branchName += `-${kebabTitle}`;

    return branchName;
  }

  /**
   * Generate conventional commit message
   *
   * Format: {type}({scope}): {description}
   * Example: feat(auth): add OAuth2 login support
   */
  generateCommitMessage(config: CommitConfig): string {
    let message = config.type;

    if (config.scope) {
      message += `(${config.scope})`;
    }

    if (config.breaking) {
      message += '!';
    }

    message += `: ${config.description}`;

    if (config.body) {
      message += `\n\n${config.body}`;
    }

    if (config.issueNumber) {
      message += `\n\nCloses #${config.issueNumber}`;
    }

    return message;
  }

  /**
   * Generate PR description from changes
   */
  generatePRDescription(description: PRDescription): string {
    let body = PR_TEMPLATE;

    // Summary
    body = body.replace('{{summary}}', description.summary);

    // Changes
    const changesText = description.changes
      .map(c => `- ${c}`)
      .join('\n');
    body = body.replace('{{changes}}', changesText);

    // Test Plan
    const testPlanText = description.testPlan
      .map(t => `- [ ] ${t}`)
      .join('\n');
    body = body.replace('{{testPlan}}', testPlanText);

    // Breaking Changes
    if (description.breakingChanges && description.breakingChanges.length > 0) {
      const breakingText = `## ⚠️ Breaking Changes\n${description.breakingChanges.map(b => `- ${b}`).join('\n')}`;
      body = body.replace('{{breakingChanges}}', breakingText);
    } else {
      body = body.replace('{{breakingChanges}}', '');
    }

    // Issue Links
    if (description.issueLinks.length > 0) {
      const issueText = `## Related Issues\n${description.issueLinks.join('\n')}`;
      body = body.replace('{{issueLinks}}', issueText);
    } else {
      body = body.replace('{{issueLinks}}', '');
    }

    return body.trim();
  }

  /**
   * Auto-detect issue numbers from branch name or commit messages
   */
  extractIssueNumbers(text: string): number[] {
    const patterns = [
      /#(\d+)/g,           // #123
      /issue-(\d+)/gi,     // issue-123
      /fixes\s+#(\d+)/gi,  // fixes #123
      /closes\s+#(\d+)/gi, // closes #123
      /resolves\s+#(\d+)/gi, // resolves #123
    ];

    const issues = new Set<number>();

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        issues.add(parseInt(match[1], 10));
      }
    }

    return Array.from(issues);
  }

  /**
   * Generate issue links for PR body
   */
  generateIssueLinks(issueNumbers: number[], closeOnMerge = true): string[] {
    return issueNumbers.map(num => {
      if (closeOnMerge) {
        return `Closes #${num}`;
      }
      return `Related to #${num}`;
    });
  }

  /**
   * Create a Pull Request with enhanced features
   */
  async createPR(config: PRConfig): Promise<CreatedPR> {
    if (!this.octokit) {
      throw new Error('GitHub not initialized. Call init() first.');
    }

    console.log(`[GitHubEnhanced] Creating PR: ${config.title}`);

    try {
      // Create the PR
      const { data: pr } = await this.octokit.pulls.create({
        owner: config.owner,
        repo: config.repo,
        title: config.title,
        body: config.body || '',
        head: config.head,
        base: config.base,
        draft: config.draft || false,
      });

      console.log(`[GitHubEnhanced] ✅ PR created: #${pr.number}`);

      // Add labels if provided
      if (config.labels && config.labels.length > 0) {
        try {
          await this.octokit.issues.addLabels({
            owner: config.owner,
            repo: config.repo,
            issue_number: pr.number,
            labels: config.labels,
          });
          console.log(`[GitHubEnhanced] Added labels: ${config.labels.join(', ')}`);
        } catch (err) {
          console.warn(`[GitHubEnhanced] Failed to add labels:`, err);
        }
      }

      // Request reviewers if provided
      if (config.reviewers && config.reviewers.length > 0) {
        try {
          await this.octokit.pulls.requestReviewers({
            owner: config.owner,
            repo: config.repo,
            pull_number: pr.number,
            reviewers: config.reviewers,
          });
          console.log(`[GitHubEnhanced] Requested reviewers: ${config.reviewers.join(', ')}`);
        } catch (err) {
          console.warn(`[GitHubEnhanced] Failed to request reviewers:`, err);
        }
      }

      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        state: pr.state,
      };
    } catch (error: any) {
      console.error(`[GitHubEnhanced] ❌ Failed to create PR:`, error.message);
      throw error;
    }
  }

  /**
   * Create PR with AI-generated description
   */
  async createPRWithAIDescription(
    config: Omit<PRConfig, 'body'>,
    changes: {
      summary: string;
      filesChanged: string[];
      storiesCompleted: string[];
      issueNumbers?: number[];
    }
  ): Promise<CreatedPR> {
    // Generate description
    const description = this.generatePRDescription({
      summary: changes.summary,
      changes: changes.filesChanged.map(f => `Modified \`${f}\``),
      testPlan: [
        'Verify all new functionality works as expected',
        'Run existing test suite',
        'Manual testing of affected features',
      ],
      issueLinks: this.generateIssueLinks(changes.issueNumbers || []),
    });

    return this.createPR({
      ...config,
      body: description,
    });
  }

  /**
   * Link an issue to a PR
   */
  async linkIssueToPR(
    owner: string,
    repo: string,
    prNumber: number,
    issueNumber: number
  ): Promise<void> {
    if (!this.octokit) {
      throw new Error('GitHub not initialized');
    }

    // Get current PR body
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Add issue link if not already present
    if (!pr.body?.includes(`#${issueNumber}`)) {
      const newBody = `${pr.body || ''}\n\nCloses #${issueNumber}`;

      await this.octokit.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        body: newBody,
      });

      console.log(`[GitHubEnhanced] Linked issue #${issueNumber} to PR #${prNumber}`);
    }
  }

  /**
   * Get labels for PR based on changes
   */
  suggestLabels(changes: {
    filesChanged: string[];
    type: 'feature' | 'fix' | 'refactor' | 'docs' | 'test';
    breaking?: boolean;
  }): string[] {
    const labels: string[] = [];

    // Type-based labels
    switch (changes.type) {
      case 'feature':
        labels.push('enhancement', 'feature');
        break;
      case 'fix':
        labels.push('bug', 'fix');
        break;
      case 'refactor':
        labels.push('refactor', 'tech-debt');
        break;
      case 'docs':
        labels.push('documentation');
        break;
      case 'test':
        labels.push('test', 'quality');
        break;
    }

    // Breaking change label
    if (changes.breaking) {
      labels.push('breaking-change');
    }

    // File-based labels
    const hasBackend = changes.filesChanged.some(f =>
      f.includes('src/api') || f.includes('src/services') || f.includes('server')
    );
    const hasFrontend = changes.filesChanged.some(f =>
      f.includes('components') || f.includes('pages') || f.includes('.tsx') || f.includes('.jsx')
    );
    const hasDB = changes.filesChanged.some(f =>
      f.includes('migration') || f.includes('schema') || f.includes('.prisma')
    );

    if (hasBackend) labels.push('backend');
    if (hasFrontend) labels.push('frontend');
    if (hasDB) labels.push('database');

    return [...new Set(labels)]; // Remove duplicates
  }

  /**
   * Check if branch exists
   */
  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    if (!this.octokit) {
      throw new Error('GitHub not initialized');
    }

    try {
      await this.octokit.repos.getBranch({
        owner,
        repo,
        branch,
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Get default branch for a repo
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    if (!this.octokit) {
      throw new Error('GitHub not initialized');
    }

    const { data } = await this.octokit.repos.get({ owner, repo });
    return data.default_branch;
  }

  /**
   * Parse owner/repo from GitHub URL
   */
  parseRepoUrl(url: string): { owner: string; repo: string } | null {
    const patterns = [
      /github\.com[/:]([^/]+)\/([^/.]+)/,
      /^([^/]+)\/([^/]+)$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return {
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
        };
      }
    }

    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const githubEnhancedService = new GitHubEnhancedServiceClass();
export default githubEnhancedService;
