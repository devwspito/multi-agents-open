/**
 * Orchestrator V2
 *
 * 4-phase architecture:
 * 1. Analysis Phase - Create branch, analyze task, break into stories (1 session)
 * 2. Developer Phase - Implement all stories with DEV → JUDGE → SPY loop (1 session per story)
 * 3. Merge Phase - Create PR, wait for approval, merge
 * 4. Global Scan Phase - ALWAYS runs, comprehensive security scan
 *
 * Key principles:
 * - Analysis/Merge: 1 session per phase
 * - Developer: 1 session per STORY (for context isolation)
 * - All Git operations happen at HOST level
 * - SPY runs at end of each iteration within phases
 * - Global Scan runs at the END, always, even if Merge fails
 * - All data pushed to Sentinental for ML training
 */

import { Task, Story, RepositoryInfo, GlobalVulnerabilityScan } from '../types/index.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { sentinentalWebhook } from '../services/training/index.js';
import { socketService, approvalService } from '../services/realtime/index.js';
import { cleanupTaskTracking } from './PhaseTracker.js';
import { getProjectLLMConfig, getFullProjectLLMConfig } from '../api/routes/projects.js';
import { openCodeClient } from '../services/opencode/OpenCodeClient.js';
import { toOpenCodeProvider, hasPhaseOverrides, type PhaseType, type ProjectLLMConfig } from '../config/llmProviders.js';

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
import {
  executeGlobalScanPhase,
  GlobalScanPhaseContext,
  GlobalScanResult,
} from './phases/GlobalScanPhaseV2.js';

export type ApprovalMode = 'manual' | 'automatic';

/**
 * Orchestration options
 */
