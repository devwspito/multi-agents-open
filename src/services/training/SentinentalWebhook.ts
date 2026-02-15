/**
 * Sentinental Core Webhook
 *
 * Pushes SECURITY data to Sentinental Core for ML training.
 * Only sends data when AgentSpy detects vulnerabilities.
 *
 * Sentinental Core entrena modelos para detectar:
 * - Comandos peligrosos
 * - Exposición de secretos
 * - Path traversal
 * - Code injection
 * - Loops infinitos
 * - etc.
 *
 * PLATINO TRACE: Includes full context for 4 Sentinental models:
 * - ProjectContext: Language, framework, dependencies
 * - CodeContext: Expanded code with surrounding lines
 * - CVSSLike: Vulnerability scoring metrics
 * - TaskHistory: Previous phases and recurring patterns
 */

import { agentSpy, Vulnerability } from '../security/AgentSpy.js';
import { SentinentalRepository } from '../../database/repositories/SentinentalRepository.js';

// ============================================
// PLATINO TRACE INTERFACES
// ============================================

/**
 * Project context for ML training
 * Helps Devstral understand the technology stack being exploited
 * Helps GLM 4.7 design framework-specific defenses
 */
export interface ProjectContext {
  /** Primary programming language */
  language: string;
  /** Framework being used (express, react, django, etc.) */
  framework?: string;
  /** Package manager (npm, pip, cargo, etc.) */
  packageManager?: string;
  /** Key dependencies relevant to security */
  dependencies: Array<{
    name: string;
    version?: string;
    /** Known CVEs for this version */
    knownCves?: string[];
  }>;
  /** Project type (api, webapp, cli, library) */
  projectType?: string;
  /** Node version, Python version, etc. */
  runtimeVersion?: string;
  /** Build tools (webpack, vite, esbuild) */
  buildTools?: string[];
}

/**
 * Expanded code context for ML training
 * Provides Devstral with exploitable code patterns
 * Provides GLM 4.7 with context for surgical fixes
 */
export interface CodeContext {
  /** Full file content (truncated if > 10KB) */
  fileContent?: string;
  /** Lines before the vulnerability (context) */
  linesBefore: string[];
  /** The vulnerable line(s) */
  vulnerableLines: string[];
  /** Lines after the vulnerability (context) */
  linesAfter: string[];
  /** Import statements in the file */
  imports: string[];
  /** Function/class name containing the vulnerability */
  containingFunction?: string;
  /** Class name if applicable */
  containingClass?: string;
  /** AST node type if determinable */
  astNodeType?: string;
  /** Related files that might be affected */
  relatedFiles?: string[];
}

/**
 * CVSS-like scoring for ML training
 * Helps Nemotron (Judge) evaluate severity accurately
 * Based on CVSS v3.1 but simplified for agent context
 */
export interface CVSSLike {
  /** How the vulnerability is exploited: network, adjacent, local, physical */
  attackVector: 'network' | 'adjacent' | 'local' | 'physical';
  /** How complex is the attack: low (easy), high (needs specific conditions) */
  attackComplexity: 'low' | 'high';
  /** What privileges does attacker need: none, low, high */
  privilegesRequired: 'none' | 'low' | 'high';
  /** Is user interaction required: none, required */
  userInteraction: 'none' | 'required';
  /** Scope: unchanged (same context), changed (affects other components) */
  scope: 'unchanged' | 'changed';
  /** Impact on confidentiality: none, low, high */
  confidentialityImpact: 'none' | 'low' | 'high';
  /** Impact on integrity: none, low, high */
  integrityImpact: 'none' | 'low' | 'high';
  /** Impact on availability: none, low, high */
  availabilityImpact: 'none' | 'low' | 'high';
  /** Calculated base score 0.0-10.0 */
  baseScore: number;
  /** Severity string based on score */
  severityRating: 'none' | 'low' | 'medium' | 'high' | 'critical';
  /** Exploitability sub-score */
  exploitabilityScore: number;
  /** Impact sub-score */
  impactScore: number;
}

