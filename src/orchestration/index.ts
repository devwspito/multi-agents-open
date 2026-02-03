/**
 * Orchestration Exports
 */

export { IPhase, BasePhase, PhaseResult, PhaseContext, PhaseConfig } from './Phase.js';
export { orchestrator, Pipeline, OrchestrationResult } from './Orchestrator.js';
export { AnalysisPhase, DevelopmentPhase } from './phases/index.js';

// Create and register default pipelines
import { orchestrator } from './Orchestrator.js';
import { AnalysisPhase } from './phases/AnalysisPhase.js';
import { DevelopmentPhase } from './phases/DevelopmentPhase.js';

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

  console.log('[Orchestration] Default pipelines initialized');
}
