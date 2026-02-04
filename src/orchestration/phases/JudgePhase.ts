/**
 * Judge Phase
 *
 * Reviews code changes made by Development phase for a SINGLE STORY.
 * Provides structured feedback and verdict (approved/rejected).
 *
 * Uses OpenCode SDK for agent execution.
 */

import { BasePhase, PhaseContext, PhaseResult, OpenCodeExecutionResult } from '../Phase.js';
import { Story } from '../../types/index.js';

export type JudgeVerdict = 'approved' | 'rejected' | 'needs_revision';

export interface JudgeOutput {
  verdict: JudgeVerdict;
  score: number; // 0-100
  summary: string;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    file: string;
    description: string;
    suggestion?: string;
  }>;
  filesReviewed: string[];
}

export class JudgePhase extends BasePhase {
  readonly name = 'Judge';
  readonly description = 'Review code changes and provide structured feedback';
  readonly agentType = 'judge';

  async validate(context: PhaseContext): Promise<boolean> {
    // Require development to be done first
    const development = context.previousResults.get('Development');
    if (!development?.success) {
      console.log('[JudgePhase] Development phase must complete successfully first');
      return false;
    }
    return true;
  }

  buildPrompt(context: PhaseContext): string {
    const { task, projectPath, repositories } = context;
    const filesModified = context.variables.get('filesModified') || [];
    const devOutput = context.previousResults.get('Development')?.output;
    const currentStory = context.variables.get('currentStory') as Story | undefined;
    const storyIndex = context.variables.get('storyIndex') as number || 0;
    const totalStories = context.variables.get('totalStories') as number || 1;

    // Build repository info section
    let repoSection = '';
    if (repositories && repositories.length > 0) {
      repoSection = `## Available Repositories
${repositories.map(repo => `- **${repo.name}** (${repo.type}): ${repo.localPath}`).join('\n')}

`;
    }

    // Build story-specific prompt if we have a story
    if (currentStory) {
      const acceptanceCriteria = currentStory.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified';

      return `# Code Review for Story ${storyIndex + 1}/${totalStories}

## Story Details
- **ID**: ${currentStory.id}
- **Title**: ${currentStory.title}
- **Description**: ${currentStory.description}

${repoSection}## Acceptance Criteria
${acceptanceCriteria}

## Development Summary
${devOutput?.summary || 'No development summary available'}

## Files Modified
${filesModified.length > 0 ? filesModified.map((f: string) => `- ${f}`).join('\n') : 'No files recorded'}

## Your Mission
Review the code changes FOR THIS STORY ONLY and provide a structured verdict.

## Instructions
1. Read each modified file using the Read tool
2. Check for:
   - **Acceptance Criteria**: Are ALL criteria met?
   - **Correctness**: Does the code do what it should?
   - **Security**: Any vulnerabilities? (SQL injection, XSS, etc.)
   - **Code Quality**: Clean, readable, maintainable?
   - **Patterns**: Does it follow project conventions?
${repositories.length > 1 ? `   - **Cross-Repo Consistency**: Are frontend/backend changes aligned?` : ''}

## Project Path
${projectPath}

## Required Output Format
You MUST output a JSON block with this exact structure:

\`\`\`json
{
  "verdict": "approved" | "rejected" | "needs_revision",
  "score": <number 0-100>,
  "summary": "<brief summary of your review>",
  "issues": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "file": "<file path>",
      "description": "<what's wrong>",
      "suggestion": "<how to fix>"
    }
  ]
}
\`\`\`

## Verdict Guidelines
- **approved**: Score >= 80, acceptance criteria met, no critical/major issues
- **needs_revision**: Score 50-79, has issues but fixable
- **rejected**: Score < 50, fundamental problems`;
    }

    // Fallback to original prompt if no story context
    const taskDescription = task.description || task.title;

    return `# Code Review Task

## Original Task
- **Task**: ${taskDescription}

${repoSection}## Development Summary
${devOutput?.summary || 'No development summary available'}

## Files Modified
${filesModified.length > 0 ? filesModified.map((f: string) => `- ${f}`).join('\n') : 'No files recorded'}

## Your Mission
Review the code changes and provide a structured verdict.

## Instructions
1. Read each modified file using the Read tool
2. Check for:
   - **Correctness**: Does the code do what it should?
   - **Security**: Any vulnerabilities? (SQL injection, XSS, etc.)
   - **Code Quality**: Clean, readable, maintainable?
   - **Patterns**: Does it follow project conventions?
   - **Edge Cases**: Are edge cases handled?
${repositories.length > 1 ? `   - **Cross-Repo Consistency**: Are frontend/backend changes aligned?` : ''}

## Project Path
${projectPath}

## Required Output Format
You MUST output a JSON block with this exact structure:

\`\`\`json
{
  "verdict": "approved" | "rejected" | "needs_revision",
  "score": <number 0-100>,
  "summary": "<brief summary of your review>",
  "issues": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "file": "<file path>",
      "description": "<what's wrong>",
      "suggestion": "<how to fix>"
    }
  ]
}
\`\`\`

## Verdict Guidelines
- **approved**: Score >= 80, no critical/major issues
- **needs_revision**: Score 50-79, has major issues but fixable
- **rejected**: Score < 50, fundamental problems`;
  }

