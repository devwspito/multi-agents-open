/**
 * Orchestrator V2
 *
 * 5-phase architecture:
 * 0. Product Planning Phase - Clarifying questions, UX flows, task breakdown (BrainGrid-style)
 * 1. Analysis Phase - Create branch, analyze task, break into stories (1 session)
 * 2. Developer Phase - Implement all stories with DEV → JUDGE → SPY loop (1 session per story)
 * 3. Merge Phase - Create PR, wait for approval, merge
 * 4. Global Scan Phase - ALWAYS runs, comprehensive security scan
 *
 * Key principles:
 * - Planning: Enriches user prompt with clarifications and UX flows
 * - Analysis/Merge: 1 session per phase
 * - Developer: 1 session per STORY (for context isolation)
 * - All Git operations happen at HOST level
 * - SPY runs at end of each iteration within phases
 * - Global Scan runs at the END, always, even if Merge fails
 * - All data pushed to Sentinental for ML training
 */

import { Task, Story, RepositoryInfo, GlobalVulnerabilityScan } from '../types/index.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { sentinentalWebhook, trainingExportService } from '../services/training/index.js';
import { socketService, approvalService } from '../services/realtime/index.js';
import { cleanupTaskTracking } from './PhaseTracker.js';
import { getProjectLLMConfig, getFullProjectLLMConfig } from '../api/routes/projects.js';
import { openCodeClient } from '../services/opencode/OpenCodeClient.js';
import { toOpenCodeProvider, hasPhaseOverrides, type PhaseType, type ProjectLLMConfig } from '../config/llmProviders.js';

// New V2 Services
import { contextCacheService } from '../services/context/index.js';
import { githubEnhancedService } from '../services/git/index.js';

// Import V2 phases
import {
  runProductPlanningPhase,
  ProductPlanningContext,
  ProductPlanningResult,
} from './phases/ProductPlanningPhase.js';
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
import {
  runTestGenerationPhase,
  TestGenerationContext,
  TestGenerationResult,
} from './phases/TestGenerationPhase.js';

export type ApprovalMode = 'manual' | 'automatic';

/**
 * Orchestration options
 */
/** Valid phases for retry */
export type RetryablePhase = 'Planning' | 'Analysis' | 'Developer' | 'TestGeneration' | 'Merge' | 'GlobalScan';

export interface OrchestrationOptions {
  /** Base project path */
  projectPath?: string;
  /** All repositories for this project */
  repositories?: RepositoryInfo[];
  /** Phase approval mode - 'manual' requires user approval between phases, 'automatic' continues without pause */
  phaseApprovalMode?: ApprovalMode;
  /** Auto-merge PR without approval */
  autoMerge?: boolean;
  /** Skip product planning phase for simple tasks */
  skipPlanningForSimpleTasks?: boolean;
  /** Skip planning phase entirely */
  skipPlanning?: boolean;
  /** Skip test generation phase */
  skipTestGeneration?: boolean;
  /** Test coverage threshold (0-100) */
  coverageThreshold?: number;
  /** Enable context caching for reduced token usage */
  enableContextCache?: boolean;
  /** Use enhanced GitHub integration for PRs */
  useEnhancedGitHub?: boolean;
  /** GitHub token for enhanced features */
  githubToken?: string;
  /** Phase-selective retry: Start from this phase instead of beginning */
  startFromPhase?: RetryablePhase;
  /** When retrying, preserve existing analysis results */
  preserveAnalysis?: boolean;
  /** When retrying, preserve existing story results */
  preserveStories?: boolean;
  /** Called when Planning phase completes */
  onPlanningComplete?: (result: ProductPlanningResult) => void;
  /** Called when Analysis phase completes */
  onAnalysisComplete?: (result: AnalysisResult) => void;
  /** Called when a story is completed */
  onStoryComplete?: (storyIndex: number, story: Story, success: boolean) => void;
  /** Called when Developer phase completes */
  onDeveloperComplete?: (result: DeveloperResult) => void;
  /** Called when Test Generation phase completes */
  onTestGenerationComplete?: (result: TestGenerationResult) => void;
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
  /** Product planning - clarifications, UX flows, enriched prompt */
  planning?: ProductPlanningResult;
  analysis?: AnalysisResult;
  developer?: DeveloperResult;
  /** Test generation - coverage, edge cases, generated tests */
  testGeneration?: TestGenerationResult;
  merge?: MergeResult;
  /** Global scan - ALWAYS runs at the end */
  globalScan?: GlobalScanResult;
  /** Context cache stats */
  cacheStats?: {
    cacheHits: number;
    cacheMisses: number;
    tokensSaved: number;
  };
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

