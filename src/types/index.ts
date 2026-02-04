/**
 * Shared Types for Open Multi-Agents
 *
 * Core types used across the system.
 * OpenCode SDK handles LLM-specific types internally.
 */

/**
 * Task status for orchestration
 */
export type TaskStatus =
  | 'pending'
  | 'queued'      // Added to BullMQ queue, waiting for worker
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';  // Server restarted while task was running

/**
 * Story status for tracking progress
 */
export type StoryStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Story - A small unit of work within a task
 * Each story should be implementable in ~5-20 lines of code
 */
export interface Story {
  id: string;
  title: string;
  description: string;
  status: StoryStatus;
  /** Files that need to be modified */
  filesToModify?: string[];
  /** Files that need to be created */
  filesToCreate?: string[];
  /** Files to read for context */
  filesToRead?: string[];
  /** Acceptance criteria */
  acceptanceCriteria?: string[];
  /** Development output after implementation */
  developmentOutput?: string;
  /** Judge verdict */
  judgeVerdict?: 'approved' | 'rejected' | 'needs_revision';
  /** Judge score 0-100 */
  judgeScore?: number;
  /** Issues found by judge */
  judgeIssues?: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    file: string;
    description: string;
    suggestion?: string;
  }>;
}

/**
 * Repository info for multi-repo support
 * Passed to phases so OpenCode knows about all repos and their types
 */
export interface RepositoryInfo {
  id: string;
  name: string;
  type: 'backend' | 'frontend' | 'shared' | 'infrastructure' | 'docs' | string;
  /** Local path where the repo is cloned (within task workspace) */
  localPath: string;
  /** GitHub URL for reference */
  githubUrl: string;
  /** Branch being used */
  branch: string;
  /** Description of what this repo contains */
  description?: string;
  /** Execution order (lower = first) */
  executionOrder?: number;
}

/**
 * Task definition
 */
