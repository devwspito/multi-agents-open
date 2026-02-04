/**
 * Analysis Phase V2
 *
 * New architecture:
 * - Creates ONE OpenCode session for the entire phase
 * - ANALYST → JUDGE loop within same session
 * - HOST creates branch before starting
 * - Final analysis becomes branch description
 *
 * Flow:
 * 1. HOST: Create branch task/{taskId}
 * 2. Create OpenCode session (with allow-all permissions)
 * 3. Send ANALYST prompt → wait for idle
 * 4. Send JUDGE prompt → wait for idle
 * 5. If rejected → send FIX prompt → back to JUDGE
 * 6. If approved → save analysis as branch description
 * 7. HOST: Commit + Push
 */

import { Task, Story, RepositoryInfo } from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { gitService } from '../../services/git/index.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { socketService } from '../../services/realtime/index.js';
import { agentSpy, Vulnerability } from '../../services/security/AgentSpy.js';

export interface AnalysisResult {
  success: boolean;
  sessionId: string;
  analysis: {
    summary: string;
    approach: string;
    risks: string[];
  };
  stories: Story[];
  branchName: string;
  /** Vulnerabilities detected by SPY (does not block) */
  vulnerabilities: Vulnerability[];
  error?: string;
}

export interface AnalysisPhaseContext {
  task: Task;
  projectPath: string;
  repositories: RepositoryInfo[];
  /** Called when iteration needs user approval (manual mode) */
  onApprovalRequired?: (type: 'analysis' | 'story', data: any) => Promise<boolean>;
  /** Auto-approve all iterations */
  autoApprove?: boolean;
}

/**
 * Prompts for the Analysis Phase
 */
const PROMPTS = {
  analyst: (task: Task, repositories: RepositoryInfo[], projectPath: string) => `
# Task Analysis & Story Breakdown

## Task Details
- **Task**: ${task.description || task.title}

## Repositories Available
${repositories.map((repo, i) => `
### Repository ${i + 1}: ${repo.name} (${repo.type.toUpperCase()})
- **Type**: ${repo.type}
- **Path**: ${repo.localPath}
- **GitHub**: ${repo.githubUrl}
`).join('\n')}

## Your Mission
1. **Analyze** the task and ALL repositories in the codebase
2. **Break down** the task into small, implementable Stories (2-5 stories, each ~5-20 lines of code)

## Instructions
1. Use Glob to explore project structure at: ${projectPath}
2. Use Read to examine relevant files
3. Use Grep to find related code patterns
4. Divide the task into ordered Stories

## Required Output Format
Output a JSON block:

\`\`\`json
{
  "analysis": {
    "summary": "<brief summary>",
    "approach": "<implementation approach>",
    "risks": ["<risk 1>", "<risk 2>"]
  },
  "stories": [
    {
      "id": "story-1",
      "title": "<short title>",
      "description": "<what this accomplishes>",
      "repository": "<repository name>",
      "filesToModify": ["<path/to/file>"],
      "filesToCreate": ["<new files>"],
      "filesToRead": ["<context files>"],
      "acceptanceCriteria": ["<criterion 1>"]
    }
  ]
}
\`\`\`
`,

  judge: () => `
# Evaluate the Analysis

Review the analysis and stories you just created. Evaluate:

1. **Completeness**: Does the analysis cover all aspects of the task?
2. **Story Quality**: Are stories small, focused, and implementable?
3. **Dependencies**: Are stories ordered correctly by dependency?
4. **Clarity**: Are acceptance criteria clear and testable?

## Required Output Format
Output a JSON block with your verdict:

\`\`\`json
{
  "verdict": "approved" | "needs_revision",
  "score": 0-100,
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "description": "<issue description>",
      "suggestion": "<how to fix>"
    }
  ],
  "summary": "<brief evaluation summary>"
}
\`\`\`

If score >= 80 and no critical/major issues, set verdict to "approved".
`,

  fix: (issues: any[]) => `
# Fix the Analysis Issues

The analysis was evaluated and needs revision. Fix these issues:

${issues.map((issue, i) => `
${i + 1}. [${issue.severity.toUpperCase()}] ${issue.description}
   Suggestion: ${issue.suggestion}
`).join('\n')}

Please revise the analysis and stories to address ALL issues.
Output the corrected JSON block with the same format as before.
`,
};

/**
 * Execute the Analysis Phase
 */
