/**
 * Phase Tracker
 *
 * Shared utilities for tracking events, vulnerabilities, and security analysis
 * across all phases. Integrates with AgentSpy and Sentinental.
 *
 * This ensures consistent tracking regardless of which phase is executing.
 */

import { agentSpy, Vulnerability } from '../services/security/AgentSpy.js';
import { openCodeEventBridge } from '../services/opencode/OpenCodeEventBridge.js';
import { executionTracker } from '../services/training/ExecutionTracker.js';
import {
  sentinentalWebhook,
  ExecutionContext,
  ProjectContext,
  CodeContext,
  TaskHistory,
} from '../services/training/SentinentalWebhook.js';
import { OpenCodeEvent } from '../services/opencode/OpenCodeClient.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Context for tracking a phase execution
 */
export interface PhaseTrackingContext {
  taskId: string;
  sessionId: string;
  phaseName: string;
  projectPath: string;
  startTime: number;
}

/**
 * State accumulated during phase execution
 */
export interface PhaseTrackingState {
  events: OpenCodeEvent[];
  vulnerabilities: Vulnerability[];
  toolCalls: Array<{
    toolName: string;
    toolInput: any;
    toolOutput?: any;
    success: boolean;
    timestamp: string;
    /** 🔥 CAUSALITY: Tool use ID for linking vulnerabilities to specific tool calls */
    toolUseId?: string;
  }>;
  turns: number;
  partialOutput: string;
}

/**
 * Task-level tracking state (persists across phases)
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
 * Clean up task tracking state
 */
export function cleanupTaskTracking(taskId: string): void {
  taskTrackingStates.delete(taskId);
  agentSpy.clear(taskId);
  // Clean up EventBridge sessions for this task
  openCodeEventBridge.unregisterTaskSessions(taskId);
}

/**
 * Create a new tracking state for a phase
 */
export function createTrackingState(): PhaseTrackingState {
  return {
    events: [],
    vulnerabilities: [],
    toolCalls: [],
    turns: 0,
    partialOutput: '',
  };
}

/**
 * Process an OpenCode event and track it
 * Call this for every event received during waitForIdle
 */
export async function trackEvent(
  event: OpenCodeEvent,
  context: PhaseTrackingContext,
  state: PhaseTrackingState
): Promise<void> {
  state.events.push(event);

  // Update partial output
  if (event.type === 'message.part.updated') {
    const part = event.properties?.part;
    if (part?.type === 'text') {
      state.partialOutput = part.text || state.partialOutput;
    }
  }

  // 🔥 CAUSALITY: Extract tool_use_id for linking vulnerabilities to tool calls
  const toolUseId = event.properties?.tool_use_id || event.properties?.id;

  // Track tool calls
  if (event.type === 'tool.execute.before') {
    state.turns++;
    state.toolCalls.push({
      toolName: event.properties?.tool,
      toolInput: event.properties?.args,
      toolUseId, // 🔥 Store for causality
      success: true,
      timestamp: new Date().toISOString(),
    });
  }

  if (event.type === 'tool.execute.after') {
    const lastToolCall = state.toolCalls[state.toolCalls.length - 1];
    if (lastToolCall) {
      lastToolCall.toolOutput = event.properties?.result;
      lastToolCall.success = !event.properties?.error;
    }
  }

  // === SECURITY ANALYSIS ===
  // 🔥 Pass toolUseId for EXACT causality linking
  const vulnerabilities = await agentSpy.analyze(event, {
    taskId: context.taskId,
    sessionId: context.sessionId,
    phase: context.phaseName,
    toolUseId, // 🔥 CAUSALITY: Links vulnerability directly to tool_calls table
    turnNumber: state.turns,
  });

  if (vulnerabilities.length > 0) {
    state.vulnerabilities.push(...vulnerabilities);

    // Push to Sentinental immediately for critical vulnerabilities
    for (const vuln of vulnerabilities) {
      if (vuln.severity === 'critical' || vuln.severity === 'high') {
        await pushVulnerabilityToSentinental(context, state, vuln);
      }
    }
  }
}

