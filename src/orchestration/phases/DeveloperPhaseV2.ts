/**
 * Developer Phase V2
 *
 * New architecture:
 * - Creates ONE OpenCode session for ALL stories
 * - DEV → JUDGE → FIX loop within same session per story
 * - HOST commits + pushes after each approved story
 * - User can send messages to session anytime
 *
 * Flow per story:
 * 1. Send DEV prompt → wait for idle
 * 2. Send JUDGE prompt → wait for idle
 * 3. If rejected → send FIX prompt → back to JUDGE
 * 4. If approved → HOST: commit + push
 * 5. Next story
 */

import { Task, Story, RepositoryInfo } from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { gitService } from '../../services/git/index.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { socketService } from '../../services/realtime/index.js';
import { agentSpy, Vulnerability } from '../../services/security/AgentSpy.js';

export interface StoryResult {
  storyId: string;
  storyTitle: string;
  success: boolean;
  verdict: 'approved' | 'rejected' | 'needs_revision';
  iterations: number;
  commitHash?: string;
  /** Vulnerabilities detected by SPY for this story */
  vulnerabilities: Vulnerability[];
}

export interface DeveloperResult {
  success: boolean;
  sessionId: string;
  storyResults: StoryResult[];
  totalCommits: number;
  /** All vulnerabilities across all stories */
  allVulnerabilities: Vulnerability[];
  error?: string;
}

export interface DeveloperPhaseContext {
  task: Task;
  projectPath: string;
  repositories: RepositoryInfo[];
  stories: Story[];
  branchName: string;
  /** Called when iteration needs user approval (manual mode) */
  onApprovalRequired?: (storyId: string, data: any) => Promise<boolean>;
  /** Auto-approve all iterations */
  autoApprove?: boolean;
}

/**
 * Prompts for the Developer Phase
 */
const PROMPTS = {
  developer: (story: Story, storyIndex: number, totalStories: number, repositories: RepositoryInfo[]) => `
# Story Implementation (${storyIndex + 1}/${totalStories})

## Story Details
- **ID**: ${story.id}
- **Title**: ${story.title}
- **Description**: ${story.description}

## Files Context
- **Files to Modify**: ${story.filesToModify?.join(', ') || 'Not specified'}
- **Files to Create**: ${story.filesToCreate?.join(', ') || 'None'}
- **Files to Read for Context**: ${story.filesToRead?.join(', ') || 'None specified'}

## Acceptance Criteria
${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified'}

## Available Repositories
${repositories.map(r => `- **${r.name}** (${r.type}): ${r.localPath}`).join('\n')}

## Your Mission
Implement ONLY this story. Do not implement other stories.

## Instructions
1. Read the files specified in "Files to Read for Context"
2. Modify files in "Files to Modify" using the Edit tool
3. Create files in "Files to Create" using the Write tool
4. Run any necessary commands (npm install, tests, etc.)

## Guidelines
- Focus ONLY on this story
- Write clean, well-documented code
- Follow existing code patterns
- Make minimal, focused changes
- Ensure acceptance criteria are met

## Output
After completing the story, summarize:
- What files were modified/created
- What changes were made
- Whether acceptance criteria were met
`,

  judge: (story: Story) => `
# Evaluate the Implementation

Review the code changes you just made for story "${story.title}".

## Acceptance Criteria to Check
${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified'}

## Evaluation Checklist
1. **Correctness**: Does the code work correctly?
2. **Completeness**: Are all acceptance criteria met?
3. **Code Quality**: Is the code clean and follows patterns?
4. **Security**: Any security issues? (SQL injection, XSS, etc.)
5. **Tests**: Were tests added/updated if needed?

## Required Output Format
Output a JSON block with your verdict:

\`\`\`json
{
  "verdict": "approved" | "needs_revision" | "rejected",
  "score": 0-100,
  "criteriaStatus": [
    { "criterion": "<criterion text>", "met": true/false, "notes": "<optional notes>" }
  ],
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "file": "<file path>",
      "description": "<issue description>",
      "suggestion": "<how to fix>"
    }
  ],
  "summary": "<brief evaluation summary>"
}
\`\`\`

Guidelines:
- "approved" (score >= 80): All criteria met, no critical/major issues
- "needs_revision" (50-79): Has fixable issues
- "rejected" (< 50): Fundamental problems, needs complete redo
`,

  fix: (issues: any[]) => `
# Fix the Implementation Issues

The implementation was evaluated and needs fixes. Address these issues:

${issues.map((issue, i) => `
${i + 1}. [${issue.severity.toUpperCase()}] ${issue.file ? `(${issue.file})` : ''} ${issue.description}
   Suggestion: ${issue.suggestion}
`).join('\n')}

Please fix ALL issues. Use Edit tool to modify files.
After fixing, output a summary of what was changed.
`,
};

/**
 * Execute the Developer Phase
 */
