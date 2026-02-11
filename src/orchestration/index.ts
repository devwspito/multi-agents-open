/**
 * Orchestration Exports
 *
 * V2 4-Phase Architecture:
 * 1. Analysis: Create branch, analyze task, break into stories
 * 2. Developer: Implement stories with DEV → JUDGE → SPY loop
 * 3. Merge: Create PR, wait for approval, merge
 * 4. GlobalScan: Final comprehensive security scan
 */

// Main Orchestrator
export { orchestratorV2 } from './OrchestratorV2.js';
export type { OrchestrationOptions, OrchestrationResult } from './OrchestratorV2.js';

// Phases
export { executeAnalysisPhase } from './phases/AnalysisPhaseV2.js';
export type { AnalysisPhaseContext, AnalysisResult } from './phases/AnalysisPhaseV2.js';

export { executeDeveloperPhase, sendUserMessage } from './phases/DeveloperPhaseV2.js';
export type { DeveloperPhaseContext, DeveloperResult, StoryResult } from './phases/DeveloperPhaseV2.js';

export { executeMergePhase, checkPRStatus, triggerMerge } from './phases/MergePhaseV2.js';
export type { MergePhaseContext, MergeResult, RepoPullRequestInfo } from './phases/MergePhaseV2.js';

export { executeGlobalScanPhase } from './phases/GlobalScanPhaseV2.js';
export type { GlobalScanPhaseContext, GlobalScanResult } from './phases/GlobalScanPhaseV2.js';

// Phase Tracker (Security & Sentinental integration)
export {
  createTrackingState,
  trackEvent,
  completePhaseTracking,
  hasBlockingVulnerabilities,
  getBlockingVulnerabilities,
  cleanupTaskTracking,
} from './PhaseTracker.js';
export type { PhaseTrackingContext, PhaseTrackingState } from './PhaseTracker.js';