export async function executeAnalysisPhase(
  context: AnalysisPhaseContext
): Promise<AnalysisResult> {
  const { task, projectPath, repositories } = context;
  const autoApprove = context.autoApprove ?? false;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[AnalysisPhase] Starting for task: ${task.title}`);
  console.log(`${'='.repeat(60)}`);

  // Determine working directory (primary repo)
  const workingDirectory = determineWorkingDirectory(repositories, projectPath);

  // === STEP 1: Create branch ===
  console.log(`[AnalysisPhase] Creating branch...`);
  let branchName: string;
  try {
    const branchInfo = await gitService.createBranch(task.id, workingDirectory);
    branchName = branchInfo.name;
    console.log(`[AnalysisPhase] Branch created: ${branchName}`);
  } catch (error: any) {
    // Branch might already exist
    branchName = `task/${task.id}`;
    console.log(`[AnalysisPhase] Using existing branch: ${branchName}`);
    try {
      await gitService.checkout(workingDirectory, branchName);
    } catch {
      return {
        success: false,
        sessionId: '',
        analysis: { summary: '', approach: '', risks: [] },
        stories: [],
        branchName: '',
        vulnerabilities: [],
        error: `Failed to create/checkout branch: ${error.message}`,
      };
    }
  }

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Analysis',
    branchName,
  });

  // === STEP 2: Create OpenCode session ===
  console.log(`[AnalysisPhase] Creating OpenCode session...`);
  const sessionId = await openCodeClient.createSession({
    title: `Analysis: ${task.title}`,
    directory: workingDirectory,
    autoApprove: true, // Always allow-all for OpenCode tools
  });

  console.log(`[AnalysisPhase] Session created: ${sessionId}`);

  // Save session to database
  await SessionRepository.create({
    sessionId,
    taskId: task.id,
    directory: workingDirectory,
    phaseName: 'Analysis',
    approvalMode: autoApprove ? 'all' : 'manual',
  });

  // Notify frontend about session
  socketService.toTask(task.id, 'session:created', {
    sessionId,
    phaseName: 'Analysis',
    directory: workingDirectory,
  });

  // === STEP 3: ANALYST → JUDGE → SPY loop ===
  // Track all vulnerabilities across iterations
  const allVulnerabilities: Vulnerability[] = [];

  // === ANALYST → JUDGE → SPY loop ===
  let analysis: any = null;
  let stories: Story[] = [];
  let approved = false;
  let iterations = 0;
  const maxIterations = 3;

  while (!approved && iterations < maxIterations) {
    iterations++;
    console.log(`\n[AnalysisPhase] Iteration ${iterations}/${maxIterations}`);

    // --- ANALYST ---
    if (iterations === 1) {
      console.log(`[AnalysisPhase] Sending ANALYST prompt...`);
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.analyst(task, repositories, projectPath),
        { directory: workingDirectory }
      );
    }

    // Wait for completion
    const analystEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: workingDirectory,
      timeout: 300000,
    });

    // Extract analysis from output
    const analystOutput = extractFinalOutput(analystEvents);
    const parsedAnalysis = parseAnalysisJSON(analystOutput);

    if (parsedAnalysis) {
      analysis = parsedAnalysis.analysis;
      stories = parsedAnalysis.stories;
    }

    // Notify frontend
    socketService.toTask(task.id, 'iteration:complete', {
      type: 'analyst',
      iteration: iterations,
      analysis,
      stories: stories.map(s => ({ id: s.id, title: s.title })),
    });

    // --- JUDGE ---
    console.log(`[AnalysisPhase] Sending JUDGE prompt...`);
    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.judge(),
      { directory: workingDirectory }
    );

    const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: workingDirectory,
      timeout: 120000,
    });

    const judgeOutput = extractFinalOutput(judgeEvents);
    const verdict = parseJudgeVerdict(judgeOutput);

    console.log(`[AnalysisPhase] Judge verdict: ${verdict.verdict} (score: ${verdict.score})`);

    // Notify frontend
    socketService.toTask(task.id, 'iteration:complete', {
      type: 'judge',
      iteration: iterations,
      verdict: verdict.verdict,
      score: verdict.score,
      issues: verdict.issues,
    });

    // --- SPY (after JUDGE, never blocks) ---
    console.log(`[AnalysisPhase] Running SPY scan...`);
    const spyVulns = await agentSpy.scanWorkspace(workingDirectory, {
      taskId: task.id,
      sessionId,
      phase: 'Analysis',
      iteration: iterations,
    });
    allVulnerabilities.push(...spyVulns);

    // Notify frontend about SPY results
    socketService.toTask(task.id, 'iteration:complete', {
      type: 'spy',
      iteration: iterations,
      vulnerabilities: spyVulns.length,
      bySeverity: {
        critical: spyVulns.filter(v => v.severity === 'critical').length,
        high: spyVulns.filter(v => v.severity === 'high').length,
        medium: spyVulns.filter(v => v.severity === 'medium').length,
        low: spyVulns.filter(v => v.severity === 'low').length,
      },
    });
    console.log(`[AnalysisPhase] SPY found ${spyVulns.length} vulnerabilities (not blocking)`);

    if (verdict.verdict === 'approved') {
      approved = true;
    } else if (verdict.issues && verdict.issues.length > 0) {
      // --- FIX ---
      console.log(`[AnalysisPhase] Sending FIX prompt (${verdict.issues.length} issues)...`);
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.fix(verdict.issues),
        { directory: workingDirectory }
      );
      // Next iteration will wait for the fix and re-judge
    } else {
      // No specific issues, can't improve further
      console.log(`[AnalysisPhase] No specific issues to fix, accepting as-is`);
      approved = true;
    }
  }

  if (!approved) {
    console.log(`[AnalysisPhase] Failed to get approval after ${maxIterations} iterations`);
  }

  // === STEP 4: Save analysis as branch description ===
  if (analysis) {
    const description = `# ${task.title}\n\n## Summary\n${analysis.summary}\n\n## Approach\n${analysis.approach}\n\n## Risks\n${analysis.risks?.map((r: string) => `- ${r}`).join('\n') || 'None identified'}`;

    try {
      await gitService.setBranchDescription(workingDirectory, description);
    } catch {
      // Branch description is optional
    }
  }

  // === STEP 5: Commit + Push (if there are changes) ===
  const hasChanges = await gitService.hasChanges(workingDirectory);
  if (hasChanges) {
    console.log(`[AnalysisPhase] Committing analysis changes...`);
    await gitService.commitAndPush(
      workingDirectory,
      `[Analysis] ${task.title}\n\nGenerated ${stories.length} stories.`
    );
  }

  // Update session status
  await SessionRepository.updateStatus(sessionId, 'completed');

  // === STEP 6: Save to database ===
  if (approved && analysis) {
    await TaskRepository.updateAfterAnalysis(task.id, {
      branchName,
      analysis,
      stories,
    });
    console.log(`[AnalysisPhase] Saved analysis and stories to database`);
  }

  // Notify frontend
  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Analysis',
    success: approved,
    sessionId,
    branchName,
    analysis,
    stories: stories.map(s => ({ id: s.id, title: s.title, description: s.description })),
  });

  console.log(`\n[AnalysisPhase] Completed: ${stories.length} stories created, ${allVulnerabilities.length} vulnerabilities detected`);

  return {
    success: approved,
    sessionId,
    analysis: analysis || { summary: '', approach: '', risks: [] },
    stories,
    branchName,
    vulnerabilities: allVulnerabilities,
  };
}