/**
 * Task history for pattern detection
 * Helps Qwen3 (Chronicler) identify recurring vulnerabilities
 * Helps detect if fixes are actually working
 */
export interface TaskHistory {
  /** Phases completed before this one */
  completedPhases: Array<{
    name: string;
    success: boolean;
    vulnerabilitiesDetected: number;
  }>;
  /** Previous vulnerabilities in this task */
  previousVulnerabilities: Array<{
    type: string;
    severity: string;
    phase: string;
    wasBlocked: boolean;
    wasFixed: boolean;
  }>;
  /** Is this a recurring vulnerability pattern? */
  isRecurring: boolean;
  /** How many times has this pattern appeared? */
  recurrenceCount: number;
  /** Task retry count */
  retryCount: number;
  /** Time since task started (ms) */
  taskElapsedMs: number;
  /** Total tool calls in task so far */
  totalToolCalls: number;
  /** Total turns in task so far */
  totalTurns: number;
}

// ============================================
// EXECUTION CONTEXT
// ============================================

/**
 * Execution context when vulnerability was detected
 */
export interface ExecutionContext {
  /** The prompt being executed */
  prompt: string;
  /** Current turn number */
  turnNumber: number;
  /** Tool calls made up to this point */
  toolCalls: Array<{
    toolName: string;
    toolInput: any;
    toolOutput?: any;
    success: boolean;
    timestamp: string;
  }>;
  /** The event that triggered the detection */
  triggerEvent: {
    type: string;
    tool?: string;
    args?: any;
    result?: any;
    messageContent?: string;
  };
  /** Model output up to this point */
  partialOutput: string;
  /** Time since execution started (ms) */
  elapsedMs: number;
}

/**
 * Security training record for Sentinental Core - PLATINO TRACE
 *
 * This is the JSON structure that feeds the 4 Sentinental models:
 * - Devstral (Atacante): Uses vulnerabilities + codeContext + projectContext to generate exploits
 * - GLM 4.7 (Defensor): Uses OWASP/CWE + recommendation + projectContext to design fixes
 * - Nemotron (Juez): Uses summary + cvssLike to validate if defense succeeds
 * - Qwen3 (Cronista): Uses full context + taskHistory to extract lessons learned
 */
export interface SecurityTrainingRecord {
  /** Unique record ID */
  id: string;
  /** Task ID from orchestration */
  taskId: string;
  /** OpenCode session ID */
  sessionId: string;
  /** ISO timestamp when record was created */
  timestamp: string;
  /** Phase name (e.g., "DevelopersPhase") */
  phase: string;

  /** Metadata for Sentinental */
  meta: {
    /** Schema version for compatibility */
    schemaVersion: '3.0'; // UPGRADED for platino
    /** Source system identifier */
    source: 'open-multi-agents';
    /** Record type */
    recordType: 'security';
    /** Agent type that was executing */
    agentType?: string;
    /** Model ID used (if known) */
    modelId?: string;
    /** Trace quality level */
    traceLevel: 'bronze' | 'silver' | 'gold' | 'platinum';
  };

  /** Vulnerabilities detected by AgentSpy - with OWASP/CWE enrichment */
  vulnerabilities: Vulnerability[];

  /** Execution context when vulnerability was detected - CRITICAL for ML */
  executionContext: ExecutionContext;

  // ============================================
  // PLATINO TRACE FIELDS
  // ============================================

  /** Project context - technology stack info for Devstral & GLM 4.7 */
  projectContext?: ProjectContext;

  /** Code context - expanded code for exploit generation & fix design */
  codeContext?: CodeContext;

  /** CVSS-like scoring - structured severity for Nemotron */
  cvssLike?: CVSSLike;

  /** Task history - pattern detection for Qwen3 */
  taskHistory?: TaskHistory;

