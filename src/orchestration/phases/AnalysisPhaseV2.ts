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
import { specialistManager } from '../../services/specialists/index.js';
import type { UXFlow, PlannedTask } from './ProductPlanningPhase.js';

// Re-export types for backward compatibility
export type { AnalysisResultV2 as AnalysisResult };

/**
 * 🔥 Planning data passed from ProductPlanningPhase
 * Contains structured output that Analysis should USE instead of regenerating
 */
export interface PlanningData {
  uxFlows?: UXFlow[];
  plannedTasks?: PlannedTask[];
  clarifications?: {
    questions: Array<{ question: string; answer?: string }>;
    answers: Record<string, string>;
  };
}

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
  /** 🔥 Planning data from ProductPlanningPhase - USE THIS instead of regenerating */
  planningData?: PlanningData;
}

/**
 * Prompts for the Analysis Phase
 */
const PROMPTS = {
  /**
   * 🔥 Clarifying Questions - asks before analysis to identify ambiguities
   * Returns questions the user should answer to avoid assumptions
   */
  clarifier: (task: Task, specialistContext?: string, planningData?: PlanningData) => `
${specialistContext || ''}

# Identify TECHNICAL Clarifying Questions

Before starting the analysis, identify any TECHNICAL ambiguities that could affect implementation.

## Task Description
"${task.description || task.title}"

${planningData?.clarifications && Object.keys(planningData.clarifications.answers || {}).length > 0 ? `
## ⚠️ ALREADY ANSWERED by Planning Phase (DO NOT ask again)
${Object.entries(planningData.clarifications.answers).map(([q, a]) => `- **Q**: ${q}\n  **A**: ${a}`).join('\n')}
` : ''}

${planningData?.plannedTasks && planningData.plannedTasks.length > 0 ? `
## Tasks Already Planned (context for your questions)
${planningData.plannedTasks.map(t => `- ${t.title}: ${t.description.substring(0, 100)}...`).join('\n')}
` : ''}

## Your Mission
Identify 2-5 specific TECHNICAL questions. Focus ONLY on:

1. **Technical choices**: Which ORM, which test framework, which state management
2. **Code architecture**: File structure, naming conventions, design patterns
3. **Integration details**: API versioning, auth mechanism, data formats
4. **Testing strategy**: Unit vs integration, mocking approach, coverage targets

## Guidelines
- DO NOT repeat questions already answered by Planning Phase
- Only ask IMPLEMENTATION-LEVEL questions (not product/UX questions)
- Avoid questions that can be answered by exploring the codebase
- Maximum 5 questions
- If Planning already covered everything, return an empty questions array

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

  /**
   * 🤖 SELF-ANSWER - When in autopilot mode, answer TECHNICAL questions yourself
   * The agent identifies technical ambiguities AND decides the best answer itself
   */
  selfAnswer: (task: Task, questions: any[], planningData?: PlanningData, specialistContext?: string) => `
${specialistContext || ''}

# 🤖 AUTOPILOT MODE: Self-Answer TECHNICAL Questions

You are running in **AUTOPILOT MODE**. You identified ${questions.length} technical clarifying questions.
Now you must DECIDE the best answer for each using your expert technical judgment.

## Task
"${task.description || task.title}"

${planningData?.clarifications && Object.keys(planningData.clarifications.answers || {}).length > 0 ? `
## Context: Already Answered by Planning Phase
${Object.entries(planningData.clarifications.answers).map(([q, a]) => `- **Q**: ${q}\n  **A**: ${a}`).join('\n')}
` : ''}

${planningData?.plannedTasks && planningData.plannedTasks.length > 0 ? `
## Context: Planned Tasks
${planningData.plannedTasks.map(t => `- ${t.title}: ${t.description.substring(0, 80)}...`).join('\n')}
` : ''}

## TECHNICAL Questions You Identified (ANSWER ALL)
${questions.map((q, i) => `
### Question ${i + 1}: ${q.question}
- **Category**: ${q.category}
- **Impact**: ${q.impact}
`).join('\n')}

## Your Mission
1. For each TECHNICAL question, decide the BEST answer based on:
   - Codebase patterns you discovered
   - Industry best practices for this tech stack
   - Simplicity and maintainability
   - Security considerations

2. Briefly justify each decision (1-2 sentences)

## Guidelines
- Be decisive - pick the most practical option
- Prefer following existing codebase patterns
- Choose approaches that minimize technical debt
- Consider security and performance implications

## Required Output Format
\`\`\`json
{
  "selfAnswers": [
    {
      "questionId": "q1",
      "question": "<the original question>",
      "answer": "<your decided technical answer>",
      "reasoning": "<brief technical justification>"
    }
  ],
  "technicalDecisionSummary": "<1-2 sentence summary of key technical decisions>"
}
\`\`\`
`,

  analyst: (task: Task, repositories: RepositoryInfo[], projectPath: string, clarifications?: string, specialistContext?: string, planningData?: PlanningData) => {
    // 🔥 If we have planning data with tasks, use a DIFFERENT prompt that uses them as base
    if (planningData?.plannedTasks && planningData.plannedTasks.length > 0) {
      return `
${specialistContext || ''}

# Task Analysis & Story Refinement

## IMPORTANT: Use the Pre-Planned Tasks Below
The Product Planning phase has already analyzed this task and created a detailed breakdown.
Your job is to REFINE these into implementation-ready stories, NOT to start from scratch.

## Task Details
- **Task**: ${task.description || task.title}

${planningData.clarifications && Object.keys(planningData.clarifications.answers || {}).length > 0 ? `
## Clarifications from Planning Phase (ALREADY ANSWERED)
${Object.entries(planningData.clarifications.answers).map(([q, a]) => `- **Q**: ${q}\n  **A**: ${a}`).join('\n')}
` : ''}

${clarifications ? `
## Additional Clarifications
${clarifications}
` : ''}

## Pre-Planned Tasks from Product Planning
${planningData.plannedTasks.map((t, i) => `
### Task ${i + 1}: ${t.title} [${t.estimatedComplexity}]
- **Description**: ${t.description}
- **Acceptance Criteria**:
${t.acceptanceCriteria.map(c => `  - ${c}`).join('\n')}
- **Affected Areas**: ${t.affectedAreas?.join(', ') || 'TBD'}
- **Dependencies**: ${t.dependencies?.join(', ') || 'None'}
`).join('\n')}

${planningData.uxFlows && planningData.uxFlows.length > 0 ? `
## UX Flows Designed
${planningData.uxFlows.map((f, i) => `
### Flow ${i + 1}: ${f.name}
- **Description**: ${f.description}
- **Steps**:
${f.steps?.map(s => `  ${s.step}. ${s.action}${s.screen ? ` (Screen: ${s.screen})` : ''}${s.component ? ` [Component: ${s.component}]` : ''}${s.notes ? ` - ${s.notes}` : ''}`).join('\n') || '  (No steps defined)'}
- **Edge Cases**: ${f.edgeCases?.join(', ') || 'None identified'}
- **Error Handling**: ${f.errorHandling?.join(', ') || 'Standard'}
`).join('\n')}
` : ''}

## Repositories Available
${repositories.map((repo, i) => `
### Repository ${i + 1}: ${repo.name} (${repo.type.toUpperCase()})
- **Type**: ${repo.type}
- **Path**: ${repo.localPath}
`).join('\n')}

## Your Mission
1. **VALIDATE** the pre-planned tasks by briefly checking the codebase
2. **CONVERT** each planned task into an implementable Story
3. **IDENTIFY** specific files to modify/create based on the affected areas

## Instructions
1. Use Glob/Read/Grep ONLY to verify file paths and find exact locations
2. DO NOT re-analyze everything - the planning is already done
3. Focus on mapping tasks to specific files and code locations

## Required Output Format
Output a JSON block:

\`\`\`json
{
  "analysis": {
    "summary": "<brief summary based on planned tasks>",
    "approach": "<implementation approach>",
    "risks": ["<risk 1>", "<risk 2>"]
  },
  "stories": [
    {
      "id": "story-1",
      "title": "<from planned task>",
      "description": "<from planned task>",
      "repository": "<repository name>",
      "filesToModify": ["<specific paths found>"],
      "filesToCreate": ["<new files needed>"],
      "filesToRead": ["<context files>"],
      "acceptanceCriteria": ["<from planned task>"]
    }
  ]
}
\`\`\`
`;
    }

    // 🔥 Original prompt when no planning data is available
    return `
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
`;
  },

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

  /**
   * SPY - Security analysis of the analysis/stories
   * Runs in the same session after JUDGE
   */
  spy: (analysisData: any, stories: any[]) => `
# Security Analysis (SPY Agent)

You are a security expert. Analyze the proposed analysis and stories for potential security issues.

## Task Analysis
${analysisData?.summary || 'No summary provided'}

## Proposed Stories
${stories.map((s, i) => `
### Story ${i + 1}: ${s.title}
- Files to modify: ${s.filesToModify?.join(', ') || 'None'}
- Files to create: ${s.filesToCreate?.join(', ') || 'None'}
- Description: ${s.description || 'None'}
`).join('\n')}

## Your Mission
1. Review the proposed changes for security implications
2. Identify potential vulnerabilities in the planned implementation
3. Look for missing security considerations

## Security Categories to Check
1. **Authentication/Authorization** - Are auth checks planned where needed?
2. **Input Validation** - Will user inputs be validated?
3. **Data Exposure** - Could sensitive data be exposed?
4. **Injection Risks** - SQL, XSS, Command injection potential?
5. **Cryptographic Issues** - Proper encryption/hashing planned?
6. **Access Control** - Proper RBAC/permissions?
7. **Logging/Monitoring** - Security events logged?
8. **Dependencies** - Any risky new packages?

## Required Output Format
\`\`\`json
{
  "vulnerabilities": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "type": "<vulnerability type>",
      "file": "<planned file or 'architecture'>",
      "description": "<security concern>",
      "recommendation": "<how to address this>"
    }
  ],
  "summary": "<security posture summary>",
  "riskLevel": "safe" | "low" | "medium" | "high" | "critical"
}
\`\`\`
`,
};