  protected getSystemPrompt(): string {
    return `You are a senior code reviewer agent. Your job is to ensure code quality and security.

You excel at:
- Spotting bugs and security vulnerabilities
- Ensuring code follows best practices
- Providing constructive feedback
- Being thorough but fair

Review criteria:
- Correctness: Does it work as intended?
- Security: No vulnerabilities?
- Quality: Clean, readable, documented?
- Patterns: Follows project conventions?
- Acceptance Criteria: All criteria met?

Be objective and specific. Always explain WHY something is an issue.
Output MUST include a JSON block with verdict, score, summary, and issues.`;
  }

  async processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult> {
    const currentStory = context.variables.get('currentStory') as Story | undefined;
    const output = result.finalOutput;
    let judgeOutput: JudgeOutput;

    try {
      // Extract JSON from output
      const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        judgeOutput = JSON.parse(jsonMatch[1]);
      } else {
        // Try to find raw JSON
        const rawJson = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
        if (rawJson) {
          judgeOutput = JSON.parse(rawJson[0]);
        } else {
          throw new Error('No JSON verdict found');
        }
      }

      // Validate required fields
      if (!judgeOutput.verdict || !['approved', 'rejected', 'needs_revision'].includes(judgeOutput.verdict)) {
        throw new Error('Invalid verdict');
      }

      judgeOutput.score = judgeOutput.score ?? 50;
      judgeOutput.issues = judgeOutput.issues ?? [];
      judgeOutput.summary = judgeOutput.summary ?? 'No summary provided';
      judgeOutput.filesReviewed = result.toolCalls
        .filter(tc => tc.toolName === 'Read')
        .map(tc => tc.toolInput?.file_path)
        .filter(Boolean);

    } catch (error: any) {
      console.warn(`[JudgePhase] Failed to parse verdict: ${error.message}`);
      // Default to needs_revision if we can't parse
      judgeOutput = {
        verdict: 'needs_revision',
        score: 50,
        summary: 'Could not parse judge output. Manual review recommended.',
        issues: [{
          severity: 'major',
          file: 'unknown',
          description: 'Judge output parsing failed',
          suggestion: 'Review output manually',
        }],
        filesReviewed: [],
      };
    }

    // Store for FixerPhase
    context.variables.set('judgeVerdict', judgeOutput.verdict);
    context.variables.set('judgeScore', judgeOutput.score);
    context.variables.set('judgeIssues', judgeOutput.issues);

    const storyInfo = currentStory ? ` for story "${currentStory.title}"` : '';
    console.log(`[JudgePhase] Verdict${storyInfo}: ${judgeOutput.verdict} (score: ${judgeOutput.score})`);
    if (judgeOutput.issues.length > 0) {
      console.log(`[JudgePhase] Issues found: ${judgeOutput.issues.length}`);
      for (const issue of judgeOutput.issues) {
        console.log(`  - [${issue.severity}] ${issue.file}: ${issue.description}`);
      }
    }

    return {
      success: true,
      output: judgeOutput,
      metadata: {
        sessionId: result.sessionId,
        turns: result.turns,
        toolCalls: result.toolCalls.length,
        vulnerabilities: result.vulnerabilities.length,
        verdict: judgeOutput.verdict,
        score: judgeOutput.score,
        storyId: currentStory?.id,
      },
    };
  }
}
