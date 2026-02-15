/**
 * Training Export Service
 *
 * Exports granular execution data in clean JSON/JSONL format
 * ready for ML training on NVIDIA DGX Spark.
 *
 * v2.1.0: Added ML security signals for behavioral training
 * v2.3.0: 🔥 PLATINO TRACE - Comprehensive training data with:
 *         - SPY observations per phase
 *         - SPY observations per story
 *         - GlobalScan summary
 *         - Causality map (action → vulnerability)
 * v2.4.0: 🔥 CONTEXT COMPLETO para cada modelo Sentinental:
 *         - projectContext: dependencias, fileTree, tests, infraConfig
 *         - fileSnapshots: before/after completos por story
 *         - agentReasoning: análisis del razonamiento del agente
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository.js';
import { AgentTurnRepository, IAgentTurn } from '../../database/repositories/AgentTurnRepository.js';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { SentinentalRepository, ISentinentalTrainingData } from '../../database/repositories/SentinentalRepository.js';
import { mlSecurityAnalyzer } from './MLSecurityAnalyzer.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Training data structure for a single task
 * This is what gets sent to DGX Spark for training
 */
export interface TrainingDataRecord {
  id: string;
  taskId: string;
  exportedAt: string;
  version: string;

  // ========================================
  // 🔥 PROJECT CONTEXT v2.4.0
  // Para que cada modelo tenga contexto completo del proyecto
  // ========================================

  /**
   * Context del proyecto - CRÍTICO para generar exploits/fixes realistas
   * - Atacante: sabe qué dependencias explotar (pg directo vs Prisma)
   * - Defensor: sabe qué patrones usar para el fix
   * - Juez: sabe qué tests existen para validar
   */
  projectContext?: {
    /** Workspace path donde está el proyecto */
    workspacePath: string;

    /** Dependencias del proyecto (de package.json, requirements.txt, etc.) */
    dependencies: Record<string, string>;

    /** Árbol de archivos del proyecto (paths relativos) */
    fileTree: string[];

    /** Tests existentes en el proyecto */
    existingTests: string[];

    /** Stack tecnológico detectado */
    stack: {
      language: string;      // 'typescript', 'python', 'go', etc.
      framework?: string;    // 'express', 'fastapi', 'gin', etc.
      database?: string;     // 'postgresql', 'mongodb', 'mysql', etc.
      orm?: string;          // 'prisma', 'knex', 'typeorm', 'sqlalchemy', etc.
    };

    /** Configuración de infraestructura */
    infraConfig: {
      hasWAF: boolean;
      hasRateLimit: boolean;
      hasCSRF: boolean;
      hasHelmet: boolean;
      hasCORS: boolean;
      middlewares: string[];
      containerized: boolean;
      cicd?: string;         // 'github-actions', 'gitlab-ci', 'jenkins', etc.
    };

    /** Patrones de seguridad ya existentes en el proyecto */
    existingSecurityPatterns: string[];
  };

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

  // 🔥 Activity log from real-time events (v2.2.0)
  // Contains raw frontend events with full tool input/output data
  // Critical for ML training: includes old_string, new_string, file_path for Edit tools
  activityLog?: Array<{
    type: string;
    content: string;
    timestamp?: string;
    tool?: string;
    toolState?: string;
    toolInput?: any;   // Full tool input (old_string, new_string, file_path, command, etc.)
    toolOutput?: any;  // Tool result/output
  }>;

  // ML Security Signals (v2.1.0)
  mlSecuritySignals?: {
    signals: Array<{
      id: string;
      signalType: string;
      severity: string;
      description: string;
      details: Record<string, any>;
      detectedAt: string;
    }>;
    summary: {
      total: number;
      bySeverity: Record<string, number>;
      byType: Record<string, number>;
    };
    promptClassification?: {
      primaryType: string;
      confidence: number;
    };
    gitContext?: {
      branch: string;
      isDirty: boolean;
      recentCommits: string[];
    };
    toolSequences?: string[][];
  };

  // ========================================
  // 🔥 PLATINO TRACE v2.3.0 - SPY OBSERVATIONS
  // ========================================

