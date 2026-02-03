/**
 * Analysis Phase
 *
 * Analyzes the task requirements and codebase to understand
 * what needs to be done.
 */

import { BasePhase, PhaseContext, PhaseResult } from '../Phase.js';
import { AgentExecutionResponse } from '../../types/index.js';

export class AnalysisPhase extends BasePhase {
  readonly name = 'Analysis';
  readonly description = 'Analyze task requirements and understand the codebase context';
  readonly agentType = 'analyst';

  buildPrompt(context: PhaseContext): string {
    const { task, projectPath } = context;

    return `# Task Analysis

## Task Details
- **Title**: ${task.title}
- **Description**: ${task.description || 'No description provided'}

## Your Mission
Analyze this task and the codebase to understand:

1. **Scope**: What exactly needs to be done?
2. **Files**: Which files are likely involved?
3. **Dependencies**: What existing code will this interact with?
4. **Risks**: What could go wrong?

## Instructions
1. Use the Glob tool to explore the project structure at: ${projectPath}
2. Use the Read tool to examine relevant files
3. Use the Grep tool to find related code patterns

## Output
Provide a structured analysis with:
- Summary of the task
- List of files to modify/create
- Potential challenges
- Recommended approach`;
  }

  protected getSystemPrompt(): string {
    return `You are a code analyst agent. Your job is to thoroughly understand tasks and codebases.

You excel at:
- Reading and understanding code structures
- Identifying dependencies and relationships
- Finding potential issues before they occur
- Breaking down complex tasks into clear steps

Be thorough but concise. Focus on actionable insights.`;
  }

  async processOutput(output: AgentExecutionResponse, context: PhaseContext): Promise<PhaseResult> {
    // Store analysis in context for later phases
    context.variables.set('analysis', output.finalOutput);

    return {
      success: true,
      output: {
        analysis: output.finalOutput,
        toolsUsed: output.toolCalls.map(tc => tc.toolName),
      },
      metadata: {
        turns: output.turns,
        tokens: output.usage.totalTokens,
      },
    };
  }
}