export async function executeDeveloperPhase(
  context: DeveloperPhaseContext
): Promise<DeveloperResult> {
  const { task, projectPath, repositories, stories, branchName } = context;
  const autoApprove = context.autoApprove ?? false;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[DeveloperPhase] Starting for task: ${task.title}`);
  console.log(`[DeveloperPhase] Stories to implement: ${stories.length}`);
  console.log(`${'='.repeat(60)}`);

  // Determine working directory
  const workingDirectory = determineWorkingDirectory(repositories, projectPath);

  // Ensure we're on the correct branch
  try {
    await gitService.checkout(workingDirectory, branchName);
  } catch {
    console.log(`[DeveloperPhase] Branch ${branchName} not found locally, continuing...`);
  }

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Developer',
    totalStories: stories.length,
  });

  // === Create OpenCode session ===
  console.log(`[DeveloperPhase] Creating OpenCode session...`);
  const sessionId = await openCodeClient.createSession({
    title: `Developer: ${task.title}`,
    directory: workingDirectory,
    autoApprove: true, // Always allow-all for OpenCode tools
  });

  console.log(`[DeveloperPhase] Session created: ${sessionId}`);

  // Save session to database
  await SessionRepository.create({
    sessionId,
    taskId: task.id,
    directory: workingDirectory,
    phaseName: 'Developer',
    approvalMode: autoApprove ? 'all' : 'manual',
  });

  // Notify frontend about session
  socketService.toTask(task.id, 'session:created', {
    sessionId,
    phaseName: 'Developer',
    directory: workingDirectory,
  });

  // === Process each story ===
  const storyResults: StoryResult[] = [];
  let totalCommits = 0;

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[DeveloperPhase] STORY ${i + 1}/${stories.length}: ${story.title}`);
    console.log(`${'─'.repeat(60)}`);

    // Notify frontend
    socketService.toTask(task.id, 'story:start', {
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      totalStories: stories.length,
    });

    const result = await executeStory(
      sessionId,
      story,
      i,
      stories.length,
      repositories,
      workingDirectory,
      task.id,
      autoApprove
    );

    storyResults.push(result);

    // Commit + Push if approved
    if (result.success && result.verdict === 'approved') {
      const hasChanges = await gitService.hasChanges(workingDirectory);
      if (hasChanges) {
        console.log(`[DeveloperPhase] Committing story ${story.id}...`);
        const commit = await gitService.commitAndPush(
          workingDirectory,
          `Implement: ${story.title}`,
          { storyId: story.id, storyTitle: story.title }
        );
        result.commitHash = commit.hash;
        totalCommits++;
        console.log(`[DeveloperPhase] Committed: ${commit.hash.substring(0, 7)}`);
      }
    }

    // Notify frontend
    socketService.toTask(task.id, 'story:complete', {
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      success: result.success,
      verdict: result.verdict,
      iterations: result.iterations,
      commitHash: result.commitHash,
      totalStories: stories.length,
      completedStories: i + 1,
    });
  }

  // Update session status
  await SessionRepository.updateStatus(sessionId, 'completed');

  // Calculate overall success
  const allApproved = storyResults.every(r => r.verdict === 'approved');
  const approvedCount = storyResults.filter(r => r.verdict === 'approved').length;

  // Notify frontend
  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Developer',
    success: allApproved,
    sessionId,
    storyResults: storyResults.map(r => ({
      storyId: r.storyId,
      verdict: r.verdict,
      commitHash: r.commitHash,
    })),
    totalCommits,
    approvedCount,
    totalStories: stories.length,
  });

  // Collect all vulnerabilities from all stories
  const allVulnerabilities = storyResults.flatMap(r => r.vulnerabilities || []);

  console.log(`\n[DeveloperPhase] Completed: ${approvedCount}/${stories.length} stories approved, ${allVulnerabilities.length} total vulnerabilities`);

  return {
    success: allApproved,
    sessionId,
    storyResults,
    totalCommits,
    allVulnerabilities,
  };
}

/**
 * Execute a single story with DEV → JUDGE → SPY → FIX loop
 */
