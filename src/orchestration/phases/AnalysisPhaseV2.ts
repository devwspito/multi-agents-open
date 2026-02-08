/**
 * Analysis Phase V2
 *
 * Architecture:
 * - analysis.vulnerabilities: SPY findings during analysis iterations
 * - stories[]: each story has vulnerabilities (filled in Developer phase)
 *
 * Flow:
 * 1. HOST: Create branch task/{taskId}
 * 2. Create OpenCode session (with allow-all permissions)
 * 3. ANALYST → JUDGE → SPY loop (SPY runs after each JUDGE)
 * 4. If approved → save analysis
 * 5. HOST: Commit + Push
 *
 * Note: Global Scan runs as SEPARATE FINAL PHASE after Merge
 */

import {
  Task,
  Story,
  RepositoryInfo,
  AnalysisResultV2,
  AnalysisDataV2,
  StoryResultV2,
  VulnerabilityV2,
  ProjectSpecialistsConfig,
  DEFAULT_PROJECT_SPECIALISTS,
} from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../../services/opencode/OpenCodeEventBridge.js';
import { gitService } from '../../services/git/index.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { agentSpy } from '../../services/security/AgentSpy.js';
import { specialistManager } from '../../services/specialists/index.js';

// Re-export types for backward compatibility
export type { AnalysisResultV2 as AnalysisResult };

export interface AnalysisPhaseContext {
  task: Task;
  projectPath: string;
  repositories: RepositoryInfo[];
  /** Called when iteration needs user approval (manual mode) */
  onApprovalRequired?: (type: 'analysis' | 'story', data: any) => Promise<boolean>;
  /** Auto-approve all iterations */
  autoApprove?: boolean;
  /** 🔥 Project LLM configuration */
  llmConfig?: {
    providerID: string;
    modelID: string;
    apiKey?: string;
  };
  /** 🔥 Project specialists configuration */
  specialists?: ProjectSpecialistsConfig;
}

/**
 * Prompts for the Analysis Phase
 */
