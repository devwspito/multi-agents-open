/**
 * Base Phase Interface
 *
 * All orchestration phases implement this interface.
 * Phases are the building blocks of the multi-agent system.
 *
 * NOW POWERED BY OPENCODE SDK
 * - OpenCode handles: LLM calls, tools, retries, context management
 * - We handle: Orchestration, tracking, security monitoring
 */

import { Task, RepositoryInfo } from '../types/index.js';
import { openCodeClient, OpenCodeEvent } from '../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../services/opencode/OpenCodeEventBridge.js';
import { executionTracker } from '../services/training/ExecutionTracker.js';
import { agentSpy, Vulnerability } from '../services/security/AgentSpy.js';
import {
  sentinentalWebhook,
  ExecutionContext,
  ProjectContext,
  CodeContext,
  TaskHistory,
} from '../services/training/SentinentalWebhook.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase execution result - simplified for OpenCode
 */
export interface PhaseResult {
  success: boolean;
  output: any;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * OpenCode execution result (from event processing)
 */
export interface OpenCodeExecutionResult {
  sessionId: string;
  finalOutput: string;
  turns: number;
  toolCalls: Array<{
    toolName: string;
    toolInput: any;
    toolOutput?: any;
    success: boolean;
  }>;
  events: OpenCodeEvent[];
  vulnerabilities: Vulnerability[];
}

/**
 * Phase context shared between phases
 */
export interface PhaseContext {
  task: Task;
  projectPath: string;
  /** All repositories for this project with their types */
  repositories: RepositoryInfo[];
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

// ============================================
// PLATINO TRACE: Task-level tracking
// ============================================

/**
 * Track completed phases and vulnerabilities across a task
 * Used to detect recurring patterns and build TaskHistory
 */
interface TaskTrackingState {
  taskStartTime: number;
  completedPhases: Array<{
    name: string;
    success: boolean;
    vulnerabilitiesDetected: number;
  }>;
  allVulnerabilities: Array<{
    type: string;
    severity: string;
    phase: string;
    wasBlocked: boolean;
    wasFixed: boolean;
  }>;
  totalToolCalls: number;
  totalTurns: number;
  retryCount: number;
}

/** Global task tracking state */
const taskTrackingStates = new Map<string, TaskTrackingState>();

/**
 * Get or create task tracking state
 */
function getTaskTrackingState(taskId: string): TaskTrackingState {
  if (!taskTrackingStates.has(taskId)) {
    taskTrackingStates.set(taskId, {
      taskStartTime: Date.now(),
      completedPhases: [],
      allVulnerabilities: [],
      totalToolCalls: 0,
      totalTurns: 0,
      retryCount: 0,
    });
  }
  return taskTrackingStates.get(taskId)!;
}

/**
 * Update task tracking after phase completion
 */
function updateTaskTracking(
  taskId: string,
  phaseName: string,
  success: boolean,
  vulnerabilities: Vulnerability[],
  toolCalls: number,
  turns: number
): void {
  const state = getTaskTrackingState(taskId);

  state.completedPhases.push({
    name: phaseName,
    success,
    vulnerabilitiesDetected: vulnerabilities.length,
  });

  for (const v of vulnerabilities) {
    state.allVulnerabilities.push({
      type: v.type,
      severity: v.severity,
      phase: phaseName,
      wasBlocked: v.blocked,
      wasFixed: false, // Will be updated if same pattern doesn't recur
    });
  }

  state.totalToolCalls += toolCalls;
  state.totalTurns += turns;
}

/**
 * Build TaskHistory from tracking state
 */
function buildTaskHistory(taskId: string, currentVulnerabilities: Vulnerability[]): TaskHistory {
  const state = getTaskTrackingState(taskId);

  // Check for recurring patterns
  const currentTypes = new Set(currentVulnerabilities.map(v => v.type));
  const previousTypes = new Set(state.allVulnerabilities.map(v => v.type));
  const recurringTypes = [...currentTypes].filter(t => previousTypes.has(t));

  return {
    completedPhases: state.completedPhases,
    previousVulnerabilities: state.allVulnerabilities,
    isRecurring: recurringTypes.length > 0,
    recurrenceCount: recurringTypes.length,
    retryCount: state.retryCount,
    taskElapsedMs: Date.now() - state.taskStartTime,
    totalToolCalls: state.totalToolCalls,
    totalTurns: state.totalTurns,
  };
}

/**
 * Clean up task tracking state
 */
export function cleanupTaskTracking(taskId: string): void {
  taskTrackingStates.delete(taskId);
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
   * Process the OpenCode execution result
   */
  processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult>;
}

/**
 * Abstract base class with OpenCode integration
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

  // ============================================
  // PLATINO TRACE: Context extraction methods
  // ============================================

  /**
   * Extract ProjectContext from the project path
   * Reads package.json, requirements.txt, Cargo.toml, etc.
   */
  protected extractProjectContext(projectPath: string): ProjectContext | undefined {
    try {
      const context: ProjectContext = {
        language: 'unknown',
        dependencies: [],
      };

      // Check for Node.js project
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        context.language = 'javascript';
        context.packageManager = 'npm';
        context.projectType = packageJson.main?.includes('cli') ? 'cli' : 'unknown';

        // Extract framework
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps['express']) context.framework = 'express';
        else if (deps['fastify']) context.framework = 'fastify';
        else if (deps['react']) context.framework = 'react';
        else if (deps['vue']) context.framework = 'vue';
        else if (deps['next']) context.framework = 'next';

        // Extract key security-relevant dependencies
        const securityRelevant = [
          'bcrypt', 'jsonwebtoken', 'passport', 'helmet', 'cors',
          'express-validator', 'joi', 'yup', 'zod',
          'sequelize', 'mongoose', 'prisma', 'typeorm',
        ];

        for (const dep of securityRelevant) {
          if (deps[dep]) {
            context.dependencies.push({
              name: dep,
              version: deps[dep].replace(/[\^~]/, ''),
            });
          }
        }

        // Check for TypeScript
        if (deps['typescript'] || fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
          context.language = 'typescript';
        }

        // Build tools
        context.buildTools = [];
        if (deps['webpack']) context.buildTools.push('webpack');
        if (deps['vite']) context.buildTools.push('vite');
        if (deps['esbuild']) context.buildTools.push('esbuild');
        if (deps['rollup']) context.buildTools.push('rollup');

        // Runtime version detection
        if (packageJson.engines?.node) {
          context.runtimeVersion = `node ${packageJson.engines.node}`;
        } else {
          // Check .nvmrc
          const nvmrcPath = path.join(projectPath, '.nvmrc');
          if (fs.existsSync(nvmrcPath)) {
            const nvmrc = fs.readFileSync(nvmrcPath, 'utf-8').trim();
            context.runtimeVersion = `node ${nvmrc}`;
          }
          // Check .node-version
          const nodeVersionPath = path.join(projectPath, '.node-version');
          if (fs.existsSync(nodeVersionPath)) {
            const nodeVersion = fs.readFileSync(nodeVersionPath, 'utf-8').trim();
            context.runtimeVersion = `node ${nodeVersion}`;
          }
        }

        return context;
      }