async function executeStory(
  sessionId: string,
  story: Story,
  storyIndex: number,
  totalStories: number,
  repositories: RepositoryInfo[],
  workingDirectory: string,
  taskId: string,
  autoApprove: boolean
): Promise<StoryResult> {
  let approved = false;
  let verdict: 'approved' | 'rejected' | 'needs_revision' = 'needs_revision';
  let iterations = 0;
  const maxIterations = 3;
  const storyVulnerabilities: Vulnerability[] = [];

  while (!approved && iterations < maxIterations) {
    iterations++;
    console.log(`[DeveloperPhase] Story ${story.id} - Iteration ${iterations}/${maxIterations}`);

    // --- DEVELOPER ---
    if (iterations === 1) {
      console.log(`[DeveloperPhase] Sending DEV prompt...`);
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.developer(story, storyIndex, totalStories, repositories),
        { directory: workingDirectory }
      );
    }

    // Wait for completion
    await openCodeClient.waitForIdle(sessionId, {
      directory: workingDirectory,
      timeout: 300000,
    });

    // Notify frontend
    socketService.toTask(taskId, 'iteration:complete', {
      type: 'developer',
      storyId: story.id,
      iteration: iterations,
    });

    // --- JUDGE ---
    console.log(`[DeveloperPhase] Sending JUDGE prompt...`);
    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.judge(story),
      { directory: workingDirectory }
    );

    const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: workingDirectory,
      timeout: 120000,
    });

    const judgeOutput = extractFinalOutput(judgeEvents);
    const judgeResult = parseJudgeVerdict(judgeOutput);

    verdict = judgeResult.verdict;
    console.log(`[DeveloperPhase] Judge verdict: ${verdict} (score: ${judgeResult.score})`);

    // Notify frontend
    socketService.toTask(taskId, 'iteration:complete', {
      type: 'judge',
      storyId: story.id,
      iteration: iterations,
      verdict,
      score: judgeResult.score,
      issues: judgeResult.issues?.length || 0,
    });

    // --- SPY (after JUDGE, never blocks) ---
    console.log(`[DeveloperPhase] Running SPY scan for story ${story.id}...`);
    const spyVulns = await agentSpy.scanWorkspace(workingDirectory, {
      taskId,
      sessionId,
      phase: 'Developer',
      storyId: story.id,
      iteration: iterations,
    }, {
      filesToScan: [...(story.filesToModify || []), ...(story.filesToCreate || [])],
    });
    storyVulnerabilities.push(...spyVulns);

    // Notify frontend about SPY results
    socketService.toTask(taskId, 'iteration:complete', {
      type: 'spy',
      storyId: story.id,
      iteration: iterations,
      vulnerabilities: spyVulns.length,
      bySeverity: {
        critical: spyVulns.filter(v => v.severity === 'critical').length,
        high: spyVulns.filter(v => v.severity === 'high').length,
        medium: spyVulns.filter(v => v.severity === 'medium').length,
        low: spyVulns.filter(v => v.severity === 'low').length,
      },
    });
    console.log(`[DeveloperPhase] SPY found ${spyVulns.length} vulnerabilities (not blocking)`);

    if (verdict === 'approved') {
      approved = true;
    } else if (verdict === 'rejected') {
      // Fundamental problem, stop trying
      console.log(`[DeveloperPhase] Story rejected - stopping iterations`);
      break;
    } else if (judgeResult.issues && judgeResult.issues.length > 0) {
      // --- FIX ---
      console.log(`[DeveloperPhase] Sending FIX prompt (${judgeResult.issues.length} issues)...`);
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.fix(judgeResult.issues),
        { directory: workingDirectory }
      );
      // Next iteration will wait for the fix and re-judge
    } else {
      // No specific issues but not approved
      console.log(`[DeveloperPhase] No specific issues to fix, accepting as-is`);
      approved = true;
      verdict = 'approved';
    }
  }

  return {
    storyId: story.id,
    storyTitle: story.title,
    success: verdict === 'approved',
    verdict,
    iterations,
    vulnerabilities: storyVulnerabilities,
  };
}

// === Helper Functions ===

function determineWorkingDirectory(repositories: RepositoryInfo[], projectPath: string): string {
  if (!repositories || repositories.length === 0) {
    return projectPath;
  }

  const sorted = [...repositories].sort((a, b) => {
    if (a.type === 'backend' && b.type !== 'backend') return -1;
    if (b.type === 'backend' && a.type !== 'backend') return 1;
    return (a.executionOrder ?? 999) - (b.executionOrder ?? 999);
  });

  return sorted[0].localPath;
}

function extractFinalOutput(events: any[]): string {
  let output = '';
  for (const event of events) {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      if (part?.type === 'text') {
        output = part.text || output;
      }
    }
  }
  return output;
}

function parseJudgeVerdict(output: string): {
  verdict: 'approved' | 'needs_revision' | 'rejected';
  score: number;
  issues: any[];
  criteriaStatus: any[];
  summary: string;
} {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      return {
        verdict: data.verdict || 'needs_revision',
        score: data.score || 0,
        issues: data.issues || [],
        criteriaStatus: data.criteriaStatus || [],
        summary: data.summary || '',
      };
    }
  } catch (e) {
    console.warn(`[DeveloperPhase] Failed to parse judge verdict: ${e}`);
  }
  return { verdict: 'needs_revision', score: 0, issues: [], criteriaStatus: [], summary: '' };
}

/**
 * Send a user message to the active developer session
 * This allows the user to intervene and chat with OpenCode
 */
export async function sendUserMessage(
  taskId: string,
  message: string
): Promise<boolean> {
  const session = await SessionRepository.findActiveByTaskId(taskId);
  if (!session || session.phaseName !== 'Developer') {
    console.warn(`[DeveloperPhase] No active developer session for task ${taskId}`);
    return false;
  }

  await openCodeClient.sendPrompt(
    session.sessionId,
    message,
    { directory: session.directory }
  );

  console.log(`[DeveloperPhase] User message sent to session ${session.sessionId}`);
  return true;
}
