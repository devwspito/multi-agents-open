/**
 * Application Constants
 *
 * Centralized constants to avoid magic strings throughout the codebase.
 */

// ============================================================================
// PHASE NAMES
// ============================================================================

export const PHASES = {
  PLANNING: 'Planning',
  ANALYSIS: 'Analysis',
  DEVELOPER: 'Developer',
  TEST_GENERATION: 'TestGeneration',
  MERGE: 'Merge',
  GLOBAL_SCAN: 'GlobalScan',
  SECURITY_SCAN: 'SecurityScan',
} as const;

export type PhaseName = typeof PHASES[keyof typeof PHASES];

export const PHASE_DISPLAY_NAMES: Record<PhaseName, string> = {
  [PHASES.PLANNING]: 'Product Planning',
  [PHASES.ANALYSIS]: 'Analysis',
  [PHASES.DEVELOPER]: 'Developer',
  [PHASES.TEST_GENERATION]: 'Test Generation',
  [PHASES.MERGE]: 'Merge',
  [PHASES.GLOBAL_SCAN]: 'Global Security Scan',
  [PHASES.SECURITY_SCAN]: 'Security Scan',
};

// ============================================================================
// TASK STATUS
// ============================================================================

export const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted', // Server restarted while task was running
} as const;

export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS];

// ============================================================================
// SOCKET EVENTS
// ============================================================================

export const SOCKET_EVENTS = {
  // Orchestration
  ORCHESTRATION_START: 'orchestration:start',
  ORCHESTRATION_COMPLETE: 'orchestration:complete',
  ORCHESTRATION_CANCELLED: 'orchestration:cancelled',

  // Phase lifecycle
  PHASE_START: 'phase:start',
  PHASE_STARTED: 'phase:started',
  PHASE_COMPLETE: 'phase:complete',
  PHASE_COMPLETED: 'phase:completed',
  PHASE_FAILED: 'phase:failed',

  // Agent progress
  AGENT_PROGRESS: 'agent:progress',
  AGENT_OUTPUT: 'agent:output',
  AGENT_ACTIVITY: 'agent:activity',

  // Approval
  APPROVAL_REQUIRED: 'approval:required',
  APPROVAL_RESPONSE: 'approval:response',
  APPROVAL_TIMEOUT: 'approval:timeout',

  // Merge
  MERGE_PR_CREATED: 'merge:pr_created',
  MERGE_APPROVAL_REQUIRED: 'merge:approval_required',
  MERGE_COMPLETE: 'merge:complete',

  // Test Generation
  TESTGEN_FIX_APPLIED: 'testgen:fix_applied',

  // Task
  TASK_UPDATE: 'task:update',
  TASK_STATUS: 'task:status',

  // Cost
  COST_UPDATE: 'cost:update',
  COST_BREAKDOWN: 'cost:breakdown',

  // Progress
  PROGRESS_UPDATE: 'progress:update',
  PROGRESS_FILE: 'progress:file',

  // Connection
  CLIENT_JOIN: 'client:join',
  CLIENT_LEAVE: 'client:leave',
} as const;

export type SocketEvent = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];

// ============================================================================
// ERROR CODES
// ============================================================================