  /** SPY observations organized by phase - for training Sentinental */
  spyObservations?: {
    /** Summary across all phases */
    summary: {
      totalVulnerabilities: number;
      totalBlocked: number;
      avgRiskScore: number;
      bySeverity: Record<string, number>;
      byType: Record<string, number>;
      byOwasp: Record<string, number>;
      byCwe: Record<string, number>;
    };

    /** SPY observations for each phase */
    byPhase: Array<{
      phase: string;
      vulnerabilitiesDetected: number;
      vulnerabilities: Array<{
        id: string;
        type: string;
        severity: string;
        description: string;
        blocked: boolean;
        owaspCategory?: string;
        cweId?: string;
        recommendation?: string;
        filePath?: string;
        lineNumber?: number;
        codeSnippet?: string;
        // 🔥 CAUSALITY: Which action caused this
        causedByToolCall?: {
          toolName: string;
          toolInput?: any;
          toolCallIndex?: number;
        };
      }>;
      riskScore: number;
      traceLevel: string;
      cvssLike?: any;
    }>;

    /** SPY observations for each story (Developer phase breakdown) */
    byStory?: Array<{
      storyId: string;
      storyTitle?: string;
      vulnerabilitiesDetected: number;
      vulnerabilities: Array<{
        id: string;
        type: string;
        severity: string;
        description: string;
        blocked: boolean;
        owaspCategory?: string;
        cweId?: string;
        filePath?: string;
        lineNumber?: number;
        codeSnippet?: string;
        causedByToolCall?: {
          toolName: string;
          toolInput?: any;
        };
      }>;
      riskScore: number;

      /**
       * 🔥 FILE SNAPSHOTS v2.4.0
       * Estado completo de archivos antes/después de la story
       * CRÍTICO para:
       * - Atacante: ver el contexto completo del código vulnerable
       * - Defensor: generar un fix que funcione con el código existente
       */
      fileSnapshots?: Record<string, {
        /** Contenido completo del archivo ANTES de la story */
        before: string;
        /** Contenido completo del archivo DESPUÉS de la story */
        after: string;
        /** Diff unificado para referencia rápida */
        unifiedDiff?: string;
      }>;

      /**
       * 🔥 FILE OPERATIONS v2.4.1
       * TODAS las operaciones de archivos que hizo el agente en esta story
       * CRÍTICO: Sin esto, no sabemos qué leyó/escribió el agente
       */
      fileOperations?: Array<{
        /** Orden de la operación */
        order: number;
        /** Tipo de operación */
        operation: 'read' | 'edit' | 'write';
        /** Path del archivo */
        filePath: string;
        /** Para Read: contenido que leyó */
        contentRead?: string;
        /** Para Edit: old_string que buscó */
        oldString?: string;
        /** Para Edit: new_string que puso */
        newString?: string;
        /** Para Write: contenido completo que escribió */
        contentWritten?: string;
        /** toolUseId para linking */
        toolUseId?: string;
        /** Timestamp */
        timestamp?: string;
      }>;

      /** Tests que se ejecutaron para esta story (si hay) */
      testsRun?: Array<{
        testFile: string;
        passed: boolean;
        output?: string;
      }>;
    }>;

    /** Global scan summary (end of task) */
    globalScan?: {
      scannedAt: string;
      totalFilesScanned: number;
      totalVulnerabilities: number;
      repositoriesScanned: Array<{
        name: string;
        type: string;
        filesScanned: number;
        vulnerabilitiesFound: number;
      }>;
      bySeverity: Record<string, number>;
      byType: Record<string, number>;
    };

    /**
     * 🔥 CAUSALITY MAP - Links actions to vulnerabilities
     * Critical for ML training: "This Edit caused this SQL injection"
     */
    causalityMap: Array<{
      /** The action that caused the vulnerability */
      action: {
        phase: string;
        storyId?: string;
        toolCallIndex: number;
        toolName: string;
        toolInput?: any;
        /** 🔥 Direct tool_use_id for database joins (if available) */
        toolUseId?: string;
        /** 🔥 Type of causality link: 'exact' (via toolUseId) or 'approximate' (via file path) */
        causalityType?: 'exact' | 'approximate';
      };
      /** The vulnerability that was caused */
      vulnerability: {
        id: string;
        type: string;
        severity: string;
        owaspCategory?: string;
        cweId?: string;
      };
      /** Was the agent aware of the vulnerability? (always false - SPY is invisible) */
      agentWasAware: false;
      /** Did Judge detect this? (usually false - Judge checks code quality, not security) */
      judgeCaught: boolean;

      /**
       * 🔥 AGENT REASONING v2.4.0
       * Análisis del razonamiento del agente - ORO para el Cronista
       * ¿POR QUÉ el agente eligió string concatenation en vez de parameterized queries?
       */
      agentReasoning?: {
        /** Texto relevante del agente antes de la acción vulnerable */
        messageBeforeAction?: string;
        /** ¿El agente mencionó seguridad en algún momento? */
        mentionedSecurity: boolean;
        /** ¿El agente consideró alternativas? */
        consideredAlternatives: boolean;
        /** Alternativas que mencionó (si las hay) */
        alternativesMentioned?: string[];
        /** Razón inferida de por qué eligió el approach vulnerable */
        inferredReason?: 'speed' | 'simplicity' | 'ignorance' | 'copy_paste' | 'unknown';
        /** Confidence de la inferencia (0-1) */
        inferenceConfidence?: number;
        /** Keywords de seguridad que debió mencionar pero no lo hizo */
        missingSecurityKeywords?: string[];
      };

      /**
       * Contexto disponible cuando el agente tomó la decisión
       * Para que Cronista sepa si el agente PODÍA saber que era vulnerable
       */
      contextAvailableToAgent?: {
        /** ¿El archivo tenía comentarios sobre seguridad? */
        hadSecurityComments: boolean;
        /** ¿Había ejemplos de parameterized queries en el proyecto? */
        hadSecureExamples: boolean;
        /** ¿El proyecto tenía linter de seguridad? */
        hadSecurityLinter: boolean;
        /** Documentación relevante mencionada */
        relevantDocs?: string[];
      };
    }>;
  };
}

export interface ExportOptions {
  startDate?: string;
  endDate?: string;
  status?: 'completed' | 'failed' | 'all';
  limit?: number;
  offset?: number;
}

class TrainingExportServiceClass {
  private readonly VERSION = '2.4.1'; // + fileOperations con contenido completo de Read/Edit/Write

  /**
   * Export training data for a single task
   * 🔥 PLATINO TRACE v2.4.0: Context completo para cada modelo Sentinental
   * - projectContext: dependencias, stack, infra
   * - fileSnapshots: before/after por story
   * - agentReasoning: análisis del razonamiento
   */
  async exportTask(taskId: string): Promise<TrainingDataRecord> {
    const executions = await AgentExecutionRepository.findByTaskId(taskId);
    const turns = await AgentTurnRepository.findByTaskId(taskId);
    const toolCalls = await ToolCallRepository.findByTaskId(taskId);
    const task = await TaskRepository.findById(taskId);

    const summary = this.calculateSummary(executions, turns, toolCalls);

    // Get ML security signals
    const mlSignalsData = await this.getMLSecuritySignals(taskId, executions);

    // 🔥 Get activity_log from task - contains full tool input/output from real-time events
    // This is critical for ML training: includes old_string, new_string, file_path for Edit tools
    const activityLog = await this.getActivityLog(taskId);

    // 🔥 PROJECT CONTEXT v2.4.0: Context completo para generar exploits/fixes realistas
    // Try to find workspacePath from: tool calls file paths, execution prompt, or sentinental records
    const workspacePath = this.extractWorkspacePath(toolCalls, executions);
    const projectContext = workspacePath ? await this.getProjectContext(workspacePath) : undefined;

    // 🔥 PLATINO TRACE: Get SPY observations per phase and story (now with file snapshots + agent reasoning)
    const spyObservations = await this.getSpyObservations(taskId, toolCalls, turns, projectContext?.workspacePath);

    return {
      id: this.generateExportId(),
      taskId,
      exportedAt: new Date().toISOString(),
      version: this.VERSION,
      projectContext,
      summary,
      executions: executions.map(e => this.mapExecution(e)),
      turns: turns.map(t => this.mapTurn(t)),
      toolCalls: toolCalls.map(tc => this.mapToolCall(tc)),
      activityLog,
      mlSecuritySignals: mlSignalsData,
      spyObservations,
    };
  }

