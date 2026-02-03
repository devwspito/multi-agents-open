/**
 * Base Phase Interface
 *
 * All orchestration phases implement this interface.
 * Phases are the building blocks of the multi-agent system.
 */

import { AgentExecutionResponse, Task } from '../types/index.js';

/**
 * Phase result returned after execution
 */
export interface PhaseResult {
  success: boolean;
  output: any;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Phase context shared between phases
 */
export interface PhaseContext {
  task: Task;
  projectPath: string;
  previousResults: Map<string, PhaseResult>;
  variables: Map<string, any>;
}

/**
 * Phase configuration
 */
export interface PhaseConfig {
  name: string;
  description?: string;
  agentType: string;
  maxRetries?: number;
  timeout?: number;
}

/**
 * Base phase interface that all phases must implement
 */
export interface IPhase {
  readonly name: string;
  readonly description: string;
  readonly agentType: string;

  /**
   * Execute the phase
   */
  execute(context: PhaseContext): Promise<PhaseResult>;

  /**
   * Validate that the phase can be executed
   */
  validate(context: PhaseContext): Promise<boolean>;

  /**
   * Build the prompt for the agent
   */
  buildPrompt(context: PhaseContext): string;

  /**
   * Process the agent's output
   */
  processOutput(output: AgentExecutionResponse, context: PhaseContext): Promise<PhaseResult>;
}

/**
 * Abstract base class with common functionality
 */
export abstract class BasePhase implements IPhase {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly agentType: string;

  protected config: Partial<PhaseConfig>;

  constructor(config?: Partial<PhaseConfig>) {
    this.config = {
      maxRetries: 3,
      timeout: 300000, // 5 minutes
      ...config,
    };
  }

  /**
   * Get full config with defaults from abstract properties
   */
  protected getConfig(): PhaseConfig {
    return {
      name: this.name,
      agentType: this.agentType,
      maxRetries: 3,
      timeout: 300000,
      ...this.config,
    };
  }

  /**
   * Default validation - always passes
   * Override in subclasses for specific validation
   */
  async validate(context: PhaseContext): Promise<boolean> {
    return true;
  }

  /**
   * Execute the phase with retry logic
   */
  async execute(context: PhaseContext): Promise<PhaseResult> {
    // Import here to avoid circular dependencies
    const { agentExecutor } = await import('../services/agents/AgentExecutorService.js');
    const { toolDefinitions, toolHandlers } = await import('../tools/index.js');

    // Validate
    const isValid = await this.validate(context);
    if (!isValid) {
      return {
        success: false,
        output: null,
        error: `Validation failed for phase ${this.name}`,
      };
    }

    // Build prompt
    const prompt = this.buildPrompt(context);

    let lastError: string | undefined;
    const config = this.getConfig();
    let retries = config.maxRetries || 3;
    const maxRetries = retries;

    while (retries > 0) {
      try {
        console.log(`[${this.name}] Executing (${maxRetries - retries + 1}/${maxRetries})...`);

        const result = await agentExecutor.execute(
          {
            taskId: context.task.id,
            agentType: this.agentType,
            phaseName: this.name,
            prompt,
            systemPrompt: this.getSystemPrompt(),
            tools: toolDefinitions,
            maxTurns: 20,
          },
          { toolHandlers }
        );

        // Process output
        const phaseResult = await this.processOutput(result, context);

        if (phaseResult.success) {
          console.log(`[${this.name}] Completed successfully`);
          return phaseResult;
        }

        lastError = phaseResult.error;
        retries--;

        if (retries > 0) {
          console.log(`[${this.name}] Failed, retrying... (${retries} attempts left)`);
        }
      } catch (error: any) {
        lastError = error.message;
        retries--;

        if (retries > 0) {
          console.log(`[${this.name}] Error: ${error.message}, retrying...`);
        }
      }
    }

    console.log(`[${this.name}] Failed after all retries`);
    return {
      success: false,
      output: null,
      error: lastError || 'Phase failed after all retries',
    };
  }

  /**
   * Default system prompt - override in subclasses
   */
  protected getSystemPrompt(): string {
    return `You are a specialized AI agent performing the "${this.name}" phase of a multi-agent development workflow.

Your role: ${this.description}

Guidelines:
- Focus only on your specific task
- Use the provided tools to accomplish your goals
- Be thorough but efficient
- If you encounter errors, try to fix them
- Output clear, structured results`;
  }

  /**
   * Must be implemented by subclasses
   */
  abstract buildPrompt(context: PhaseContext): string;

  /**
   * Default output processing - override in subclasses
   */
  async processOutput(output: AgentExecutionResponse, context: PhaseContext): Promise<PhaseResult> {
    return {
      success: true,
      output: output.finalOutput,
      metadata: {
        turns: output.turns,
        toolCalls: output.toolCalls.length,
        tokens: output.usage.totalTokens,
      },
    };
  }
}