// ============================================================================
// SPY RESPONSE PARSING
// ============================================================================

interface SpyVulnerability {
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: string;
  file: string;
  description: string;
  recommendation?: string;
}

interface SpyResult {
  vulnerabilities: SpyVulnerability[];
  summary: string;
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
}

function extractSpyResult(output: string): SpyResult {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        vulnerabilities: parsed.vulnerabilities || [],
        summary: parsed.summary || '',
        riskLevel: parsed.riskLevel || 'safe',
      };
    } catch {
      console.warn('[AnalysisPhase] Failed to parse SPY JSON response');
    }
  }
  return { vulnerabilities: [], summary: 'Failed to parse', riskLevel: 'safe' };
}

function convertSpyVulnerabilities(
  spyResult: SpyResult,
  context: { taskId: string; sessionId: string; iteration: number }
): VulnerabilityV2[] {
  return spyResult.vulnerabilities.map((v, index) => ({
    id: `spy-analysis-${context.iteration}-${index}`,
    taskId: context.taskId,
    sessionId: context.sessionId,
    phase: 'Analysis',
    timestamp: new Date(),
    severity: v.severity,
    type: v.type as any,
    description: v.description,
    evidence: '',
    blocked: false,
    category: 'security',
    filePath: v.file,
    recommendation: v.recommendation,
  }));
}