  /** Summary stats for the Juez (Nemotron) */
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    /** OWASP categories found */
    byOwasp: Record<string, number>;
    /** CWE IDs found */
    byCwe: Record<string, number>;
    blocked: number;
    /** Risk score 0-100 */
    riskScore: number;
    /** CVSS average score if available */
    avgCvssScore?: number;
    /** Is this a recurring pattern? */
    hasRecurringPatterns: boolean;
  };
}

export interface SentinentalConfig {
  /** Sentinental Core endpoint URL */
  url: string;
  /** API key for authentication */
  apiKey?: string;
  /** Batch size before auto-flush */
  batchSize?: number;
  /** Flush interval in milliseconds */
  flushIntervalMs?: number;
  /** Enable/disable webhook */
  enabled?: boolean;
  /** Minimum severity to send: 'low' | 'medium' | 'high' | 'critical' */
  minSeverity?: 'low' | 'medium' | 'high' | 'critical';
}

const SEVERITY_LEVELS = { low: 1, medium: 2, high: 3, critical: 4 };

class SentinentalWebhookService {
  private config: SentinentalConfig;
  private buffer: SecurityTrainingRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.config = {
      url: process.env.SENTINENTAL_URL || 'http://localhost:8081/api/training/ingest',
      apiKey: process.env.SENTINENTAL_API_KEY,
      batchSize: parseInt(process.env.SENTINENTAL_BATCH_SIZE || '10'),
      flushIntervalMs: parseInt(process.env.SENTINENTAL_FLUSH_INTERVAL || '30000'),
      enabled: process.env.SENTINENTAL_ENABLED === 'true',
      minSeverity: (process.env.SENTINENTAL_MIN_SEVERITY as any) || 'low',
    };

