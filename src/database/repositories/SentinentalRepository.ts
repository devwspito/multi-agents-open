/**
 * Sentinental Training Data Repository
 *
 * SINGLE SOURCE OF TRUTH for Sentinental Core ML training data.
 * Stores PLATINO TRACE records locally before HTTP export.
 *
 * Data flow:
 * AgentSpy → SentinentalWebhook → PostgreSQL (here) → HTTP → Sentinental Core
 *
 * Benefits:
 * - Backup before sending (no data loss on HTTP failure)
 * - Offline analysis capability
 * - Clean unified structure for ML training
 * - Audit trail
 */

import { postgresService } from '../postgres/PostgresService.js';
import type { SecurityTrainingRecord } from '../../services/training/SentinentalWebhook.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface ISentinentalTrainingData {
  id: string;
  taskId: string;
  sessionId: string;
  phase: string;

  // Schema & Source
  schemaVersion: string;
  source: string;
  traceLevel: 'bronze' | 'silver' | 'gold' | 'platinum';
  agentType?: string;
  modelId?: string;

  // Vulnerabilities
  vulnerabilities: any[];
  vulnerabilitiesCount: number;

  // Execution Context
  executionContext: any;

  // PLATINO TRACE
  projectContext?: any;
  codeContext?: any;
  cvssLike?: any;
  taskHistory?: any;

  // Summary
  summary: any;
  riskScore: number;
  avgCvssScore?: number;
  blockedCount: number;

  // Export State
  sentToSentinental: boolean;
  sentAt?: Date;
  sendAttempts: number;
  lastError?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

