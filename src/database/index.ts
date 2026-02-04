/**
 * Database Layer for Open Multi-Agents
 *
 * SQLite database for:
 * - User authentication & GitHub tokens
 * - Projects & repositories
 * - Task orchestration state
 * - Agent execution tracking (for ML training)
 * - Turn-by-turn data capture
 * - Tool call granular tracking
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database path
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'app.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create database connection
const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Initialize all database tables
 */
export function initializeDatabase(): void {
  console.log('[Database] Initializing SQLite database at:', DB_PATH);

  // ============================================
  // USERS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry TEXT,
      default_api_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

  // ============================================
  // OAUTH STATES TABLE (CSRF protection)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY,
      state TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state)`);

  // ============================================
  // PROJECTS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'web-app',
      status TEXT DEFAULT 'planning',
      user_id TEXT NOT NULL,
      api_key TEXT,
      settings TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active)`);

  // ============================================
  // REPOSITORIES TABLE (matches agents-software-arq)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      project_id TEXT NOT NULL,
      github_repo_url TEXT NOT NULL,
      github_repo_name TEXT NOT NULL,
      github_branch TEXT DEFAULT 'main',
      type TEXT NOT NULL,
      path_patterns TEXT,
      execution_order INTEGER,
      dependencies TEXT,
      env_variables TEXT,
      is_active INTEGER DEFAULT 1,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repositories_project_id ON repositories(project_id)`);

  // ============================================
  // TASKS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      user_id TEXT NOT NULL,
      project_id TEXT,
      repository_id TEXT,
      status TEXT DEFAULT 'pending',
      orchestration TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);

  // ============================================
  // AGENT EXECUTIONS TABLE (ML Training)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      model_id TEXT NOT NULL,
      phase_name TEXT,
      prompt TEXT NOT NULL,
      final_output TEXT,
      status TEXT DEFAULT 'running',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      turns_completed INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error_message TEXT,
      error_type TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_task ON agent_executions(task_id)`);

  // ============================================
  // AGENT TURNS TABLE (ML Training)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      turn_type TEXT DEFAULT 'assistant',
      message_content TEXT,
      has_tool_calls INTEGER DEFAULT 0,
      tool_calls_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (execution_id) REFERENCES agent_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_execution ON agent_turns(execution_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_task ON agent_turns(task_id)`);

  // ============================================
  // TOOL CALLS TABLE (ML Training)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_use_id TEXT,
      tool_input TEXT,
      tool_input_summary TEXT,
      tool_output TEXT,
      tool_success INTEGER DEFAULT 1,
      tool_error TEXT,
      file_path TEXT,
      bash_command TEXT,
      bash_exit_code INTEGER,
      duration_ms INTEGER,
      call_order INTEGER DEFAULT 0,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (execution_id) REFERENCES agent_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_toolcalls_execution ON tool_calls(execution_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_toolcalls_turn ON tool_calls(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls(task_id)`);

  // ============================================
  // ML SECURITY SIGNALS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS ml_security_signals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT,
      signal_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      detected_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (execution_id) REFERENCES agent_executions(id) ON DELETE SET NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ml_signals_task ON ml_security_signals(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ml_signals_execution ON ml_security_signals(execution_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ml_signals_type ON ml_security_signals(signal_type)`);

  // ============================================
  // SENTINENTAL TRAINING DATA TABLE (UNIFIED)
  // ============================================
  // Single source of truth for Sentinental Core ML training
  // Stores PLATINO TRACE records locally before HTTP export
  // Includes: Vulnerabilities + ExecutionContext + ProjectContext + CVSSLike + TaskHistory
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinental_training_data (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      phase TEXT NOT NULL,

      -- Schema & Source
      schema_version TEXT DEFAULT '3.0',
      source TEXT DEFAULT 'open-multi-agents',
      trace_level TEXT DEFAULT 'bronze',
      agent_type TEXT,
      model_id TEXT,

      -- Vulnerabilities (JSON array with OWASP/CWE enrichment)
      vulnerabilities TEXT NOT NULL DEFAULT '[]',
      vulnerabilities_count INTEGER DEFAULT 0,

      -- Execution Context (JSON)
      execution_context TEXT NOT NULL DEFAULT '{}',

      -- PLATINO TRACE Fields (JSON)
      project_context TEXT,
      code_context TEXT,
      cvss_like TEXT,
      task_history TEXT,

      -- Summary Statistics
      summary TEXT NOT NULL DEFAULT '{}',
      risk_score INTEGER DEFAULT 0,
      avg_cvss_score REAL,
      blocked_count INTEGER DEFAULT 0,

      -- Export State
      sent_to_sentinental INTEGER DEFAULT 0,
      sent_at TEXT,
      send_attempts INTEGER DEFAULT 0,
      last_error TEXT,

      -- Timestamps
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_task ON sentinental_training_data(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_session ON sentinental_training_data(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_phase ON sentinental_training_data(phase)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_sent ON sentinental_training_data(sent_to_sentinental)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_risk ON sentinental_training_data(risk_score)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentinental_trace ON sentinental_training_data(trace_level)`);

  console.log('[Database] SQLite initialized successfully');
}

/**
 * Connect to database (initialize if needed)
 * Also recovers stale tasks from previous sessions
 */
export async function connectDatabase(): Promise<void> {
  initializeDatabase();

  // Fix #4: Recover tasks that were running when server stopped
  // Import dynamically to avoid circular dependencies
  const { TaskRepository } = await import('./repositories/TaskRepository.js');
  TaskRepository.recoverStaleTasks();
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  db.close();
  console.log('[Database] Connection closed');
}

/**
 * Clean up expired OAuth states (older than 10 minutes)
 */
export function cleanupExpiredOAuthStates(): void {
  const stmt = db.prepare(`
    DELETE FROM oauth_states
    WHERE datetime(created_at) < datetime('now', '-10 minutes')
  `);
  stmt.run();
}

/**
 * Generate unique IDs
 */
export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Get current timestamp in ISO format
 */
export function now(): string {
  return new Date().toISOString();
}

export { db };
export type { DatabaseType };
