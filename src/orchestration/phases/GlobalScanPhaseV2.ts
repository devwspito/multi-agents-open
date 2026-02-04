/**
 * Global Scan Phase V2
 *
 * FINAL PHASE - Always runs after Merge, even if Merge fails
 *
 * Purpose:
 * - Comprehensive security scan of ALL repositories
 * - Final vulnerability report for Sentinental ML training
 * - Complete picture of security state after all changes
 *
 * Flow:
 * Analysis → Developer → Merge → GLOBAL SCAN (always)
 */

import {
  Task,
  RepositoryInfo,
  GlobalVulnerabilityScan,
  VulnerabilityV2,
} from '../../types/index.js';
import { agentSpy } from '../../services/security/AgentSpy.js';
import { socketService } from '../../services/realtime/index.js';

export interface GlobalScanPhaseContext {
  task: Task;
  repositories: RepositoryInfo[];
  /** Session ID from previous phase (for context) */
  sessionId?: string;
  /** Branch name being scanned */
  branchName?: string;
  /** Whether merge was successful */
  mergeSuccess?: boolean;
}

export interface GlobalScanResult {
  success: boolean;
  /** The comprehensive scan result */
  scan: GlobalVulnerabilityScan;
  /** Summary stats */
  summary: {
    totalRepositories: number;
    totalFilesScanned: number;
    totalVulnerabilities: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
  };
  error?: string;
}

/**
 * Execute the Global Scan Phase
 *
 * This phase ALWAYS runs, regardless of whether previous phases succeeded or failed.
 * It provides a complete security picture of all repositories.
 */
export async function executeGlobalScanPhase(
  context: GlobalScanPhaseContext
): Promise<GlobalScanResult> {
  const { task, repositories } = context;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[GlobalScanPhase] Starting final security scan`);
  console.log(`[GlobalScanPhase] Repositories to scan: ${repositories.length}`);
  console.log(`${'='.repeat(60)}`);

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'GlobalScan',
    totalRepositories: repositories.length,
    branchName: context.branchName,
    mergeSuccess: context.mergeSuccess,
  });

  try {
    // Execute the global scan
    const scanResult = await agentSpy.scanAllRepositories(
      repositories.map(r => ({
        name: r.name,
        localPath: r.localPath,
        type: r.type,
      })),
      {
        taskId: task.id,
        sessionId: context.sessionId || 'global-scan',
        phase: 'GlobalScan',
      }
    );

    // Build the GlobalVulnerabilityScan result
    const scan: GlobalVulnerabilityScan = {
      scannedAt: scanResult.scannedAt,
      totalFilesScanned: scanResult.totalFilesScanned,
      repositoriesScanned: scanResult.repositoriesScanned,
      vulnerabilities: scanResult.vulnerabilities as unknown as VulnerabilityV2[],
      bySeverity: scanResult.bySeverity,
      byType: scanResult.byType,
      byRepository: scanResult.byRepository,
    };

    // Build summary
    const summary = {
      totalRepositories: repositories.length,
      totalFilesScanned: scan.totalFilesScanned,
      totalVulnerabilities: scan.vulnerabilities.length,
      criticalCount: scan.bySeverity.critical,
      highCount: scan.bySeverity.high,
      mediumCount: scan.bySeverity.medium,
      lowCount: scan.bySeverity.low,
    };

    // Notify frontend
    socketService.toTask(task.id, 'phase:complete', {
      phase: 'GlobalScan',
      success: true,
      scan: {
        totalFilesScanned: summary.totalFilesScanned,
        totalVulnerabilities: summary.totalVulnerabilities,
        bySeverity: scan.bySeverity,
        byRepository: scan.byRepository,
        repositoriesScanned: scan.repositoriesScanned.map(r => ({
          name: r.name,
          type: r.type,
          filesScanned: r.filesScanned,
          vulnerabilitiesFound: r.vulnerabilitiesFound,
        })),
      },
      summary,
    });

    console.log(`\n[GlobalScanPhase] Completed:`);
    console.log(`  - Repositories: ${summary.totalRepositories}`);
    console.log(`  - Files scanned: ${summary.totalFilesScanned}`);
    console.log(`  - Vulnerabilities: ${summary.totalVulnerabilities}`);
    console.log(`    - Critical: ${summary.criticalCount}`);
    console.log(`    - High: ${summary.highCount}`);
    console.log(`    - Medium: ${summary.mediumCount}`);
    console.log(`    - Low: ${summary.lowCount}`);

    return {
      success: true,
      scan,
      summary,
    };
  } catch (error: any) {
    console.error(`[GlobalScanPhase] Error: ${error.message}`);

    // Notify frontend about failure
    socketService.toTask(task.id, 'phase:complete', {
      phase: 'GlobalScan',
      success: false,
      error: error.message,
    });

    // Return empty scan on error
    return {
      success: false,
      scan: createEmptyGlobalScan(),
      summary: {
        totalRepositories: repositories.length,
        totalFilesScanned: 0,
        totalVulnerabilities: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
      },
      error: error.message,
    };
  }
}

/**
 * Create an empty GlobalVulnerabilityScan for error cases
 */
function createEmptyGlobalScan(): GlobalVulnerabilityScan {
  return {
    scannedAt: new Date(),
    totalFilesScanned: 0,
    repositoriesScanned: [],
    vulnerabilities: [],
    bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    byType: {},
    byRepository: {},
  };
}
