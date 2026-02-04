/**
 * Orchestrator V2
 *
 * Clean 3-phase architecture:
 * 1. Analysis Phase - Create branch, analyze task, break into stories
 * 2. Developer Phase - Implement all stories with DEV → JUDGE → FIX loop
 * 3. Merge Phase - Create PR, wait for approval, merge
 *
 * Key principles:
 * - One OpenCode session per phase (not per story)
 * - All Git operations happen at HOST level
 * - Security analysis (AgentSpy) runs at end of each iteration
 * - All data pushed to Sentinental for ML training
 */

import { Task, Story, RepositoryInfo } from '../types/index.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { sentinentalWebhook } from '../services/training/index.js';
import { socketService } from '../services/realtime/index.js';
import { cleanupTaskTracking } from './PhaseTracker.js';

// Import V2 phases
import {
  executeAnalysisPhase,
  AnalysisPhaseContext,
  AnalysisResult,
} from './phases/AnalysisPhaseV2.js';
import {
  executeDeveloperPhase,
  DeveloperPhaseContext,
  DeveloperResult,
} from './phases/DeveloperPhaseV2.js';
import {
  executeMergePhase,
  MergePhaseContext,
  MergeResult,
} from './phases/MergePhaseV2.js';

export type ApprovalMode = 'manual' | 'automatic';

/**
 * Orchestration options
 */
export interface OrchestrationOptions {
  /** Base project path */
  projectPath?: string;
  /** All repositories for this project */
  repositories?: RepositoryInfo[];
  /** Approval mode for phases */
  approvalMode?: ApprovalMode;
  /** Auto-merge PR without approval */
  autoMerge?: boolean;
  /** Called when Analysis phase completes */
  onAnalysisComplete?: (result: AnalysisResult) => void;
  /** Called when a story is completed */
  onStoryComplete?: (storyIndex: number, story: Story, success: boolean) => void;
  /** Called when Developer phase completes */
  onDeveloperComplete?: (result: DeveloperResult) => void;
  /** Called when PR is created */
  onPullRequestCreated?: (prNumber: number, prUrl: string) => void;
  /** Called to request merge approval */
  onMergeApprovalRequired?: (prNumber: number, prUrl: string) => Promise<boolean>;
}

/**
 * Orchestration result
 */
export interface OrchestrationResult {
  success: boolean;
  taskId: string;
  analysis?: AnalysisResult;
  developer?: DeveloperResult;
  merge?: MergeResult;
  error?: string;
  duration: number;
}