      // Check for Python project
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      if (fs.existsSync(requirementsPath) || fs.existsSync(pyprojectPath)) {
        context.language = 'python';
        context.packageManager = 'pip';

        if (fs.existsSync(requirementsPath)) {
          const requirements = fs.readFileSync(requirementsPath, 'utf-8');
          const securityRelevant = [
            'django', 'flask', 'fastapi', 'sqlalchemy', 'pyjwt',
            'bcrypt', 'cryptography', 'requests', 'httpx',
          ];

          for (const line of requirements.split('\n')) {
            const match = line.match(/^([a-zA-Z0-9_-]+)([=<>!]+.*)?$/);
            if (match && securityRelevant.includes(match[1].toLowerCase())) {
              context.dependencies.push({
                name: match[1],
                version: match[2]?.replace(/[=<>!]+/, '') || undefined,
              });
              if (['django', 'flask', 'fastapi'].includes(match[1].toLowerCase())) {
                context.framework = match[1].toLowerCase();
              }
            }
          }
        }

        // Python runtime version detection
        const pythonVersionPath = path.join(projectPath, '.python-version');
        if (fs.existsSync(pythonVersionPath)) {
          const pyVersion = fs.readFileSync(pythonVersionPath, 'utf-8').trim();
          context.runtimeVersion = `python ${pyVersion}`;
        }
        // Check pyproject.toml for python version
        if (fs.existsSync(pyprojectPath)) {
          const pyproject = fs.readFileSync(pyprojectPath, 'utf-8');
          const versionMatch = pyproject.match(/python\s*=\s*["']([^"']+)["']/);
          if (versionMatch) {
            context.runtimeVersion = `python ${versionMatch[1]}`;
          }
        }

        return context;
      }

