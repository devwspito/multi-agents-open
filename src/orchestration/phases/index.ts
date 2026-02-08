/**
 * Phase Exports
 *
 * V2 4-Phase Architecture:
 * 1. AnalysisPhaseV2: ANALYST → JUDGE → SPY loop
 * 2. DeveloperPhaseV2: DEV → JUDGE → SPY loop per story
 * 3. MergePhaseV2: PR creation and merge
 * 4. GlobalScanPhaseV2: Final security scan (ALWAYS runs)
 *
 * Result Structure:
 * - analysis.vulnerabilities: SPY findings during analysis
 * - stories[].vulnerabilities: SPY findings per story
 * - globalScan: Final comprehensive scan of ALL repositories
 */

export { executeAnalysisPhase } from './AnalysisPhaseV2.js';
export type { AnalysisPhaseContext, AnalysisResult } from './AnalysisPhaseV2.js';

export { executeDeveloperPhase, sendUserMessage } from './DeveloperPhaseV2.js';
export type { DeveloperPhaseContext, DeveloperResult, StoryResult } from './DeveloperPhaseV2.js';

export { executeMergePhase, checkPRStatus, triggerMerge } from './MergePhaseV2.js';
export type { MergePhaseContext, MergeResult } from './MergePhaseV2.js';

export { executeGlobalScanPhase } from './GlobalScanPhaseV2.js';
export type { GlobalScanPhaseContext, GlobalScanResult } from './GlobalScanPhaseV2.js';

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