// === Helper Functions ===

function determineWorkingDirectory(repositories: RepositoryInfo[], projectPath: string): string {
  if (!repositories || repositories.length === 0) {
    return projectPath;
  }

  // Prefer backend repo
  const sorted = [...repositories].sort((a, b) => {
    if (a.type === 'backend' && b.type !== 'backend') return -1;
    if (b.type === 'backend' && a.type !== 'backend') return 1;
    return (a.executionOrder ?? 999) - (b.executionOrder ?? 999);
  });

  return sorted[0].localPath;
}

function extractFinalOutput(events: any[]): string {
  // Look for the last text output
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

function parseAnalysisJSON(output: string): { analysis: any; stories: Story[] } | null {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const stories = (data.stories || []).map((s: any, i: number) => ({
        id: s.id || `story-${i + 1}`,
        title: s.title || `Story ${i + 1}`,
        description: s.description || '',
        status: 'pending' as const,
        filesToModify: s.filesToModify || [],
        filesToCreate: s.filesToCreate || [],
        filesToRead: s.filesToRead || [],
        acceptanceCriteria: s.acceptanceCriteria || [],
      }));
      return { analysis: data.analysis, stories };
    }
  } catch (e) {
    console.warn(`[AnalysisPhase] Failed to parse JSON: ${e}`);
  }
  return null;
}

function parseJudgeVerdict(output: string): {
  verdict: 'approved' | 'needs_revision';
  score: number;
  issues: any[];
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
        summary: data.summary || '',
      };
    }
  } catch (e) {
    console.warn(`[AnalysisPhase] Failed to parse judge verdict: ${e}`);
  }
  return { verdict: 'needs_revision', score: 0, issues: [], summary: '' };
}