interface SentinentalRow {
  id: string;
  task_id: string;
  session_id: string;
  phase: string;
  schema_version: string;
  source: string;
  trace_level: string;
  agent_type: string | null;
  model_id: string | null;
  vulnerabilities: any[];
  vulnerabilities_count: number;
  execution_context: any;
  project_context: any | null;
  code_context: any | null;
  cvss_like: any | null;
  task_history: any | null;
  summary: any;
  risk_score: number;
  avg_cvss_score: number | null;
  blocked_count: number;
  sent_to_sentinental: boolean;
  sent_at: Date | null;
  send_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SentinentalRow): ISentinentalTrainingData {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    phase: row.phase,
    schemaVersion: row.schema_version,
    source: row.source,
    traceLevel: row.trace_level as 'bronze' | 'silver' | 'gold' | 'platinum',
    agentType: row.agent_type || undefined,
    modelId: row.model_id || undefined,
    vulnerabilities: row.vulnerabilities || [],
    vulnerabilitiesCount: row.vulnerabilities_count,
    executionContext: row.execution_context || {},
    projectContext: row.project_context || undefined,
    codeContext: row.code_context || undefined,
    cvssLike: row.cvss_like || undefined,
    taskHistory: row.task_history || undefined,
    summary: row.summary || {},
    riskScore: row.risk_score,
    avgCvssScore: row.avg_cvss_score || undefined,
    blockedCount: row.blocked_count,
    sentToSentinental: row.sent_to_sentinental,
    sentAt: row.sent_at || undefined,
    sendAttempts: row.send_attempts,
    lastError: row.last_error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SentinentalRepository {
  /**
   * Create a new training data record
   */
  static async create(record: SecurityTrainingRecord): Promise<ISentinentalTrainingData> {
    const id = record.id || generateId();

    await postgresService.query(
      `INSERT INTO sentinental_training_data (
        id, task_id, session_id, phase,
        schema_version, source, trace_level, agent_type, model_id,
        vulnerabilities, vulnerabilities_count,
        execution_context,
        project_context, code_context, cvss_like, task_history,
        summary, risk_score, avg_cvss_score, blocked_count,
        sent_to_sentinental, send_attempts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        id,
        record.taskId,
        record.sessionId,
        record.phase,
        record.meta.schemaVersion,
        record.meta.source,
        record.meta.traceLevel,
        record.meta.agentType || null,
        record.meta.modelId || null,
        JSON.stringify(record.vulnerabilities),
        record.vulnerabilities.length,
        JSON.stringify(record.executionContext),
        record.projectContext ? JSON.stringify(record.projectContext) : null,
        record.codeContext ? JSON.stringify(record.codeContext) : null,
        record.cvssLike ? JSON.stringify(record.cvssLike) : null,
        record.taskHistory ? JSON.stringify(record.taskHistory) : null,
        JSON.stringify(record.summary),
        record.summary.riskScore,
        record.summary.avgCvssScore || null,
        record.summary.blocked,
        false,
        0,
      ]
    );

    return {
      id,
      taskId: record.taskId,
      sessionId: record.sessionId,
      phase: record.phase,
      schemaVersion: record.meta.schemaVersion,
      source: record.meta.source,
      traceLevel: record.meta.traceLevel,
      agentType: record.meta.agentType,
      modelId: record.meta.modelId,
      vulnerabilities: record.vulnerabilities,
      vulnerabilitiesCount: record.vulnerabilities.length,
      executionContext: record.executionContext,
      projectContext: record.projectContext,
      codeContext: record.codeContext,
      cvssLike: record.cvssLike,
      taskHistory: record.taskHistory,
      summary: record.summary,
      riskScore: record.summary.riskScore,
      avgCvssScore: record.summary.avgCvssScore,
      blockedCount: record.summary.blocked,
      sentToSentinental: false,
      sendAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Mark records as sent to Sentinental
   */
  static async markSent(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await postgresService.query(
      `UPDATE sentinental_training_data
       SET sent_to_sentinental = true, sent_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1)`,
      [ids]
    );
  }

  /**
   * Mark a send attempt failed
   */
  static async markSendFailed(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;

    await postgresService.query(
      `UPDATE sentinental_training_data
       SET send_attempts = send_attempts + 1, last_error = $1, updated_at = NOW()
       WHERE id = ANY($2)`,
      [error, ids]
    );
  }

  /**
   * Find records pending send to Sentinental
   */
  static async findPending(limit: number = 100): Promise<ISentinentalTrainingData[]> {
    const result = await postgresService.query<SentinentalRow>(
      `SELECT * FROM sentinental_training_data
       WHERE sent_to_sentinental = false
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Find all records for a task
   */
  static async findByTaskId(taskId: string): Promise<ISentinentalTrainingData[]> {
    const result = await postgresService.query<SentinentalRow>(
      `SELECT * FROM sentinental_training_data
       WHERE task_id = $1
       ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Find record by ID
   */
  static async findById(id: string): Promise<ISentinentalTrainingData | null> {
    const result = await postgresService.query<SentinentalRow>(
      'SELECT * FROM sentinental_training_data WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Get statistics
   */
  static async getStats(): Promise<{
    total: number;
    sent: number;
    pending: number;
    failed: number;
    totalVulnerabilities: number;
    byTraceLevel: Record<string, number>;
    avgRiskScore: number;
  }> {
    const statsResult = await postgresService.query<{
      total: string;
      sent: string;
      pending: string;
      failed: string;
      total_vulns: string;
      avg_risk: string;
    }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN sent_to_sentinental = true THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN sent_to_sentinental = false AND send_attempts = 0 THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN sent_to_sentinental = false AND send_attempts > 0 THEN 1 ELSE 0 END) as failed,
        SUM(vulnerabilities_count) as total_vulns,
        AVG(risk_score) as avg_risk
      FROM sentinental_training_data
    `);
    const stats = statsResult.rows[0];

    const traceLevelResult = await postgresService.query<{ trace_level: string; count: string }>(`
      SELECT trace_level, COUNT(*) as count
      FROM sentinental_training_data
      GROUP BY trace_level
    `);
    const byTraceLevel: Record<string, number> = {};
    for (const row of traceLevelResult.rows) {
      byTraceLevel[row.trace_level] = parseInt(row.count, 10);
    }

    return {
      total: parseInt(stats.total, 10) || 0,
      sent: parseInt(stats.sent, 10) || 0,
      pending: parseInt(stats.pending, 10) || 0,
      failed: parseInt(stats.failed, 10) || 0,
      totalVulnerabilities: parseInt(stats.total_vulns, 10) || 0,
      byTraceLevel,
      avgRiskScore: Math.round(parseFloat(stats.avg_risk) || 0),
    };
  }

  /**
   * Find records for training export
   */
  static async findForExport(options: {
    startDate?: string;
    endDate?: string;
    traceLevel?: string;
    minRiskScore?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<ISentinentalTrainingData[]> {
    let query = 'SELECT * FROM sentinental_training_data WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options.startDate) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(options.startDate);
      paramIndex++;
    }
    if (options.endDate) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(options.endDate);
      paramIndex++;
    }
    if (options.traceLevel) {
      query += ` AND trace_level = $${paramIndex}`;
      params.push(options.traceLevel);
      paramIndex++;
    }
    if (options.minRiskScore !== undefined) {
      query += ` AND risk_score >= $${paramIndex}`;
      params.push(options.minRiskScore);
      paramIndex++;
    }

    query += ' ORDER BY created_at ASC';

    if (options.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }
    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await postgresService.query<SentinentalRow>(query, params);
    return result.rows.map(mapRow);
  }

  /**
   * Convert to SecurityTrainingRecord format for HTTP send
   */
  static toTrainingRecord(data: ISentinentalTrainingData): SecurityTrainingRecord {
    return {
      id: data.id,
      taskId: data.taskId,
      sessionId: data.sessionId,
      timestamp: data.createdAt.toISOString(),
      phase: data.phase,
      meta: {
        schemaVersion: data.schemaVersion as '3.0',
        source: data.source as 'open-multi-agents',
        recordType: 'security',
        agentType: data.agentType,
        modelId: data.modelId,
        traceLevel: data.traceLevel,
      },
      vulnerabilities: data.vulnerabilities,
      executionContext: data.executionContext,
      projectContext: data.projectContext,
      codeContext: data.codeContext,
      cvssLike: data.cvssLike,
      taskHistory: data.taskHistory,
      summary: data.summary,
    };
  }

  /**
   * Delete old sent records (cleanup)
   */
  static async deleteOldSentRecords(olderThanDays: number = 30): Promise<number> {
    const result = await postgresService.query(
      `DELETE FROM sentinental_training_data
       WHERE sent_to_sentinental = true
         AND sent_at < NOW() - INTERVAL '1 day' * $1`,
      [olderThanDays]
    );
    return result.rowCount ?? 0;
  }
}

export default SentinentalRepository;