  /**
   * 🔥 PLATINO TRACE: Get SPY observations organized by phase and story
   * Critical for Sentinental ML training - includes causality mapping
   * v2.4.0: Now includes fileSnapshots and agentReasoning
   */
  private async getSpyObservations(
    taskId: string,
    toolCalls: IToolCall[],
    turns: IAgentTurn[],
    workspacePath?: string
  ): Promise<TrainingDataRecord['spyObservations']> {
    try {
      // Fetch all Sentinental records for this task
      const sentinentalRecords = await SentinentalRepository.findByTaskId(taskId);

      if (sentinentalRecords.length === 0) {
        return undefined;
      }

      // Group by phase
      const byPhaseMap = new Map<string, ISentinentalTrainingData[]>();
      for (const record of sentinentalRecords) {
        const phaseRecords = byPhaseMap.get(record.phase) || [];
        phaseRecords.push(record);
        byPhaseMap.set(record.phase, phaseRecords);
      }

      // Calculate overall summary
      let totalVulnerabilities = 0;
      let totalBlocked = 0;
      let totalRiskScore = 0;
      const bySeverity: Record<string, number> = {};
      const byType: Record<string, number> = {};
      const byOwasp: Record<string, number> = {};
      const byCwe: Record<string, number> = {};

      for (const record of sentinentalRecords) {
        totalVulnerabilities += record.vulnerabilitiesCount;
        totalBlocked += record.blockedCount;
        totalRiskScore += record.riskScore;

        // Aggregate summaries
        if (record.summary?.bySeverity) {
          for (const [sev, count] of Object.entries(record.summary.bySeverity)) {
            bySeverity[sev] = (bySeverity[sev] || 0) + (count as number);
          }
        }
        if (record.summary?.byType) {
          for (const [type, count] of Object.entries(record.summary.byType)) {
            byType[type] = (byType[type] || 0) + (count as number);
          }
        }
        if (record.summary?.byOwasp) {
          for (const [owasp, count] of Object.entries(record.summary.byOwasp)) {
            byOwasp[owasp] = (byOwasp[owasp] || 0) + (count as number);
          }
        }
        if (record.summary?.byCwe) {
          for (const [cwe, count] of Object.entries(record.summary.byCwe)) {
            byCwe[cwe] = (byCwe[cwe] || 0) + (count as number);
          }
        }
      }

      // Build byPhase array
      const byPhase: NonNullable<TrainingDataRecord['spyObservations']>['byPhase'] = [];
      for (const [phaseName, records] of Array.from(byPhaseMap.entries())) {
        // Combine vulnerabilities from all records in this phase
        const phaseVulns: any[] = [];
        let phaseRiskScore = 0;
        let bestTraceLevel = 'bronze';

        for (const record of records) {
          phaseRiskScore = Math.max(phaseRiskScore, record.riskScore);
          if (record.traceLevel === 'platinum') bestTraceLevel = 'platinum';
          else if (record.traceLevel === 'gold' && bestTraceLevel !== 'platinum') bestTraceLevel = 'gold';
          else if (record.traceLevel === 'silver' && !['platinum', 'gold'].includes(bestTraceLevel)) bestTraceLevel = 'silver';

          for (const vuln of record.vulnerabilities || []) {
            phaseVulns.push({
              id: vuln.id,
              type: vuln.type,
              severity: vuln.severity,
              description: vuln.description,
              blocked: vuln.blocked,
              owaspCategory: vuln.owaspCategory,
              cweId: vuln.cweId,
              recommendation: vuln.recommendation,
              filePath: vuln.filePath,
              lineNumber: vuln.lineNumber,
              codeSnippet: vuln.codeSnippet,
              // Try to link to a tool call that caused this
              causedByToolCall: this.findCausalToolCall(vuln, toolCalls, phaseName),
            });
          }
        }

        byPhase.push({
          phase: phaseName,
          vulnerabilitiesDetected: phaseVulns.length,
          vulnerabilities: phaseVulns,
          riskScore: phaseRiskScore,
          traceLevel: bestTraceLevel,
          cvssLike: records[0]?.cvssLike,
        });
      }

      // Extract stories from Developer phase records (v2.4.0: with file snapshots)
      const byStory = this.extractStorySpy(sentinentalRecords, toolCalls, workspacePath);

      // Extract GlobalScan data from records
      const globalScan = await this.extractGlobalScanFromRecords(sentinentalRecords);

      // Build causality map - links each vulnerability to the action that caused it
      // v2.4.0: Now includes agent reasoning analysis
      const causalityMap = this.buildCausalityMap(sentinentalRecords, toolCalls, turns);

      return {
        summary: {
          totalVulnerabilities,
          totalBlocked,
          avgRiskScore: sentinentalRecords.length > 0 ? Math.round(totalRiskScore / sentinentalRecords.length) : 0,
          bySeverity,
          byType,
          byOwasp,
          byCwe,
        },
        byPhase,
        byStory: byStory.length > 0 ? byStory : undefined,
        globalScan,
        causalityMap,
      };
    } catch (error: any) {
      console.warn(`[TrainingExport] SPY observations error for task ${taskId}: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Find the tool call that likely caused a vulnerability
   */
  private findCausalToolCall(
    vuln: any,
    toolCalls: IToolCall[],
    phase: string
  ): { toolName: string; toolInput?: any; toolCallIndex?: number } | undefined {
    if (!vuln.filePath && !vuln.evidence?.filePath) return undefined;

    const targetPath = vuln.filePath || vuln.evidence?.filePath;

    // Look for Edit or Write tool calls to the same file
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (['edit', 'write', 'Edit', 'Write'].includes(tc.toolName)) {
        const tcPath = tc.filePath || tc.toolInput?.file_path || tc.toolInput?.path;
        if (tcPath && targetPath.includes(tcPath.split('/').pop() || '')) {
          return {
            toolName: tc.toolName,
            toolInput: tc.toolInput,
            toolCallIndex: i,
          };
        }
      }
    }

    // Look for Bash commands that might have caused the issue
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (['bash', 'Bash'].includes(tc.toolName)) {
        const command = tc.bashCommand || tc.toolInput?.command;
        if (command && vuln.evidence?.command && command.includes(vuln.evidence.command.substring(0, 30))) {
          return {
            toolName: tc.toolName,
            toolInput: { command },
            toolCallIndex: i,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Extract story-level SPY observations from Developer phase records
   * v2.4.0: Now includes fileSnapshots for each story
   */
  private extractStorySpy(
    records: ISentinentalTrainingData[],
    toolCalls: IToolCall[],
    workspacePath?: string
  ): NonNullable<NonNullable<TrainingDataRecord['spyObservations']>['byStory']> {
    const byStory: NonNullable<NonNullable<TrainingDataRecord['spyObservations']>['byStory']> = [];

    // Filter to Developer phase only
    const devRecords = records.filter(r =>
      r.phase.toLowerCase().includes('developer') ||
      r.phase.toLowerCase().includes('dev')
    );

    // Group by session (each session typically = one story)
    const bySession = new Map<string, ISentinentalTrainingData[]>();
    for (const record of devRecords) {
      const sessionRecords = bySession.get(record.sessionId) || [];
      sessionRecords.push(record);
      bySession.set(record.sessionId, sessionRecords);
    }

    let storyIndex = 0;
    for (const [sessionId, sessionRecords] of Array.from(bySession.entries())) {
      const storyVulns: any[] = [];
      let storyRiskScore = 0;

      // Collect tool calls for this story's session
      const storyToolCalls = toolCalls.filter(tc =>
        sessionRecords.some(r => r.executionContext?.executionId === tc.executionId)
      );

      for (const record of sessionRecords) {
        storyRiskScore = Math.max(storyRiskScore, record.riskScore);

        for (const vuln of record.vulnerabilities || []) {
          storyVulns.push({
            id: vuln.id,
            type: vuln.type,
            severity: vuln.severity,
            description: vuln.description,
            blocked: vuln.blocked,
            owaspCategory: vuln.owaspCategory,
            cweId: vuln.cweId,
            filePath: vuln.filePath,
            lineNumber: vuln.lineNumber,
            codeSnippet: vuln.codeSnippet,
            causedByToolCall: this.findCausalToolCall(vuln, toolCalls, 'Developer'),
          });
        }
      }

      // Try to extract story ID from execution context or task history
      const storyId = sessionRecords[0]?.executionContext?.storyId ||
        sessionRecords[0]?.taskHistory?.completedPhases?.find((p: any) => p.storyId)?.storyId ||
        `story-${storyIndex}`;

      // 🔥 v2.4.0: Get file snapshots for this story
      const fileSnapshots = this.getFileSnapshots(storyToolCalls, workspacePath);

      // 🔥 v2.4.1: Get ALL file operations (Read/Edit/Write) with full content
      const fileOperations = this.extractFileOperations(storyToolCalls);

      if (storyVulns.length > 0 || storyIndex < 10) { // Include even empty stories for completeness
        byStory.push({
          storyId,
          storyTitle: sessionRecords[0]?.executionContext?.storyTitle,
          vulnerabilitiesDetected: storyVulns.length,
          vulnerabilities: storyVulns,
          riskScore: storyRiskScore,
          fileSnapshots, // 🔥 v2.4.0: Include file snapshots
          fileOperations, // 🔥 v2.4.1: All Read/Edit/Write operations
        });
      }

      storyIndex++;
    }

    return byStory;
  }

  /**
   * Extract GlobalScan data from Sentinental records
   * GlobalScan runs at the end and stores results in sentinental_training_data with phase='GlobalScan'
   */
  private async extractGlobalScanFromRecords(
    records: ISentinentalTrainingData[]
  ): Promise<NonNullable<TrainingDataRecord['spyObservations']>['globalScan']> {
    try {
      // Find GlobalScan phase records
      const globalScanRecords = records.filter(r =>
        r.phase.toLowerCase().includes('global') ||
        r.phase.toLowerCase().includes('scan')
      );

      if (globalScanRecords.length === 0) return undefined;

      // Aggregate data from all GlobalScan records
      let totalVulnerabilities = 0;
      const bySeverity: Record<string, number> = {};
      const byType: Record<string, number> = {};

      for (const record of globalScanRecords) {
        totalVulnerabilities += record.vulnerabilitiesCount;

        if (record.summary?.bySeverity) {
          for (const [sev, count] of Object.entries(record.summary.bySeverity)) {
            bySeverity[sev] = (bySeverity[sev] || 0) + (count as number);
          }
        }
        if (record.summary?.byType) {
          for (const [type, count] of Object.entries(record.summary.byType)) {
            byType[type] = (byType[type] || 0) + (count as number);
          }
        }
      }

      // Get repository info from execution context if available
      const repoInfo = globalScanRecords[0]?.executionContext?.repositoriesScanned || [];

      return {
        scannedAt: globalScanRecords[0]?.createdAt?.toISOString() || new Date().toISOString(),
        totalFilesScanned: 0, // Not tracked in current schema
        totalVulnerabilities,
        repositoriesScanned: repoInfo.map((r: any) => ({
          name: r.name || 'unknown',
          type: r.type || 'unknown',
          filesScanned: r.filesScanned || 0,
          vulnerabilitiesFound: r.vulnerabilitiesFound || 0,
        })),
        bySeverity,
        byType,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 🔥 Build causality map - links each action to vulnerabilities it caused
   * Critical for Sentinental ML training: "This Edit caused SQL injection"
   *
   * Uses TWO methods for linking:
   * 1. EXACT: Uses toolUseId from vulnerability (if SPY captured it)
   * 2. APPROXIMATE: Matches by file path/command (fallback)
   *
   * v2.4.0: Now includes agent reasoning analysis for Cronista
   */
  private buildCausalityMap(
    records: ISentinentalTrainingData[],
    toolCalls: IToolCall[],
    turns: IAgentTurn[]
  ): NonNullable<TrainingDataRecord['spyObservations']>['causalityMap'] {
    const causalityMap: NonNullable<TrainingDataRecord['spyObservations']>['causalityMap'] = [];

    // Build lookup map for exact matching by toolUseId
    const toolCallByUseId = new Map<string, { tc: IToolCall; index: number }>();
    for (let i = 0; i < toolCalls.length; i++) {
      if (toolCalls[i].toolUseId) {
        toolCallByUseId.set(toolCalls[i].toolUseId!, { tc: toolCalls[i], index: i });
      }
    }

    for (const record of records) {
      for (const vuln of record.vulnerabilities || []) {
        let causalTool: { toolName: string; toolInput?: any; toolCallIndex?: number; toolUseId?: string; exact: boolean } | undefined;

        // 🔥 Method 1: EXACT match via toolUseId (preferred)
        if (vuln.toolUseId && toolCallByUseId.has(vuln.toolUseId)) {
          const match = toolCallByUseId.get(vuln.toolUseId)!;
          causalTool = {
            toolName: match.tc.toolName,
            toolInput: match.tc.toolInput,
            toolCallIndex: match.index,
            toolUseId: vuln.toolUseId,
            exact: true, // 🔥 EXACT causality
          };
        } else {
          // 🔥 Method 2: APPROXIMATE match by file path (fallback)
          const approx = this.findCausalToolCall(vuln, toolCalls, record.phase);
          if (approx) {
            causalTool = { ...approx, exact: false };
          }
        }

        if (causalTool) {
          // 🔥 v2.4.0: Analyze agent reasoning - WHY did they make this vulnerable choice?
          const agentReasoning = this.analyzeAgentReasoning(turns, causalTool.toolCallIndex || 0, vuln.type);

          causalityMap.push({
            action: {
              phase: record.phase,
              storyId: (vuln as any).storyId || record.executionContext?.storyId,
              toolCallIndex: causalTool.toolCallIndex || 0,
              toolName: causalTool.toolName,
              toolInput: causalTool.toolInput,
              // 🔥 Include toolUseId for database joins
              toolUseId: causalTool.toolUseId,
              // 🔥 Mark if this is exact or approximate causality
              causalityType: causalTool.exact ? 'exact' : 'approximate',
            } as any,
            vulnerability: {
              id: vuln.id,
              type: vuln.type,
              severity: vuln.severity,
              owaspCategory: vuln.owaspCategory,
              cweId: vuln.cweId,
            },
            agentWasAware: false, // SPY is invisible - agent NEVER knows
            judgeCaught: false, // Judge evaluates code quality, not security
            agentReasoning, // 🔥 v2.4.0: WHY did the agent make this choice?
          });
        }
      }
    }

    return causalityMap;
  }

  /**
   * Get activity log from task record
   * Contains ALL real-time events with full tool input/output data
   * NO FILTERING - export everything for comprehensive training data
   */
  private async getActivityLog(taskId: string): Promise<TrainingDataRecord['activityLog']> {
    try {
      const activityLog = await TaskRepository.getActivityLog(taskId);
      if (!activityLog || !Array.isArray(activityLog) || activityLog.length === 0) {
        return undefined;
      }

      // Return ALL entries without filtering - comprehensive training data
      return activityLog.map((entry: any) => ({
        type: entry.type,
        content: entry.content || '',
        timestamp: entry.timestamp,
        tool: entry.tool,
        toolState: entry.toolState,
        toolInput: entry.toolInput,
        toolOutput: entry.toolOutput,
      }));
    } catch (error: any) {
      console.warn(`[TrainingExport] Activity log error for task ${taskId}: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Get ML security signals for a task
   */
  private async getMLSecuritySignals(taskId: string, executions: IAgentExecution[]): Promise<TrainingDataRecord['mlSecuritySignals']> {
    try {
      const signals = await mlSecurityAnalyzer.getSignalsForTask(taskId);
      const summary = await mlSecurityAnalyzer.getSignalSummary(taskId);

      // Extract prompt classification
      const promptSignal = signals.find(s => s.signalType === 'prompt_classification');
      const promptClassification = promptSignal?.details
        ? {
            primaryType: promptSignal.details.primaryType as string,
            confidence: promptSignal.details.confidence as number,
          }
        : undefined;

      // Extract git context
      const gitSignal = signals.find(s => s.signalType === 'git_context');
      const gitContext = gitSignal?.details
        ? {
            branch: gitSignal.details.branch as string,
            isDirty: gitSignal.details.isDirty as boolean,
            recentCommits: gitSignal.details.recentCommits as string[],
          }
        : undefined;

      // Get tool sequences
      const toolSequences = executions
        .map(e => mlSecurityAnalyzer.getToolSequence(e.id))
        .filter(seq => seq.length > 0);

      return {
        signals: signals.map(s => ({
          id: s.id,
          signalType: s.signalType,
          severity: s.severity,
          description: s.description,
          details: s.details,
          detectedAt: s.detectedAt.toISOString(),
        })),
        summary: {
          total: summary.total,
          bySeverity: summary.bySeverity,
          byType: summary.byType,
        },
        promptClassification,
        gitContext,
        toolSequences: toolSequences.length > 0 ? toolSequences : undefined,
      };
    } catch (error: any) {
      console.warn(`[TrainingExport] ML signals error: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Export multiple tasks as JSONL (JSON Lines) for streaming to DGX
   */
  async exportAsJSONL(options: ExportOptions = {}): Promise<string> {
    const executions = await AgentExecutionRepository.findForTraining({
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
    const executions = await AgentExecutionRepository.findForTraining({
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const taskIds = new Set(executions.map(e => e.taskId));
    let totalTurns = 0;
    let totalToolCalls = 0;

    for (const taskId of taskIds) {
      const turns = await AgentTurnRepository.findByTaskId(taskId);
      const toolCalls = await ToolCallRepository.findByTaskId(taskId);
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

  /**
   * Extract workspace path from tool calls or execution prompts
   * Tries multiple sources to find the project root
   */
  private extractWorkspacePath(toolCalls: IToolCall[], executions: IAgentExecution[]): string | undefined {
    // Method 1: Look for common project root from file paths in tool calls
    const filePaths = toolCalls
      .map(tc => tc.filePath || tc.toolInput?.file_path || tc.toolInput?.path)
      .filter(Boolean) as string[];

    if (filePaths.length > 0) {
      // Find the common prefix (workspace root)
      const sortedPaths = filePaths.sort();
      const first = sortedPaths[0];
      const last = sortedPaths[sortedPaths.length - 1];

      let commonPrefix = '';
      for (let i = 0; i < first.length && i < last.length; i++) {
        if (first[i] === last[i]) {
          commonPrefix += first[i];
        } else {
          break;
        }
      }

      // Trim to last directory separator
      const lastSlash = commonPrefix.lastIndexOf('/');
      if (lastSlash > 0) {
        const workspacePath = commonPrefix.substring(0, lastSlash);
        // Validate it looks like a workspace (has package.json, requirements.txt, etc.)
        if (fs.existsSync(path.join(workspacePath, 'package.json')) ||
            fs.existsSync(path.join(workspacePath, 'requirements.txt')) ||
            fs.existsSync(path.join(workspacePath, 'go.mod')) ||
            fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
          return workspacePath;
        }
        // Try parent directory
        const parentDir = path.dirname(workspacePath);
        if (fs.existsSync(path.join(parentDir, 'package.json')) ||
            fs.existsSync(path.join(parentDir, 'requirements.txt'))) {
          return parentDir;
        }
        return workspacePath;
      }
    }

    // Method 2: Extract from execution prompt
    for (const exec of executions) {
      const match = exec.prompt?.match(/(?:workspace|project|directory)[:\s]+([\/\w.-]+)/i);
      if (match && fs.existsSync(match[1])) {
        return match[1];
      }
    }

    return undefined;
  }

  // ==================== v2.4.0 PROJECT CONTEXT ====================

  /**
   * 🔥 Extract project context for Sentinental models
   * - Atacante: knows what to exploit (pg vs Prisma)
   * - Defensor: knows what patterns to use for fix
   * - Juez: knows what tests exist
   */
  private async getProjectContext(workspacePath: string): Promise<TrainingDataRecord['projectContext']> {
    try {
      const dependencies: Record<string, string> = {};
      const fileTree: string[] = [];
      const existingTests: string[] = [];
      const existingSecurityPatterns: string[] = [];

      // Read package.json for Node.js projects
      const packageJsonPath = path.join(workspacePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          Object.assign(dependencies, pkg.dependencies || {});
          Object.assign(dependencies, pkg.devDependencies || {});
        } catch { /* ignore parse errors */ }
      }

      // Read requirements.txt for Python projects
      const requirementsPath = path.join(workspacePath, 'requirements.txt');
      if (fs.existsSync(requirementsPath)) {
        try {
          const reqs = fs.readFileSync(requirementsPath, 'utf-8');
          for (const line of reqs.split('\n')) {
            const match = line.match(/^([a-zA-Z0-9_-]+)==?(.+)?/);
            if (match) {
              dependencies[match[1]] = match[2] || '*';
            }
          }
        } catch { /* ignore */ }
      }

      // Get file tree (limited depth to avoid huge trees)
      this.collectFileTree(workspacePath, '', fileTree, 3, 500);

      // Find test files
      for (const file of fileTree) {
        if (file.includes('test') || file.includes('spec') || file.includes('__tests__')) {
          existingTests.push(file);
        }
      }

      // Detect stack
      const stack = this.detectStack(dependencies, fileTree);

      // Detect infra config
      const infraConfig = this.detectInfraConfig(workspacePath, dependencies, fileTree);

      // Find existing security patterns
      this.detectSecurityPatterns(workspacePath, fileTree, existingSecurityPatterns);

      return {
        workspacePath,
        dependencies,
        fileTree,
        existingTests,
        stack,
        infraConfig,
        existingSecurityPatterns,
      };
    } catch (error: any) {
      console.warn(`[TrainingExport] Project context error: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Collect file tree recursively with limits
   */
  private collectFileTree(
    basePath: string,
    relativePath: string,
    result: string[],
    maxDepth: number,
    maxFiles: number
  ): void {
    if (maxDepth <= 0 || result.length >= maxFiles) return;

    const fullPath = path.join(basePath, relativePath);
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (result.length >= maxFiles) break;

        // Skip common noise directories
        if (['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next'].includes(entry.name)) {
          continue;
        }

        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          this.collectFileTree(basePath, entryRelPath, result, maxDepth - 1, maxFiles);
        } else {
          result.push(entryRelPath);
        }
      }
    } catch { /* ignore permission errors */ }
  }

  /**
   * Detect tech stack from dependencies and files
   */
  private detectStack(
    dependencies: Record<string, string>,
    fileTree: string[]
  ): NonNullable<TrainingDataRecord['projectContext']>['stack'] {
    let language = 'unknown';
    let framework: string | undefined;
    let database: string | undefined;
    let orm: string | undefined;

    // Detect language
    const hasTs = fileTree.some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
    const hasJs = fileTree.some(f => f.endsWith('.js') || f.endsWith('.jsx'));
    const hasPy = fileTree.some(f => f.endsWith('.py'));
    const hasGo = fileTree.some(f => f.endsWith('.go'));
    const hasRust = fileTree.some(f => f.endsWith('.rs'));

    if (hasTs) language = 'typescript';
    else if (hasJs) language = 'javascript';
    else if (hasPy) language = 'python';
    else if (hasGo) language = 'go';
    else if (hasRust) language = 'rust';

    // Detect framework
    if (dependencies['express']) framework = 'express';
    else if (dependencies['fastify']) framework = 'fastify';
    else if (dependencies['koa']) framework = 'koa';
    else if (dependencies['next']) framework = 'nextjs';
    else if (dependencies['nuxt']) framework = 'nuxt';
    else if (dependencies['fastapi']) framework = 'fastapi';
    else if (dependencies['django']) framework = 'django';
    else if (dependencies['flask']) framework = 'flask';

    // Detect database
    if (dependencies['pg'] || dependencies['postgres'] || dependencies['postgresql']) database = 'postgresql';
    else if (dependencies['mysql'] || dependencies['mysql2']) database = 'mysql';
    else if (dependencies['mongodb'] || dependencies['mongoose']) database = 'mongodb';
    else if (dependencies['sqlite3'] || dependencies['better-sqlite3']) database = 'sqlite';
    else if (dependencies['redis'] || dependencies['ioredis']) database = 'redis';

    // Detect ORM
    if (dependencies['prisma'] || dependencies['@prisma/client']) orm = 'prisma';
    else if (dependencies['typeorm']) orm = 'typeorm';
    else if (dependencies['sequelize']) orm = 'sequelize';
    else if (dependencies['knex']) orm = 'knex';
    else if (dependencies['drizzle-orm']) orm = 'drizzle';
    else if (dependencies['sqlalchemy']) orm = 'sqlalchemy';
    else if (dependencies['tortoise-orm']) orm = 'tortoise';

    return { language, framework, database, orm };
  }

  /**
   * Detect infrastructure configuration
   */
  private detectInfraConfig(
    workspacePath: string,
    dependencies: Record<string, string>,
    fileTree: string[]
  ): NonNullable<TrainingDataRecord['projectContext']>['infraConfig'] {
    const hasWAF = fileTree.some(f => f.includes('waf') || f.includes('firewall'));
    const hasRateLimit = !!dependencies['express-rate-limit'] || !!dependencies['rate-limiter-flexible'];
    const hasCSRF = !!dependencies['csurf'] || !!dependencies['csrf'];
    const hasHelmet = !!dependencies['helmet'];
    const hasCORS = !!dependencies['cors'];

    const middlewares: string[] = [];
    if (hasRateLimit) middlewares.push('rate-limit');
    if (hasCSRF) middlewares.push('csrf');
    if (hasHelmet) middlewares.push('helmet');
    if (hasCORS) middlewares.push('cors');
    if (dependencies['express-validator']) middlewares.push('express-validator');
    if (dependencies['joi']) middlewares.push('joi');
    if (dependencies['zod']) middlewares.push('zod');

    const containerized = fileTree.some(f =>
      f === 'Dockerfile' || f === 'docker-compose.yml' || f === 'docker-compose.yaml'
    );

    let cicd: string | undefined;
    if (fileTree.some(f => f.includes('.github/workflows'))) cicd = 'github-actions';
    else if (fileTree.some(f => f === '.gitlab-ci.yml')) cicd = 'gitlab-ci';
    else if (fileTree.some(f => f === 'Jenkinsfile')) cicd = 'jenkins';
    else if (fileTree.some(f => f.includes('.circleci'))) cicd = 'circleci';

    return {
      hasWAF,
      hasRateLimit,
      hasCSRF,
      hasHelmet,
      hasCORS,
      middlewares,
      containerized,
      cicd,
    };
  }

  /**
   * Detect existing security patterns in the codebase
   */
  private detectSecurityPatterns(
    workspacePath: string,
    fileTree: string[],
    patterns: string[]
  ): void {
    // Check for security-related files/patterns
    const securityIndicators = [
      { pattern: /auth/i, name: 'authentication' },
      { pattern: /sanitize|escape|encode/i, name: 'input-sanitization' },
      { pattern: /parameterized|prepared|placeholder/i, name: 'parameterized-queries' },
      { pattern: /bcrypt|argon|scrypt/i, name: 'password-hashing' },
      { pattern: /jwt|oauth|passport/i, name: 'token-auth' },
      { pattern: /csrf|xsrf/i, name: 'csrf-protection' },
      { pattern: /helmet|security.*header/i, name: 'security-headers' },
      { pattern: /rate.?limit/i, name: 'rate-limiting' },
      { pattern: /validator|validate/i, name: 'input-validation' },
    ];

    // Sample a few source files to check patterns
    const sourceFiles = fileTree
      .filter(f => /\.(ts|js|py|go|rs)$/.test(f))
      .slice(0, 20);

    for (const file of sourceFiles) {
      try {
        const content = fs.readFileSync(path.join(workspacePath, file), 'utf-8');
        for (const indicator of securityIndicators) {
          if (indicator.pattern.test(content) && !patterns.includes(indicator.name)) {
            patterns.push(indicator.name);
          }
        }
      } catch { /* ignore read errors */ }
    }
  }

  // ==================== v2.4.0 FILE SNAPSHOTS ====================

  /**
   * 🔥 Get file snapshots (before/after) for files modified in a story
   * Critical for Atacante to see full context and Defensor to generate working fix
   */
  private getFileSnapshots(
    toolCalls: IToolCall[],
    workspacePath?: string
  ): Record<string, { before: string; after: string; unifiedDiff?: string }> | undefined {
    if (!workspacePath) return undefined;

    const snapshots: Record<string, { before: string; after: string; unifiedDiff?: string }> = {};

    // Find all Edit/Write tool calls and reconstruct before/after
    for (const tc of toolCalls) {
      if (!['Edit', 'edit', 'Write', 'write'].includes(tc.toolName)) continue;

      const filePath = tc.filePath || tc.toolInput?.file_path || tc.toolInput?.path;
      if (!filePath) continue;

      const relativePath = filePath.replace(workspacePath, '').replace(/^\//, '');

      // For Edit: we have old_string and new_string
      if (['Edit', 'edit'].includes(tc.toolName)) {
        const oldStr = tc.toolInput?.old_string || '';
        const newStr = tc.toolInput?.new_string || '';

        if (!snapshots[relativePath]) {
          // Try to read current file as "after"
          try {
            const fullPath = path.join(workspacePath, relativePath);
            const currentContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
            snapshots[relativePath] = {
              before: currentContent.replace(newStr, oldStr), // Approximate before
              after: currentContent,
              unifiedDiff: this.createUnifiedDiff(oldStr, newStr),
            };
          } catch {
            snapshots[relativePath] = {
              before: `[Could not read] Old content included: ${oldStr.substring(0, 500)}`,
              after: `[Could not read] New content included: ${newStr.substring(0, 500)}`,
            };
          }
        }
      }

      // For Write: the entire content is new
      if (['Write', 'write'].includes(tc.toolName)) {
        const content = tc.toolInput?.content || tc.toolOutput || '';
        if (!snapshots[relativePath]) {
          snapshots[relativePath] = {
            before: '', // File didn't exist or was empty
            after: content,
          };
        }
      }
    }

    return Object.keys(snapshots).length > 0 ? snapshots : undefined;
  }

  /**
   * Create a simple unified diff representation
   */
  private createUnifiedDiff(oldStr: string, newStr: string): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    let diff = '';
    for (const line of oldLines) {
      diff += `- ${line}\n`;
    }
    for (const line of newLines) {
      diff += `+ ${line}\n`;
    }
    return diff;
  }

  /**
   * 🔥 v2.4.1: Extract ALL file operations (Read/Edit/Write) with full content
   * CRITICAL: This is what the agent actually saw and wrote
   * Without this, ML models can't understand the agent's decision-making
   */
  private extractFileOperations(
    toolCalls: IToolCall[]
  ): NonNullable<NonNullable<TrainingDataRecord['spyObservations']>['byStory']>[0]['fileOperations'] {
    const operations: NonNullable<NonNullable<TrainingDataRecord['spyObservations']>['byStory']>[0]['fileOperations'] = [];

    let order = 0;
    for (const tc of toolCalls) {
      const toolNameLower = tc.toolName.toLowerCase();

      // Only process file operations
      if (!['read', 'edit', 'write'].includes(toolNameLower)) continue;

      const filePath = tc.filePath || tc.toolInput?.file_path || tc.toolInput?.path || '';

      if (toolNameLower === 'read') {
        // READ: Capture what the agent READ
        operations.push({
          order: order++,
          operation: 'read',
          filePath,
          // toolOutput contains what was read (the file content)
          contentRead: tc.toolOutput || '[Content not captured]',
          toolUseId: tc.toolUseId,
          timestamp: tc.startedAt?.toISOString(),
        });
      } else if (toolNameLower === 'edit') {
        // EDIT: Capture old_string, new_string
        operations.push({
          order: order++,
          operation: 'edit',
          filePath,
          oldString: tc.toolInput?.old_string || '',
          newString: tc.toolInput?.new_string || '',
          toolUseId: tc.toolUseId,
          timestamp: tc.startedAt?.toISOString(),
        });
      } else if (toolNameLower === 'write') {
        // WRITE: Capture full content written
        operations.push({
          order: order++,
          operation: 'write',
          filePath,
          contentWritten: tc.toolInput?.content || tc.toolOutput || '',
          toolUseId: tc.toolUseId,
          timestamp: tc.startedAt?.toISOString(),
        });
      }
    }

    return operations.length > 0 ? operations : undefined;
  }

  // ==================== v2.4.0 AGENT REASONING ====================

  /**
   * 🔥 Analyze agent reasoning for a vulnerability
   * Gold for Cronista: WHY did the agent make a vulnerable choice?
   */
  private analyzeAgentReasoning(
    turns: IAgentTurn[],
    toolCallIndex: number,
    vulnerabilityType: string
  ): NonNullable<NonNullable<TrainingDataRecord['spyObservations']>['causalityMap'][0]['agentReasoning']> {
    // Find the turn before the vulnerable action
    const relevantTurns = turns.filter(t =>
      t.turnType === 'assistant' && t.messageContent
    );

    const messageBeforeAction = relevantTurns.length > 0
      ? relevantTurns[Math.min(toolCallIndex, relevantTurns.length - 1)]?.messageContent?.substring(0, 500)
      : undefined;

    // Security keywords the agent should have mentioned
    const securityKeywordsByType: Record<string, string[]> = {
      sql_injection: ['parameterized', 'prepared statement', 'escape', 'sanitize', '$1', '?'],
      xss: ['escape', 'sanitize', 'encode', 'DOMPurify', 'textContent'],
      command_injection: ['escape', 'shell-escape', 'execFile', 'spawn'],
      path_traversal: ['path.resolve', 'normalize', 'basename', 'realpath'],
      hardcoded_secret: ['environment variable', 'env', 'process.env', 'config', 'vault'],
    };

    const expectedKeywords = securityKeywordsByType[vulnerabilityType] || [];
    const allContent = relevantTurns.map(t => t.messageContent || '').join(' ').toLowerCase();

    // Check what the agent mentioned
    const mentionedSecurity = /security|secure|safe|protect|sanitize|validate|escape/i.test(allContent);
    const consideredAlternatives = /alternatively|could also|another approach|option/i.test(allContent);
    const alternativesMentioned = allContent.match(/(?:alternatively|could also|another approach)[^.]+/gi) || [];

    // Find missing security keywords
    const missingSecurityKeywords = expectedKeywords.filter(kw =>
      !allContent.includes(kw.toLowerCase())
    );

    // Infer reason
    let inferredReason: 'speed' | 'simplicity' | 'ignorance' | 'copy_paste' | 'unknown' = 'unknown';
    let inferenceConfidence = 0.3;

    if (/quickly|fast|simple|easy|straightforward/i.test(allContent)) {
      inferredReason = 'speed';
      inferenceConfidence = 0.7;
    } else if (/copy|paste|example|template|snippet/i.test(allContent)) {
      inferredReason = 'copy_paste';
      inferenceConfidence = 0.6;
    } else if (!mentionedSecurity && missingSecurityKeywords.length > 2) {
      inferredReason = 'ignorance';
      inferenceConfidence = 0.5;
    } else if (/simple|basic|minimal/i.test(allContent)) {
      inferredReason = 'simplicity';
      inferenceConfidence = 0.6;
    }

    return {
      messageBeforeAction,
      mentionedSecurity,
      consideredAlternatives,
      alternativesMentioned: alternativesMentioned.length > 0 ? alternativesMentioned.slice(0, 3) : undefined,
      inferredReason,
      inferenceConfidence,
      missingSecurityKeywords: missingSecurityKeywords.length > 0 ? missingSecurityKeywords : undefined,
    };
  }
}

export const trainingExportService = new TrainingExportServiceClass();
export default trainingExportService;
