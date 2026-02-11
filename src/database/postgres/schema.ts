/**
 * PostgreSQL Schema
 *
 * Database schema for the multi-agent system.
 * Optimized for high concurrency with proper indexes.
 */

import { postgresService } from './PostgresService.js';

/**
 * Initialize all database tables
 */
export async function initializeSchema(): Promise<void> {
  console.log('[PostgreSQL] Initializing schema...');

  // Enable UUID extension
  await postgresService.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  // ============================================
  // USERS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      github_id VARCHAR(64) UNIQUE NOT NULL,
      username VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry TIMESTAMP,
      default_api_key TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

  // ============================================
  // OAUTH STATES TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      id VARCHAR(64) PRIMARY KEY,
      state VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state)`);

  // ============================================
  // PROJECTS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      type VARCHAR(64) DEFAULT 'web-app',
      status VARCHAR(64) DEFAULT 'planning',
      user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      api_key TEXT,
      settings JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active)`);

  // ============================================
  // REPOSITORIES TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS repositories (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      github_repo_url TEXT NOT NULL,
      github_repo_name VARCHAR(255) NOT NULL,
      github_branch VARCHAR(255) DEFAULT 'main',
      type VARCHAR(64) DEFAULT 'backend',
      path_patterns JSONB DEFAULT '[]',
      execution_order INTEGER DEFAULT 0,
      dependencies JSONB DEFAULT '[]',
      env_variables JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT TRUE,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_repositories_project_id ON repositories(project_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_repositories_is_active ON repositories(is_active)`);

  // ============================================
  // TASKS TABLE (with queue support)
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id VARCHAR(64) REFERENCES projects(id) ON DELETE SET NULL,
      repository_id VARCHAR(64) REFERENCES repositories(id) ON DELETE SET NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(64) DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      queue_position INTEGER,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message TEXT,
      result JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, created_at ASC)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority DESC, created_at ASC) WHERE status = 'queued'`);

  // Add new columns for orchestration tracking (if they don't exist)
  await postgresService.query(`
    DO $$ BEGIN
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS analysis JSONB;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stories JSONB;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_number INTEGER;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_url TEXT;
      -- Cost tracking columns
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS total_cost DECIMAL(10, 6) DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS total_input_tokens INTEGER DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS total_output_tokens INTEGER DEFAULT 0;
      -- 🔥 RESUME: Columns for task resume after restart
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_phases JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS current_phase VARCHAR(64);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS current_step INTEGER;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS current_agent VARCHAR(64);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_completed_story_index INTEGER;
      -- 🔥 ACTIVITY LOG: Persisted console activity for page refresh recovery
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS activity_log JSONB DEFAULT '[]'::jsonb;
      -- 🔥 PLANNING: Store full planning result for ML training
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planning_result JSONB;
      -- 🔥 Failure reason - shown to user when task fails
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS failure_reason TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // ============================================
  // AGENT EXECUTIONS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS agent_executions (
      id VARCHAR(64) PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_type VARCHAR(64) NOT NULL,
      model_id VARCHAR(255),
      phase_name VARCHAR(64),
      prompt TEXT,
      final_output TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd DECIMAL(10, 6) DEFAULT 0,
      duration_ms INTEGER,
      status VARCHAR(64) DEFAULT 'pending',
      error_type VARCHAR(64),
      error_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_executions_task_id ON agent_executions(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_executions_status ON agent_executions(status)`);

  // Add missing columns (started_at, completed_at, turns_completed)
  await postgresService.query(`
    DO $$ BEGIN
      ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
      ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
      ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS turns_completed INTEGER DEFAULT 0;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // ============================================
  // AGENT TURNS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id VARCHAR(64) PRIMARY KEY,
      execution_id VARCHAR(64) NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_number INTEGER NOT NULL,
      role VARCHAR(32) NOT NULL,
      content TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      tool_calls_count INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_turns_execution_id ON agent_turns(execution_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_turns_task_id ON agent_turns(task_id)`);

  // ============================================
  // TOOL CALLS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id VARCHAR(64) PRIMARY KEY,
      execution_id VARCHAR(64) NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
      turn_id VARCHAR(64) NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tool_name VARCHAR(255) NOT NULL,
      tool_use_id VARCHAR(64),
      tool_input JSONB,
      tool_input_summary TEXT,
      tool_output TEXT,
      tool_success BOOLEAN DEFAULT TRUE,
      tool_error TEXT,
      file_path TEXT,
      bash_command TEXT,
      bash_exit_code INTEGER,
      duration_ms INTEGER,
      call_order INTEGER DEFAULT 0,
      started_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_toolcalls_execution ON tool_calls(execution_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_toolcalls_turn ON tool_calls(turn_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_toolcalls_tool ON tool_calls(tool_name)`);

  // ============================================
  // ML SECURITY SIGNALS TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS ml_security_signals (
      id VARCHAR(64) PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id VARCHAR(64) REFERENCES agent_executions(id) ON DELETE SET NULL,
      signal_type VARCHAR(64) NOT NULL,
      severity VARCHAR(32) NOT NULL,
      description TEXT NOT NULL,
      details JSONB DEFAULT '{}',
      detected_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_ml_signals_task ON ml_security_signals(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_ml_signals_type ON ml_security_signals(signal_type)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_ml_signals_severity ON ml_security_signals(severity)`);

  // ============================================
  // SENTINENTAL TRAINING DATA TABLE
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS sentinental_training_data (
      id VARCHAR(64) PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      phase VARCHAR(64) NOT NULL,
      schema_version VARCHAR(16) DEFAULT '3.0',
      source VARCHAR(64) DEFAULT 'open-multi-agents',
      trace_level VARCHAR(32) DEFAULT 'bronze',
      agent_type VARCHAR(64),
      model_id VARCHAR(255),
      vulnerabilities JSONB DEFAULT '[]',
      vulnerabilities_count INTEGER DEFAULT 0,
      execution_context JSONB DEFAULT '{}',
      project_context JSONB,
      code_context JSONB,
      cvss_like JSONB,
      task_history JSONB,
      summary JSONB DEFAULT '{}',
      risk_score INTEGER DEFAULT 0,
      avg_cvss_score DECIMAL(4, 2),
      blocked_count INTEGER DEFAULT 0,
      sent_to_sentinental BOOLEAN DEFAULT FALSE,
      sent_at TIMESTAMP,
      send_attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_sentinental_task ON sentinental_training_data(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_sentinental_session ON sentinental_training_data(session_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_sentinental_sent ON sentinental_training_data(sent_to_sentinental)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_sentinental_risk ON sentinental_training_data(risk_score DESC)`);

  // ============================================
  // OPENCODE SESSIONS TABLE
  // Tracks OpenCode sessions with approval modes
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS opencode_sessions (
      id VARCHAR(64) PRIMARY KEY,
      session_id VARCHAR(128) UNIQUE NOT NULL,
      task_id VARCHAR(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      directory TEXT NOT NULL,
      phase_name VARCHAR(64),
      approval_mode VARCHAR(32) DEFAULT 'manual',
      permissions JSONB DEFAULT '{"edit": "ask", "bash": "ask", "webfetch": "ask"}',
      status VARCHAR(32) DEFAULT 'active',
      pending_permission_id VARCHAR(128),
      pending_permission_data JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session ON opencode_sessions(session_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_opencode_sessions_task ON opencode_sessions(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_opencode_sessions_status ON opencode_sessions(status)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_opencode_sessions_approval ON opencode_sessions(approval_mode)`);

  // ============================================
  // QUEUE JOBS TABLE (BullMQ backup/monitoring)
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id VARCHAR(64) PRIMARY KEY,
      queue_name VARCHAR(64) NOT NULL,
      job_id VARCHAR(64) NOT NULL,
      task_id VARCHAR(64) REFERENCES tasks(id) ON DELETE CASCADE,
      status VARCHAR(32) DEFAULT 'waiting',
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      data JSONB DEFAULT '{}',
      result JSONB,
      error TEXT,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_queue_jobs_status ON queue_jobs(status)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_queue_jobs_queue ON queue_jobs(queue_name, status)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_queue_jobs_task ON queue_jobs(task_id)`);

  // ============================================
  // APPROVAL LOGS TABLE (Audit trail)
  // ============================================
  await postgresService.query(`
    CREATE TABLE IF NOT EXISTS approval_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id VARCHAR(100) NOT NULL,
      phase VARCHAR(50) NOT NULL,
      action VARCHAR(20) NOT NULL,
      user_id VARCHAR(100),
      client_id VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_approval_logs_task_id ON approval_logs(task_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_approval_logs_user_id ON approval_logs(user_id)`);
  await postgresService.query(`CREATE INDEX IF NOT EXISTS idx_approval_logs_created_at ON approval_logs(created_at)`);

  console.log('[PostgreSQL] Schema initialized successfully');
}

/**
 * Recover stale tasks on server restart
 */
export async function recoverStaleTasks(): Promise<number> {
  const result = await postgresService.query(`
    UPDATE tasks
    SET status = 'interrupted', updated_at = NOW()
    WHERE status IN ('running', 'paused')
    RETURNING id
  `);

  if (result.rowCount && result.rowCount > 0) {
    console.log(`[PostgreSQL] Recovered ${result.rowCount} stale task(s)`);
  }

  return result.rowCount || 0;
}

/**
 * Clean up expired OAuth states
 */
export async function cleanupExpiredOAuthStates(): Promise<void> {
  await postgresService.query(`
    DELETE FROM oauth_states
    WHERE created_at < NOW() - INTERVAL '10 minutes'
  `);
}

export default { initializeSchema, recoverStaleTasks, cleanupExpiredOAuthStates };
