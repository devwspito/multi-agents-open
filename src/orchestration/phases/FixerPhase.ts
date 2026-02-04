/**
 * Fixer Phase
 *
 * Fixes issues identified by Judge phase.
 * Only runs when Judge returns 'needs_revision' or 'rejected'.
 *
 * Uses OpenCode SDK for agent execution.
 */

import { BasePhase, PhaseContext, PhaseResult, OpenCodeExecutionResult } from '../Phase.js';
import { JudgeOutput } from './JudgePhase.js';

export class FixerPhase extends BasePhase {
  readonly name = 'Fixer';
  readonly description = 'Fix issues identified during code review';
  readonly agentType = 'fixer';

  async validate(context: PhaseContext): Promise<boolean> {
    // Require judge phase to be done
    const judge = context.previousResults.get('Judge');
    if (!judge?.success) {
      console.log('[FixerPhase] Judge phase must complete successfully first');
      return false;
    }

    // Only run if there are issues to fix
    const verdict = context.variables.get('judgeVerdict');
    if (verdict === 'approved') {
      console.log('[FixerPhase] Code was approved, no fixes needed');
      return false;
    }

    const issues = context.variables.get('judgeIssues') || [];
    if (issues.length === 0) {
      console.log('[FixerPhase] No issues to fix');
      return false;
    }

    return true;
  }

  buildPrompt(context: PhaseContext): string {
    const { task, projectPath, repositories } = context;
    const judgeOutput = context.previousResults.get('Judge')?.output as JudgeOutput;
    const issues = context.variables.get('judgeIssues') || [];
    const taskDescription = task.description || task.title;

    // Build repository info section
    let repoSection = '';
    if (repositories && repositories.length > 0) {
      repoSection = `## Available Repositories
${repositories.map(repo => `- **${repo.name}** (${repo.type}): ${repo.localPath}`).join('\n')}

`;
    }

    // Format issues for the prompt
    const issuesText = issues.map((issue: any, i: number) => {
      return `### Issue ${i + 1}: [${issue.severity.toUpperCase()}]
- **File**: ${issue.file}
- **Problem**: ${issue.description}
${issue.suggestion ? `- **Suggested Fix**: ${issue.suggestion}` : ''}`;
    }).join('\n\n');

    return `# Code Fix Task

## Original Task
- **Task**: ${taskDescription}

${repoSection}## Judge Review Summary
- **Verdict**: ${judgeOutput?.verdict || 'unknown'}
- **Score**: ${judgeOutput?.score || 0}/100
- **Summary**: ${judgeOutput?.summary || 'No summary'}

## Issues to Fix (${issues.length})

${issuesText}

## Your Mission
Fix ALL the issues identified by the code reviewer.

## Instructions
1. Read each file with issues using the Read tool
2. Fix each issue using the Edit tool
3. Prioritize by severity: critical > major > minor > suggestion
4. Test changes work (use Bash if needed)

## Project Path
${projectPath}

## Guidelines
- Fix the actual root cause, not just symptoms
- Maintain code style consistency
- Don't introduce new issues while fixing
- Critical and major issues MUST be fixed
- Minor issues and suggestions are nice-to-have
${repositories.length > 1 ? `- Issues may span MULTIPLE repositories (backend/frontend)` : ''}

## Output
After fixing, summarize:
- Which issues were fixed
- How they were fixed
- Any issues that couldn't be fixed (and why)`;
  }

  protected getSystemPrompt(): string {
    return `You are a bug fixer agent. Your job is to fix issues identified in code review.

You excel at:
- Understanding and fixing bugs
- Addressing security vulnerabilities
- Improving code quality
- Making surgical, focused fixes

Guidelines:
- Always read files before editing
- Fix the root cause, not symptoms
- Don't break working code while fixing
- Prioritize critical issues first
- Be thorough but minimal in changes`;
  }

  async processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult> {
    const originalIssues = context.variables.get('judgeIssues') || [];

    // Track which files were modified during fixing
    const filesFixed = result.toolCalls
      .filter(tc => tc.toolName === 'Edit' || tc.toolName === 'Write')
      .map(tc => tc.toolInput?.file_path)
      .filter(Boolean);

    // Determine which issues were likely fixed
    const issuesAddressed = originalIssues.filter((issue: any) =>
      filesFixed.includes(issue.file)
    );

    const fixOutput = {
      summary: result.finalOutput,
      originalIssueCount: originalIssues.length,
      filesFixed,
      issuesAddressed: issuesAddressed.length,
      issuesRemaining: originalIssues.length - issuesAddressed.length,
    };

    // Store for potential re-review
    context.variables.set('fixerOutput', fixOutput);
    context.variables.set('fixerFilesModified', filesFixed);

    console.log(`[FixerPhase] Fixed ${issuesAddressed.length}/${originalIssues.length} issues`);
    console.log(`[FixerPhase] Files modified: ${filesFixed.join(', ') || 'none'}`);

    return {
      success: true,
      output: fixOutput,
      metadata: {
        sessionId: result.sessionId,
        turns: result.turns,
        toolCalls: result.toolCalls.length,
        vulnerabilities: result.vulnerabilities.length,
        issuesFixed: issuesAddressed.length,
      },
    };
  }
}