class OrchestratorV2Class {
  /**
   * Execute a task through the 3-phase pipeline
   */
  async execute(
    taskId: string,
    options: OrchestrationOptions = {}
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const projectPath = options.projectPath || process.cwd();
    const repositories = options.repositories || [];
    const autoApprove = options.approvalMode === 'automatic';

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[OrchestratorV2] Starting task: ${taskId}`);
    console.log(`${'═'.repeat(70)}`);

    // Get task
    const task = await TaskRepository.findById(taskId);
    if (!task) {
      return {
        success: false,
        taskId,
        error: 'Task not found',
        duration: 0,
      };
    }

    // Update task status
    await TaskRepository.updateStatus(taskId, 'running');

    // Notify frontend
    socketService.toTask(taskId, 'orchestration:start', {
      taskId,
      title: task.title,
      phases: ['Analysis', 'Developer', 'Merge'],
    });

    let analysisResult: AnalysisResult | undefined;
    let developerResult: DeveloperResult | undefined;
    let mergeResult: MergeResult | undefined;

    try {
      // ════════════════════════════════════════════════════════════════
      // PHASE 1: ANALYSIS
      // ════════════════════════════════════════════════════════════════
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`[OrchestratorV2] PHASE 1: ANALYSIS`);
      console.log(`${'─'.repeat(70)}`);

      const analysisContext: AnalysisPhaseContext = {
        task,
        projectPath,
        repositories,
        autoApprove,
      };

      analysisResult = await executeAnalysisPhase(analysisContext);
      options.onAnalysisComplete?.(analysisResult);

      if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Analysis phase failed');
      }

      if (analysisResult.stories.length === 0) {
        throw new Error('Analysis produced no stories');
      }

      console.log(`[OrchestratorV2] Analysis complete: ${analysisResult.stories.length} stories created`);
      console.log(`[OrchestratorV2] Branch: ${analysisResult.branchName}`);

      // ════════════════════════════════════════════════════════════════
      // PHASE 2: DEVELOPER
      // ════════════════════════════════════════════════════════════════
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`[OrchestratorV2] PHASE 2: DEVELOPER`);
      console.log(`${'─'.repeat(70)}`);

      const developerContext: DeveloperPhaseContext = {
        task,
        projectPath,
        repositories,
        stories: analysisResult.stories,
        branchName: analysisResult.branchName,
        autoApprove,
      };

      developerResult = await executeDeveloperPhase(developerContext);
      options.onDeveloperComplete?.(developerResult);

      // Track story completions
      for (let i = 0; i < developerResult.stories.length; i++) {
        const sr = developerResult.stories[i];
        const story = analysisResult.stories.find(s => s.id === sr.id);
        if (story) {
          options.onStoryComplete?.(i, story, sr.verdict === 'approved');
        }
      }

      if (!developerResult.success) {
        console.warn(`[OrchestratorV2] Developer phase completed with issues`);
        // Continue to merge even if some stories failed
      }

      const approvedCount = developerResult.stories.filter(r => r.verdict === 'approved').length;
      console.log(`[OrchestratorV2] Developer complete: ${approvedCount}/${analysisResult.stories.length} stories approved`);
      console.log(`[OrchestratorV2] Total commits: ${developerResult.totalCommits}`);

      // ════════════════════════════════════════════════════════════════
      // PHASE 3: MERGE
      // ════════════════════════════════════════════════════════════════
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`[OrchestratorV2] PHASE 3: MERGE`);
      console.log(`${'─'.repeat(70)}`);

      // Determine working directory for merge
      const workingDirectory = determineWorkingDirectory(repositories, projectPath);

      const mergeContext: MergePhaseContext = {
        task,
        workingDirectory,
        branchName: analysisResult.branchName,
        analysisDescription: formatAnalysisDescription(analysisResult.analysis),
        storiesCompleted: approvedCount,
        totalStories: analysisResult.stories.length,
        autoMerge: options.autoMerge,
        onMergeApprovalRequired: options.onMergeApprovalRequired
          ? async (prInfo) => {
              options.onPullRequestCreated?.(prInfo.number, prInfo.url);
              return options.onMergeApprovalRequired!(prInfo.number, prInfo.url);
            }
          : undefined,
      };

      mergeResult = await executeMergePhase(mergeContext);

      if (mergeResult.pullRequest) {
        options.onPullRequestCreated?.(mergeResult.pullRequest.number, mergeResult.pullRequest.url);
      }

      console.log(`[OrchestratorV2] Merge complete: PR ${mergeResult.pullRequest?.number || 'N/A'}, merged: ${mergeResult.merged}`);

    } catch (error: any) {
      console.error(`[OrchestratorV2] Error: ${error.message}`);

      await TaskRepository.updateStatus(taskId, 'failed');

      socketService.toTask(taskId, 'orchestration:complete', {
        success: false,
        error: error.message,
        duration: Date.now() - startTime,
      });

      // Still push to Sentinental for training data
      sentinentalWebhook.push(taskId).catch(err => {
        console.warn(`[OrchestratorV2] Failed to push to Sentinental: ${err.message}`);
      });

      cleanupTaskTracking(taskId);

      return {
        success: false,
        taskId,
        analysis: analysisResult,
        developer: developerResult,
        merge: mergeResult,
        error: error.message,
        duration: Date.now() - startTime,
      };
    }

    // ════════════════════════════════════════════════════════════════
    // COMPLETION
    // ════════════════════════════════════════════════════════════════
    const success = mergeResult?.success ?? false;
    const duration = Date.now() - startTime;

    // Update task status
    await TaskRepository.updateStatus(taskId, success ? 'completed' : 'failed');

    // Notify frontend
    socketService.toTask(taskId, 'orchestration:complete', {
      success,
      duration,
      analysis: {
        sessionId: analysisResult?.sessionId,
        stories: analysisResult?.stories.length,
        branchName: analysisResult?.branchName,
      },
      developer: {
        sessionId: developerResult?.sessionId,
        commits: developerResult?.totalCommits,
        approved: developerResult?.stories.filter(r => r.verdict === 'approved').length,
      },
      merge: {
        prNumber: mergeResult?.pullRequest?.number,
        prUrl: mergeResult?.pullRequest?.url,
        merged: mergeResult?.merged,
      },
    });

    // Push to Sentinental for ML training
    sentinentalWebhook.push(taskId).catch(err => {
      console.warn(`[OrchestratorV2] Failed to push to Sentinental: ${err.message}`);
    });

    // Cleanup
    cleanupTaskTracking(taskId);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[OrchestratorV2] Task ${success ? 'COMPLETED' : 'FAILED'}`);
    console.log(`  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`  Stories: ${developerResult?.stories.filter(r => r.verdict === 'approved').length}/${analysisResult?.stories.length}`);
    console.log(`  PR: ${mergeResult?.pullRequest?.url || 'N/A'}`);
    console.log(`${'═'.repeat(70)}\n`);

    return {
      success,
      taskId,
      analysis: analysisResult,
      developer: developerResult,
      merge: mergeResult,
      duration,
    };
  }

  /**
   * Resume a task from a specific phase
   * Useful when a task was interrupted or needs retry
   */
  async resume(
    taskId: string,
    fromPhase: 'analysis' | 'developer' | 'merge',
    options: OrchestrationOptions = {}
  ): Promise<OrchestrationResult> {
    const task = await TaskRepository.findById(taskId);
    if (!task) {
      return {
        success: false,
        taskId,
        error: 'Task not found',
        duration: 0,
      };
    }

    // If resuming from developer or merge, we need existing analysis data
    if (fromPhase !== 'analysis' && (!task.analysis || !task.stories)) {
      return {
        success: false,
        taskId,
        error: 'Cannot resume: missing analysis data',
        duration: 0,
      };
    }

    // For now, just re-execute from the beginning
    // TODO: Implement proper resume logic that skips completed phases
    console.log(`[OrchestratorV2] Resume from ${fromPhase} not yet implemented - starting fresh`);
    return this.execute(taskId, options);
  }

  /**
   * Cancel a running task
   */
  async cancel(taskId: string): Promise<void> {
    await TaskRepository.updateStatus(taskId, 'cancelled');
    cleanupTaskTracking(taskId);

    socketService.toTask(taskId, 'orchestration:cancelled', {
      taskId,
    });

    console.log(`[OrchestratorV2] Task ${taskId} cancelled`);
  }
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

function formatAnalysisDescription(analysis: { summary: string; approach: string; risks: string[] }): string {
  return `### Summary
${analysis.summary}

### Approach
${analysis.approach}

### Risks
${analysis.risks?.map(r => `- ${r}`).join('\n') || 'None identified'}`;
}

export const orchestratorV2 = new OrchestratorV2Class();
export default orchestratorV2;