const PROMPTS = {
  /**
   * 🔥 Clarifying Questions - asks before analysis to identify ambiguities
   * Returns questions the user should answer to avoid assumptions
   */
  clarifier: (task: Task, specialistContext?: string) => `
${specialistContext || ''}

# Identify Clarifying Questions

Before starting the analysis, identify any ambiguities or missing details in the task description that could lead to incorrect assumptions.

## Task Description
"${task.description || task.title}"

## Your Mission
Identify 2-5 specific questions that, if answered, would significantly improve the accuracy of the implementation. Focus on:

1. **Technical choices**: Technology stack, frameworks, or libraries to use
2. **Scope boundaries**: What is in/out of scope
3. **Business logic**: Edge cases, validation rules, error handling
4. **UI/UX**: Design preferences, component placement, user flow
5. **Integration**: API contracts, data formats, external dependencies

## Guidelines
- Only ask questions where the answer could change the implementation
- Be specific and concise
- Avoid questions that can be answered by exploring the codebase
- Maximum 5 questions

## Required Output Format
Output a JSON block:

\`\`\`json
{
  "questions": [
    {
      "id": "q1",
      "question": "<the clarifying question>",
      "category": "technical" | "scope" | "business" | "ui" | "integration",
      "impact": "<why this matters for implementation>"
    }
  ],
  "assumptionsIfSkipped": [
    "<what you will assume if user skips clarification>"
  ]
}
\`\`\`
`,

  analyst: (task: Task, repositories: RepositoryInfo[], projectPath: string, clarifications?: string, specialistContext?: string) => `
${specialistContext || ''}

# Task Analysis & Story Breakdown

## Task Details
- **Task**: ${task.description || task.title}
${clarifications ? `
## User Clarifications
The user has provided the following clarifications to guide the implementation:
${clarifications}
` : ''}
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
): Promise<AnalysisResultV2> {
  const { task, projectPath, repositories, llmConfig, specialists } = context;
  const autoApprove = context.autoApprove ?? false;

  // 🔥 Build model config for sendPrompt
  const modelConfig = llmConfig ? {
    model: { providerID: llmConfig.providerID, modelID: llmConfig.modelID },
  } : {};

  // 🔥 Build contextual specialist context based on task content
  const specialistsConfig = specialists || DEFAULT_PROJECT_SPECIALISTS;

  // Build task content for contextual analysis
  const taskContent = [
    task.title,
    task.description || '',
  ].join('\n');

  // Use contextual matching for dynamic specialist activation
  const specialistCtx = specialistManager.buildContextualContext(taskContent, specialistsConfig, 'analysis');
  const activeSpecialists = specialistCtx.activeSpecialists;
  const contextualMatches = specialistCtx.contextualMatches;

  // Build the specialist prompt section
  const specialistPrompt = [
    specialistCtx.personaPrompt,
    specialistCtx.stackGuidelines,
    specialistCtx.instructionsPrompt,
  ].filter(Boolean).join('\n\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[AnalysisPhase] Starting for task: ${task.title}`);
  console.log(`[AnalysisPhase] Active specialists: ${activeSpecialists.join(', ') || 'none'}`);
  if (contextualMatches.length > 0) {
    console.log(`[AnalysisPhase] Contextual matches:`);
    for (const m of contextualMatches.slice(0, 5)) {
      console.log(`  - ${m.specialist} (score: ${m.score}, matched: ${m.matchedKeywords.join(', ')})`);
    }
  }
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
      return createErrorResult(`Failed to create/checkout branch: ${error.message}`);
    }
  }

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Analysis',
    branchName,
  });

  // === STEP 2: Create OpenCode session ===
  // Use projectPath (workspace root) so OpenCode can see all repos (frontend + backend)
  console.log(`[AnalysisPhase] Creating OpenCode session in workspace: ${projectPath}`);
  const sessionId = await openCodeClient.createSession({
    title: `Analysis: ${task.title}`,
    directory: projectPath, // Use workspace path, not individual repo
    autoApprove: true,
  });

  console.log(`[AnalysisPhase] Session created: ${sessionId}`);

  // 🔥 Register session with EventBridge so events get forwarded to frontend
  // Use projectPath for event subscription (same as session directory)
  openCodeEventBridge.registerSession(task.id, sessionId, projectPath);

  // Wait for event subscription to establish before sending prompt
  console.log(`[AnalysisPhase] Waiting for event subscription...`);
  await new Promise(resolve => setTimeout(resolve, 500));

  // Save session to database
  await SessionRepository.create({
    sessionId,
    taskId: task.id,
    directory: projectPath,
    phaseName: 'Analysis',
    approvalMode: autoApprove ? 'all' : 'manual',
  });

  // Notify frontend about session
  socketService.toTask(task.id, 'session:created', {
    sessionId,
    phaseName: 'Analysis',
    directory: projectPath,
  });

  // === STEP 2.5: CLARIFYING QUESTIONS (optional, only in manual mode) ===
  let userClarifications: string | undefined;

  if (!autoApprove) {
    console.log(`[AnalysisPhase] Sending CLARIFIER prompt to identify ambiguities...`);

    // Ask AI to identify clarifying questions
    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.clarifier(task, specialistPrompt),
      { directory: projectPath, ...modelConfig }
    );

    const clarifierEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      timeout: 60000,
    });

    const clarifierOutput = extractFinalOutput(clarifierEvents);
    const parsedQuestions = parseClarifierOutput(clarifierOutput);

    if (parsedQuestions && parsedQuestions.questions.length > 0) {
      console.log(`[AnalysisPhase] Found ${parsedQuestions.questions.length} clarifying questions`);

      // Request user input for clarifications
      socketService.toTask(task.id, 'clarification:required', {
        questions: parsedQuestions.questions,
        assumptions: parsedQuestions.assumptionsIfSkipped,
      });

      try {
        // Request approval with questions embedded - user can answer or skip
        const clarificationResponse = await approvalService.requestApproval(
          task.id,
          'clarification',
          {
            type: 'clarification',
            questions: parsedQuestions.questions,
            assumptions: parsedQuestions.assumptionsIfSkipped,
            message: 'Please answer these questions to help guide the implementation, or skip to use default assumptions.',
          },
          { timeout: 300000 } // 5 minute timeout for user to respond
        );

        if (clarificationResponse.approved && clarificationResponse.feedback) {
          // User provided answers
          userClarifications = clarificationResponse.feedback;
          console.log(`[AnalysisPhase] Received user clarifications: ${userClarifications.substring(0, 100)}...`);

          socketService.toTask(task.id, 'clarification:received', {
            clarifications: userClarifications,
          });
        } else {
          // User skipped or rejected - use assumptions
          console.log(`[AnalysisPhase] User skipped clarifications, using default assumptions`);
          userClarifications = `Using default assumptions:\n${parsedQuestions.assumptionsIfSkipped.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;

          socketService.toTask(task.id, 'clarification:skipped', {
            assumptions: parsedQuestions.assumptionsIfSkipped,
          });
        }
      } catch (error) {
        // Timeout or error - proceed with assumptions
        console.log(`[AnalysisPhase] Clarification timeout/error, using default assumptions`);
        userClarifications = `Using default assumptions:\n${parsedQuestions.assumptionsIfSkipped.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
      }
    } else {
      console.log(`[AnalysisPhase] No clarifying questions needed, task description is clear`);
    }
  }

  // === STEP 3: ANALYST → JUDGE → SPY loop ===
  // Track vulnerabilities found during analysis iterations
  const analysisVulnerabilities: VulnerabilityV2[] = [];
  let analysisData: { summary: string; approach: string; risks: string[] } | null = null;
  let parsedStories: Story[] = [];
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
        PROMPTS.analyst(task, repositories, projectPath, userClarifications, specialistPrompt),
        { directory: projectPath, ...modelConfig }
      );
    }

    // Wait for completion
    const analystEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      timeout: 300000,
    });

    // Extract analysis from output
    const analystOutput = extractFinalOutput(analystEvents);
    const parsedAnalysis = parseAnalysisJSON(analystOutput);

    if (parsedAnalysis) {
      analysisData = parsedAnalysis.analysis;
      parsedStories = parsedAnalysis.stories;
    }

    // Notify frontend
    socketService.toTask(task.id, 'iteration:complete', {
      type: 'analyst',
      iteration: iterations,
      analysis: analysisData,
      stories: parsedStories.map(s => ({ id: s.id, title: s.title })),
    });

    // --- JUDGE ---
    console.log(`[AnalysisPhase] Sending JUDGE prompt...`);
    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.judge(),
      { directory: projectPath, ...modelConfig }
    );

    const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
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
    // Cast to VulnerabilityV2 (compatible types)
    analysisVulnerabilities.push(...(spyVulns as unknown as VulnerabilityV2[]));

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
        { directory: projectPath, ...modelConfig }
      );
    } else {
      console.log(`[AnalysisPhase] No specific issues to fix, accepting as-is`);
      approved = true;
    }
  }

  if (!approved) {
    console.log(`[AnalysisPhase] Failed to get approval after ${maxIterations} iterations`);
  }

  // === STEP 4: Save analysis as branch description ===
  if (analysisData) {
    const description = `# ${task.title}\n\n## Summary\n${analysisData.summary}\n\n## Approach\n${analysisData.approach}\n\n## Risks\n${analysisData.risks?.map((r: string) => `- ${r}`).join('\n') || 'None identified'}`;

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
      `[Analysis] ${task.title}\n\nGenerated ${parsedStories.length} stories.`
    );
  }

  // Update session status and cleanup EventBridge
  await SessionRepository.updateStatus(sessionId, 'completed');

  // 🔥 FIX: Unregister session from EventBridge so Developer phase sessions get events
  // Without this, events without sessionID would still be routed to this old session
  openCodeEventBridge.unregisterSession(sessionId);
  console.log(`[AnalysisPhase] Session ${sessionId} unregistered from EventBridge`);

  // === STEP 6: Save to database ===
  if (approved && analysisData) {
    await TaskRepository.updateAfterAnalysis(task.id, {
      branchName,
      analysis: analysisData,
      stories: parsedStories,
    });
    console.log(`[AnalysisPhase] Saved analysis and stories to database`);
  }

  // Build stories with V2 structure (vulnerabilities empty - will be filled in Developer phase)
  const storiesV2: StoryResultV2[] = parsedStories.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    status: s.status,
    filesToModify: s.filesToModify,
    filesToCreate: s.filesToCreate,
    filesToRead: s.filesToRead,
    acceptanceCriteria: s.acceptanceCriteria,
    iterations: 0,
    verdict: 'needs_revision' as const,
    vulnerabilities: [], // Empty - Developer phase will fill this
  }));

  // Build analysis with embedded vulnerabilities
  const analysisWithVulns: AnalysisDataV2 = {
    summary: analysisData?.summary || '',
    approach: analysisData?.approach || '',
    risks: analysisData?.risks || [],
    vulnerabilities: analysisVulnerabilities,
  };

  // Notify frontend
  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Analysis',
    success: approved,
    sessionId,
    branchName,
    analysis: analysisWithVulns,
    stories: storiesV2.map(s => ({ id: s.id, title: s.title, description: s.description })),
    spyVulnerabilities: analysisVulnerabilities.length,
  });

  console.log(`\n[AnalysisPhase] Completed:`);
  console.log(`  - Stories: ${storiesV2.length}`);
  console.log(`  - SPY vulnerabilities: ${analysisVulnerabilities.length}`);

  return {
    success: approved,
    sessionId,
    analysis: analysisWithVulns,
    stories: storiesV2,
    branchName,
  };
}

// === Helper Functions ===

function createErrorResult(error: string): AnalysisResultV2 {
  return {
    success: false,
    sessionId: '',
    analysis: {
      summary: '',
      approach: '',
      risks: [],
      vulnerabilities: [],
    },
    stories: [],
    branchName: '',
    error,
  };
}

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

/**
 * Parse clarifier output to extract questions and assumptions
 */
function parseClarifierOutput(output: string): {
  questions: Array<{ id: string; question: string; category: string; impact: string }>;
  assumptionsIfSkipped: string[];
} | null {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      return {
        questions: data.questions || [],
        assumptionsIfSkipped: data.assumptionsIfSkipped || [],
      };
    }
  } catch (e) {
    console.warn(`[AnalysisPhase] Failed to parse clarifier output: ${e}`);
  }
  return null;
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