      // Check for Rust project
      const cargoPath = path.join(projectPath, 'Cargo.toml');
      if (fs.existsSync(cargoPath)) {
        context.language = 'rust';
        context.packageManager = 'cargo';
        return context;
      }

      // Check for Go project
      const goModPath = path.join(projectPath, 'go.mod');
      if (fs.existsSync(goModPath)) {
        context.language = 'go';
        context.packageManager = 'go';
        return context;
      }

      return context.language !== 'unknown' ? context : undefined;
    } catch (error) {
      console.warn(`[Phase] Failed to extract project context: ${error}`);
      return undefined;
    }
  }

  /**
   * Extract CodeContext from a file operation tool call
   * Provides expanded code around the vulnerable area
   */
  protected extractCodeContext(
    toolName: string,
    toolInput: any,
    toolOutput: any,
    projectPath: string
  ): CodeContext | undefined {
    try {
      // Only extract for file-related tools
      if (!['Read', 'Edit', 'Write', 'Grep'].includes(toolName)) {
        return undefined;
      }

      const filePath = toolInput?.file_path || toolInput?.path;
      if (!filePath) return undefined;

      // Resolve to absolute path if relative
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(projectPath, filePath);

      if (!fs.existsSync(absolutePath)) return undefined;

      const fileContent = fs.readFileSync(absolutePath, 'utf-8');
      const lines = fileContent.split('\n');

      // Default context - show first 50 lines if no specific line
      let targetLine = 0;
      const contextLines = 10;

      // Try to extract line number from various sources
      if (toolInput?.line_number) {
        targetLine = toolInput.line_number - 1;
      } else if (toolInput?.offset) {
        targetLine = toolInput.offset - 1;
      } else if (toolInput?.old_string && typeof toolInput.old_string === 'string') {
        // Find the line containing the old_string
        const idx = lines.findIndex(l => l.includes(toolInput.old_string.split('\n')[0]));
        if (idx >= 0) targetLine = idx;
      }

      // Extract surrounding lines
      const startLine = Math.max(0, targetLine - contextLines);
      const endLine = Math.min(lines.length - 1, targetLine + contextLines);

      // Extract imports (first 30 lines typically)
      const imports = lines.slice(0, 30).filter(l =>
        l.match(/^(import |from |require\(|use |#include|using )/)
      );

      // Try to find containing function/class
      let containingFunction: string | undefined;
      let containingClass: string | undefined;

      for (let i = targetLine; i >= 0; i--) {
        const line = lines[i];
        if (!containingFunction) {
          const fnMatch = line.match(/(?:function|def|fn|func|async)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
          const arrowMatch = line.match(/(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(/);
          if (fnMatch) containingFunction = fnMatch[1];
          else if (arrowMatch) containingFunction = arrowMatch[1];
        }
        if (!containingClass) {
          const classMatch = line.match(/(?:class|struct|interface)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (classMatch) containingClass = classMatch[1];
        }
        if (containingFunction && containingClass) break;
      }

      // Detect related files from imports
      const relatedFiles: string[] = [];
      const fileDir = path.dirname(absolutePath);

      for (const importLine of imports) {
        // Match various import patterns
        // TypeScript/JavaScript: import x from './file' or require('./file')
        const jsMatch = importLine.match(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/);
        // Python: from module import x or import module
        const pyMatch = importLine.match(/(?:from\s+|import\s+)([a-zA-Z_][a-zA-Z0-9_.]*)/);

        let importPath: string | null = null;
        if (jsMatch && jsMatch[1].startsWith('.')) {
          importPath = jsMatch[1];
        } else if (pyMatch) {
          importPath = pyMatch[1].replace(/\./g, '/');
        }

        if (importPath) {
          // Resolve to absolute path
          const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', ''];
          for (const ext of extensions) {
            const resolvedPath = path.resolve(fileDir, importPath + ext);
            if (fs.existsSync(resolvedPath)) {
              // Store relative path from project root
              relatedFiles.push(resolvedPath);
              break;
            }
            // Check for index file
            const indexPath = path.resolve(fileDir, importPath, 'index' + ext);
            if (fs.existsSync(indexPath)) {
              relatedFiles.push(indexPath);
              break;
            }
          }
        }
      }

      return {
        fileContent: fileContent.length > 10240 ? fileContent.slice(0, 10240) + '\n... (truncated)' : fileContent,
        linesBefore: lines.slice(startLine, targetLine),
        vulnerableLines: [lines[targetLine] || ''],
        linesAfter: lines.slice(targetLine + 1, endLine + 1),
        imports,
        containingFunction,
        containingClass,
        relatedFiles: relatedFiles.length > 0 ? relatedFiles.slice(0, 10) : undefined, // Limit to 10
      };
    } catch (error) {
      console.warn(`[Phase] Failed to extract code context: ${error}`);
      return undefined;
    }
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
   * Execute the phase using OpenCode SDK
   *
   * Flow:
   * 1. Validate phase can run
   * 2. Create OpenCode session
   * 3. Send prompt with system context
   * 4. Subscribe to events (track + security monitor)
   * 5. Wait for completion
   * 6. Process results
   */
  async execute(context: PhaseContext): Promise<PhaseResult> {
    // Validate
    const isValid = await this.validate(context);
    if (!isValid) {
      return {
        success: false,
        output: null,
        error: `Validation failed for phase ${this.name}`,
      };
    }

    // Ensure OpenCode is connected
    if (!openCodeClient.isConnected()) {
      await openCodeClient.connect();
    }

    // Build prompt with system context
    const userPrompt = this.buildPrompt(context);
    const systemPrompt = this.getSystemPrompt();
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const config = this.getConfig();
    let retries = config.maxRetries || 3;
    const maxRetries = retries;
    let lastError: string | undefined;

    while (retries > 0) {
      try {
        console.log(`[${this.name}] Executing via OpenCode (${maxRetries - retries + 1}/${maxRetries})...`);

        const result = await this.executeWithOpenCode(context, fullPrompt);

        // Check for blocking vulnerabilities
        const blockedVulns = result.vulnerabilities.filter(v => agentSpy.shouldBlock(v));
        if (blockedVulns.length > 0) {
          console.log(`[${this.name}] Blocked due to security vulnerabilities`);
          return {
            success: false,
            output: null,
            error: `Security violation: ${blockedVulns.map(v => v.description).join(', ')}`,
            metadata: { vulnerabilities: blockedVulns },
          };
        }

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
   * Execute using OpenCode SDK with full tracking
   * CRITICAL: Captures execution context for Sentinental when vulnerabilities detected
   */
  private async executeWithOpenCode(
    context: PhaseContext,
    prompt: string
  ): Promise<OpenCodeExecutionResult> {
    const startTime = Date.now();
    const { task } = context;

    // Start execution tracking
    const executionId = executionTracker.startExecution({
      taskId: task.id,
      agentType: this.agentType,
      modelId: 'opencode', // OpenCode manages the model
      phaseName: this.name,
      prompt,
    });

    // Create OpenCode session with the correct working directory
    // CRITICAL: projectPath is where the user's repo was cloned
    const workingDirectory = context.projectPath;
    console.log(`[${this.name}] Using working directory: ${workingDirectory}`);

    const sessionId = await openCodeClient.createSession({
      title: `${this.name} - ${task.title}`,
      directory: workingDirectory,
    });

    console.log(`[${this.name}] Created session: ${sessionId}`);

    // CRITICAL: Register session for event forwarding to frontend
    openCodeEventBridge.registerSession(task.id, sessionId);

    // Send prompt with the same directory
    await openCodeClient.sendPrompt(sessionId, prompt, {
      directory: workingDirectory,
    });

    // ========================================
    // EXECUTION STATE for Sentinental context
    // ========================================
    const executionState = {
      prompt,
      turns: 0,
      toolCalls: [] as Array<{
        toolName: string;
        toolInput: any;
        toolOutput?: any;
        success: boolean;
        timestamp: string;
      }>,
      partialOutput: '',
    };

    // ========================================
    // PLATINO TRACE: Extract project context
    // ========================================
    const projectContext = this.extractProjectContext(context.projectPath);
    if (projectContext) {
      console.log(`[${this.name}] Project: ${projectContext.language}/${projectContext.framework || 'none'}`);
    }

    // Track latest code context for vulnerability reporting
    let latestCodeContext: CodeContext | undefined;

    // Collect events and track
    const events: OpenCodeEvent[] = [];
    const toolCalls: OpenCodeExecutionResult['toolCalls'] = [];
    const vulnerabilities: Vulnerability[] = [];

    try {
      // Wait for completion while tracking events
      const allEvents = await openCodeClient.waitForIdle(sessionId, {
        timeout: this.config.timeout || 300000,
        onEvent: (event) => {
          events.push(event);

          // Update execution state for context capture
          if (event.type === 'message.part.updated') {
            const part = event.properties?.part;
            if (part?.type === 'text') {
              executionState.partialOutput = part.text || executionState.partialOutput;
            }
          }

          // Track tool calls with timestamps
          if (event.type === 'tool.execute.before') {
            executionState.turns++;
            executionTracker.startTurn(task.id, 'assistant');
            executionTracker.startToolCall(task.id, {
              toolName: event.properties?.tool,
              toolUseId: event.properties?.id || `tc_${Date.now()}`,
              toolInput: event.properties?.args,
            });

            // Add to state (will be completed when after event arrives)
            executionState.toolCalls.push({
              toolName: event.properties?.tool,
              toolInput: event.properties?.args,
              success: true, // Will update on completion
              timestamp: new Date().toISOString(),
            });
          }

          if (event.type === 'tool.execute.after') {
            const toolUseId = event.properties?.id || `tc_${Date.now()}`;
            const hasError = !!event.properties?.error;
            const toolName = event.properties?.tool;
            const toolInput = event.properties?.args;
            const toolOutput = event.properties?.result;

            executionTracker.completeToolCall(task.id, {
              toolUseId,
              toolOutput,
              toolSuccess: !hasError,
              toolError: event.properties?.error,
            });

            // Update the last tool call in state
            const lastToolCall = executionState.toolCalls[executionState.toolCalls.length - 1];
            if (lastToolCall) {
              lastToolCall.toolOutput = toolOutput;
              lastToolCall.success = !hasError;
            }

            toolCalls.push({
              toolName,
              toolInput,
              toolOutput,
              success: !hasError,
            });

            // ========================================
            // PLATINO TRACE: Extract code context from file ops
            // ========================================
            if (['Read', 'Edit', 'Write', 'Grep'].includes(toolName || '')) {
              const codeCtx = this.extractCodeContext(
                toolName || '',
                toolInput,
                toolOutput,
                context.projectPath
              );
              if (codeCtx) {
                latestCodeContext = codeCtx;
              }
            }
          }

          // ========================================
          // SECURITY ANALYSIS + SENTINENTAL PUSH
          // ========================================
          this.trackEventWithContext(
            event,
            task.id,
            sessionId,
            vulnerabilities,
            executionState,
            startTime,
            context.projectPath,
            projectContext,
            latestCodeContext
          );
        },
      });

      // Complete tracking
      executionTracker.completeExecution(task.id, {
        finalOutput: executionState.partialOutput,
        inputTokens: 0, // OpenCode doesn't expose tokens (it's managed internally)
        outputTokens: 0,
        costUsd: 0, // Cost is managed by OpenCode/provider
      });

      // ========================================
      // PLATINO TRACE: Update task tracking state
      // ========================================
      updateTaskTracking(
        task.id,
        this.name,
        vulnerabilities.length === 0 || !vulnerabilities.some(v => v.blocked),
        vulnerabilities,
        toolCalls.length,
        executionState.turns
      );

      console.log(`[${this.name}] Session completed - ${executionState.turns} turns, ${toolCalls.length} tool calls`);

      // Unregister session from event bridge
      openCodeEventBridge.unregisterSession(sessionId);

      return {
        sessionId,
        finalOutput: executionState.partialOutput,
        turns: executionState.turns,
        toolCalls,
        events,
        vulnerabilities,
      };
    } catch (error: any) {
      // Unregister session on error too
      openCodeEventBridge.unregisterSession(sessionId);
      executionTracker.failExecution(task.id, error.message, 'opencode_error');
      throw error;
    }
  }

  /**
   * Track an event for ML training and security
   * PUSHES TO SENTINENTAL with full PLATINO context when vulnerabilities detected
   */
  private trackEventWithContext(
    event: OpenCodeEvent,
    taskId: string,
    sessionId: string,
    vulnerabilities: Vulnerability[],
    executionState: {
      prompt: string;
      turns: number;
      toolCalls: Array<{
        toolName: string;
        toolInput: any;
        toolOutput?: any;
        success: boolean;
        timestamp: string;
      }>;
      partialOutput: string;
    },
    startTime: number,
    projectPath: string,
    projectContext?: ProjectContext,
    codeContext?: CodeContext
  ): void {
    // Run security analysis
    const detected = agentSpy.analyze(event, {
      taskId,
      sessionId,
      phase: this.name,
    });

    if (detected.length > 0) {
      vulnerabilities.push(...detected);

      // Log detections
      for (const v of detected) {
        console.log(`[AgentSpy] ${v.severity.toUpperCase()}: ${v.description}`);
        if (v.owaspCategory) console.log(`  OWASP: ${v.owaspCategory}`);
        if (v.cweId) console.log(`  CWE: ${v.cweId}`);
      }

      // ========================================
      // BUILD EXECUTION CONTEXT FOR SENTINENTAL
      // ========================================
      const executionContext: ExecutionContext = {
        prompt: executionState.prompt,
        turnNumber: executionState.turns,
        toolCalls: [...executionState.toolCalls], // Copy current state
        triggerEvent: {
          type: event.type,
          tool: event.properties?.tool,
          args: event.properties?.args,
          result: event.properties?.result,
          messageContent: event.properties?.part?.text,
        },
        partialOutput: executionState.partialOutput,
        elapsedMs: Date.now() - startTime,
      };

      // ========================================
      // BUILD PLATINO TRACE CONTEXT
      // ========================================
      const taskHistory = buildTaskHistory(taskId, detected);

      // Try to enrich code context from the vulnerability itself
      let enrichedCodeContext = codeContext;
      if (!enrichedCodeContext && event.properties?.tool) {
        enrichedCodeContext = this.extractCodeContext(
          event.properties.tool,
          event.properties.args,
          event.properties.result,
          projectPath
        );
      }

      // PUSH TO SENTINENTAL IMMEDIATELY with PLATINO context
      sentinentalWebhook.pushSecurityData(
        taskId,
        sessionId,
        this.name,
        detected,
        executionContext,
        { agentType: this.agentType, modelId: 'opencode' },
        {
          projectContext,
          codeContext: enrichedCodeContext,
          taskHistory,
        }
      ).catch(err => {
        console.warn(`[Sentinental] Failed to push: ${err.message}`);
      });
    }
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
  async processOutput(result: OpenCodeExecutionResult, context: PhaseContext): Promise<PhaseResult> {
    return {
      success: true,
      output: result.finalOutput,
      metadata: {
        sessionId: result.sessionId,
        turns: result.turns,
        toolCalls: result.toolCalls.length,
        vulnerabilities: result.vulnerabilities.length,
      },
    };
  }
}