    // 🔥 RESUME DETECTION: Check if we're resuming from a previous execution
    const completedPhases = task.completedPhases || [];
    const isResuming = completedPhases.length > 0 || task.currentPhase;

    if (isResuming) {
      console.log(`[OrchestratorV2] 🔄 RESUMING task from previous execution`);
      console.log(`[OrchestratorV2]   Completed phases: ${completedPhases.join(', ') || 'none'}`);
      console.log(`[OrchestratorV2]   Last phase in progress: ${task.currentPhase || 'none'}`);
      if (task.lastCompletedStoryIndex !== undefined) {
        console.log(`[OrchestratorV2]   Last completed story: ${task.lastCompletedStoryIndex}`);
      }
    }

    // Update task status
    await TaskRepository.updateStatus(taskId, 'running');

    // Initialize GitHub Enhanced if token provided
    if (options.useEnhancedGitHub && options.githubToken) {
      try {
        await githubEnhancedService.init(options.githubToken);
        console.log(`[OrchestratorV2] ✅ GitHub Enhanced initialized`);
      } catch (err: any) {
        console.warn(`[OrchestratorV2] ⚠️ GitHub Enhanced init failed: ${err.message}`);
      }
    }

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

    // Determine which phases to run based on startFromPhase OR resume state
    const startFromPhase = options.startFromPhase;
    const phaseOrder: RetryablePhase[] = ['Planning', 'Analysis', 'Developer', 'TestGeneration', 'Merge', 'GlobalScan'];
    const startPhaseIndex = startFromPhase ? phaseOrder.indexOf(startFromPhase) : 0;

    // 🔥 RESUME: Check completed phases from previous execution
    const planningDone = completedPhases.includes('Planning');
    const analysisDone = completedPhases.includes('Analysis');
    const developerDone = completedPhases.includes('Developer');
    const testGenDone = completedPhases.includes('TestGeneration');
    const mergeDone = completedPhases.includes('Merge');

    // Determine if planning should run (skip if already done OR if startFromPhase says so)
    const skipPlanning = options.skipPlanning || startPhaseIndex > 0 || planningDone;
    const skipAnalysis = startPhaseIndex > 1 || analysisDone; // Skip if starting from Developer or later, or already done
    const skipDeveloper = startPhaseIndex > 2 || developerDone; // Skip if starting from TestGeneration or later
    const skipTestGeneration = options.skipTestGeneration || startPhaseIndex > 3 || testGenDone;
    const skipMerge = startPhaseIndex > 4 || mergeDone; // Only skip if starting from GlobalScan

    // For Developer phase resume: track which story to start from
    const resumeFromStoryIndex = isResuming && task.lastCompletedStoryIndex !== undefined
      ? task.lastCompletedStoryIndex + 1
      : 0;

    if (startFromPhase) {
      console.log(`[OrchestratorV2] 🔄 Phase-selective retry: Starting from ${startFromPhase}`);
      console.log(`[OrchestratorV2]   Skip Planning: ${skipPlanning}, Skip Analysis: ${skipAnalysis}, Skip Developer: ${skipDeveloper}`);
    }