export interface Task {
  id: string;
  userId?: string;
  projectId?: string;
  repositoryId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Branch created for this task */
  branchName?: string;
  /** Analysis result from AnalysisPhase */
  analysis?: {
    summary: string;
    approach: string;
    risks: string[];
  };
  /** Stories broken down from the task */
  stories?: Story[];
  /** Current story index being processed */
  currentStoryIndex?: number;
  /** Pull Request number */
  prNumber?: number;
  /** Pull Request URL */
  prUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// V2 RESULT STRUCTURES - Vulnerabilities embedded at each level
// ============================================================================

/**
 * Vulnerability severity levels
 */
export type VulnerabilitySeverityV2 = 'low' | 'medium' | 'high' | 'critical';

/**
 * Vulnerability type (imported from AgentSpy at runtime, defined here for typing)
 */
export type VulnerabilityTypeV2 =
  | 'dangerous_command' | 'destructive_operation'
  | 'secret_exposure' | 'credential_leak'
  | 'code_injection' | 'command_injection' | 'sql_injection' | 'xss_injection' | 'template_injection'
  | 'path_traversal' | 'sensitive_file_access' | 'file_permission_manipulation'
  | 'data_exfiltration' | 'reverse_shell' | 'unauthorized_network' | 'dns_exfiltration'
  | 'resource_exhaustion' | 'fork_bomb' | 'infinite_loop' | 'excessive_tokens'
  | 'malicious_package' | 'typosquatting' | 'dependency_confusion'
  | 'privilege_escalation' | 'permission_violation' | 'container_escape'
  | 'persistence_mechanism' | 'backdoor' | 'cron_manipulation'
  | 'prompt_injection' | 'jailbreak_attempt' | 'role_manipulation' | 'hallucination';

/**
 * Vulnerability record - used throughout V2 results
 */
export interface VulnerabilityV2 {
  id: string;
  taskId: string;
  sessionId: string;
  phase: string;
  timestamp: Date;
  severity: VulnerabilitySeverityV2;
  type: VulnerabilityTypeV2;
  description: string;
  evidence: any;
  toolName?: string;
  blocked: boolean;
  matchedPattern?: string;
  category: string;
  // OWASP/CWE for Sentinental
  owaspCategory?: string;
  cweId?: string;
  // File location
  filePath?: string;
  lineNumber?: number;
  codeSnippet?: string;
  recommendation?: string;
  // Absolute paths for Sentinental local access
  workspacePath?: string;
  absoluteFilePath?: string;
  // Context
  storyId?: string;
  iteration?: number;
}

/**
 * Analysis data WITH embedded vulnerabilities
 */
export interface AnalysisDataV2 {
  summary: string;
  approach: string;
  risks: string[];
  /** Vulnerabilities found during analysis phase */
  vulnerabilities: VulnerabilityV2[];
}

/**
 * Story result V2 - complete trace of what happened
 */
export interface StoryResultV2 {
  id: string;
  title: string;
  description: string;
  status: StoryStatus;
  filesToModify?: string[];
  filesToCreate?: string[];
  filesToRead?: string[];
  acceptanceCriteria?: string[];
  /** Number of DEV→JUDGE→FIX iterations */
  iterations: number;
  /** Final verdict from JUDGE */
  verdict: 'approved' | 'rejected' | 'needs_revision';
  /** Judge score 0-100 */
  score?: number;
  /** Issues found by JUDGE */
  issues?: Array<{
    severity: 'critical' | 'major' | 'minor';
    file?: string;
    description: string;
    suggestion?: string;
  }>;
  /** Commit hash if approved */
  commitHash?: string;
  /** Vulnerabilities found by SPY for THIS story */
  vulnerabilities: VulnerabilityV2[];
  /** Execution trace for Sentinental */
  trace?: {
    startTime: number;
    endTime: number;
    toolCalls: number;
    turns: number;
  };
}

/**
 * Global vulnerability scan - scans ALL repositories at end of phase
 */
export interface GlobalVulnerabilityScan {
  scannedAt: Date;
  totalFilesScanned: number;
  /** Each repository scanned */
  repositoriesScanned: Array<{
    name: string;
    path: string;
    type: string;
    filesScanned: number;
    vulnerabilitiesFound: number;
  }>;
  /** All vulnerabilities across all repos */
  vulnerabilities: VulnerabilityV2[];
  /** Summary by severity */
  bySeverity: Record<VulnerabilitySeverityV2, number>;
  /** Summary by type */
  byType: Record<string, number>;
  /** Summary by repository */
  byRepository: Record<string, number>;
}

/**
 * Analysis Phase V2 Result
 *
 * Note: Global scan runs as SEPARATE FINAL PHASE after Merge
 * analysis.vulnerabilities = SPY findings during analysis iterations
 */
export interface AnalysisResultV2 {
  success: boolean;
  sessionId: string;
  /** Analysis WITH vulnerabilities from SPY */
  analysis: AnalysisDataV2;
  /** Stories (vulnerabilities filled during Developer phase) */
  stories: StoryResultV2[];
  branchName: string;
  error?: string;
}

/**
 * Developer Phase V2 Result
 *
 * Note: Global scan runs as SEPARATE FINAL PHASE after Merge
 * stories[].vulnerabilities = SPY findings per story iteration
 */
export interface DeveloperResultV2 {
  success: boolean;
  sessionId: string;
  /** Stories WITH vulnerabilities from SPY per story */
  stories: StoryResultV2[];
  totalCommits: number;
  error?: string;
}

/**
 * Complete Orchestration V2 Result
 */
export interface OrchestrationResultV2 {
  success: boolean;
  taskId: string;
  branchName: string;
  /** Analysis phase result */
  analysis: AnalysisResultV2;
  /** Developer phase result */
  developer: DeveloperResultV2;
  /** Merge phase result */
  merge?: {
    success: boolean;
    prNumber?: number;
    prUrl?: string;
    merged: boolean;
  };
  /** Final global scan after EVERYTHING */
  finalGlobalScan: GlobalVulnerabilityScan;
  /** Total execution time in ms */
  totalExecutionMs: number;
}
