/**
 * Training Export Service
 *
 * Exports granular execution data in clean JSON/JSONL format
 * ready for ML training on NVIDIA DGX Spark.
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository.js';
import { AgentTurnRepository, IAgentTurn } from '../../database/repositories/AgentTurnRepository.js';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository.js';
import fs from 'fs';
import path from 'path';

/**
 * Training data structure for a single task
 * This is what gets sent to DGX Spark for training
 */
export interface TrainingDataRecord {
  id: string;
  taskId: string;
  exportedAt: string;
  version: string;

  summary: {
    totalExecutions: number;
    totalTurns: number;
    totalToolCalls: number;
    totalCost: number;
    totalTokens: number;
    totalDurationMs: number;
    status: 'completed' | 'partial' | 'failed';
  };

  executions: Array<{
    id: string;
    agentType: string;
    modelId: string;
    phaseName?: string;
    prompt: string;
    finalOutput?: string;
    status: string;
    durationMs?: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turnsCompleted: number;
  }>;

  turns: Array<{
    id: string;
    executionId: string;
    turnNumber: number;
    turnType: string;
    messageContent?: string;
    hasToolCalls: boolean;
    toolCallsCount: number;
    inputTokens: number;
    outputTokens: number;
  }>;

  toolCalls: Array<{
    id: string;
    executionId: string;
    turnId: string;
    toolName: string;
    toolInput: any;
    toolInputSummary?: string;
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    filePath?: string;
    bashCommand?: string;
    bashExitCode?: number;
    durationMs?: number;
    callOrder: number;
  }>;
}

export interface ExportOptions {
  startDate?: string;
  endDate?: string;
  status?: 'completed' | 'failed' | 'all';
  limit?: number;
  offset?: number;
}

class TrainingExportServiceClass {
  private readonly VERSION = '2.0.0';

  /**
   * Export training data for a single task
   */
  async exportTask(taskId: string): Promise<TrainingDataRecord> {
    const executions = AgentExecutionRepository.findByTaskId(taskId);
    const turns = AgentTurnRepository.findByTaskId(taskId);
    const toolCalls = ToolCallRepository.findByTaskId(taskId);

    const summary = this.calculateSummary(executions, turns, toolCalls);

    return {
      id: this.generateExportId(),
      taskId,
      exportedAt: new Date().toISOString(),
      version: this.VERSION,
      summary,
      executions: executions.map(e => this.mapExecution(e)),
      turns: turns.map(t => this.mapTurn(t)),
      toolCalls: toolCalls.map(tc => this.mapToolCall(tc)),
    };
  }

  /**
   * Export multiple tasks as JSONL (JSON Lines) for streaming to DGX
   */
  async exportAsJSONL(options: ExportOptions = {}): Promise<string> {
    const executions = AgentExecutionRepository.findForTraining({
      startDate: options.startDate,
      endDate: options.endDate,
      status: options.status === 'all' ? undefined : options.status,
      limit: options.limit,
      offset: options.offset,
    });

    const taskIds = new Set(executions.map(e => e.taskId));
    const records: string[] = [];

    for (const taskId of taskIds) {
      try {
        const record = await this.exportTask(taskId);
        records.push(JSON.stringify(record));
      } catch (error: any) {
        console.warn(`[TrainingExport] Failed to export task ${taskId}: ${error.message}`);
      }
    }

    return records.join('\n');
  }

  /**
   * Export to file
   */
  async exportToFile(taskId: string, outputPath: string): Promise<void> {
    const record = await this.exportTask(taskId);
    const dir = path.dirname(outputPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(record, null, 2));
    console.log(`[TrainingExport] Exported task ${taskId} to ${outputPath}`);
  }

  /**
   * Export batch to JSONL file
   */
  async exportBatchToFile(options: ExportOptions, outputPath: string): Promise<number> {
    const jsonl = await this.exportAsJSONL(options);
    const dir = path.dirname(outputPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, jsonl);
    const count = jsonl.split('\n').filter(Boolean).length;
    console.log(`[TrainingExport] Exported ${count} tasks to ${outputPath}`);
    return count;
  }

  /**
   * Get export statistics
   */
  async getExportStats(options: { startDate?: string; endDate?: string } = {}): Promise<{
    totalTasks: number;
    totalExecutions: number;
    totalTurns: number;
    totalToolCalls: number;
  }> {
    const executions = AgentExecutionRepository.findForTraining({
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const taskIds = new Set(executions.map(e => e.taskId));
    let totalTurns = 0;
    let totalToolCalls = 0;

    for (const taskId of taskIds) {
      const turns = AgentTurnRepository.findByTaskId(taskId);
      const toolCalls = ToolCallRepository.findByTaskId(taskId);
      totalTurns += turns.length;
      totalToolCalls += toolCalls.length;
    }

    return {
      totalTasks: taskIds.size,
      totalExecutions: executions.length,
      totalTurns,
      totalToolCalls,
    };
  }

  // ==================== Private Helpers ====================

  private calculateSummary(
    executions: IAgentExecution[],
    turns: IAgentTurn[],
    toolCalls: IToolCall[]
  ): TrainingDataRecord['summary'] {
    const totalCost = executions.reduce((sum, e) => sum + e.costUsd, 0);
    const totalTokens = executions.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    const totalDurationMs = executions.reduce((sum, e) => sum + (e.durationMs || 0), 0);

    const hasCompleted = executions.some(e => e.status === 'completed');
    const hasFailed = executions.some(e => e.status === 'failed');

    let status: 'completed' | 'partial' | 'failed';
    if (hasCompleted && !hasFailed) {
      status = 'completed';
    } else if (hasCompleted && hasFailed) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    return {
      totalExecutions: executions.length,
      totalTurns: turns.length,
      totalToolCalls: toolCalls.length,
      totalCost,
      totalTokens,
      totalDurationMs,
      status,
    };
  }

  private mapExecution(e: IAgentExecution) {
    return {
      id: e.id,
      agentType: e.agentType,
      modelId: e.modelId,
      phaseName: e.phaseName,
      prompt: e.prompt,
      finalOutput: e.finalOutput,
      status: e.status,
      durationMs: e.durationMs,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costUsd: e.costUsd,
      turnsCompleted: e.turnsCompleted,
    };
  }

  private mapTurn(t: IAgentTurn) {
    return {
      id: t.id,
      executionId: t.executionId,
      turnNumber: t.turnNumber,
      turnType: t.turnType,
      messageContent: t.messageContent,
      hasToolCalls: t.hasToolCalls,
      toolCallsCount: t.toolCallsCount,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
    };
  }

  private mapToolCall(tc: IToolCall) {
    return {
      id: tc.id,
      executionId: tc.executionId,
      turnId: tc.turnId,
      toolName: tc.toolName,
      toolInput: tc.toolInput,
      toolInputSummary: tc.toolInputSummary,
      toolOutput: tc.toolOutput,
      toolSuccess: tc.toolSuccess,
      toolError: tc.toolError,
      filePath: tc.filePath,
      bashCommand: tc.bashCommand,
      bashExitCode: tc.bashExitCode,
      durationMs: tc.durationMs,
      callOrder: tc.callOrder,
    };
  }

  private generateExportId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `exp_${timestamp}_${random}`;
  }
}

export const trainingExportService = new TrainingExportServiceClass();
export default trainingExportService;