    // Notify frontend
    const phases = [
      ...(skipPlanning ? [] : ['Planning']),
      ...(skipAnalysis ? [] : ['Analysis']),
      ...(skipDeveloper ? [] : ['Developer']),
      ...(skipTestGeneration ? [] : ['Test Generation']),
      ...(skipMerge ? [] : ['Merge']),
      'Security Scan',
    ];
    socketService.toTask(taskId, 'orchestration:start', {
      taskId,
      title: task.title,
      phases,
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

    let planningResult: ProductPlanningResult | undefined;
    let analysisResult: AnalysisResult | undefined;
    let developerResult: DeveloperResult | undefined;
    let testGenerationResult: TestGenerationResult | undefined;
    let mergeResult: MergeResult | undefined;

    // Track enriched task description (from planning)
    let enrichedTaskDescription = task.description || task.title;

    // Track cache statistics
    let cacheStats = { cacheHits: 0, cacheMisses: 0, tokensSaved: 0 };

    try {
      // ════════════════════════════════════════════════════════════════
      // PHASE 0: PRODUCT PLANNING (BrainGrid-style)
      // ════════════════════════════════════════════════════════════════
      if (!skipPlanning) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`[OrchestratorV2] PHASE 0: PRODUCT PLANNING`);
        console.log(`${'─'.repeat(70)}`);

        // 🔥 RESUME: Mark phase as in progress
        await TaskRepository.setCurrentPhase(taskId, 'Planning');

        const planningContext: ProductPlanningContext = {
          task,
          projectPath,
          repositories,
          autoApprove: phaseApprovalMode === 'automatic',
          llmConfig: analysisLLMConfig,
          skipForSimpleTasks: options.skipPlanningForSimpleTasks ?? true,
        };

        planningResult = await runProductPlanningPhase(planningContext);
        options.onPlanningComplete?.(planningResult);

        if (!planningResult.success) {
          throw new Error('Product Planning phase failed or was rejected');
        }

        // 🔥 RESUME: Mark phase as completed WITH approved data for display
        await TaskRepository.markPhaseComplete(taskId, 'Planning', {
          uxFlows: planningResult.uxFlows,
          plannedTasks: planningResult.plannedTasks,
          clarifications: planningResult.clarifications,
        });

        // 🔥 TRAINING: Save planning result to PostgreSQL for future Specialist ML training
        await TaskRepository.savePlanningResult(taskId, {
          uxFlows: planningResult.uxFlows,
          plannedTasks: planningResult.plannedTasks,
          clarifications: planningResult.clarifications,
          enrichedPrompt: planningResult.enrichedPrompt,
          planningDurationMs: planningResult.planningDurationMs,
        });

        console.log(`[OrchestratorV2] 📋 Planning result saved to PostgreSQL`);

        // Use enriched prompt for subsequent phases
        if (planningResult.enrichedPrompt) {
          enrichedTaskDescription = planningResult.enrichedPrompt;
          console.log(`[OrchestratorV2] Using enriched prompt from planning phase`);
        }

        console.log(`[OrchestratorV2] Planning complete:`);
        console.log(`  - Questions: ${planningResult.clarifications?.questions.length || 0}`);
        console.log(`  - UX Flows: ${planningResult.uxFlows?.length || 0}`);
        console.log(`  - Planned Tasks: ${planningResult.plannedTasks?.length || 0}`);
      }

      // ════════════════════════════════════════════════════════════════
      // CONTEXT CACHING (if enabled)
      // ════════════════════════════════════════════════════════════════
      if (options.enableContextCache !== false) {
        console.log(`\n[OrchestratorV2] 📦 Initializing Context Cache...`);
        try {
          const primaryRepo = repositories.find(r => r.type === 'backend') || repositories[0];
          const cachePath = primaryRepo?.localPath || projectPath;

          // Get or build context (uses cache if available)
          const context = await contextCacheService.getContext(task.projectId || taskId, taskId, cachePath);
          const stats = contextCacheService.getStats();

          // Estimate tokens saved based on cache hit rate
          const estimatedTokensSaved = Math.round(context.totalSize / 4 * stats.hitRate);
          cacheStats = {
            cacheHits: Math.round(stats.hitRate * 100),
            cacheMisses: Math.round(stats.missRate * 100),
            tokensSaved: estimatedTokensSaved,
          };
          console.log(`[OrchestratorV2] ✅ Context cached: ${context.totalFiles} files, ~${estimatedTokensSaved} tokens saved (hit rate: ${(stats.hitRate * 100).toFixed(0)}%)`);
        } catch (cacheError: any) {
          console.warn(`[OrchestratorV2] ⚠️ Context cache failed (non-fatal): ${cacheError.message}`);
        }
      }

      // ════════════════════════════════════════════════════════════════
      // PHASE 1: ANALYSIS
      // ════════════════════════════════════════════════════════════════
      if (skipAnalysis && options.preserveAnalysis) {
        // Load analysis from existing task data
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`[OrchestratorV2] PHASE 1: ANALYSIS (SKIPPED - using preserved data)`);
        console.log(`${'─'.repeat(70)}`);

        if (task.analysis && task.stories && task.stories.length > 0) {
          analysisResult = {
            success: true,
            sessionId: 'preserved',
            analysis: {
              ...task.analysis,
              vulnerabilities: [], // Add empty vulnerabilities array for preserved data
            },
            stories: task.stories.map(s => ({
              id: s.id,
              title: s.title,
              description: s.description,
              status: s.status,
              filesToModify: s.filesToModify,
              filesToCreate: s.filesToCreate,
              filesToRead: s.filesToRead,
              acceptanceCriteria: s.acceptanceCriteria,
              iterations: 0,
              verdict: 'approved' as const,
              vulnerabilities: [],
            })),
            branchName: task.branchName || `feature/task-${taskId}`,
          };
          console.log(`[OrchestratorV2] ✅ Loaded ${analysisResult.stories.length} stories from preserved analysis`);
        } else {
          throw new Error('Cannot skip Analysis - no preserved analysis/stories found');
        }
      } else {
        // Run Analysis phase normally
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`[OrchestratorV2] PHASE 1: ANALYSIS`);
        console.log(`${'─'.repeat(70)}`);