/**
 * Execute the Analysis Phase
 */
export async function executeAnalysisPhase(
  context: AnalysisPhaseContext
): Promise<AnalysisResultV2> {
  const { task, projectPath, repositories, llmConfig, specialists, planningData } = context;
  const autoApprove = context.autoApprove ?? false;

  // 🔥 Log if we have planning data from ProductPlanningPhase
  if (planningData?.plannedTasks && planningData.plannedTasks.length > 0) {
    console.log(`[AnalysisPhase] 📋 Using planning data from ProductPlanningPhase:`);
    console.log(`[AnalysisPhase]   - Planned tasks: ${planningData.plannedTasks.length}`);
    console.log(`[AnalysisPhase]   - UX flows: ${planningData.uxFlows?.length || 0}`);
    console.log(`[AnalysisPhase]   Will REFINE these instead of starting from scratch`);
  }

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

  // === STEP 2.5: CLARIFYING QUESTIONS ===
  let userClarifications: string | undefined;

  // 🔥 Check if Planning already collected clarifications (Analysis will know about them)
  const hasPlanningClarifications = planningData?.clarifications &&
    Object.keys(planningData.clarifications.answers || {}).length > 0;

  if (hasPlanningClarifications) {
    console.log(`[AnalysisPhase] 📋 Planning already collected ${Object.keys(planningData!.clarifications!.answers).length} clarifications (will be visible in prompt)`);
  }

  // 🔥 Analysis can STILL ask its own TECHNICAL questions (different from Planning's product questions)
  // In autopilot mode, it will SELF-ANSWER instead of skipping
  console.log(`[AnalysisPhase] Sending CLARIFIER prompt to identify technical ambiguities...`);
  await TaskRepository.setCurrentStep(task.id, 1, 'CLARIFIER');
  socketService.toTask(task.id, 'agent:start', {
    agent: 'CLARIFIER',
    phase: 'Analysis',
    step: 1,
    sessionId,
  });

  // Ask AI to identify clarifying questions (with context from Planning if available)
  await openCodeClient.sendPrompt(
    sessionId,
    PROMPTS.clarifier(task, specialistPrompt, planningData),
    { directory: projectPath, ...modelConfig }
  );

  const clarifierEvents = await openCodeClient.waitForIdle(sessionId, {
    directory: projectPath,
    // 🔥 No timeout - let OpenCode handle its own limits
  });

  const clarifierOutput = extractFinalOutput(clarifierEvents);
  const parsedQuestions = parseClarifierOutput(clarifierOutput);

  if (parsedQuestions && parsedQuestions.questions.length > 0) {
    console.log(`[AnalysisPhase] Found ${parsedQuestions.questions.length} clarifying questions`);

    if (autoApprove) {
      // 🤖 AUTOPILOT MODE: Self-answer the TECHNICAL questions instead of skipping
      console.log(`[AnalysisPhase] 🤖 AUTOPILOT: Self-answering ${parsedQuestions.questions.length} technical questions...`);
      await TaskRepository.setCurrentStep(task.id, 2, 'SELF_ANSWERER');
      socketService.toTask(task.id, 'agent:start', {
        agent: 'SELF_ANSWERER',
        phase: 'Analysis',
        step: 2,
        mode: 'autopilot',
        questionsCount: parsedQuestions.questions.length,
        sessionId,
      });

      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.selfAnswer(task, parsedQuestions.questions, planningData, specialistPrompt),
        { directory: projectPath, ...modelConfig }
      );

      const selfAnswerEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        // 🔥 No timeout - let OpenCode handle its own limits
      });

      const selfAnswerOutput = extractFinalOutput(selfAnswerEvents);
      const selfAnswerResult = parseSelfAnswerOutput(selfAnswerOutput);

      if (selfAnswerResult?.selfAnswers && selfAnswerResult.selfAnswers.length > 0) {
        // Format self-answers as clarifications text
        userClarifications = selfAnswerResult.selfAnswers
          .map((sa: any) => `Q: ${sa.question}\nA: [AUTOPILOT] ${sa.answer}\nReasoning: ${sa.reasoning}`)
          .join('\n\n');

        console.log(`[AnalysisPhase] 🤖 AUTOPILOT: Self-answered ${selfAnswerResult.selfAnswers.length} technical questions`);
        console.log(`[AnalysisPhase] Decision summary: ${selfAnswerResult.technicalDecisionSummary || 'N/A'}`);

        // Notify frontend about self-answered clarifications
        socketService.toTask(task.id, 'clarification:self-answered', {
          phase: 'Analysis',
          mode: 'autopilot',
          questionsCount: parsedQuestions.questions.length,
          selfAnswers: selfAnswerResult.selfAnswers,
          decisionSummary: selfAnswerResult.technicalDecisionSummary,
        });
      } else {
        // Fallback to assumptions if self-answer parsing failed
        console.warn(`[AnalysisPhase] 🤖 AUTOPILOT: Failed to parse self-answers, using default assumptions`);
        userClarifications = `Using default assumptions:\n${parsedQuestions.assumptionsIfSkipped.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
      }
    } else {
      // Manual mode: Request user approval with questions
      try {
        // 🔥 NO TIMEOUT - human is never bypassed, wait forever for user response
        const clarificationResponse = await approvalService.requestApproval(
          task.id,
          'clarification',
          {
            type: 'clarification',
            phase: 'Analysis',
            phaseName: 'Analysis Phase',
            questions: parsedQuestions.questions,
            assumptions: parsedQuestions.assumptionsIfSkipped,
            defaultAssumptions: parsedQuestions.assumptionsIfSkipped, // Alias for compatibility
            message: 'Please answer these TECHNICAL questions to guide the implementation:',
          }
          // No timeout - wait indefinitely for human response
        );

        if (clarificationResponse.action === 'approve' && clarificationResponse.feedback) {
          // User provided answers
          userClarifications = clarificationResponse.feedback;
          console.log(`[AnalysisPhase] Received user clarifications: ${userClarifications.substring(0, 100)}...`);

          socketService.toTask(task.id, 'clarification:received', {
            phase: 'Analysis',
            clarifications: userClarifications,
          });
        } else {
          // User skipped or rejected - use assumptions
          console.log(`[AnalysisPhase] User skipped clarifications, using default assumptions`);
          userClarifications = `Using default assumptions:\n${parsedQuestions.assumptionsIfSkipped.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;

          socketService.toTask(task.id, 'clarification:skipped', {
            phase: 'Analysis',
            assumptions: parsedQuestions.assumptionsIfSkipped,
          });
        }
      } catch (error) {
        // Timeout or error - proceed with assumptions
        console.log(`[AnalysisPhase] Clarification timeout/error, using default assumptions`);
        userClarifications = `Using default assumptions:\n${parsedQuestions.assumptionsIfSkipped.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
      }
    }
  } else {
    console.log(`[AnalysisPhase] No clarifying questions needed, task description is clear`);
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
      await TaskRepository.setCurrentStep(task.id, 3, 'ANALYST');
      socketService.toTask(task.id, 'agent:start', {
        agent: 'ANALYST',
        phase: 'Analysis',
        step: 3,
        iteration: iterations,
        sessionId,
      });
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.analyst(task, repositories, projectPath, userClarifications, specialistPrompt, planningData),
        { directory: projectPath, ...modelConfig }
      );
    }

    // Wait for completion
    // 🔥 NO TIMEOUT - Let OpenCode manage its own internal limits
    const analystEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
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
    await TaskRepository.setCurrentStep(task.id, 4, 'JUDGE');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'JUDGE',
      phase: 'Analysis',
      step: 4,
      iteration: iterations,
      sessionId,
    });
    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.judge(),
      { directory: projectPath, ...modelConfig }
    );

    const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
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

    // --- SPY (LLM-based security analysis, same session) ---
    console.log(`[AnalysisPhase] Running SPY analysis...`);
    await TaskRepository.setCurrentStep(task.id, 5, 'SPY');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'SPY',
      phase: 'Analysis',
      step: 5,
      iteration: iterations,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.spy(analysisData, parsedStories),
      { directory: projectPath, ...modelConfig }
    );

    const spyEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits // 2 min for security analysis
    });

    const spyOutput = extractFinalOutput(spyEvents);
    const spyResult = extractSpyResult(spyOutput);
    const spyVulns = convertSpyVulnerabilities(spyResult, {
      taskId: task.id,
      sessionId,
      iteration: iterations,
    });
    analysisVulnerabilities.push(...spyVulns);

    // Notify frontend about SPY results
    socketService.toTask(task.id, 'iteration:complete', {
      type: 'spy',
      iteration: iterations,
      vulnerabilities: spyVulns.length,
      riskLevel: spyResult.riskLevel,
      summary: spyResult.summary,
      bySeverity: {
        critical: spyVulns.filter(v => v.severity === 'critical').length,
        high: spyVulns.filter(v => v.severity === 'high').length,
        medium: spyVulns.filter(v => v.severity === 'medium').length,
        low: spyVulns.filter(v => v.severity === 'low').length,
      },
    });
    console.log(`[AnalysisPhase] SPY found ${spyVulns.length} vulnerabilities (risk: ${spyResult.riskLevel})`);

    if (verdict.verdict === 'approved') {
      approved = true;
    } else if (verdict.issues && verdict.issues.length > 0) {
      // --- FIX ---
      console.log(`[AnalysisPhase] Sending FIX prompt (${verdict.issues.length} issues)...`);
      await TaskRepository.setCurrentStep(task.id, 5, 'FIXER');
      socketService.toTask(task.id, 'agent:start', {
        agent: 'FIXER',
        phase: 'Analysis',
        step: 5,
        iteration: iterations,
        issuesCount: verdict.issues.length,
        sessionId,
      });
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.fix(verdict.issues),
        { directory: projectPath, ...modelConfig }
      );
    } else {
      // 🔥 BUG FIX: If verdict is needs_revision but no issues, check if we have valid stories
      // Don't accept empty results - either retry with clarification or fail
      const hasValidStories = parsedStories && parsedStories.length > 0;
      if (hasValidStories && verdict.score >= 50) {
        console.log(`[AnalysisPhase] No specific issues, accepting with ${parsedStories.length} stories (score: ${verdict.score})`);
        approved = true;
      } else {
        console.log(`[AnalysisPhase] Verdict: needs_revision with no issues and score ${verdict.score}. Stories: ${parsedStories?.length || 0}`);
        // Add a synthetic issue to trigger a retry
        if (iterations < maxIterations) {
          console.log(`[AnalysisPhase] Retrying - asking for better task decomposition...`);
          socketService.toTask(task.id, 'agent:start', {
            agent: 'FIXER',
            phase: 'Analysis',
            iteration: iterations,
            issuesCount: 1,
            sessionId,
          });
          await openCodeClient.sendPrompt(
            sessionId,
            PROMPTS.fix([{
              severity: 'critical',
              description: 'The analysis did not produce valid stories',
              suggestion: 'Please analyze the task again and break it down into specific, implementable stories with clear acceptance criteria',
            }]),
            { directory: projectPath, ...modelConfig }
          );
        } else {
          console.log(`[AnalysisPhase] Max iterations reached, cannot produce valid stories`);
        }
      }
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
  let textParts = 0;

  for (const event of events) {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      if (part?.type === 'text') {
        output = part.text || output;
        textParts++;
      }
    }
  }

  // 🔥 DEBUG: Log extraction details
  if (textParts === 0) {
    console.warn(`[AnalysisPhase] extractFinalOutput: No text parts found in ${events.length} events`);
    // Log event types for debugging
    const eventTypes = [...new Set(events.map(e => e.type))];
    console.warn(`[AnalysisPhase] Event types: ${eventTypes.join(', ')}`);
  } else {
    console.log(`[AnalysisPhase] extractFinalOutput: Found ${textParts} text parts, output length: ${output.length} chars`);
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

/**
 * Parse self-answer output from autopilot mode
 */
function parseSelfAnswerOutput(output: string): {
  selfAnswers: Array<{ questionId: string; question: string; answer: string; reasoning: string }>;
  technicalDecisionSummary: string;
} | null {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      return {
        selfAnswers: data.selfAnswers || [],
        technicalDecisionSummary: data.technicalDecisionSummary || data.decisionSummary || '',
      };
    }

    // Try raw JSON extraction
    const rawMatch = output.match(/\{[\s\S]*?"selfAnswers"[\s\S]*\}/);
    if (rawMatch) {
      const data = JSON.parse(rawMatch[0]);
      return {
        selfAnswers: data.selfAnswers || [],
        technicalDecisionSummary: data.technicalDecisionSummary || data.decisionSummary || '',
      };
    }
  } catch (e) {
    console.warn(`[AnalysisPhase] Failed to parse self-answer output: ${e}`);
  }
  return null;
}

function parseAnalysisJSON(output: string): { analysis: any; stories: Story[] } | null {
  // 🔥 DEBUG: Log output preview
  const outputPreview = output.substring(0, 500);
  console.log(`[AnalysisPhase] parseAnalysisJSON: Output preview (${output.length} chars):\n${outputPreview}...`);

  if (!output || output.length === 0) {
    console.error(`[AnalysisPhase] parseAnalysisJSON: Empty output received!`);
    return null;
  }

  try {
    // Try to find JSON in code block first
    let jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);

    // If no code block, try to find raw JSON object
    if (!jsonMatch) {
      console.log('[AnalysisPhase] No json code block found, trying raw JSON extraction...');
      // Look for { "analysis": or { "stories": pattern
      const rawJsonMatch = output.match(/\{[\s\S]*?"(?:analysis|stories)"[\s\S]*\}/);
      if (rawJsonMatch) {
        jsonMatch = [rawJsonMatch[0], rawJsonMatch[0]];
        console.log(`[AnalysisPhase] Found raw JSON object (${rawJsonMatch[0].length} chars)`);
      }
    }

    if (jsonMatch) {
      const jsonStr = jsonMatch[1];
      console.log(`[AnalysisPhase] Parsing JSON (${jsonStr.length} chars)...`);

      const data = JSON.parse(jsonStr);

      if (!data.stories || !Array.isArray(data.stories)) {
        console.error(`[AnalysisPhase] Parsed JSON but no stories array! Keys: ${Object.keys(data).join(', ')}`);
        return null;
      }

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

      console.log(`[AnalysisPhase] Successfully parsed ${stories.length} stories`);
      return { analysis: data.analysis, stories };
    } else {
      console.error(`[AnalysisPhase] No JSON found in output. Looking for patterns...`);
      // Log what we did find
      const hasCodeBlock = output.includes('```');
      const hasAnalysis = output.includes('"analysis"');
      const hasStories = output.includes('"stories"');
      console.error(`[AnalysisPhase] Has code block: ${hasCodeBlock}, has "analysis": ${hasAnalysis}, has "stories": ${hasStories}`);
    }
  } catch (e: any) {
    console.error(`[AnalysisPhase] JSON parse error: ${e.message}`);
    // Try to find the position of the error
    if (e.message.includes('position')) {
      const posMatch = e.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1]);
        const context = output.substring(Math.max(0, pos - 50), pos + 50);
        console.error(`[AnalysisPhase] Error context: ...${context}...`);
      }
    }
  }
  return null;
}

