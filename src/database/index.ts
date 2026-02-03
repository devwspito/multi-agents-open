/**
 * Database Layer for Open Multi-Agents
 *
 * SQLite database for:
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
  console.log('[Database] Initializing SQLite database...');

  // Tasks table - orchestration state
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      orchestration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Agent Executions - for ML training
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
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  // Agent Turns - turn-by-turn tracking
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
      FOREIGN KEY (execution_id) REFERENCES agent_executions(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  // Tool Calls - granular tool tracking
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
      FOREIGN KEY (execution_id) REFERENCES agent_executions(id),
      FOREIGN KEY (turn_id) REFERENCES agent_turns(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_executions_task ON agent_executions(task_id);
    CREATE INDEX IF NOT EXISTS idx_turns_execution ON agent_turns(execution_id);
    CREATE INDEX IF NOT EXISTS idx_turns_task ON agent_turns(task_id);
    CREATE INDEX IF NOT EXISTS idx_toolcalls_execution ON tool_calls(execution_id);
    CREATE INDEX IF NOT EXISTS idx_toolcalls_turn ON tool_calls(turn_id);
    CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls(task_id);
  `);

  console.log('[Database] SQLite initialized successfully');
}

/**
 * Connect to database (initialize if needed)
 */
export async function connectDatabase(): Promise<void> {
  initializeDatabase();
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  db.close();
  console.log('[Database] Connection closed');
}

// Generate unique IDs
export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export { db };
export type { DatabaseType };