        // 🔥 RESUME: Mark phase as in progress
        await TaskRepository.setCurrentPhase(taskId, 'Analysis');

        // Create task copy with enriched description
        const enrichedTask = {
          ...task,
          description: enrichedTaskDescription,
          // Store original for reference
          originalDescription: task.description,
        };

        const analysisContext: AnalysisPhaseContext = {
          task: enrichedTask as Task,
          projectPath,
          repositories,
          autoApprove,
          llmConfig: analysisLLMConfig,
          // 🔥 Pass structured data from Planning phase - Analysis will USE this instead of regenerating
          planningData: planningResult ? {
            uxFlows: planningResult.uxFlows,
            plannedTasks: planningResult.plannedTasks,
            clarifications: planningResult.clarifications,
          } : undefined,
        };

        analysisResult = await executeAnalysisPhase(analysisContext);
        options.onAnalysisComplete?.(analysisResult);

        if (!analysisResult.success) {
          throw new Error(analysisResult.error || 'Analysis phase failed');
        }

        if (analysisResult.stories.length === 0) {
          throw new Error('Analysis produced no stories');
        }

        // 🔥 RESUME: Mark phase as completed WITH approved data for display
        await TaskRepository.markPhaseComplete(taskId, 'Analysis', {
          stories: analysisResult.stories,
          branchName: analysisResult.branchName,
        });