/**
 * Complete phase tracking and push final data to Sentinental
 */
export async function completePhaseTracking(
  context: PhaseTrackingContext,
  state: PhaseTrackingState,
  success: boolean
): Promise<void> {
  // Update task-level tracking
  const taskState = getTaskTrackingState(context.taskId);

  taskState.completedPhases.push({
    name: context.phaseName,
    success,
    vulnerabilitiesDetected: state.vulnerabilities.length,
  });

  for (const v of state.vulnerabilities) {
    taskState.allVulnerabilities.push({
      type: v.type,
      severity: v.severity,
      phase: context.phaseName,
      wasBlocked: v.blocked,
      wasFixed: false,
    });
  }

  taskState.totalToolCalls += state.toolCalls.length;
  taskState.totalTurns += state.turns;

  // Build task history
  const taskHistory = buildTaskHistory(context.taskId, state.vulnerabilities);

  // Extract project context
  const projectContext = extractProjectContext(context.projectPath);

  // Push to Sentinental (using correct method signature)
  await sentinentalWebhook.pushSecurityData(
    context.taskId,
    context.sessionId,
    context.phaseName,
    state.vulnerabilities,
    {
      prompt: '',
      turnNumber: state.turns,
      toolCalls: state.toolCalls,
      triggerEvent: { type: 'phase_complete' },
      partialOutput: state.partialOutput,
      elapsedMs: Date.now() - context.startTime,
    },
    undefined, // meta
    {
      projectContext,
      taskHistory,
    }
  );

  console.log(`[PhaseTracker] Phase ${context.phaseName} completed. Vulnerabilities: ${state.vulnerabilities.length}`);
}

/**
 * Check if any vulnerabilities should block execution
 */
export function hasBlockingVulnerabilities(state: PhaseTrackingState): boolean {
  return state.vulnerabilities.some(v => agentSpy.shouldBlock(v));
}

/**
 * Get blocking vulnerabilities
 */
export function getBlockingVulnerabilities(state: PhaseTrackingState): Vulnerability[] {
  return state.vulnerabilities.filter(v => agentSpy.shouldBlock(v));
}

// === Helper Functions ===

function buildTaskHistory(taskId: string, currentVulnerabilities: Vulnerability[]): TaskHistory {
  const state = getTaskTrackingState(taskId);

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

async function pushVulnerabilityToSentinental(
  context: PhaseTrackingContext,
  state: PhaseTrackingState,
  vulnerability: Vulnerability
): Promise<void> {
  const projectContext = extractProjectContext(context.projectPath);

  await sentinentalWebhook.pushSecurityData(
    context.taskId,
    context.sessionId,
    context.phaseName,
    [vulnerability],
    {
      prompt: '',
      turnNumber: state.turns,
      toolCalls: state.toolCalls.slice(-5), // Last 5 tool calls for context
      triggerEvent: { type: 'vulnerability_detected' },
      partialOutput: state.partialOutput.slice(-1000), // Last 1000 chars
      elapsedMs: Date.now() - context.startTime,
    },
    undefined, // meta
    {
      projectContext,
    }
  );
}

function extractProjectContext(projectPath: string): ProjectContext | undefined {
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

      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (deps['express']) context.framework = 'express';
      else if (deps['fastify']) context.framework = 'fastify';
      else if (deps['react']) context.framework = 'react';
      else if (deps['next']) context.framework = 'next';

      if (deps['typescript'] || fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
        context.language = 'typescript';
      }

      return context;
    }

    // Check for Python project
    const requirementsPath = path.join(projectPath, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      context.language = 'python';
      context.packageManager = 'pip';
      return context;
    }

    return context;
  } catch {
    return undefined;
  }
}