    if (this.config.enabled) {
      this.startFlushTimer();
      console.log(`[Sentinental] Webhook enabled → ${this.config.url} (minSeverity: ${this.config.minSeverity})`);
    }
  }

  /**
   * Update configuration
   */
  configure(config: Partial<SentinentalConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };

    if (!wasEnabled && this.config.enabled) {
      this.startFlushTimer();
      console.log(`[Sentinental] Webhook enabled → ${this.config.url}`);
    } else if (wasEnabled && !this.config.enabled) {
      this.stopFlushTimer();
      console.log('[Sentinental] Webhook disabled');
    }
  }

  /**
   * Push security data when vulnerabilities are detected - PLATINO TRACE
   * Called from Phase.execute() after AgentSpy analysis
   * NOW INCLUDES FULL EXECUTION CONTEXT + PLATINO FIELDS for ML training
   */
  async pushSecurityData(
    taskId: string,
    sessionId: string,
    phase: string,
    vulnerabilities: Vulnerability[],
    executionContext: ExecutionContext,
    meta?: { agentType?: string; modelId?: string },
    platino?: {
      projectContext?: ProjectContext;
      codeContext?: CodeContext;
      taskHistory?: TaskHistory;
    }
  ): Promise<void> {
    // 🔥 ALWAYS save to PostgreSQL, even if external webhook is disabled
    // The enabled flag only controls HTTP sending to external Sentinental server
    if (vulnerabilities.length === 0) return;

    // Filter by minimum severity
    const minLevel = SEVERITY_LEVELS[this.config.minSeverity || 'low'];
    const filtered = vulnerabilities.filter(v => SEVERITY_LEVELS[v.severity] >= minLevel);

    if (filtered.length === 0) {
      console.log(`[Sentinental] Skipped ${vulnerabilities.length} vulns (below minSeverity: ${this.config.minSeverity})`);
      return;
    }

    // Calculate CVSS-like scores for each vulnerability
    const cvssScores = filtered.map(v => this.calculateCVSSLike(v));
    const avgCvssScore = cvssScores.length > 0
      ? cvssScores.reduce((sum, c) => sum + c.baseScore, 0) / cvssScores.length
      : 0;

    // Determine trace level based on available data
    const traceLevel = this.determineTraceLevel(platino, executionContext);

    // Build training record WITH FULL CONTEXT for Sentinental's 4 models
    const record: SecurityTrainingRecord = {
      id: this.generateId(),
      taskId,
      sessionId,
      timestamp: new Date().toISOString(),
      phase,
      meta: {
        schemaVersion: '3.0',
        source: 'open-multi-agents',
        recordType: 'security',
        agentType: meta?.agentType,
        modelId: meta?.modelId,
        traceLevel,
      },
      vulnerabilities: filtered,
      executionContext, // CRITICAL: What was happening when vulnerability was detected

      // PLATINO FIELDS
      projectContext: platino?.projectContext,
      codeContext: platino?.codeContext,
      cvssLike: cvssScores.length > 0 ? this.aggregateCVSS(cvssScores) : undefined,
      taskHistory: platino?.taskHistory,

      summary: this.buildSummary(filtered, avgCvssScore, platino?.taskHistory),
    };

    // 🔥 ALWAYS PERSIST TO POSTGRESQL (training data is always valuable)
    try {
      await SentinentalRepository.create(record);
      console.log(`[Sentinental] ✅ Persisted record ${record.id} to PostgreSQL (${filtered.length} vulnerabilities, risk: ${record.summary.riskScore})`);
    } catch (dbError: any) {
      console.warn(`[Sentinental] PostgreSQL persist failed: ${dbError.message}`);
    }

    // Only buffer for HTTP send if external webhook is enabled
    if (this.config.enabled) {
      this.buffer.push(record);
      console.log(`[Sentinental] Buffered for HTTP send (${this.buffer.length}/${this.config.batchSize})`);

      // Auto-flush if batch size reached
      if (this.buffer.length >= (this.config.batchSize || 10)) {
        await this.flush();
      }
    }
  }

  /**
   * Calculate CVSS-like score for a vulnerability
   * Based on CVSS v3.1 simplified for agent context
   */
  private calculateCVSSLike(vuln: Vulnerability): CVSSLike {
    // Determine attack vector based on vulnerability type
    let attackVector: CVSSLike['attackVector'] = 'local';
    if (['network_attack', 'ssrf', 'open_redirect', 'api_exposure'].includes(vuln.type)) {
      attackVector = 'network';
    } else if (['supply_chain', 'dependency_confusion'].includes(vuln.type)) {
      attackVector = 'network';
    }

    // Attack complexity based on pattern
    const attackComplexity: CVSSLike['attackComplexity'] =
      ['code_injection', 'prompt_injection', 'deserialization'].includes(vuln.type) ? 'high' : 'low';

    // Privileges required based on severity
    let privilegesRequired: CVSSLike['privilegesRequired'] = 'low';
    if (vuln.type === 'privilege_escalation' || vuln.type === 'container_escape') {
      privilegesRequired = 'low'; // Starts with low, escalates
    } else if (['dangerous_command', 'file_operation'].includes(vuln.type)) {
      privilegesRequired = 'none'; // Agent already has these
    }

    // User interaction
    const userInteraction: CVSSLike['userInteraction'] =
      ['social_engineering', 'phishing'].includes(vuln.type) ? 'required' : 'none';

    // Scope - does it affect other components?
    const scope: CVSSLike['scope'] =
      ['container_escape', 'privilege_escalation', 'persistence'].includes(vuln.type) ? 'changed' : 'unchanged';

    // Impact based on severity and type
    let confidentialityImpact: CVSSLike['confidentialityImpact'] = 'none';
    let integrityImpact: CVSSLike['integrityImpact'] = 'none';
    let availabilityImpact: CVSSLike['availabilityImpact'] = 'none';

    if (vuln.severity === 'critical') {
      confidentialityImpact = 'high';
      integrityImpact = 'high';
      availabilityImpact = 'high';
    } else if (vuln.severity === 'high') {
      if (['secret_exposure', 'credential_leak', 'path_traversal'].includes(vuln.type)) {
        confidentialityImpact = 'high';
      }
      if (['code_injection', 'file_operation', 'dangerous_command'].includes(vuln.type)) {
        integrityImpact = 'high';
      }
      if (['infinite_loop', 'resource_exhaustion', 'dos'].includes(vuln.type)) {
        availabilityImpact = 'high';
      }
    } else if (vuln.severity === 'medium') {
      confidentialityImpact = 'low';
      integrityImpact = 'low';
    }

    // Calculate scores using CVSS v3.1 formulas (simplified)
    const exploitabilityScore = this.calcExploitability(
      attackVector, attackComplexity, privilegesRequired, userInteraction
    );
    const impactScore = this.calcImpact(
      confidentialityImpact, integrityImpact, availabilityImpact, scope
    );

    let baseScore = 0;
    if (impactScore > 0) {
      if (scope === 'unchanged') {
        baseScore = Math.min(impactScore + exploitabilityScore, 10);
      } else {
        baseScore = Math.min(1.08 * (impactScore + exploitabilityScore), 10);
      }
    }
    baseScore = Math.round(baseScore * 10) / 10;

    // Severity rating
    let severityRating: CVSSLike['severityRating'] = 'none';
    if (baseScore >= 9.0) severityRating = 'critical';
    else if (baseScore >= 7.0) severityRating = 'high';
    else if (baseScore >= 4.0) severityRating = 'medium';
    else if (baseScore >= 0.1) severityRating = 'low';

    return {
      attackVector,
      attackComplexity,
      privilegesRequired,
      userInteraction,
      scope,
      confidentialityImpact,
      integrityImpact,
      availabilityImpact,
      baseScore,
      severityRating,
      exploitabilityScore: Math.round(exploitabilityScore * 10) / 10,
      impactScore: Math.round(impactScore * 10) / 10,
    };
  }

  /**
   * Calculate exploitability sub-score (CVSS v3.1)
   */
  private calcExploitability(
    av: CVSSLike['attackVector'],
    ac: CVSSLike['attackComplexity'],
    pr: CVSSLike['privilegesRequired'],
    ui: CVSSLike['userInteraction']
  ): number {
    const AV = { network: 0.85, adjacent: 0.62, local: 0.55, physical: 0.2 };
    const AC = { low: 0.77, high: 0.44 };
    const PR = { none: 0.85, low: 0.62, high: 0.27 };
    const UI = { none: 0.85, required: 0.62 };

    return 8.22 * AV[av] * AC[ac] * PR[pr] * UI[ui];
  }

  /**
   * Calculate impact sub-score (CVSS v3.1)
   */
  private calcImpact(
    c: CVSSLike['confidentialityImpact'],
    i: CVSSLike['integrityImpact'],
    a: CVSSLike['availabilityImpact'],
    scope: CVSSLike['scope']
  ): number {
    const IMPACT = { none: 0, low: 0.22, high: 0.56 };
    const iscBase = 1 - ((1 - IMPACT[c]) * (1 - IMPACT[i]) * (1 - IMPACT[a]));

    if (scope === 'unchanged') {
      return 6.42 * iscBase;
    } else {
      return 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15);
    }
  }

  /**
   * Aggregate multiple CVSS scores into one representative
   */
  private aggregateCVSS(scores: CVSSLike[]): CVSSLike {
    if (scores.length === 0) {
      return {
        attackVector: 'local',
        attackComplexity: 'low',
        privilegesRequired: 'none',
        userInteraction: 'none',
        scope: 'unchanged',
        confidentialityImpact: 'none',
        integrityImpact: 'none',
        availabilityImpact: 'none',
        baseScore: 0,
        severityRating: 'none',
        exploitabilityScore: 0,
        impactScore: 0,
      };
    }

    // Return the highest severity score
    return scores.reduce((worst, current) =>
      current.baseScore > worst.baseScore ? current : worst
    );
  }

  /**
   * Determine trace level based on available data
   */
  private determineTraceLevel(
    platino?: { projectContext?: ProjectContext; codeContext?: CodeContext; taskHistory?: TaskHistory },
    executionContext?: ExecutionContext
  ): 'bronze' | 'silver' | 'gold' | 'platinum' {
    let score = 0;

    // Bronze: Basic vulnerability info (always present)
    score += 1;

    // Silver: Has execution context
    if (executionContext && executionContext.toolCalls.length > 0) {
      score += 1;
    }

    // Gold: Has project context
    if (platino?.projectContext) {
      score += 1;
    }

    // Platinum: Has code context AND task history
    if (platino?.codeContext && platino?.taskHistory) {
      score += 1;
    }

    if (score >= 4) return 'platinum';
    if (score >= 3) return 'gold';
    if (score >= 2) return 'silver';
    return 'bronze';
  }

  /**
   * Legacy push method - now fetches from AgentSpy
   * 🔥 ALWAYS saves to PostgreSQL for training data, even if external webhook is disabled
   * @deprecated Use pushSecurityData with executionContext instead
   */
  async push(taskId: string): Promise<void> {
    // 🔥 Always save to PostgreSQL, even if external webhook is disabled
    // The enabled flag only controls sending to external Sentinental server
    const summary = agentSpy.getSummary(taskId);
    if (summary.vulnerabilities.length === 0) {
      console.log(`[Sentinental] Skipped task ${taskId} (no vulnerabilities detected)`);
      return;
    }

    console.warn(`[Sentinental] Using legacy push() without execution context - data quality reduced`);

    // Group by session
    const bySession = new Map<string, Vulnerability[]>();
    for (const v of summary.vulnerabilities) {
      const existing = bySession.get(v.sessionId) || [];
      existing.push(v);
      bySession.set(v.sessionId, existing);
    }

    // Create records per session with minimal context
    for (const [sessionId, vulns] of bySession) {
      const minimalContext: ExecutionContext = {
        prompt: '[Context not captured - legacy call]',
        turnNumber: 0,
        toolCalls: [],
        triggerEvent: { type: 'unknown' },
        partialOutput: '',
        elapsedMs: 0,
      };
      await this.pushSecurityData(taskId, sessionId, vulns[0]?.phase || 'unknown', vulns, minimalContext);
    }
  }

  /**
   * Flush buffered data to Sentinental Core
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    const batchIds = batch.map(r => r.id);
    this.buffer = [];

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
        },
        body: batch.map(r => JSON.stringify(r)).join('\n'),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const totalVulns = batch.reduce((sum, r) => sum + r.vulnerabilities.length, 0);
      console.log(`[Sentinental] Pushed ${batch.length} records (${totalVulns} vulnerabilities) to DGX Spark`);

      // Mark as sent in PostgreSQL
      try {
        await SentinentalRepository.markSent(batchIds);
      } catch (dbError: any) {
        console.warn(`[Sentinental] Failed to mark records as sent in PostgreSQL: ${dbError.message}`);
      }
    } catch (error: any) {
      // Re-buffer on failure
      this.buffer = [...batch, ...this.buffer];
      console.error(`[Sentinental] Push failed, ${batch.length} records re-buffered: ${error.message}`);

      // Mark send attempt failed in PostgreSQL
      try {
        await SentinentalRepository.markSendFailed(batchIds, error.message);
      } catch (dbError: any) {
        console.warn(`[Sentinental] Failed to mark send failure in PostgreSQL: ${dbError.message}`);
      }
    }
  }

  /**
   * Get current status (includes PostgreSQL stats)
   */
  async getStatus(): Promise<{
    enabled: boolean;
    url: string;
    bufferedRecords: number;
    batchSize: number;
    minSeverity: string;
    postgres: {
      total: number;
      sent: number;
      pending: number;
      failed: number;
    };
  }> {
    let postgresStats = { total: 0, sent: 0, pending: 0, failed: 0 };
    try {
      const stats = await SentinentalRepository.getStats();
      postgresStats = {
        total: stats.total,
        sent: stats.sent,
        pending: stats.pending,
        failed: stats.failed,
      };
    } catch {
      // Table may not exist yet
    }

    return {
      enabled: this.config.enabled || false,
      url: this.config.url,
      bufferedRecords: this.buffer.length,
      batchSize: this.config.batchSize || 10,
      minSeverity: this.config.minSeverity || 'low',
      postgres: postgresStats,
    };
  }

  /**
   * Retry sending failed records from PostgreSQL
   */
  async retryFailed(limit: number = 50): Promise<{ sent: number; failed: number }> {
    if (!this.config.enabled) return { sent: 0, failed: 0 };

    try {
      const pendingRecords = await SentinentalRepository.findPending(limit);
      if (pendingRecords.length === 0) {
        console.log('[Sentinental] No pending records to retry');
        return { sent: 0, failed: 0 };
      }

      // Convert back to SecurityTrainingRecord format
      const records = pendingRecords.map(r => SentinentalRepository.toTrainingRecord(r));
      const recordIds = pendingRecords.map(r => r.id);

      // Send to Sentinental
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
        },
        body: records.map(r => JSON.stringify(r)).join('\n'),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Mark as sent
      await SentinentalRepository.markSent(recordIds);
      console.log(`[Sentinental] Retry successful: ${recordIds.length} records sent`);
      return { sent: recordIds.length, failed: 0 };
    } catch (error: any) {
      console.error(`[Sentinental] Retry failed: ${error.message}`);
      return { sent: 0, failed: 1 };
    }
  }

  private buildSummary(
    vulnerabilities: Vulnerability[],
    avgCvssScore?: number,
    taskHistory?: TaskHistory
  ): SecurityTrainingRecord['summary'] {
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byOwasp: Record<string, number> = {};
    const byCwe: Record<string, number> = {};
    let blocked = 0;
    let riskScore = 0;

    for (const v of vulnerabilities) {
      // Severity counts
      bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;

      // Type counts
      byType[v.type] = (byType[v.type] || 0) + 1;

      // Category counts
      if (v.category) {
        byCategory[v.category] = (byCategory[v.category] || 0) + 1;
      }

      // OWASP counts (for Defensor)
      if (v.owaspCategory) {
        byOwasp[v.owaspCategory] = (byOwasp[v.owaspCategory] || 0) + 1;
      }

      // CWE counts (for Atacante)
      if (v.cweId) {
        byCwe[v.cweId] = (byCwe[v.cweId] || 0) + 1;
      }

      // Blocked count
      if (v.blocked) blocked++;

      // Risk score calculation
      switch (v.severity) {
        case 'critical': riskScore += 25; break;
        case 'high': riskScore += 15; break;
        case 'medium': riskScore += 5; break;
        case 'low': riskScore += 1; break;
      }
    }

    // Determine if there are recurring patterns
    const hasRecurringPatterns = taskHistory?.isRecurring || (taskHistory?.recurrenceCount ?? 0) > 1;

    return {
      total: vulnerabilities.length,
      bySeverity,
      byType,
      byCategory,
      byOwasp,
      byCwe,
      blocked,
      riskScore: Math.min(100, riskScore),
      avgCvssScore: avgCvssScore ? Math.round(avgCvssScore * 10) / 10 : undefined,
      hasRecurringPatterns: hasRecurringPatterns || false,
    };
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `sec_${timestamp}_${random}`;
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        console.error(`[Sentinental] Flush timer error: ${err.message}`);
      });
    }, this.config.flushIntervalMs || 30000);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Shutdown - flush remaining data
   */
  async shutdown(): Promise<void> {
    this.stopFlushTimer();
    if (this.buffer.length > 0) {
      console.log(`[Sentinental] Flushing ${this.buffer.length} remaining records...`);
      await this.flush();
    }
  }
}

export const sentinentalWebhook = new SentinentalWebhookService();
export default sentinentalWebhook;
