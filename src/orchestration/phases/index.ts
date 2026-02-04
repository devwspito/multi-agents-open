/**
 * Phase Exports
 *
 * V2 Phases (Recommended):
 * - AnalysisPhaseV2: Single session with ANALYST → JUDGE loop
 * - DeveloperPhaseV2: Single session with DEV → JUDGE → FIX loop per story
 * - MergePhaseV2: HOST-only PR creation and merge
 *
 * Legacy Phases (Deprecated):
 * - AnalysisPhase, DevelopmentPhase, JudgePhase, FixerPhase
 */

// === V2 Phases (Recommended) ===
export { executeAnalysisPhase } from './AnalysisPhaseV2.js';
export type { AnalysisPhaseContext, AnalysisResult } from './AnalysisPhaseV2.js';

export { executeDeveloperPhase, sendUserMessage } from './DeveloperPhaseV2.js';
export type { DeveloperPhaseContext, DeveloperResult, StoryResult } from './DeveloperPhaseV2.js';

export { executeMergePhase, checkPRStatus, triggerMerge } from './MergePhaseV2.js';
export type { MergePhaseContext, MergeResult } from './MergePhaseV2.js';

// === Legacy Phases (Deprecated) ===
export { AnalysisPhase } from './AnalysisPhase.js';
export { DevelopmentPhase } from './DevelopmentPhase.js';
export { JudgePhase } from './JudgePhase.js';
export type { JudgeVerdict, JudgeOutput } from './JudgePhase.js';
export { FixerPhase } from './FixerPhase.js';
