/**
 * Development Phase
 *
 * Implements the changes required by the task.
 */

import { BasePhase, PhaseContext, PhaseResult } from '../Phase.js';
import { AgentExecutionResponse } from '../../types/index.js';

export class DevelopmentPhase extends BasePhase {
  readonly name = 'Development';
  readonly description = 'Implement the required code changes';
  readonly agentType = 'developer';

  async validate(context: PhaseContext): Promise<boolean> {
    // Require analysis to be done first
    const analysis = context.previousResults.get('Analysis');
    if (!analysis?.success) {
      console.log('[DevelopmentPhase] Analysis phase must complete successfully first');
      return false;
    }
    return true;
  }

  buildPrompt(context: PhaseContext): string {
    const { task, projectPath } = context;
    const analysis = context.variables.get('analysis') || 'No prior analysis available';

    return `# Development Task

## Task Details
- **Title**: ${task.title}
- **Description**: ${task.description || 'No description provided'}

## Prior Analysis
${analysis}

## Your Mission
Implement the required changes based on the analysis above.

## Instructions
1. Read the relevant files using the Read tool
2. Make changes using the Edit tool for existing files
3. Create new files using the Write tool if needed
4. Use Bash to run any necessary commands (npm install, etc.)

## Guidelines
- Write clean, well-documented code
- Follow existing code patterns in the project
- Make minimal, focused changes
- Test your changes work as expected

## Project Path
${projectPath}

## Output
After making changes, summarize:
- What files were modified/created
- What changes were made
- Any issues encountered`;
  }

  protected getSystemPrompt(): string {
    return `You are a senior software developer agent. Your job is to implement code changes.

You excel at:
- Writing clean, maintainable code
- Following existing code patterns
- Making minimal, focused changes
- Testing your work

Guidelines:
- Always read files before editing them
- Use Edit for modifications, Write for new files
- Follow the project's coding style
- Be thorough but efficient`;
  }

  async processOutput(output: AgentExecutionResponse, context: PhaseContext): Promise<PhaseResult> {
    // Track which files were modified
    const filesModified = output.toolCalls
      .filter(tc => tc.toolName === 'Edit' || tc.toolName === 'Write')
      .map(tc => tc.toolInput.file_path)
      .filter(Boolean);

    context.variables.set('filesModified', filesModified);

    return {
      success: true,
      output: {
        summary: output.finalOutput,
        filesModified,
        toolCalls: output.toolCalls.length,
      },
      metadata: {
        turns: output.turns,
        tokens: output.usage.totalTokens,
      },
    };
  }
}
