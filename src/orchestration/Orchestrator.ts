/**
 * Orchestrator
 *
 * Coordinates the execution of multiple phases in sequence.
 * Routes tasks through the appropriate pipeline.
 *
 * NEW: Story-based execution
 * - Analysis phase breaks task into Stories
 * - For each story: Development → Judge → Fixer (if needed)
 * - Automatically pushes completed data to Sentinental Core for ML training.
 */

import { IPhase, PhaseContext, PhaseResult, cleanupTaskTracking } from './Phase.js';
import { Task, TaskStatus, Story, RepositoryInfo } from '../types/index.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { sentinentalWebhook } from '../services/training/index.js';
import { socketService, approvalService } from '../services/realtime/index.js';

export type ApprovalMode = 'manual' | 'automatic';

/**
 * Pipeline definition
 */
export interface Pipeline {
  name: string;
  description: string;
  phases: IPhase[];
}

/**
 * Story execution result
 */
export interface StoryResult {
  storyId: string;
  storyTitle: string;
  success: boolean;
  developmentResult?: PhaseResult;
  judgeResult?: PhaseResult;
  fixerResult?: PhaseResult;
  finalVerdict?: 'approved' | 'rejected' | 'needs_revision';
}

/**
 * Orchestration result
 */
export interface OrchestrationResult {
  success: boolean;
  taskId: string;
  pipeline: string;
  phaseResults: Map<string, PhaseResult>;
  storyResults?: StoryResult[];
  error?: string;
  duration: number;
}

class OrchestratorClass {
  private pipelines: Map<string, Pipeline> = new Map();

  /**
   * Register a pipeline
   */
  registerPipeline(pipeline: Pipeline): void {
    this.pipelines.set(pipeline.name, pipeline);
    console.log(`[Orchestrator] Registered pipeline: ${pipeline.name} (${pipeline.phases.length} phases)`);
  }

  /**
   * Get a registered pipeline
   */
  getPipeline(name: string): Pipeline | undefined {
    return this.pipelines.get(name);
  }

  /**
   * Get all registered pipelines
   */
  getAllPipelines(): Pipeline[] {
    return Array.from(this.pipelines.values());
  }

  /**
   * Execute a task through a pipeline with STORY-BASED execution
   */
  async execute(
    taskId: string,
    pipelineName: string,
    options: {
      projectPath?: string;
      /** All repositories for this project with their types */
      repositories?: RepositoryInfo[];
      variables?: Record<string, any>;
      approvalMode?: ApprovalMode;
      onPhaseStart?: (phaseName: string) => void;
      onPhaseComplete?: (phaseName: string, result: PhaseResult) => void;
      onStoryStart?: (storyIndex: number, story: Story) => void;
      onStoryComplete?: (storyIndex: number, story: Story, result: StoryResult) => void;
      /** Called when a phase creates an OpenCode session - use to track sessionId */
      onSessionCreated?: (sessionId: string, phaseName: string) => void;
    } = {}
  ): Promise<OrchestrationResult> {
    const approvalMode = options.approvalMode || 'automatic';
    const startTime = Date.now();

    // Get task
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return {
        success: false,
        taskId,
        pipeline: pipelineName,
        phaseResults: new Map(),
        error: 'Task not found',
        duration: 0,
      };
    }

