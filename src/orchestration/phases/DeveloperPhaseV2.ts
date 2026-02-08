/**
 * Developer Phase V2
 *
 * Architecture:
 * - stories[]: each story has its own vulnerabilities from SPY
 *
 * Flow per story:
 * 1. DEV → JUDGE → SPY loop (SPY runs after each JUDGE)
 * 2. If approved → HOST: commit + push
 * 3. Next story
 *
 * Note: Global Scan runs as SEPARATE FINAL PHASE after Merge
 */

import {
  Task,
  Story,
  RepositoryInfo,
  DeveloperResultV2,
  StoryResultV2,
  VulnerabilityV2,
  ProjectSpecialistsConfig,
  DEFAULT_PROJECT_SPECIALISTS,
} from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../../services/opencode/OpenCodeEventBridge.js';
import { gitService } from '../../services/git/index.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { agentSpy } from '../../services/security/AgentSpy.js';
import type { ApprovalResponse } from '../../services/realtime/ApprovalService.js';
import { specialistManager } from '../../services/specialists/index.js';

// Re-export types for backward compatibility
export type { DeveloperResultV2 as DeveloperResult, StoryResultV2 as StoryResult };

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
 * Prompts for the Developer Phase
 */
const PROMPTS = {
  developer: (story: Story, storyIndex: number, totalStories: number, repositories: RepositoryInfo[], specialistContext?: string) => `
${specialistContext || ''}

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
 *
 * ARCHITECTURE: 1 Session per Story
 * Each story gets its own fresh OpenCode session to avoid context overflow.
 * This ensures stories 10+ don't fail due to context limits.
 */
export async function executeDeveloperPhase(
  context: DeveloperPhaseContext
): Promise<DeveloperResultV2> {
  const { task, projectPath, repositories, stories, branchName, llmConfig, specialists } = context;
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
    ...stories.map(s => `${s.title}: ${s.description || ''}`),
  ].join('\n');

  // Use contextual matching for dynamic specialist activation
  const specialistCtx = specialistManager.buildContextualContext(taskContent, specialistsConfig, 'developer');
  const activeSpecialists = specialistCtx.activeSpecialists;
  const contextualMatches = specialistCtx.contextualMatches;

  // Build the specialist prompt section
  const specialistPrompt = [
    specialistCtx.personaPrompt,
    specialistCtx.stackGuidelines,
    specialistCtx.instructionsPrompt,
  ].filter(Boolean).join('\n\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[DeveloperPhase] Starting for task: ${task.title}`);
  console.log(`[DeveloperPhase] Stories to implement: ${stories.length}`);
  console.log(`[DeveloperPhase] Active specialists: ${activeSpecialists.join(', ') || 'none'}`);
  if (contextualMatches.length > 0) {
    console.log(`[DeveloperPhase] Contextual matches:`);
    for (const m of contextualMatches.slice(0, 5)) {
      console.log(`  - ${m.specialist} (score: ${m.score}, matched: ${m.matchedKeywords.join(', ')})`);
    }
  }
  console.log(`[DeveloperPhase] Architecture: 1 Session per Story (context isolation)`);
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
    architecture: 'session-per-story',
  });

  // === Process each story with its OWN session ===
  const storyResultsV2: StoryResultV2[] = [];
  let totalCommits = 0;
  const sessionIds: string[] = []; // Track all sessions created

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const startTime = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[DeveloperPhase] STORY ${i + 1}/${stories.length}: ${story.title}`);
    console.log(`[DeveloperPhase] Creating NEW session for this story...`);
    console.log(`${'─'.repeat(60)}`);

    // Notify frontend
    socketService.toTask(task.id, 'story:start', {
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      totalStories: stories.length,
    });

    // Execute story with its own session
    const result = await executeStoryWithSession(
      story,
      i,
      stories.length,
      repositories,
      workingDirectory,
      projectPath,
      task.id,
      task.title,
      autoApprove,
      modelConfig,
      specialistPrompt
    );

    // Track session ID
    if (result.sessionId) {
      sessionIds.push(result.sessionId);
    }

    // Build V2 story result
    const storyResultV2: StoryResultV2 = {
      id: story.id,
      title: story.title,
      description: story.description,
      status: result.verdict === 'approved' ? 'completed' : 'failed',
      filesToModify: story.filesToModify,
      filesToCreate: story.filesToCreate,
      filesToRead: story.filesToRead,
      acceptanceCriteria: story.acceptanceCriteria,
      iterations: result.iterations,
      verdict: result.verdict,
      score: result.score,
      issues: result.issues,
      vulnerabilities: result.vulnerabilities as unknown as VulnerabilityV2[],
      trace: {
        startTime,
        endTime: Date.now(),
        toolCalls: result.toolCalls || 0,
        turns: result.iterations,
      },
    };

    // Commit + Push if approved by Judge
    if (result.verdict === 'approved') {
      const hasChanges = await gitService.hasChanges(workingDirectory);
      if (hasChanges) {
        // === MANUAL APPROVAL LOOP: Supports approve, reject, and request_changes ===
        let userApproved = autoApprove;
        let approvalAttempts = 0;
        const maxApprovalAttempts = 5; // Max feedback rounds before forcing a decision

        // Auto-approve mode: skip approval loop
        if (!autoApprove) {
          let currentResult = { ...result }; // Track current state for feedback rounds

          approvalLoop: while (approvalAttempts < maxApprovalAttempts) {
            approvalAttempts++;
            console.log(`[DeveloperPhase] 🔔 Requesting user approval for story ${story.id} (attempt ${approvalAttempts})...`);

            try {
              // 🔥 Get files modified for this story using git
              let filesModified: string[] = [];
              let gitDiff = '';
              try {
                // Get list of changed files (staged + unstaged)
                filesModified = await gitService.getChangedFiles(workingDirectory);

                // Get short diff summary
                const diffOutput = await gitService.getDiffSummary(workingDirectory);
                gitDiff = diffOutput.substring(0, 2000); // Limit size
              } catch (gitError) {
                console.warn(`[DeveloperPhase] Could not get git info: ${gitError}`);
              }

              const approvalResponse: ApprovalResponse = await approvalService.requestApproval(
                task.id,
                `story-${story.id}`, // Unique phase name per story
                {
                  // 🔥 Story identity
                  storyId: story.id,
                  storyTitle: story.title,
                  storyDescription: story.description,
                  storyIndex: i,
                  totalStories: stories.length,

                  // 🔥 Implementation results
                  verdict: currentResult.verdict,
                  score: currentResult.score,
                  iterations: currentResult.iterations,

                  // 🔥 What was done
                  filesModified,
                  filesToModify: story.filesToModify || [],
                  filesToCreate: story.filesToCreate || [],
                  gitDiff,

                  // 🔥 Quality info
                  issues: currentResult.issues,
                  vulnerabilities: currentResult.vulnerabilities.length,
                  acceptanceCriteria: story.acceptanceCriteria || [],

                  // 🔥 Session info
                  sessionId: currentResult.sessionId,
                  approvalAttempt: approvalAttempts,
                }
                // 🔥 NO TIMEOUT - wait indefinitely for human approval
              );

              console.log(`[DeveloperPhase] User response: ${approvalResponse.action} for story ${story.id}`);

              switch (approvalResponse.action) {
                case 'approve':
                  userApproved = true;
                  break approvalLoop;

                case 'reject':
                  userApproved = false;
                  break approvalLoop;

                case 'request_changes':
                  // === FEEDBACK LOOP: Send user feedback to OpenCode and continue ===
                  console.log(`[DeveloperPhase] 📝 User requested changes: "${approvalResponse.feedback?.substring(0, 100)}..."`);

                  if (currentResult.sessionId && approvalResponse.feedback) {
                    // Notify frontend about feedback round
                    socketService.toTask(task.id, 'story:feedback_round', {
                      storyId: story.id,
                      feedback: approvalResponse.feedback,
                      attempt: approvalAttempts,
                    });

                    // Send feedback to OpenCode session
                    console.log(`[DeveloperPhase] Sending feedback to OpenCode session ${currentResult.sessionId}...`);
                    await openCodeClient.sendPrompt(
                      currentResult.sessionId,
                      `# User Feedback - Please Make Changes