function parseJudgeVerdict(output: string): {
  verdict: 'approved' | 'needs_revision';
  score: number;
  issues: any[];
  summary: string;
} {
  // 🔥 DEBUG: Log judge output preview
  const outputPreview = output.substring(0, 300);
  console.log(`[AnalysisPhase] parseJudgeVerdict: Output preview (${output.length} chars):\n${outputPreview}...`);

  if (!output || output.length === 0) {
    console.error('[AnalysisPhase] parseJudgeVerdict: Empty output received!');
    return { verdict: 'needs_revision', score: 0, issues: [], summary: 'No judge output received' };
  }

  try {
    // Try code block first
    let jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);

    // Try raw JSON if no code block
    if (!jsonMatch) {
      console.log('[AnalysisPhase] No json code block in judge output, trying raw JSON...');
      const rawJsonMatch = output.match(/\{[\s\S]*?"verdict"[\s\S]*\}/);
      if (rawJsonMatch) {
        jsonMatch = [rawJsonMatch[0], rawJsonMatch[0]];
      }
    }

    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const result = {
        verdict: data.verdict || 'needs_revision',
        score: data.score || 0,
        issues: data.issues || [],
        summary: data.summary || '',
      };
      console.log(`[AnalysisPhase] Judge verdict parsed: ${result.verdict}, score: ${result.score}, issues: ${result.issues.length}`);
      return result;
    } else {
      console.error('[AnalysisPhase] No JSON found in judge output');
      const hasVerdict = output.includes('"verdict"');
      const hasScore = output.includes('"score"');
      console.error(`[AnalysisPhase] Has "verdict": ${hasVerdict}, has "score": ${hasScore}`);
    }
  } catch (e: any) {
    console.error(`[AnalysisPhase] Failed to parse judge verdict: ${e.message}`);
  }

  console.warn('[AnalysisPhase] Returning default verdict: needs_revision, score: 0');
  return { verdict: 'needs_revision', score: 0, issues: [], summary: 'Failed to parse judge output' };
}
