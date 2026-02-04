/**
 * Analysis Phase
 *
 * Analyzes the task requirements and codebase to understand
 * what needs to be done. ALSO breaks down the task into Stories.
 *
 * Uses OpenCode SDK for agent execution.
 */

import { BasePhase, PhaseContext, PhaseResult, OpenCodeExecutionResult } from '../Phase.js';
import { Story } from '../../types/index.js';

export class AnalysisPhase extends BasePhase {
  readonly name = 'Analysis';
  readonly description = 'Analyze task requirements and break down into stories';
  readonly agentType = 'analyst';

  buildPrompt(context: PhaseContext): string {
    const { task, projectPath, repositories } = context;

    // Use description if provided, otherwise use title as the task description
    const taskDescription = task.description || task.title;

    // Build repository info section
    let repoSection = '';
    if (repositories && repositories.length > 0) {
      repoSection = `## Repositories Available
This project has ${repositories.length} repositories. You MUST explore ALL of them:

${repositories.map((repo, i) => `### Repository ${i + 1}: ${repo.name} (${repo.type.toUpperCase()})
- **Type**: ${repo.type}
- **Path**: ${repo.localPath}
- **GitHub**: ${repo.githubUrl}
- **Description**: ${repo.description || 'No description'}
`).join('\n')}

**IMPORTANT**: The task may require changes in MULTIPLE repositories. For example:
- Backend changes for API endpoints
- Frontend changes for UI components
- When specifying files in stories, include the full path starting from the repository folder.
`;
    }

    return `# Task Analysis & Story Breakdown

## Task Details
- **Task**: ${taskDescription}

${repoSection}
## Your Mission
1. **Analyze** the task and ALL repositories in the codebase
2. **Break down** the task into small, implementable Stories

## Instructions
1. Use the Glob tool to explore the project structure at: ${projectPath}
${repositories.length > 0 ? `   - Explore each repository: ${repositories.map(r => r.name).join(', ')}` : ''}
2. Use the Read tool to examine relevant files
3. Use the Grep tool to find related code patterns
4. Divide the task into 2-5 Stories (each ~5-20 lines of code)
${repositories.length > 1 ? `5. Consider if changes are needed in BOTH backend and frontend repositories` : ''}

## Story Guidelines
- Each story should be INDEPENDENTLY implementable
- Stories should be ordered by dependency (what needs to be done first)
- Each story should modify/create only a few files
- Be specific about what files to touch
${repositories.length > 1 ? `- Indicate which REPOSITORY each file belongs to (e.g., "backend/src/routes/auth.ts")` : ''}

## Required Output Format
After your analysis, you MUST output a JSON block with stories:

\`\`\`json
{
  "analysis": {
    "summary": "<brief summary of the task>",
    "approach": "<recommended implementation approach>",
    "risks": ["<risk 1>", "<risk 2>"]
  },
  "stories": [
    {
      "id": "story-1",
      "title": "<short title>",
      "description": "<what this story accomplishes>",
      "repository": "<repository name if multiple repos>",
      "filesToModify": ["<full/path/to/file1>", "<full/path/to/file2>"],
      "filesToCreate": ["<new file if any>"],
      "filesToRead": ["<files to read for context>"],
      "acceptanceCriteria": ["<criterion 1>", "<criterion 2>"]
    }
  ]
}
\`\`\`

## Example Stories
For a task like "Add user authentication" with backend + frontend:
- Story 1: "Create User model in backend" (backend)
- Story 2: "Add registration API endpoint" (backend)
- Story 3: "Add login form component" (frontend)
- Story 4: "Connect login form to API" (frontend)

## Project Path
${projectPath}`;
  }

  protected getSystemPrompt(): string {
    return `You are a senior software architect and analyst. Your job is to:
1. Thoroughly understand tasks and codebases
2. Break down complex tasks into small, manageable Stories

You excel at:
- Reading and understanding code structures
- Identifying dependencies and relationships
- Breaking down work into atomic, implementable units
- Creating clear, actionable stories

CRITICAL: You MUST output a JSON block with the analysis and stories.
Each story should be small enough to implement in ~5-20 lines of code.
Order stories by dependency - what needs to be done first.`;
  }

  async processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult> {
    const output = result.finalOutput;

    // Try to extract JSON from output
    let analysisData: any = null;
    let stories: Story[] = [];

    try {
      // Look for JSON block in output
      const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        analysisData = JSON.parse(jsonMatch[1]);
      } else {
        // Try to find raw JSON
        const rawJson = output.match(/\{[\s\S]*"stories"[\s\S]*\}/);
        if (rawJson) {
          analysisData = JSON.parse(rawJson[0]);
        }
      }

      if (analysisData?.stories && Array.isArray(analysisData.stories)) {
        stories = analysisData.stories.map((s: any, index: number) => ({
          id: s.id || `story-${index + 1}`,
          title: s.title || `Story ${index + 1}`,
          description: s.description || '',
          status: 'pending' as const,
          filesToModify: s.filesToModify || [],
          filesToCreate: s.filesToCreate || [],
          filesToRead: s.filesToRead || [],
          acceptanceCriteria: s.acceptanceCriteria || [],
        }));
      }
    } catch (error: any) {
      console.warn(`[AnalysisPhase] Failed to parse stories JSON: ${error.message}`);
    }

    // If no stories parsed, create a single story for the whole task
    if (stories.length === 0) {
      console.log('[AnalysisPhase] No stories parsed, creating single story from task');
      stories = [{
        id: 'story-1',
        title: context.task.title,
        description: context.task.description || context.task.title,
        status: 'pending',
        filesToModify: [],
        filesToCreate: [],
        filesToRead: [],
        acceptanceCriteria: [],
      }];
    }

    // Store in context for later phases
    context.variables.set('analysis', analysisData?.analysis || output);
    context.variables.set('stories', stories);

    console.log(`[AnalysisPhase] Created ${stories.length} stories:`);
    stories.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.title}`);
    });

    return {
      success: true,
      output: {
        analysis: analysisData?.analysis || output,
        stories,
        storyCount: stories.length,
        toolsUsed: result.toolCalls.map(tc => tc.toolName),
      },
      metadata: {
        sessionId: result.sessionId,
        turns: result.turns,
        toolCalls: result.toolCalls.length,
        vulnerabilities: result.vulnerabilities.length,
      },
    };
  }
}
