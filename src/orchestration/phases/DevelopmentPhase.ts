/**
 * Development Phase
 *
 * Implements changes for a SINGLE STORY.
 * The Orchestrator iterates stories and calls this phase for each.
 *
 * Uses OpenCode SDK for agent execution.
 */

import { BasePhase, PhaseContext, PhaseResult, OpenCodeExecutionResult } from '../Phase.js';
import { Story } from '../../types/index.js';

export class DevelopmentPhase extends BasePhase {
  readonly name = 'Development';
  readonly description = 'Implement the required code changes for a story';
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
    const { task, projectPath, repositories } = context;
    const analysis = context.variables.get('analysis') || 'No prior analysis available';
    const currentStory = context.variables.get('currentStory') as Story | undefined;
    const storyIndex = context.variables.get('storyIndex') as number || 0;
    const totalStories = context.variables.get('totalStories') as number || 1;

    // Build repository info section
    let repoSection = '';
    if (repositories && repositories.length > 0) {
      repoSection = `## Available Repositories
${repositories.map((repo, i) => `- **${repo.name}** (${repo.type}): ${repo.localPath}`).join('\n')}

`;
    }

    // Build story-specific prompt if we have a story
    if (currentStory) {
      const filesToModify = currentStory.filesToModify?.join(', ') || 'Not specified';
      const filesToCreate = currentStory.filesToCreate?.join(', ') || 'None';
      const filesToRead = currentStory.filesToRead?.join(', ') || 'None specified';
      const acceptanceCriteria = currentStory.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified';

      return `# Story Implementation (${storyIndex + 1}/${totalStories})

## Story Details
- **ID**: ${currentStory.id}
- **Title**: ${currentStory.title}
- **Description**: ${currentStory.description}

${repoSection}## Files Context
- **Files to Modify**: ${filesToModify}
- **Files to Create**: ${filesToCreate}
- **Files to Read for Context**: ${filesToRead}

## Acceptance Criteria
${acceptanceCriteria}

## Prior Analysis
${typeof analysis === 'object' ? JSON.stringify(analysis, null, 2) : analysis}

## Your Mission
Implement ONLY this story. Do not implement other stories.

## Instructions
1. Read the files specified in "Files to Read for Context"
2. Modify files in "Files to Modify" using the Edit tool
3. Create files in "Files to Create" using the Write tool
4. Run any necessary commands (npm install, etc.)

## Guidelines
- Focus ONLY on this story
- Write clean, well-documented code
- Follow existing code patterns
- Make minimal, focused changes
- Ensure acceptance criteria are met
${repositories.length > 1 ? `- Files may span MULTIPLE repositories (backend/frontend)` : ''}

## Project Path
${projectPath}

## Output
After completing the story, summarize:
- What files were modified/created
- What changes were made
- Whether acceptance criteria were met`;
    }

    // Fallback to original prompt if no story context
    const taskDescription = task.description || task.title;

    return `# Development Task

## Task Details
- **Task**: ${taskDescription}

${repoSection}## Prior Analysis
${typeof analysis === 'object' ? JSON.stringify(analysis, null, 2) : analysis}

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
${repositories.length > 1 ? `- Changes may be needed in MULTIPLE repositories` : ''}

## Project Path
${projectPath}

## Output
After making changes, summarize:
- What files were modified/created
- What changes were made
- Any issues encountered`;
  }

  protected getSystemPrompt(): string {
    const currentStory = this.getCurrentStoryFromContext();

    if (currentStory) {
      return `You are a senior software developer agent implementing a specific story.

Your current story: "${currentStory.title}"

You excel at:
- Writing clean, maintainable code
- Following existing code patterns
- Making minimal, focused changes
- Meeting acceptance criteria

Guidelines:
- ONLY implement the current story, nothing more
- Always read files before editing them
- Use Edit for modifications, Write for new files
- Follow the project's coding style
- Ensure all acceptance criteria are met`;
    }

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

  private getCurrentStoryFromContext(): Story | undefined {
    // This is a workaround - ideally we'd pass context to getSystemPrompt
    return undefined;
  }

  async processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult> {
    const currentStory = context.variables.get('currentStory') as Story | undefined;

    // Track which files were modified
    const filesModified = result.toolCalls
      .filter(tc => tc.toolName === 'Edit' || tc.toolName === 'Write')
      .map(tc => tc.toolInput?.file_path)
      .filter(Boolean);

    context.variables.set('filesModified', filesModified);

    // Update story with development output if we have one
    if (currentStory) {
      currentStory.developmentOutput = result.finalOutput;
      currentStory.status = 'in_progress'; // Will be set to completed after Judge approves
    }

    return {
      success: true,
      output: {
        storyId: currentStory?.id,
        storyTitle: currentStory?.title,
        summary: result.finalOutput,
        filesModified,
        toolCalls: result.toolCalls.length,
      },
      metadata: {
        sessionId: result.sessionId,
        turns: result.turns,
        vulnerabilities: result.vulnerabilities.length,
      },
    };
  }
}