export interface OrchestrationOptions {
  /** Base project path */
  projectPath?: string;
  /** All repositories for this project */
  repositories?: RepositoryInfo[];
  /** Phase approval mode - 'manual' requires user approval between phases, 'automatic' continues without pause */
  phaseApprovalMode?: ApprovalMode;
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
  /** Global scan - ALWAYS runs at the end */
  globalScan?: GlobalScanResult;
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
    // OpenCode sessions ALWAYS have all permissions (autoApprove = true)
    const autoApprove = true;
    // Phase approval mode - default to 'manual' (user must approve between phases)
    const phaseApprovalMode = options.phaseApprovalMode || 'manual';

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[OrchestratorV2] Starting task: ${taskId}`);
    console.log(`[OrchestratorV2] Phase approval mode: ${phaseApprovalMode}`);
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

    // 🔥 Get project LLM configuration with per-phase support
    const fullLLMConfig: ProjectLLMConfig = task.projectId
      ? await getFullProjectLLMConfig(task.projectId)
      : { default: { provider: 'local', model: 'kimi-dev-72b' } };

    // Get per-phase configs
    const analysisLLMConfig = task.projectId
      ? await getProjectLLMConfig(task.projectId, 'analysis')
      : { providerID: 'dgx-spark', modelID: 'kimi-dev-72b' };

    const developerLLMConfig = task.projectId
      ? await getProjectLLMConfig(task.projectId, 'developer')
      : { providerID: 'dgx-spark', modelID: 'kimi-dev-72b' };

    const securityLLMConfig = task.projectId
      ? await getProjectLLMConfig(task.projectId, 'security')
      : { providerID: 'dgx-spark', modelID: 'kimi-dev-72b' };

    // Log configuration
    const hasOverrides = hasPhaseOverrides(fullLLMConfig);
    console.log(`[OrchestratorV2] LLM Default: ${toOpenCodeProvider(fullLLMConfig.default.provider as any)}/${fullLLMConfig.default.model}`);
    if (hasOverrides) {
      console.log(`[OrchestratorV2] Per-phase overrides:`);
      console.log(`  - Analysis: ${analysisLLMConfig.providerID}/${analysisLLMConfig.modelID}`);
      console.log(`  - Developer: ${developerLLMConfig.providerID}/${developerLLMConfig.modelID}`);
      console.log(`  - Security: ${securityLLMConfig.providerID}/${securityLLMConfig.modelID}`);
    }

    // Configure auth for all unique providers that need API keys
    const uniqueConfigs = [
      { config: fullLLMConfig.default, phase: 'default' },
      ...(fullLLMConfig.phases?.analysis ? [{ config: fullLLMConfig.phases.analysis, phase: 'analysis' }] : []),
      ...(fullLLMConfig.phases?.developer ? [{ config: fullLLMConfig.phases.developer, phase: 'developer' }] : []),
      ...(fullLLMConfig.phases?.security ? [{ config: fullLLMConfig.phases.security, phase: 'security' }] : []),
    ];

    const configuredProviders = new Set<string>();
    for (const { config, phase } of uniqueConfigs) {
      if (config.apiKey) {
        const providerID = toOpenCodeProvider(config.provider as any);
        if (!configuredProviders.has(providerID)) {
          console.log(`[OrchestratorV2] Configuring auth for ${providerID} (from ${phase})`);
          await openCodeClient.configureProjectAuth(providerID, config.apiKey);
          configuredProviders.add(providerID);
        }
      }
    }

    // For backwards compatibility, use analysis config as the "main" llmConfig for notifications
    const llmConfig = analysisLLMConfig;

    // Notify frontend
    socketService.toTask(taskId, 'orchestration:start', {
      taskId,
      title: task.title,
      phases: ['Analysis', 'Developer', 'Merge', 'Security Scan'],
      llm: {
        provider: llmConfig.providerID,
        model: llmConfig.modelID,
        hasPhaseOverrides,
        phases: hasOverrides ? {
          analysis: { provider: analysisLLMConfig.providerID, model: analysisLLMConfig.modelID },
          developer: { provider: developerLLMConfig.providerID, model: developerLLMConfig.modelID },
          security: { provider: securityLLMConfig.providerID, model: securityLLMConfig.modelID },
        } : undefined,
      },
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
        llmConfig: analysisLLMConfig,
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

      // 🔥 PHASE APPROVAL: Wait for user approval before continuing to Developer
      if (phaseApprovalMode === 'manual') {
        console.log(`[OrchestratorV2] ⏸️ Waiting for approval of Analysis phase...`);
        const analysisApproved = await approvalService.requestApproval(
          taskId,
          'Analysis',
          {
            stories: analysisResult.stories,
            branchName: analysisResult.branchName,
            analysis: analysisResult.analysis,
          }
        );
        if (!analysisApproved) {
          throw new Error('Analysis phase rejected by user');
        }
        console.log(`[OrchestratorV2] ✅ Analysis phase approved`);
      }

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
        llmConfig: developerLLMConfig,
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

      // 🔥 PHASE APPROVAL: Wait for user approval before continuing to Merge
      if (phaseApprovalMode === 'manual') {
        console.log(`[OrchestratorV2] ⏸️ Waiting for approval of Developer phase...`);
        const developerApproved = await approvalService.requestApproval(
          taskId,
          'Developer',
          {
            stories: developerResult.stories,
            totalCommits: developerResult.totalCommits,
            approvedCount,
            totalStories: analysisResult.stories.length,
          }
        );
        if (!developerApproved) {
          throw new Error('Developer phase rejected by user');
        }
        console.log(`[OrchestratorV2] ✅ Developer phase approved`);
      }

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
      console.error(`[OrchestratorV2] Error in phases: ${error.message}`);
      // Don't return yet - we still need to run Global Scan
    }

    // ════════════════════════════════════════════════════════════════
    // PHASE 4: GLOBAL SCAN (ALWAYS RUNS)
    // ════════════════════════════════════════════════════════════════
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[OrchestratorV2] PHASE 4: GLOBAL SCAN (Final Security Analysis)`);
    console.log(`${'─'.repeat(70)}`);

    let globalScanResult: GlobalScanResult | undefined;

    const globalScanContext: GlobalScanPhaseContext = {
      task,
      repositories,
      sessionId: developerResult?.sessionId || analysisResult?.sessionId,
      branchName: analysisResult?.branchName,
      mergeSuccess: mergeResult?.success,
    };

    globalScanResult = await executeGlobalScanPhase(globalScanContext);

    console.log(`[OrchestratorV2] Global scan complete: ${globalScanResult.summary.totalVulnerabilities} vulnerabilities found`);

    // ════════════════════════════════════════════════════════════════
    // COMPLETION
    // ════════════════════════════════════════════════════════════════
    const success = (mergeResult?.success ?? false) && (globalScanResult?.success ?? false);
    const duration = Date.now() - startTime;

    // Update task status (merge determines success, global scan is informational)
    await TaskRepository.updateStatus(taskId, mergeResult?.success ? 'completed' : 'failed');

    // Notify frontend
    socketService.toTask(taskId, 'orchestration:complete', {
      success,
      duration,
      analysis: {
        sessionId: analysisResult?.sessionId,
        stories: analysisResult?.stories.length,
        branchName: analysisResult?.branchName,
        spyVulnerabilities: analysisResult?.analysis.vulnerabilities.length || 0,
      },
      developer: {
        sessionId: developerResult?.sessionId,
        commits: developerResult?.totalCommits,
        approved: developerResult?.stories.filter(r => r.verdict === 'approved').length,
        spyVulnerabilities: developerResult?.stories.reduce((sum, s) => sum + s.vulnerabilities.length, 0) || 0,
      },
      merge: {
        prNumber: mergeResult?.pullRequest?.number,
        prUrl: mergeResult?.pullRequest?.url,
        merged: mergeResult?.merged,
      },
      globalScan: {
        totalFiles: globalScanResult?.summary.totalFilesScanned,
        totalVulnerabilities: globalScanResult?.summary.totalVulnerabilities,
        bySeverity: globalScanResult?.scan.bySeverity,
      },
    });

    // Push to Sentinental for ML training
    sentinentalWebhook.push(taskId).catch(err => {
      console.warn(`[OrchestratorV2] Failed to push to Sentinental: ${err.message}`);
    });

    // Cleanup
    cleanupTaskTracking(taskId);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[OrchestratorV2] Task ${mergeResult?.success ? 'COMPLETED' : 'FAILED'}`);
    console.log(`  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`  Stories: ${developerResult?.stories.filter(r => r.verdict === 'approved').length}/${analysisResult?.stories.length}`);
    console.log(`  PR: ${mergeResult?.pullRequest?.url || 'N/A'}`);
    console.log(`  Global Scan: ${globalScanResult?.summary.totalVulnerabilities} vulnerabilities`);
    console.log(`${'═'.repeat(70)}\n`);

    return {
      success: mergeResult?.success ?? false,
      taskId,
      analysis: analysisResult,
      developer: developerResult,
      merge: mergeResult,
      globalScan: globalScanResult,
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
