/**
 * Orchestrator
 *
 * Coordinates the execution of multiple phases in sequence.
 * Routes tasks through the appropriate pipeline.
 * Automatically pushes completed data to Sentinental Core for ML training.
 */

import { IPhase, PhaseContext, PhaseResult, cleanupTaskTracking } from './Phase.js';
import { Task, TaskStatus } from '../types/index.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { sentinentalWebhook } from '../services/training/index.js';

/**
 * Pipeline definition
 */
export interface Pipeline {
  name: string;
  description: string;
  phases: IPhase[];
}

/**
 * Orchestration result
 */
export interface OrchestrationResult {
  success: boolean;
  taskId: string;
  pipeline: string;
  phaseResults: Map<string, PhaseResult>;
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
   * Execute a task through a pipeline
   */
  async execute(
    taskId: string,
    pipelineName: string,
    options: {
      projectPath?: string;
      variables?: Record<string, any>;
      onPhaseStart?: (phaseName: string) => void;
      onPhaseComplete?: (phaseName: string, result: PhaseResult) => void;
    } = {}
  ): Promise<OrchestrationResult> {
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

    // Create context
    const context: PhaseContext = {
      task,
      projectPath: options.projectPath || process.cwd(),
      previousResults: new Map(),
      variables: new Map(Object.entries(options.variables || {})),
    };

    const phaseResults = new Map<string, PhaseResult>();
    let lastError: string | undefined;
    let success = true;

    // Execute phases in sequence
    for (const phase of pipeline.phases) {
      console.log(`\n[Orchestrator] Starting phase: ${phase.name}`);
      options.onPhaseStart?.(phase.name);

      try {
        const result = await phase.execute(context);
        phaseResults.set(phase.name, result);
        context.previousResults.set(phase.name, result);

        options.onPhaseComplete?.(phase.name, result);

        if (!result.success) {
          console.log(`[Orchestrator] Phase ${phase.name} failed: ${result.error}`);
          lastError = result.error;
          success = false;
          break;
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

    // Update task status
    TaskRepository.updateStatus(taskId, success ? 'completed' : 'failed');

    const duration = Date.now() - startTime;
    console.log(`\n[Orchestrator] Pipeline ${pipelineName} ${success ? 'completed' : 'failed'} in ${duration}ms`);

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
      variables?: Record<string, any>;
      previousResults?: Map<string, PhaseResult>;
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
      previousResults: options.previousResults || new Map(),
      variables: new Map(Object.entries(options.variables || {})),
    };

    return phase.execute(context);
  }
}

export const orchestrator = new OrchestratorClass();
export default orchestrator;
