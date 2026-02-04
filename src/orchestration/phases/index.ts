/**
 * Phase Exports
 *
 * V2 Phases (Recommended):
 * - AnalysisPhaseV2: Single session with ANALYST → JUDGE → SPY loop
 * - DeveloperPhaseV2: Single session with DEV → JUDGE → SPY loop per story
 * - MergePhaseV2: HOST-only PR creation and merge
 *
 * Result Structure:
 * - analysis.vulnerabilities: vulns found during analysis
 * - stories[].vulnerabilities: vulns found per story
 * - globalVulnerabilities: full workspace scan at end of each phase
 *
 * Legacy Phases (Deprecated):
 * - AnalysisPhase, DevelopmentPhase, JudgePhase, FixerPhase
 */

// === V2 Phases (Recommended) ===
export { executeAnalysisPhase } from './AnalysisPhaseV2.js';
export type { AnalysisPhaseContext, AnalysisResult } from './AnalysisPhaseV2.js';

export { executeDeveloperPhase, sendUserMessage } from './DeveloperPhaseV2.js';
export type { DeveloperPhaseContext, DeveloperResult, StoryResult } from './DeveloperPhaseV2.js';

// Re-export V2 types from main types
export type {
  AnalysisResultV2,
  AnalysisDataV2,
  DeveloperResultV2,
  StoryResultV2,
  GlobalVulnerabilityScan,
  VulnerabilityV2,
  OrchestrationResultV2,
} from '../../types/index.js';

export { executeMergePhase, checkPRStatus, triggerMerge } from './MergePhaseV2.js';
export type { MergePhaseContext, MergeResult } from './MergePhaseV2.js';

// === Legacy Phases (Deprecated) ===
export { AnalysisPhase } from './AnalysisPhase.js';
export { DevelopmentPhase } from './DevelopmentPhase.js';
export { JudgePhase } from './JudgePhase.js';
export type { JudgeVerdict, JudgeOutput } from './JudgePhase.js';
export { FixerPhase } from './FixerPhase.js';
