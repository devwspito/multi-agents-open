/**
 * ML Security Analyzer
 *
 * Extends the training data with behavioral signals for ML models.
 * This complements AgentSpy (which handles vulnerability detection)
 * by adding patterns useful for training security models.
 *
 * 4 Features (non-duplicating AgentSpy):
 * 1. Tool Call Chains - Track sequences for exfiltration pattern detection
 * 2. Prompt Classification - Categorize task types
 * 3. Git Context - Capture repository state
 * 4. Error Recovery Patterns - Track how agents recover from failures
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { db, generateId } from '../../database/index.js';

const execAsync = promisify(exec);

// ============================================
// TYPES
// ============================================

export type PromptType =
  | 'code_generation'
  | 'debugging'
  | 'refactoring'
  | 'security_review'
  | 'documentation'
  | 'testing'
  | 'deployment'
  | 'data_analysis'
  | 'unknown';

export type SignalSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type SignalType =
  | 'tool_chain'
  | 'prompt_classification'
  | 'git_context'
  | 'error_recovery';

export interface IMLSecuritySignal {
  id: string;
  taskId: string;
  executionId?: string;
  signalType: SignalType;
  severity: SignalSeverity;
  description: string;
  details: Record<string, any>;
  detectedAt: Date;
}

export interface GitContext {
  branch: string;
  hasUncommittedChanges: boolean;
  recentCommits: string[];
  isDirty: boolean;
  aheadBehind?: { ahead: number; behind: number };
}

export interface ErrorRecoveryAttempt {
  error: string;
  errorType: string;
  recoveryAction: string;
  recoveryToolName: string;
  successful: boolean;
  attemptNumber: number;
  timestamp: Date;
}

// ============================================
// PROMPT CLASSIFICATION PATTERNS
// ============================================

const PROMPT_PATTERNS: Array<{
  type: PromptType;
  patterns: RegExp[];
  weight: number;
}> = [
  {
    type: 'code_generation',
    patterns: [
      /create\s+(a\s+)?(new\s+)?(function|class|component|module|service)/gi,
      /implement\s+(a\s+)?(feature|functionality)/gi,
      /write\s+(code|function|class)/gi,
      /build\s+(a\s+)?(new\s+)?/gi,
      /add\s+(a\s+)?(new\s+)?(feature|endpoint|route)/gi,
    ],
    weight: 1.0,
  },
  {
    type: 'debugging',
    patterns: [
      /fix\s+(the\s+)?(bug|error|issue|problem)/gi,
      /debug/gi,
      /why\s+(is|does|isn't|doesn't)/gi,
      /not\s+working/gi,
      /error\s+(message|when)/gi,
      /broken/gi,
      /crash(ing|es)?/gi,
    ],
    weight: 1.0,
  },
  {
    type: 'refactoring',
    patterns: [
      /refactor/gi,
      /clean\s*up/gi,
      /improve\s+(the\s+)?(code|structure|performance)/gi,
      /optimize/gi,
      /simplify/gi,
      /restructure/gi,
    ],
    weight: 1.0,
  },
  {
    type: 'security_review',
    patterns: [
      /security\s+(audit|review|check|scan)/gi,
      /vulnerabilit(y|ies)/gi,
      /penetration\s+test/gi,
      /secure\s+(the\s+)?/gi,
      /authentication/gi,
      /authorization/gi,
      /xss|csrf|sql\s*injection/gi,
    ],
    weight: 1.2,
  },
  {
    type: 'documentation',
    patterns: [
      /document(ation)?/gi,
      /write\s+(docs|documentation|readme)/gi,
      /add\s+comments/gi,
      /explain\s+(the\s+)?(code|function|class)/gi,
      /jsdoc|typedoc/gi,
    ],
    weight: 0.8,
  },
  {
    type: 'testing',
    patterns: [
      /write\s+(tests?|unit\s*tests?|integration\s*tests?)/gi,
      /test\s+(coverage|the|this)/gi,
      /add\s+tests?/gi,
      /jest|mocha|pytest|vitest/gi,
      /mock(ing)?/gi,
    ],
    weight: 1.0,
  },
  {
    type: 'deployment',
    patterns: [
      /deploy/gi,
      /ci\/cd/gi,
      /docker/gi,
      /kubernetes|k8s/gi,
      /pipeline/gi,
      /release/gi,
      /production/gi,
    ],
    weight: 1.0,
  },
  {
    type: 'data_analysis',
    patterns: [
      /analyze\s+(the\s+)?(data|logs|metrics)/gi,
      /find\s+(patterns?|trends?)/gi,
      /statistics/gi,
      /report/gi,
      /aggregate/gi,
    ],
    weight: 0.9,
  },
];

// ============================================
// SUSPICIOUS TOOL CHAIN PATTERNS
// ============================================

const SUSPICIOUS_CHAINS = [
  {
    name: 'read_sensitive_then_network',
    description: 'Read sensitive file then network command (potential exfiltration)',
    severity: 'critical' as SignalSeverity,
  },
  {
    name: 'read_env_then_write',
    description: 'Read .env then write elsewhere (potential data copy)',
    severity: 'high' as SignalSeverity,
  },
  {
    name: 'grep_secrets_then_bash',
    description: 'Grep for secrets then bash command',
    severity: 'high' as SignalSeverity,
  },
  {
    name: 'multiple_reads',
    description: 'Multiple file reads in sequence (potential reconnaissance)',
    severity: 'medium' as SignalSeverity,
  },
];

// Sensitive file patterns for chain detection
const SENSITIVE_FILE_PATTERNS = [
  /\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials/i,
  /secrets?\.(json|yaml|yml)/i,
  /\.aws\/credentials/i,
  /\.kube\/config/i,
];

// ============================================
// ML SECURITY ANALYZER CLASS
// ============================================

class MLSecurityAnalyzerClass {
  // Track tool sequences per execution
  private toolSequences: Map<string, Array<{
    tool: string;
    filePath?: string;
    command?: string;
    timestamp: Date;
  }>> = new Map();

  // Track error recovery attempts
  private errorRecoveries: Map<string, ErrorRecoveryAttempt[]> = new Map();

  // ==========================================
  // 1. TOOL CALL CHAINS
  // ==========================================

  /**
   * Track a tool call and detect suspicious sequences
   */
  trackToolCall(params: {
    taskId: string;
    executionId: string;
    toolName: string;
    toolInput: any;
  }): IMLSecuritySignal[] {
    const signals: IMLSecuritySignal[] = [];

    // Initialize sequence
    if (!this.toolSequences.has(params.executionId)) {
      this.toolSequences.set(params.executionId, []);
    }

    const sequence = this.toolSequences.get(params.executionId)!;

    // Extract info from tool input
    const filePath = params.toolInput?.file_path || params.toolInput?.path;
    const command = params.toolInput?.command;

    // Add to sequence
    sequence.push({
      tool: params.toolName,
      filePath,
      command,
      timestamp: new Date(),
    });

    // Need at least 2 tools to detect patterns
    if (sequence.length < 2) return signals;

    const lastTwo = sequence.slice(-2);

    // Pattern: Read sensitive file → Bash with network
    if (lastTwo[0].tool === 'Read' && lastTwo[1].tool === 'Bash') {
      const readPath = lastTwo[0].filePath || '';
      const bashCmd = lastTwo[1].command || '';

      const isSensitive = SENSITIVE_FILE_PATTERNS.some(p => p.test(readPath));
      const isNetwork = /curl|wget|nc|netcat|ssh|scp|rsync|ftp/i.test(bashCmd);

      if (isSensitive && isNetwork) {
        signals.push(this.createSignal({
          taskId: params.taskId,
          executionId: params.executionId,
          signalType: 'tool_chain',
          severity: 'critical',
          description: 'Potential exfiltration: Read sensitive file → network command',
          details: {
            pattern: 'read_sensitive_then_network',
            readFile: readPath,
            networkCommand: bashCmd.substring(0, 100),
            sequence: lastTwo.map(s => s.tool),
          },
        }));
      }
    }

    // Pattern: Read .env → Write elsewhere
    if (lastTwo[0].tool === 'Read' && lastTwo[1].tool === 'Write') {
      const readPath = lastTwo[0].filePath || '';
      const writePath = lastTwo[1].filePath || '';

      if (/\.env/i.test(readPath) && readPath !== writePath) {
        signals.push(this.createSignal({
          taskId: params.taskId,
          executionId: params.executionId,
          signalType: 'tool_chain',
          severity: 'high',
          description: 'Potential data copy: Read .env → write elsewhere',
          details: {
            pattern: 'read_env_then_write',
            readFile: readPath,
            writeFile: writePath,
            sequence: lastTwo.map(s => s.tool),
          },
        }));
      }
    }

    // Pattern: Multiple reads (reconnaissance)
    const recentReads = sequence.slice(-5).filter(s => s.tool === 'Read');
    if (recentReads.length >= 4) {
      signals.push(this.createSignal({
        taskId: params.taskId,
        executionId: params.executionId,
        signalType: 'tool_chain',
        severity: 'medium',
        description: 'Multiple file reads (potential reconnaissance)',
        details: {
          pattern: 'multiple_reads',
          fileCount: recentReads.length,
          files: recentReads.map(r => r.filePath).filter(Boolean),
        },
      }));
    }

    // Persist signals
    for (const signal of signals) {
      this.persistSignal(signal);
    }

    return signals;
  }

  /**
   * Get tool sequence for an execution
   */
  getToolSequence(executionId: string): string[] {
    return (this.toolSequences.get(executionId) || []).map(s => s.tool);
  }

  // ==========================================
  // 2. PROMPT CLASSIFICATION
  // ==========================================

  /**
   * Classify a prompt by task type
   */
  classifyPrompt(prompt: string): {
    primaryType: PromptType;
    confidence: number;
    allTypes: Array<{ type: PromptType; score: number }>;
  } {
    const scores = new Map<PromptType, number>();

    // Initialize
    for (const config of PROMPT_PATTERNS) {
      scores.set(config.type, 0);
    }

    // Score based on patterns
    for (const config of PROMPT_PATTERNS) {
      let matchCount = 0;
      for (const pattern of config.patterns) {
        const matches = prompt.match(pattern);
        if (matches) matchCount += matches.length;
      }
      if (matchCount > 0) {
        scores.set(config.type, (scores.get(config.type) || 0) + matchCount * config.weight);
      }
    }

    // Sort by score
    const allTypes = Array.from(scores.entries())
      .map(([type, score]) => ({ type, score }))
      .sort((a, b) => b.score - a.score);

    const topScore = allTypes[0].score;
    const primaryType = topScore > 0 ? allTypes[0].type : 'unknown';
    const totalScore = allTypes.reduce((sum, t) => sum + t.score, 0);
    const confidence = totalScore > 0 ? Math.round((topScore / totalScore) * 100) / 100 : 0;

    return {
      primaryType,
      confidence,
      allTypes: allTypes.filter(t => t.score > 0),
    };
  }

  /**
   * Record prompt classification
   */
  recordPromptClassification(params: {
    taskId: string;
    executionId: string;
    prompt: string;
  }): IMLSecuritySignal {
    const classification = this.classifyPrompt(params.prompt);

    const signal = this.createSignal({
      taskId: params.taskId,
      executionId: params.executionId,
      signalType: 'prompt_classification',
      severity: 'info',
      description: `Prompt classified as: ${classification.primaryType}`,
      details: {
        primaryType: classification.primaryType,
        confidence: classification.confidence,
        allTypes: classification.allTypes,
        promptLength: params.prompt.length,
        promptPreview: params.prompt.substring(0, 200),
      },
    });

    this.persistSignal(signal);
    return signal;
  }

  // ==========================================
  // 3. GIT CONTEXT
  // ==========================================

  /**
   * Capture git context for a workspace
   */
  async captureGitContext(workspacePath: string): Promise<GitContext> {
    const context: GitContext = {
      branch: 'unknown',
      hasUncommittedChanges: false,
      recentCommits: [],
      isDirty: false,
    };

    try {
      // Get branch
      const { stdout: branchOut } = await execAsync(
        'git rev-parse --abbrev-ref HEAD',
        { cwd: workspacePath, timeout: 5000 }
      );
      context.branch = branchOut.trim();

      // Check dirty state
      const { stdout: statusOut } = await execAsync(
        'git status --porcelain',
        { cwd: workspacePath, timeout: 5000 }
      );
      context.hasUncommittedChanges = statusOut.trim().length > 0;
      context.isDirty = context.hasUncommittedChanges;

      // Recent commits
      const { stdout: logOut } = await execAsync(
        'git log --oneline -n 3 --format="%s"',
        { cwd: workspacePath, timeout: 5000 }
      );
      context.recentCommits = logOut.trim().split('\n').filter(Boolean);

      // Ahead/behind
      try {
        const { stdout: abOut } = await execAsync(
          'git rev-list --left-right --count HEAD...@{upstream}',
          { cwd: workspacePath, timeout: 5000 }
        );
        const [ahead, behind] = abOut.trim().split('\t').map(Number);
        context.aheadBehind = { ahead, behind };
      } catch {
        // No upstream
      }
    } catch (error: any) {
      console.warn(`[MLSecurityAnalyzer] Git context error: ${error.message}`);
    }

    return context;
  }

  /**
   * Record git context
   */
  async recordGitContext(params: {
    taskId: string;
    executionId: string;
    workspacePath: string;
  }): Promise<IMLSecuritySignal> {
    const gitContext = await this.captureGitContext(params.workspacePath);

    const signal = this.createSignal({
      taskId: params.taskId,
      executionId: params.executionId,
      signalType: 'git_context',
      severity: 'info',
      description: `Git: ${gitContext.branch}${gitContext.isDirty ? ' (dirty)' : ''}`,
      details: gitContext,
    });

    this.persistSignal(signal);
    return signal;
  }

  // ==========================================
  // 4. ERROR RECOVERY PATTERNS
  // ==========================================

  /**
   * Track error recovery attempt
   */
  trackErrorRecovery(params: {
    taskId: string;
    executionId: string;
    error: string;
    errorType: string;
    recoveryAction: string;
    recoveryToolName: string;
    successful: boolean;
  }): void {
    if (!this.errorRecoveries.has(params.executionId)) {
      this.errorRecoveries.set(params.executionId, []);
    }

    const attempts = this.errorRecoveries.get(params.executionId)!;
    const attemptNumber = attempts.length + 1;

    attempts.push({
      error: params.error.substring(0, 500),
      errorType: params.errorType,
      recoveryAction: params.recoveryAction,
      recoveryToolName: params.recoveryToolName,
      successful: params.successful,
      attemptNumber,
      timestamp: new Date(),
    });

    // Record signal
    const signal = this.createSignal({
      taskId: params.taskId,
      executionId: params.executionId,
      signalType: 'error_recovery',
      severity: params.successful ? 'info' : 'medium',
      description: `Error recovery #${attemptNumber}: ${params.successful ? 'success' : 'failed'}`,
      details: {
        errorType: params.errorType,
        errorPreview: params.error.substring(0, 200),
        recoveryAction: params.recoveryAction,
        recoveryTool: params.recoveryToolName,
        successful: params.successful,
        attemptNumber,
      },
    });

    this.persistSignal(signal);
  }

  /**
   * Get error recovery history
   */
  getErrorRecoveryHistory(executionId: string): ErrorRecoveryAttempt[] {
    return this.errorRecoveries.get(executionId) || [];
  }

  // ==========================================
  // PERSISTENCE & RETRIEVAL
  // ==========================================

  private createSignal(params: {
    taskId: string;
    executionId?: string;
    signalType: SignalType;
    severity: SignalSeverity;
    description: string;
    details: Record<string, any>;
  }): IMLSecuritySignal {
    return {
      id: generateId(),
      taskId: params.taskId,
      executionId: params.executionId,
      signalType: params.signalType,
      severity: params.severity,
      description: params.description,
      details: params.details,
      detectedAt: new Date(),
    };
  }

  private persistSignal(signal: IMLSecuritySignal): void {
    try {
      const stmt = db.prepare(`
        INSERT INTO ml_security_signals (
          id, task_id, execution_id, signal_type, severity,
          description, details, detected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        signal.id,
        signal.taskId,
        signal.executionId || null,
        signal.signalType,
        signal.severity,
        signal.description,
        JSON.stringify(signal.details),
        signal.detectedAt.toISOString()
      );
    } catch (error: any) {
      // Table may not exist yet
      console.warn(`[MLSecurityAnalyzer] Persist error: ${error.message}`);
    }
  }

  /**
   * Get signals for a task
   */
  getSignalsForTask(taskId: string): IMLSecuritySignal[] {
    try {
      const stmt = db.prepare(`
        SELECT * FROM ml_security_signals WHERE task_id = ? ORDER BY detected_at ASC
      `);
      const rows = stmt.all(taskId) as any[];

      return rows.map(row => ({
        id: row.id,
        taskId: row.task_id,
        executionId: row.execution_id || undefined,
        signalType: row.signal_type as SignalType,
        severity: row.severity as SignalSeverity,
        description: row.description,
        details: JSON.parse(row.details || '{}'),
        detectedAt: new Date(row.detected_at),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get signal summary
   */
  getSignalSummary(taskId: string): {
    total: number;
    bySeverity: Record<SignalSeverity, number>;
    byType: Record<SignalType, number>;
  } {
    const signals = this.getSignalsForTask(taskId);

    const bySeverity: Record<SignalSeverity, number> = {
      critical: 0, high: 0, medium: 0, low: 0, info: 0,
    };
    const byType: Record<SignalType, number> = {
      tool_chain: 0, prompt_classification: 0, git_context: 0, error_recovery: 0,
    };

    for (const s of signals) {
      bySeverity[s.severity]++;
      byType[s.signalType]++;
    }

    return { total: signals.length, bySeverity, byType };
  }

  // ==========================================
  // CLEANUP
  // ==========================================

  /**
   * Clear tracking for an execution
   */
  clearExecution(executionId: string): void {
    this.toolSequences.delete(executionId);
    this.errorRecoveries.delete(executionId);
  }
}

export const mlSecurityAnalyzer = new MLSecurityAnalyzerClass();
export default mlSecurityAnalyzer;