    // Get pipeline
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      return {
        success: false,
        taskId,
        pipeline: pipelineName,
        phaseResults: new Map(),
        error: `Pipeline not found: ${pipelineName}`,
        duration: 0,
      };
    }

    // Update task status
    TaskRepository.updateStatus(taskId, 'running');

    // Create context with repositories
    const context: PhaseContext = {
      task,
      projectPath: options.projectPath || process.cwd(),
      repositories: options.repositories || [],
      previousResults: new Map(),
      variables: new Map(Object.entries(options.variables || {})),
      onSessionCreated: options.onSessionCreated,
    };

    // Log repositories for debugging
    if (context.repositories.length > 0) {
      console.log(`[Orchestrator] Repositories available: ${context.repositories.map(r => `${r.name}(${r.type})`).join(', ')}`);
    }

    const phaseResults = new Map<string, PhaseResult>();
    const storyResults: StoryResult[] = [];
    let lastError: string | undefined;
    let success = true;

    // Identify special phases
    const analysisPhase = pipeline.phases.find(p => p.name === 'Analysis');
    const developmentPhase = pipeline.phases.find(p => p.name === 'Development');
    const judgePhase = pipeline.phases.find(p => p.name === 'Judge');
    const fixerPhase = pipeline.phases.find(p => p.name === 'Fixer');

    // Execute Analysis first (creates stories)
    if (analysisPhase) {
      console.log(`\n[Orchestrator] Starting phase: ${analysisPhase.name}`);
      options.onPhaseStart?.(analysisPhase.name);

      socketService.toTask(taskId, 'phase:start', {
        phase: analysisPhase.name,
        description: analysisPhase.description,
      });

      try {
        const result = await analysisPhase.execute(context);
        phaseResults.set(analysisPhase.name, result);
        context.previousResults.set(analysisPhase.name, result);
        options.onPhaseComplete?.(analysisPhase.name, result);

        socketService.toTask(taskId, 'phase:complete', {
          phase: analysisPhase.name,
          success: result.success,
          output: result.output,
          metadata: result.metadata,
        });

        if (!result.success) {
          console.log(`[Orchestrator] Analysis failed: ${result.error}`);
          TaskRepository.updateStatus(taskId, 'failed');
          return {
            success: false,
            taskId,
            pipeline: pipelineName,
            phaseResults,
            error: result.error,
            duration: Date.now() - startTime,
          };
        }

        console.log(`[Orchestrator] Analysis completed successfully`);
      } catch (error: any) {
        console.log(`[Orchestrator] Analysis error: ${error.message}`);
        TaskRepository.updateStatus(taskId, 'failed');
        return {
          success: false,
          taskId,
          pipeline: pipelineName,
          phaseResults,
          error: error.message,
          duration: Date.now() - startTime,
        };
      }
    }

    // Get stories from context (created by AnalysisPhase)
    const stories = context.variables.get('stories') as Story[] || [];

    if (stories.length === 0) {
      console.log('[Orchestrator] No stories found, executing phases traditionally');
      // Fall back to traditional phase execution
      return this.executeTraditional(taskId, pipeline, context, options, phaseResults, startTime);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Orchestrator] STORY-BASED EXECUTION: ${stories.length} stories`);
    console.log(`${'='.repeat(60)}`);

    // Emit stories to frontend
    socketService.toTask(taskId, 'stories:created', {
      stories: stories.map((s, i) => ({
        id: s.id,
        index: i,
        title: s.title,
        status: s.status,
      })),
      totalStories: stories.length,
    });

    // Execute each story: Development → Judge → Fixer (if needed)
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`[Orchestrator] STORY ${i + 1}/${stories.length}: ${story.title}`);
      console.log(`${'─'.repeat(60)}`);

      // Emit story start
      socketService.toTask(taskId, 'story:start', {
        storyIndex: i,
        storyId: story.id,
        storyTitle: story.title,
        totalStories: stories.length,
      });
      options.onStoryStart?.(i, story);

      story.status = 'in_progress';
      const storyResult: StoryResult = {
        storyId: story.id,
        storyTitle: story.title,
        success: false,
      };

      // Set story context for Development phase
      context.variables.set('currentStory', story);
      context.variables.set('storyIndex', i);
      context.variables.set('totalStories', stories.length);

      // === DEVELOPMENT ===
      if (developmentPhase) {
        console.log(`[Orchestrator] Story ${i + 1}: Running Development...`);
        socketService.toTask(taskId, 'phase:start', {
          phase: 'Development',
          storyId: story.id,
          storyIndex: i,
        });

        try {
          const devResult = await developmentPhase.execute(context);
          storyResult.developmentResult = devResult;
          context.previousResults.set('Development', devResult);

          socketService.toTask(taskId, 'phase:complete', {
            phase: 'Development',
            storyId: story.id,
            success: devResult.success,
            output: devResult.output,
          });

          if (!devResult.success) {
            console.log(`[Orchestrator] Story ${i + 1}: Development failed`);
            story.status = 'failed';
            storyResults.push(storyResult);
            continue; // Move to next story
          }
        } catch (error: any) {
          console.log(`[Orchestrator] Story ${i + 1}: Development error: ${error.message}`);
          story.status = 'failed';
          storyResults.push(storyResult);
          continue;
        }
      }

      // === JUDGE ===
      if (judgePhase) {
        console.log(`[Orchestrator] Story ${i + 1}: Running Judge...`);
        socketService.toTask(taskId, 'phase:start', {
          phase: 'Judge',
          storyId: story.id,
          storyIndex: i,
        });

        try {
          const judgeResult = await judgePhase.execute(context);
          storyResult.judgeResult = judgeResult;
          context.previousResults.set('Judge', judgeResult);

          const verdict = judgeResult.output?.verdict || 'needs_revision';
          story.judgeVerdict = verdict;
          story.judgeScore = judgeResult.output?.score;
          story.judgeIssues = judgeResult.output?.issues;
          storyResult.finalVerdict = verdict;

          socketService.toTask(taskId, 'phase:complete', {
            phase: 'Judge',
            storyId: story.id,
            success: judgeResult.success,
            verdict,
            score: judgeResult.output?.score,
            issues: judgeResult.output?.issues?.length || 0,
          });

          console.log(`[Orchestrator] Story ${i + 1}: Judge verdict = ${verdict} (score: ${judgeResult.output?.score || 'N/A'})`);

          // === FIXER (if needed) ===
          if (verdict !== 'approved' && fixerPhase && judgeResult.output?.issues?.length > 0) {
            console.log(`[Orchestrator] Story ${i + 1}: Running Fixer (${judgeResult.output.issues.length} issues)...`);
            socketService.toTask(taskId, 'phase:start', {
              phase: 'Fixer',
              storyId: story.id,
              storyIndex: i,
              issueCount: judgeResult.output.issues.length,
            });

            try {
              const fixerResult = await fixerPhase.execute(context);
              storyResult.fixerResult = fixerResult;
              context.previousResults.set('Fixer', fixerResult);

              socketService.toTask(taskId, 'phase:complete', {
                phase: 'Fixer',
                storyId: story.id,
                success: fixerResult.success,
                output: fixerResult.output,
              });

              // After fixer, assume story is "fixed" but not re-judged
              if (fixerResult.success) {
                storyResult.finalVerdict = 'approved';
                story.judgeVerdict = 'approved';
              }
            } catch (error: any) {
              console.log(`[Orchestrator] Story ${i + 1}: Fixer error: ${error.message}`);
            }
          }
        } catch (error: any) {
          console.log(`[Orchestrator] Story ${i + 1}: Judge error: ${error.message}`);
        }
      }

      // Mark story complete
      story.status = 'completed';
      storyResult.success = true;
      storyResults.push(storyResult);

      // Emit story complete
      socketService.toTask(taskId, 'story:complete', {
        storyIndex: i,
        storyId: story.id,
        storyTitle: story.title,
        success: storyResult.success,
        verdict: storyResult.finalVerdict,
        totalStories: stories.length,
        completedStories: i + 1,
      });
      options.onStoryComplete?.(i, story, storyResult);

      console.log(`[Orchestrator] Story ${i + 1}/${stories.length} completed: ${story.title}`);
    }

    // Calculate overall success
    const allStoriesSucceeded = storyResults.every(r => r.success);
    const failedStories = storyResults.filter(r => !r.success).length;

    if (failedStories > 0) {
      console.log(`\n[Orchestrator] ${failedStories}/${stories.length} stories failed`);
      success = false;
      lastError = `${failedStories} stories failed`;
    }

    // Update task status
    TaskRepository.updateStatus(taskId, success ? 'completed' : 'failed');

    const duration = Date.now() - startTime;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Orchestrator] Pipeline ${pipelineName} ${success ? 'COMPLETED' : 'FAILED'}`);
    console.log(`  Stories: ${storyResults.filter(r => r.success).length}/${stories.length} succeeded`);
    console.log(`  Duration: ${duration}ms`);
    console.log(`${'='.repeat(60)}`);

    // Push to Sentinental Core for ML training
    sentinentalWebhook.push(taskId).catch(err => {
      console.warn(`[Orchestrator] Failed to push to Sentinental: ${err.message}`);
    });

    // Cleanup task tracking state to prevent memory leaks
    cleanupTaskTracking(taskId);

    return {
      success,
      taskId,
      pipeline: pipelineName,
      phaseResults,
      storyResults,
      error: lastError,
      duration,
    };
  }

  /**
   * Traditional phase execution (fallback when no stories)
   */
  private async executeTraditional(
    taskId: string,
    pipeline: Pipeline,
    context: PhaseContext,
    options: {
      approvalMode?: ApprovalMode;
      onPhaseStart?: (phaseName: string) => void;
      onPhaseComplete?: (phaseName: string, result: PhaseResult) => void;
    },
    phaseResults: Map<string, PhaseResult>,
    startTime: number
  ): Promise<OrchestrationResult> {
    const approvalMode = options.approvalMode || 'automatic';
    let lastError: string | undefined;
    let success = true;

    // Skip Analysis (already done) and execute remaining phases
    const remainingPhases = pipeline.phases.filter(p => p.name !== 'Analysis');

    for (const phase of remainingPhases) {
      console.log(`\n[Orchestrator] Starting phase: ${phase.name}`);
      options.onPhaseStart?.(phase.name);

      socketService.toTask(taskId, 'phase:start', {
        phase: phase.name,
        description: phase.description,
      });

      try {
        const result = await phase.execute(context);
        phaseResults.set(phase.name, result);
        context.previousResults.set(phase.name, result);

        options.onPhaseComplete?.(phase.name, result);

        socketService.toTask(taskId, 'phase:complete', {
          phase: phase.name,
          success: result.success,
          output: result.output,
          metadata: result.metadata,
        });

        if (!result.success) {
          console.log(`[Orchestrator] Phase ${phase.name} failed: ${result.error}`);
          lastError = result.error;
          success = false;
          break;
        }

        if (approvalMode === 'manual') {
          console.log(`[Orchestrator] Waiting for approval on ${phase.name}...`);
          const approved = await approvalService.requestApproval(taskId, phase.name, result.output);
          if (!approved) {
            console.log(`[Orchestrator] Phase ${phase.name} rejected by user`);
            lastError = 'User rejected phase output';
            success = false;
            break;
          }
          console.log(`[Orchestrator] Phase ${phase.name} approved by user`);
        }

        console.log(`[Orchestrator] Phase ${phase.name} completed successfully`);
      } catch (error: any) {
        const result: PhaseResult = {
          success: false,
          output: null,
          error: error.message,
        };
        phaseResults.set(phase.name, result);
        options.onPhaseComplete?.(phase.name, result);

        console.log(`[Orchestrator] Phase ${phase.name} error: ${error.message}`);
        lastError = error.message;
        success = false;
        break;
      }
    }

    TaskRepository.updateStatus(taskId, success ? 'completed' : 'failed');

    const duration = Date.now() - startTime;
    console.log(`\n[Orchestrator] Pipeline ${pipeline.name} ${success ? 'completed' : 'failed'} in ${duration}ms`);

    sentinentalWebhook.push(taskId).catch(err => {
      console.warn(`[Orchestrator] Failed to push to Sentinental: ${err.message}`);
    });

    cleanupTaskTracking(taskId);

    return {
      success,
      taskId,
      pipeline: pipeline.name,
      phaseResults,
      error: lastError,
      duration,
    };
  }

  /**
   * Execute a single phase
   */
  async executePhase(
    taskId: string,
    phase: IPhase,
    options: {
      projectPath?: string;
      repositories?: RepositoryInfo[];
      variables?: Record<string, any>;
      previousResults?: Map<string, PhaseResult>;
      onSessionCreated?: (sessionId: string, phaseName: string) => void;
    } = {}
  ): Promise<PhaseResult> {
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return {
        success: false,
        output: null,
        error: 'Task not found',
      };
    }

    const context: PhaseContext = {
      task,
      projectPath: options.projectPath || process.cwd(),
      repositories: options.repositories || [],
      previousResults: options.previousResults || new Map(),
      variables: new Map(Object.entries(options.variables || {})),
      onSessionCreated: options.onSessionCreated,
    };

    return phase.execute(context);
  }
}

export const orchestrator = new OrchestratorClass();
export default orchestrator;
