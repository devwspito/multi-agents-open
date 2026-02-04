/**
 * Orchestration Exports
 *
 * V2 Architecture:
 * - OrchestratorV2: New 3-phase orchestrator (Analysis → Developer → Merge)
 * - V2 Phases: Single session per phase with internal loops
 *
 * Legacy (deprecated):
 * - orchestrator: Old multi-session orchestrator
 * - Old phases: AnalysisPhase, DevelopmentPhase, JudgePhase, FixerPhase
 */

// === V2 Exports (Recommended) ===
export { orchestratorV2 } from './OrchestratorV2.js';
export type { OrchestrationOptions, OrchestrationResult } from './OrchestratorV2.js';

// V2 Phases
export { executeAnalysisPhase } from './phases/AnalysisPhaseV2.js';
export type { AnalysisPhaseContext, AnalysisResult } from './phases/AnalysisPhaseV2.js';

export { executeDeveloperPhase, sendUserMessage } from './phases/DeveloperPhaseV2.js';
export type { DeveloperPhaseContext, DeveloperResult, StoryResult } from './phases/DeveloperPhaseV2.js';

export { executeMergePhase, checkPRStatus, triggerMerge } from './phases/MergePhaseV2.js';
export type { MergePhaseContext, MergeResult } from './phases/MergePhaseV2.js';

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

// === Legacy Exports (Deprecated - use V2) ===
export { BasePhase } from './Phase.js';
export type { IPhase, PhaseResult, PhaseContext, PhaseConfig } from './Phase.js';

export { orchestrator } from './Orchestrator.js';
export type { Pipeline, ApprovalMode } from './Orchestrator.js';

export { AnalysisPhase, DevelopmentPhase, JudgePhase, FixerPhase } from './phases/index.js';
export type { JudgeVerdict, JudgeOutput } from './phases/index.js';

// Create and register default pipelines (Legacy)
import { orchestrator } from './Orchestrator.js';
import { AnalysisPhase } from './phases/AnalysisPhase.js';
import { DevelopmentPhase } from './phases/DevelopmentPhase.js';
import { JudgePhase } from './phases/JudgePhase.js';
import { FixerPhase } from './phases/FixerPhase.js';

/**
 * Initialize default pipelines (Legacy)
 * @deprecated Use orchestratorV2.execute() instead
 */
export function initializePipelines(): void {
  // Basic development pipeline
  orchestrator.registerPipeline({
    name: 'development',
    description: 'Standard development pipeline: Analysis → Development',
    phases: [
      new AnalysisPhase(),
      new DevelopmentPhase(),
    ],
  });

  // Analysis-only pipeline
  orchestrator.registerPipeline({
    name: 'analysis',
    description: 'Analysis only pipeline',
    phases: [
      new AnalysisPhase(),
    ],
  });

  // Full pipeline with review
  orchestrator.registerPipeline({
    name: 'full',
    description: 'Full pipeline: Analysis → Development → Judge → Fixer',
    phases: [
      new AnalysisPhase(),
      new DevelopmentPhase(),
      new JudgePhase(),
      new FixerPhase(),
    ],
  });

  console.log('[Orchestration] Default pipelines initialized (legacy)');
}