The user has reviewed your implementation and requested the following changes:

"${approvalResponse.feedback}"

Please implement these changes now. After making the changes, provide a summary of what was modified.`,
                      { directory: projectPath, ...modelConfig }
                    );

                    // Wait for OpenCode to finish
                    const feedbackEvents = await openCodeClient.waitForIdle(currentResult.sessionId, {
                      directory: projectPath,
                      timeout: 300000,
                    });

                    // Notify frontend about feedback completion
                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'feedback',
                      storyId: story.id,
                      iteration: approvalAttempts,
                      sessionId: currentResult.sessionId,
                    });

                    // Re-run JUDGE to evaluate the changes
                    console.log(`[DeveloperPhase] Re-running JUDGE after feedback...`);
                    await openCodeClient.sendPrompt(
                      currentResult.sessionId,
                      PROMPTS.judge(story),
                      { directory: projectPath, ...modelConfig }
                    );

                    const judgeEvents = await openCodeClient.waitForIdle(currentResult.sessionId, {
                      directory: projectPath,
                      timeout: 120000,
                    });

                    const judgeOutput = extractFinalOutput(judgeEvents);
                    const judgeResult = parseJudgeVerdict(judgeOutput);

                    // Update current result with new judge verdict
                    currentResult.verdict = judgeResult.verdict;
                    currentResult.score = judgeResult.score;
                    currentResult.issues = judgeResult.issues;
                    currentResult.iterations = (currentResult.iterations || 0) + 1;

                    console.log(`[DeveloperPhase] Judge re-verdict: ${judgeResult.verdict} (score: ${judgeResult.score})`);

                    // Notify frontend about new judge result
                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'judge',
                      storyId: story.id,
                      iteration: currentResult.iterations,
                      verdict: judgeResult.verdict,
                      score: judgeResult.score,
                      issues: judgeResult.issues.length,
                      sessionId: currentResult.sessionId,
                    });

                    // Re-run SPY scan
                    console.log(`[DeveloperPhase] Re-running SPY after feedback...`);
                    const spyVulns = await agentSpy.scanWorkspace(workingDirectory, {
                      taskId: task.id,
                      sessionId: currentResult.sessionId,
                      phase: 'Developer',
                      storyId: story.id,
                      iteration: currentResult.iterations,
                    }, {
                      filesToScan: [...(story.filesToModify || []), ...(story.filesToCreate || [])],
                    });

                    // Update vulnerabilities count
                    currentResult.vulnerabilities = [
                      ...(currentResult.vulnerabilities || []),
                      ...(spyVulns as any[]),
                    ];

                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'spy',
                      storyId: story.id,
                      iteration: currentResult.iterations,
                      vulnerabilities: spyVulns.length,
                      sessionId: currentResult.sessionId,
                    });

                    // Continue loop to request approval again
                  } else {
                    console.warn(`[DeveloperPhase] Cannot process feedback: no session or feedback text`);
                    userApproved = false;
                    break approvalLoop;
                  }
                  break;
              }
            } catch (error: any) {
              console.warn(`[DeveloperPhase] Approval timeout/error for story ${story.id}: ${error.message}`);
              userApproved = false;
              break approvalLoop;
            }
          }

          // Max attempts reached without decision
          if (approvalAttempts >= maxApprovalAttempts && !userApproved) {
            console.warn(`[DeveloperPhase] Max approval attempts reached for story ${story.id}, treating as rejected`);
          }
        }

        // Only commit if user approved (or autoApprove is on)
        if (userApproved) {
          console.log(`[DeveloperPhase] Committing story ${story.id}...`);
          const commit = await gitService.commitAndPush(
            workingDirectory,
            `Implement: ${story.title}`,
            { storyId: story.id, storyTitle: story.title }
          );
          storyResultV2.commitHash = commit.hash;
          totalCommits++;
          console.log(`[DeveloperPhase] Committed: ${commit.hash.substring(0, 7)}`);
        } else {
          console.log(`[DeveloperPhase] Story ${story.id} not committed (user rejected)`);
          storyResultV2.status = 'failed';
          storyResultV2.verdict = 'rejected';

          // 🔥 ROLLBACK: Discard uncommitted changes so next story starts clean
          console.log(`[DeveloperPhase] Rolling back uncommitted changes for rejected story ${story.id}...`);
          await gitService.discardChanges(workingDirectory);

          // Notify frontend about rollback
          socketService.toTask(task.id, 'story:rollback', {
            storyId: story.id,
            storyTitle: story.title,
            reason: 'User rejected - changes discarded',
          });
        }
      }
    } else {
      // 🔥 Judge rejected the story - also discard changes
      console.log(`[DeveloperPhase] Story ${story.id} failed Judge review (verdict: ${result.verdict})`);
      const hasChanges = await gitService.hasChanges(workingDirectory);
      if (hasChanges) {
        console.log(`[DeveloperPhase] Rolling back uncommitted changes for failed story ${story.id}...`);
        await gitService.discardChanges(workingDirectory);

        socketService.toTask(task.id, 'story:rollback', {
          storyId: story.id,
          storyTitle: story.title,
          reason: `Judge verdict: ${result.verdict} - changes discarded`,
        });
      }
    }

    storyResultsV2.push(storyResultV2);

    // Notify frontend
    socketService.toTask(task.id, 'story:complete', {
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      success: result.verdict === 'approved',
      verdict: result.verdict,
      iterations: result.iterations,
      commitHash: storyResultV2.commitHash,
      vulnerabilities: storyResultV2.vulnerabilities.length,
      totalStories: stories.length,
      completedStories: i + 1,
      sessionId: result.sessionId,
    });

    console.log(`[DeveloperPhase] Story ${i + 1}/${stories.length} complete. Session closed.`);
  }

  // Calculate overall success
  const allApproved = storyResultsV2.every(r => r.verdict === 'approved');
  const approvedCount = storyResultsV2.filter(r => r.verdict === 'approved').length;
  const totalStoryVulns = storyResultsV2.reduce((sum, s) => sum + s.vulnerabilities.length, 0);

  // Notify frontend
  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Developer',
    success: allApproved,
    sessionIds, // All sessions used
    stories: storyResultsV2.map(r => ({
      id: r.id,
      verdict: r.verdict,
      commitHash: r.commitHash,
      vulnerabilities: r.vulnerabilities.length,
    })),
    totalCommits,
    approvedCount,
    totalStories: stories.length,
    spyVulnerabilities: totalStoryVulns,
  });

  console.log(`\n[DeveloperPhase] Completed:`);
  console.log(`  - Stories approved: ${approvedCount}/${stories.length}`);
  console.log(`  - Sessions created: ${sessionIds.length}`);
  console.log(`  - Total commits: ${totalCommits}`);
  console.log(`  - SPY vulnerabilities (across stories): ${totalStoryVulns}`);

  return {
    success: allApproved,
    sessionId: sessionIds[sessionIds.length - 1] || '', // Last session for compatibility
    stories: storyResultsV2,
    totalCommits,
  };
}

/**
 * Internal story execution result
 */
interface StoryExecutionResult {
  verdict: 'approved' | 'rejected' | 'needs_revision';
  iterations: number;
  score?: number;
  issues?: Array<{
    severity: 'critical' | 'major' | 'minor';
    file?: string;
    description: string;
    suggestion?: string;
  }>;
  vulnerabilities: VulnerabilityV2[];
  toolCalls?: number;
  sessionId?: string;
}

/**
 * Execute a single story with its OWN OpenCode session
 *
 * ARCHITECTURE: Each story gets a fresh session to avoid context overflow.
 * Flow: CREATE SESSION → DEV → JUDGE → SPY → FIX (loop) → CLEANUP SESSION
 */
async function executeStoryWithSession(
  story: Story,
  storyIndex: number,
  totalStories: number,
  repositories: RepositoryInfo[],
  workingDirectory: string,
  projectPath: string,
  taskId: string,
  taskTitle: string,
  autoApprove: boolean,
  modelConfig: { model?: { providerID: string; modelID: string } },
  specialistPrompt: string
): Promise<StoryExecutionResult> {
  let sessionId: string | undefined;

  try {
    // === CREATE SESSION FOR THIS STORY ===
    console.log(`[DeveloperPhase] Creating session for Story ${storyIndex + 1}: ${story.title}`);
    sessionId = await openCodeClient.createSession({
      title: `Story ${storyIndex + 1}/${totalStories}: ${story.title}`,
      directory: projectPath,
      autoApprove: true,
    });

    console.log(`[DeveloperPhase] Session created: ${sessionId}`);

    // Register with EventBridge for real-time events
    openCodeEventBridge.registerSession(taskId, sessionId, projectPath);

    // Wait for event subscription to establish
    await new Promise(resolve => setTimeout(resolve, 300));

    // Save session to database
    await SessionRepository.create({
      sessionId,
      taskId,
      directory: projectPath,
      phaseName: `Developer-Story${storyIndex + 1}`,
      approvalMode: autoApprove ? 'all' : 'manual',
    });

    // Notify frontend about session
    socketService.toTask(taskId, 'session:created', {
      sessionId,
      phaseName: 'Developer',
      directory: projectPath,
      storyId: story.id,
      storyIndex,
    });

    // === EXECUTE DEV → JUDGE → SPY → FIX LOOP ===
    let approved = false;
    let verdict: 'approved' | 'rejected' | 'needs_revision' = 'needs_revision';
    let score = 0;
    let issues: any[] = [];
    let iterations = 0;
    const maxIterations = 3;
    const storyVulnerabilities: VulnerabilityV2[] = [];
    let totalToolCalls = 0;

    while (!approved && iterations < maxIterations) {
      iterations++;
      console.log(`[DeveloperPhase] Story ${story.id} - Iteration ${iterations}/${maxIterations}`);

      // --- DEVELOPER ---
      if (iterations === 1) {
        console.log(`[DeveloperPhase] Sending DEV prompt...`);
        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.developer(story, storyIndex, totalStories, repositories, specialistPrompt),
          { directory: projectPath, ...modelConfig }
        );
      }

      // Wait for completion
      const devEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        timeout: 300000,
      });
      totalToolCalls += countToolCalls(devEvents);

      // Notify frontend
      socketService.toTask(taskId, 'iteration:complete', {
        type: 'developer',
        storyId: story.id,
        iteration: iterations,
        sessionId,
      });

      // --- JUDGE ---
      console.log(`[DeveloperPhase] Sending JUDGE prompt...`);
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.judge(story),
        { directory: projectPath, ...modelConfig }
      );

      const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        timeout: 120000,
      });
      totalToolCalls += countToolCalls(judgeEvents);

      const judgeOutput = extractFinalOutput(judgeEvents);
      const judgeResult = parseJudgeVerdict(judgeOutput);

      verdict = judgeResult.verdict;
      score = judgeResult.score;
      issues = judgeResult.issues;
      console.log(`[DeveloperPhase] Judge verdict: ${verdict} (score: ${score})`);

      // Notify frontend
      socketService.toTask(taskId, 'iteration:complete', {
        type: 'judge',
        storyId: story.id,
        iteration: iterations,
        verdict,
        score,
        issues: issues.length,
        sessionId,
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
      storyVulnerabilities.push(...(spyVulns as unknown as VulnerabilityV2[]));

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
        sessionId,
      });
      console.log(`[DeveloperPhase] SPY found ${spyVulns.length} vulnerabilities (not blocking)`);

      if (verdict === 'approved') {
        approved = true;
      } else if (verdict === 'rejected') {
        console.log(`[DeveloperPhase] Story rejected - stopping iterations`);
        break;
      } else if (issues.length > 0) {
        // --- FIX ---
        console.log(`[DeveloperPhase] Sending FIX prompt (${issues.length} issues)...`);
        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.fix(issues),
          { directory: projectPath, ...modelConfig }
        );
      } else {
        console.log(`[DeveloperPhase] No specific issues to fix, accepting as-is`);
        approved = true;
        verdict = 'approved';
      }
    }

    // === CLEANUP SESSION ===
    console.log(`[DeveloperPhase] Cleaning up session ${sessionId} for story ${story.id}`);

    // Update session status in database
    await SessionRepository.updateStatus(sessionId, 'completed');

    // Unregister from EventBridge
    openCodeEventBridge.unregisterSession(sessionId);

    // Notify frontend
    socketService.toTask(taskId, 'session:closed', {
      sessionId,
      storyId: story.id,
      storyIndex,
      verdict,
    });

    return {
      verdict,
      iterations,
      score,
      issues,
      vulnerabilities: storyVulnerabilities,
      toolCalls: totalToolCalls,
      sessionId,
    };

  } catch (error: any) {
    console.error(`[DeveloperPhase] Error executing story ${story.id}: ${error.message}`);

    // Cleanup on error
    if (sessionId) {
      try {
        await SessionRepository.updateStatus(sessionId, 'error');
        openCodeEventBridge.unregisterSession(sessionId);
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      verdict: 'rejected',
      iterations: 0,
      score: 0,
      issues: [{ severity: 'critical', description: error.message }],
      vulnerabilities: [],
      toolCalls: 0,
      sessionId,
    };
  }
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

function countToolCalls(events: any[]): number {
  return events.filter(e => e.type === 'tool.execute.before').length;
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