        console.log(`[OrchestratorV2] Analysis complete: ${analysisResult.stories.length} stories created`);
        console.log(`[OrchestratorV2] Branch: ${analysisResult.branchName}`);
      }

      // At this point, analysisResult must be defined
      if (!analysisResult) {
        throw new Error('Analysis result is required - internal error');
      }

      // 🔥 PHASE APPROVAL: Wait for user approval before continuing to Developer
      if (phaseApprovalMode === 'manual') {
        console.log(`[OrchestratorV2] ⏸️ Waiting for approval of Analysis phase...`);
        // Update task status to waiting_for_approval
        await TaskRepository.update(taskId, { status: 'waiting_for_approval' as any });
        socketService.toTask(taskId, 'task:status', { taskId, status: 'waiting_for_approval', phase: 'Analysis' });

        const analysisApproved = await approvalService.requestApproval(
          taskId,
          'Analysis',
          {
            stories: analysisResult.stories,
            branchName: analysisResult.branchName,
            analysis: analysisResult.analysis,
          }
        );

        // Restore to running
        await TaskRepository.update(taskId, { status: 'running' });
        socketService.toTask(taskId, 'task:status', { taskId, status: 'running', phase: 'Developer' });

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
      if (resumeFromStoryIndex > 0) {
        console.log(`[OrchestratorV2] 🔄 Resuming from story index ${resumeFromStoryIndex}`);
      }
      console.log(`${'─'.repeat(70)}`);

      // 🔥 RESUME: Mark phase as in progress
      await TaskRepository.setCurrentPhase(taskId, 'Developer');

      const developerContext: DeveloperPhaseContext = {
        task,
        projectPath,
        repositories,
        stories: analysisResult.stories,
        branchName: analysisResult.branchName,
        // 🔥 FIX: Story approval respects phase approval mode - NOT always auto
        autoApprove: phaseApprovalMode === 'automatic',
        llmConfig: developerLLMConfig,
        // 🔥 RESUME: Start from specific story if resuming
        startFromStoryIndex: resumeFromStoryIndex,
        // 🔥 RESUME: Callback to save progress after each story
        onStoryComplete: async (storyIndex: number) => {
          await TaskRepository.setLastCompletedStoryIndex(taskId, storyIndex);
        },
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

      // 🔥 RESUME: Mark phase as completed WITH approved data for display
      await TaskRepository.markPhaseComplete(taskId, 'Developer', {
        stories: developerResult.stories,
        totalCommits: developerResult.totalCommits,
        approvedCount,
      });

      // 🔥 PHASE APPROVAL: Wait for user approval before continuing to Merge
      if (phaseApprovalMode === 'manual') {
        console.log(`[OrchestratorV2] ⏸️ Waiting for approval of Developer phase...`);
        // Update task status to waiting_for_approval
        await TaskRepository.update(taskId, { status: 'waiting_for_approval' as any });
        socketService.toTask(taskId, 'task:status', { taskId, status: 'waiting_for_approval', phase: 'Developer' });

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

        // Restore to running
        await TaskRepository.update(taskId, { status: 'running' });
        socketService.toTask(taskId, 'task:status', { taskId, status: 'running', phase: 'TestGeneration' });

        if (!developerApproved) {
          throw new Error('Developer phase rejected by user');
        }
        console.log(`[OrchestratorV2] ✅ Developer phase approved`);
      }

      // ════════════════════════════════════════════════════════════════
      // PHASE 2.5: TEST GENERATION (if enabled)
      // ════════════════════════════════════════════════════════════════
      if (!options.skipTestGeneration) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`[OrchestratorV2] PHASE 2.5: TEST GENERATION`);
        console.log(`${'─'.repeat(70)}`);

        // 🔥 RESUME: Mark phase as in progress
        await TaskRepository.setCurrentPhase(taskId, 'TestGeneration');

        const testContext: TestGenerationContext = {
          task,
          projectPath,
          stories: developerResult.stories,
          autoApprove: phaseApprovalMode === 'automatic',
          llmConfig: developerLLMConfig,
          testFramework: 'auto',
          coverageThreshold: options.coverageThreshold ?? 70,
          maxIterations: 3,
        };

        testGenerationResult = await runTestGenerationPhase(testContext);
        options.onTestGenerationComplete?.(testGenerationResult);

        console.log(`[OrchestratorV2] Test generation complete:`);
        console.log(`  - Tests generated: ${testGenerationResult.testsGenerated.length}`);
        console.log(`  - Edge cases detected: ${testGenerationResult.edgeCasesDetected.length}`);
        console.log(`  - Tests passed: ${testGenerationResult.testsPassed ? '✅' : '❌'}`);
        console.log(`  - Coverage: ${testGenerationResult.coverageBefore}% → ${testGenerationResult.coverageAfter}%`);

        // 🔥 RESUME: Mark phase as completed WITH approved data for display
        await TaskRepository.markPhaseComplete(taskId, 'TestGeneration', {
          testsGenerated: testGenerationResult.testsGenerated.length,
          edgeCasesDetected: testGenerationResult.edgeCasesDetected.length,
          testsPassed: testGenerationResult.testsPassed,
          coverageBefore: testGenerationResult.coverageBefore,
          coverageAfter: testGenerationResult.coverageAfter,
        });

        // 🔥 PHASE APPROVAL: Wait for user approval of tests
        if (phaseApprovalMode === 'manual' && testGenerationResult.testsGenerated.length > 0) {
          console.log(`[OrchestratorV2] ⏸️ Waiting for approval of Test Generation phase...`);
          // Update task status to waiting_for_approval
          await TaskRepository.update(taskId, { status: 'waiting_for_approval' as any });
          socketService.toTask(taskId, 'task:status', { taskId, status: 'waiting_for_approval', phase: 'TestGeneration' });

          const testApproved = await approvalService.requestApproval(
            taskId,
            'TestGeneration',
            {
              testsGenerated: testGenerationResult.testsGenerated.length,
              edgeCases: testGenerationResult.edgeCasesDetected.length,
              coverageGaps: testGenerationResult.coverageGaps.length,
              testsPassed: testGenerationResult.testsPassed,
              coverageBefore: testGenerationResult.coverageBefore,
              coverageAfter: testGenerationResult.coverageAfter,
            }
          );

          // Restore to running
          await TaskRepository.update(taskId, { status: 'running' });
          socketService.toTask(taskId, 'task:status', { taskId, status: 'running', phase: 'Merge' });

          if (!testApproved) {
            throw new Error('Test Generation phase rejected by user');
          }
          console.log(`[OrchestratorV2] ✅ Test Generation phase approved`);
        }
      }

      // ════════════════════════════════════════════════════════════════
      // PHASE 3: MERGE
      // ════════════════════════════════════════════════════════════════
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`[OrchestratorV2] PHASE 3: MERGE`);
      console.log(`${'─'.repeat(70)}`);

      // 🔥 RESUME: Mark phase as in progress
      await TaskRepository.setCurrentPhase(taskId, 'Merge');

      // Determine working directory for merge
      const workingDirectory = determineWorkingDirectory(repositories, projectPath);

      // Generate enhanced PR description if GitHub Enhanced is available
      let enhancedAnalysisDescription = formatAnalysisDescription(analysisResult.analysis);

      if (options.useEnhancedGitHub) {
        try {
          // Get files changed from developer result
          const filesChanged: string[] = [];
          for (const story of developerResult.stories) {
            if (story.filesToModify) filesChanged.push(...story.filesToModify);
            if (story.filesToCreate) filesChanged.push(...story.filesToCreate);
          }

          // Extract issue numbers from task description and branch name
          const issueNumbers = githubEnhancedService.extractIssueNumbers(
            `${task.description || ''} ${analysisResult.branchName}`
          );

          // Generate AI-enhanced PR description
          enhancedAnalysisDescription = githubEnhancedService.generatePRDescription({
            summary: analysisResult.analysis.summary,
            changes: filesChanged.length > 0
              ? filesChanged.slice(0, 20).map(f => `Modified \`${f}\``)
              : analysisResult.stories.map(s => s.title),
            testPlan: [
              'Run existing test suite',
              'Manual testing of affected features',
              ...(testGenerationResult?.testsGenerated?.map(t => `Run ${t.testName}`) || []),
            ],
            breakingChanges: analysisResult.analysis.risks?.filter(r =>
              r.toLowerCase().includes('breaking') || r.toLowerCase().includes('migration')
            ),
            issueLinks: githubEnhancedService.generateIssueLinks(issueNumbers),
          });

          // Suggest labels based on changes
          const suggestedLabels = githubEnhancedService.suggestLabels({
            filesChanged,
            type: analysisResult.branchName.startsWith('fix') ? 'fix' : 'feature',
            breaking: analysisResult.analysis.risks?.some(r => r.toLowerCase().includes('breaking')),
          });

          console.log(`[OrchestratorV2] 🏷️ Suggested labels: ${suggestedLabels.join(', ')}`);
        } catch (err: any) {
          console.warn(`[OrchestratorV2] ⚠️ Enhanced PR description failed: ${err.message}`);
        }
      }

      // 🔥 MULTI-REPO: Pass all repositories to MergePhase for 1 PR per repo
      const mergeContext: MergePhaseContext = {
        task,
        workingDirectory, // Legacy fallback
        repositories,     // 🔥 NEW: All repositories for multi-repo PR creation
        branchName: analysisResult.branchName,
        analysisDescription: enhancedAnalysisDescription,
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

      // 🔥 MULTI-REPO: Notify about ALL created PRs
      if (mergeResult.pullRequests && mergeResult.pullRequests.length > 0) {
        for (const pr of mergeResult.pullRequests) {
          options.onPullRequestCreated?.(pr.number, pr.url);
        }
        console.log(`[OrchestratorV2] Merge complete: ${mergeResult.pullRequests.length} PRs created, merged: ${mergeResult.merged}`);
        mergeResult.pullRequests.forEach(pr => {
          console.log(`[OrchestratorV2]   - ${pr.repoName} (${pr.repoType}): PR #${pr.number} - ${pr.url}`);
        });
      } else if (mergeResult.pullRequest) {
        // Legacy single PR
        options.onPullRequestCreated?.(mergeResult.pullRequest.number, mergeResult.pullRequest.url);
        console.log(`[OrchestratorV2] Merge complete: PR ${mergeResult.pullRequest.number}, merged: ${mergeResult.merged}`);
      } else {
        console.log(`[OrchestratorV2] Merge complete: No PRs created, merged: ${mergeResult.merged}`);
      }

      // 🔥 RESUME: Mark phase as completed WITH approved data for display
      // 🔥 MULTI-REPO: Save all PRs, not just the first one
      await TaskRepository.markPhaseComplete(taskId, 'Merge', {
        pullRequest: mergeResult.pullRequest, // Legacy backwards compat
        pullRequests: mergeResult.pullRequests?.map(pr => ({
          number: pr.number,
          url: pr.url,
          repoName: pr.repoName,
          repoType: pr.repoType,
        })),
        merged: mergeResult.merged,
      });

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

    // 🔥 RESUME: Mark phase as in progress
    await TaskRepository.setCurrentPhase(taskId, 'GlobalScan');

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

    // 🔥 RESUME: Mark GlobalScan as completed WITH approved data for display
    await TaskRepository.markPhaseComplete(taskId, 'GlobalScan', {
      summary: globalScanResult.summary,
      vulnerabilities: globalScanResult.summary.totalVulnerabilities,
    });

    // ════════════════════════════════════════════════════════════════
    // COMPLETION
    // ════════════════════════════════════════════════════════════════
    const success = (mergeResult?.success ?? false) && (globalScanResult?.success ?? false);
    const duration = Date.now() - startTime;

    // Update task status (merge determines success, global scan is informational)
    if (mergeResult?.success) {
      await TaskRepository.updateStatus(taskId, 'completed');
    } else {
      // 🔥 Set failure reason so user knows WHY it failed
      const failureReason = !mergeResult
        ? 'Merge phase did not complete'
        : !mergeResult.pullRequest
          ? 'Failed to create pull request'
          : !mergeResult.merged
            ? 'Pull request was not merged'
            : 'Unknown merge failure';
      await TaskRepository.setFailed(taskId, failureReason);
    }

    // 🔥 RESUME: Clear resume state now that task is complete
    await TaskRepository.clearResumeState(taskId);

    // Notify frontend
    socketService.toTask(taskId, 'orchestration:complete', {
      success,
      duration,
      planning: planningResult ? {
        questions: planningResult.clarifications?.questions.length || 0,
        uxFlows: planningResult.uxFlows?.length || 0,
        plannedTasks: planningResult.plannedTasks?.length || 0,
        enriched: !!planningResult.enrichedPrompt,
      } : undefined,
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
      testGeneration: testGenerationResult ? {
        testsGenerated: testGenerationResult.testsGenerated.length,
        edgeCases: testGenerationResult.edgeCasesDetected.length,
        coverageGaps: testGenerationResult.coverageGaps.length,
        testsPassed: testGenerationResult.testsPassed,
        coverageBefore: testGenerationResult.coverageBefore,
        coverageAfter: testGenerationResult.coverageAfter,
        iterations: testGenerationResult.iterations,
      } : undefined,
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
      cacheStats: options.enableContextCache !== false ? cacheStats : undefined,
    });

    // Push to Sentinental for ML training (security vulnerabilities)
    sentinentalWebhook.push(taskId).catch(err => {
      console.warn(`[OrchestratorV2] Failed to push to Sentinental: ${err.message}`);
    });

    // 🔥 Export comprehensive training data to file
    const trainingDataDir = process.env.TRAINING_DATA_DIR || '/tmp/training-data';
    trainingExportService.exportToFile(taskId, `${trainingDataDir}/${taskId}.json`).catch(err => {
      console.warn(`[OrchestratorV2] Failed to export training data: ${err.message}`);
    });

    // Cleanup
    cleanupTaskTracking(taskId);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[OrchestratorV2] Task ${mergeResult?.success ? 'COMPLETED' : 'FAILED'}`);
    console.log(`  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`  Stories: ${developerResult?.stories.filter(r => r.verdict === 'approved').length}/${analysisResult?.stories.length}`);
    if (testGenerationResult) {
      console.log(`  Tests: ${testGenerationResult.testsGenerated.length} generated, ${testGenerationResult.testsPassed ? 'passing' : 'failing'}`);
      console.log(`  Coverage: ${testGenerationResult.coverageBefore}% → ${testGenerationResult.coverageAfter}%`);
    }
    console.log(`  PR: ${mergeResult?.pullRequest?.url || 'N/A'}`);
    console.log(`  Global Scan: ${globalScanResult?.summary.totalVulnerabilities} vulnerabilities`);
    if (cacheStats.tokensSaved > 0) {
      console.log(`  Cache: ~${cacheStats.tokensSaved} tokens saved`);
    }
    console.log(`${'═'.repeat(70)}\n`);

    return {
      success: mergeResult?.success ?? false,
      taskId,
      planning: planningResult,
      analysis: analysisResult,
      developer: developerResult,
      testGeneration: testGenerationResult,
      merge: mergeResult,
      globalScan: globalScanResult,
      cacheStats: options.enableContextCache !== false ? cacheStats : undefined,
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
    // 🔥 RESUME: Clear resume state when task is cancelled
    await TaskRepository.clearResumeState(taskId);
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
