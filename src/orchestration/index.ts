/**
 * Orchestration Exports
 */

export { BasePhase } from './Phase.js';
export type { IPhase, PhaseResult, PhaseContext, PhaseConfig } from './Phase.js';

export { orchestrator } from './Orchestrator.js';
export type { Pipeline, OrchestrationResult, ApprovalMode } from './Orchestrator.js';

export { AnalysisPhase, DevelopmentPhase, JudgePhase, FixerPhase } from './phases/index.js';
export type { JudgeVerdict, JudgeOutput } from './phases/index.js';

// Create and register default pipelines
import { orchestrator } from './Orchestrator.js';
import { AnalysisPhase } from './phases/AnalysisPhase.js';
import { DevelopmentPhase } from './phases/DevelopmentPhase.js';
import { JudgePhase } from './phases/JudgePhase.js';
import { FixerPhase } from './phases/FixerPhase.js';

/**
 * Initialize default pipelines
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

  console.log('[Orchestration] Default pipelines initialized');
}