export const ERROR_CODES = {
  // General
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Task
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_ALREADY_RUNNING: 'TASK_ALREADY_RUNNING',
  TASK_CANCELLED: 'TASK_CANCELLED',
  TASK_FAILED: 'TASK_FAILED',

  // Project
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_INVALID_CONFIG: 'PROJECT_INVALID_CONFIG',

  // Repository
  REPOSITORY_NOT_FOUND: 'REPOSITORY_NOT_FOUND',
  REPOSITORY_CLONE_FAILED: 'REPOSITORY_CLONE_FAILED',
  REPOSITORY_NOT_CLONED: 'REPOSITORY_NOT_CLONED',

  // Phase
  PHASE_FAILED: 'PHASE_FAILED',
  PHASE_REJECTED: 'PHASE_REJECTED',
  PHASE_TIMEOUT: 'PHASE_TIMEOUT',

  // OpenCode
  OPENCODE_DISCONNECTED: 'OPENCODE_DISCONNECTED',
  OPENCODE_SESSION_FAILED: 'OPENCODE_SESSION_FAILED',
  OPENCODE_TIMEOUT: 'OPENCODE_TIMEOUT',

  // Queue
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  QUEUE_FULL: 'QUEUE_FULL',

  // Database
  DATABASE_ERROR: 'DATABASE_ERROR',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',

  // GitHub
  GITHUB_AUTH_FAILED: 'GITHUB_AUTH_FAILED',
  GITHUB_RATE_LIMITED: 'GITHUB_RATE_LIMITED',
  GITHUB_PR_FAILED: 'GITHUB_PR_FAILED',

  // Approval
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// ============================================================================
// TIMEOUTS (in milliseconds)
// ============================================================================

export const TIMEOUTS = {
  // OpenCode operations
  OPENCODE_DEFAULT: 120_000, // 2 minutes
  OPENCODE_ANALYSIS: 180_000, // 3 minutes
  OPENCODE_DEVELOPER: 300_000, // 5 minutes
  OPENCODE_TEST_RUN: 180_000, // 3 minutes
  OPENCODE_FIX: 120_000, // 2 minutes

  // Approval
  APPROVAL_DEFAULT: 0, // No timeout (wait forever)
  APPROVAL_STALE_CHECK: 60_000, // 1 minute

  // Git operations
  GIT_CLONE: 300_000, // 5 minutes
  GIT_PUSH: 60_000, // 1 minute
  GIT_PR_CREATE: 30_000, // 30 seconds

  // Cache
  CONTEXT_CACHE_TTL: 30 * 60 * 1000, // 30 minutes
  ACTIVITY_LOG_FLUSH: 2_000, // 2 seconds

  // Health check
  HEALTH_CHECK_INTERVAL: 30_000, // 30 seconds
  HEALTH_CHECK_TIMEOUT: 5_000, // 5 seconds
} as const;

// ============================================================================
// LIMITS
// ============================================================================

export const LIMITS = {
  // Cache
  MAX_CACHE_SIZE_MB: 100,
  MAX_FILE_SIZE_KB: 500,

  // Activity logs
  ACTIVITY_LOG_BATCH_SIZE: 50,

  // Approval
  MAX_PENDING_APPROVALS: 100,

  // Rate limiting
  MAX_TASKS_PER_USER_PER_HOUR: 50,
  MAX_REQUESTS_PER_MINUTE: 100,

  // Phase iterations
  MAX_JUDGE_ITERATIONS: 3,
  MAX_TEST_FIX_ITERATIONS: 3,

  // Stories
  MAX_STORIES_PER_TASK: 20,

  // PR
  MAX_FILES_IN_PR_DESCRIPTION: 20,
} as const;

// ============================================================================
// SPECIALIST ROLES
// ============================================================================

export const SPECIALIST_ROLES = {
  DEVELOPER: 'developer',
  JUDGE: 'judge',
  SPY: 'spy',
  ARCHITECT: 'architect',
  TESTER: 'tester',
  FIXER: 'fixer',
} as const;

export type SpecialistRole = typeof SPECIALIST_ROLES[keyof typeof SPECIALIST_ROLES];

// ============================================================================
// VERDICT TYPES
// ============================================================================

export const VERDICTS = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  NEEDS_REVISION: 'needs_revision',
} as const;

export type Verdict = typeof VERDICTS[keyof typeof VERDICTS];

// ============================================================================
// VULNERABILITY SEVERITY
// ============================================================================

export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
} as const;

export type Severity = typeof SEVERITY[keyof typeof SEVERITY];

// ============================================================================
// FILE PATTERNS
// ============================================================================

export const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  'coverage',
  '.env',
  '.env.local',
  '*.log',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
] as const;

export const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.java', '.kt',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
] as const;

export const CONFIG_EXTENSIONS = [
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.sql',
  '.graphql', '.gql',
  '.prisma',
] as const;

export const STYLE_EXTENSIONS = [
  '.css', '.scss', '.sass', '.less',
] as const;

export const TEMPLATE_EXTENSIONS = [
  '.html', '.htm', '.vue', '.svelte',
] as const;

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  PHASES,
  PHASE_DISPLAY_NAMES,
  TASK_STATUS,
  SOCKET_EVENTS,
  ERROR_CODES,
  TIMEOUTS,
  LIMITS,
  SPECIALIST_ROLES,
  VERDICTS,
  SEVERITY,
  IGNORE_PATTERNS,
  CODE_EXTENSIONS,
  CONFIG_EXTENSIONS,
  STYLE_EXTENSIONS,
  TEMPLATE_EXTENSIONS,
};
