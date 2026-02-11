/**
 * Deep Health Check Service
 *
 * Provides comprehensive health checks for all system dependencies:
 * - PostgreSQL database
 * - Redis/BullMQ queue
 * - OpenCode connection
 * - GitHub integration
 *
 * Returns detailed status for each component.
 */

import { TIMEOUTS } from '../../constants.js';

// ============================================================================
// TYPES
// ============================================================================

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentHealth {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
  details?: Record<string, any>;
}

export interface SystemHealth {
  status: HealthStatus;
  timestamp: string;
  uptime: number;
  version?: string;
  components: {
    database: ComponentHealth;
    queue: ComponentHealth;
    opencode: ComponentHealth;
    github?: ComponentHealth;
  };
}

// ============================================================================
// HEALTH SERVICE
// ============================================================================

class HealthServiceClass {
  private startTime = Date.now();

  /**
   * Get full system health
   */
  async getHealth(): Promise<SystemHealth> {
    const [database, queue, opencode] = await Promise.all([
      this.checkDatabase(),
      this.checkQueue(),
      this.checkOpenCode(),
    ]);

    // Overall status is the worst component status
    const statuses = [database.status, queue.status, opencode.status];
    let overallStatus: HealthStatus = 'healthy';

    if (statuses.includes('unhealthy')) {
      overallStatus = 'unhealthy';
    } else if (statuses.includes('degraded')) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env.npm_package_version || '1.0.0',
      components: {
        database,
        queue,
        opencode,
      },
    };
  }

  /**
   * Quick liveness check (for k8s liveness probe)
   */
  async isAlive(): Promise<boolean> {
    return true; // Process is running
  }

  /**
   * Readiness check (for k8s readiness probe)
   */
  async isReady(): Promise<boolean> {
    try {
      const health = await this.getHealth();
      return health.status !== 'unhealthy';
    } catch {
      return false;
    }
  }

  // ============================================================================
  // COMPONENT CHECKS
  // ============================================================================

  /**
   * Check PostgreSQL database connection
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();

    try {
      // Dynamic import to avoid circular dependencies
      const { getDb } = await import('../../database/index.js');
      const db = getDb();

      if (!db) {
        return {
          status: 'unhealthy',
          message: 'Database not initialized',
        };
      }

      // Execute a simple query
      const result = await Promise.race([
        db.query('SELECT 1 as health_check'),
        this.timeout(TIMEOUTS.HEALTH_CHECK_TIMEOUT),
      ]);

      if (result === 'timeout') {
        return {
          status: 'degraded',
          latencyMs: TIMEOUTS.HEALTH_CHECK_TIMEOUT,
          message: 'Database query timeout',
        };
      }

      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        details: {
          type: 'postgresql',
        },
      };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }
  }

  /**
   * Check Redis/BullMQ queue
   */
  private async checkQueue(): Promise<ComponentHealth> {
    const start = Date.now();

    try {
      // Dynamic import
      const queueModule = await import('../queue/TaskQueue.js').catch(() => null);

      if (!queueModule) {
        return {
          status: 'degraded',
          message: 'Queue module not available',
        };
      }

      const { taskQueue } = queueModule;

      if (!taskQueue) {
        return {
          status: 'degraded',
          message: 'Queue not initialized',
        };
      }

      // Try to get queue status
      const isPaused = await Promise.race([
        taskQueue.isPaused?.() ?? Promise.resolve(false),
        this.timeout(TIMEOUTS.HEALTH_CHECK_TIMEOUT),
      ]);

      if (isPaused === 'timeout') {
        return {
          status: 'degraded',
          latencyMs: TIMEOUTS.HEALTH_CHECK_TIMEOUT,
          message: 'Queue health check timeout',
        };
      }

      // Get queue metrics if available
      const counts = await taskQueue.getJobCounts?.().catch(() => ({}));

      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        details: {
          type: 'bullmq',
          paused: isPaused,
          jobs: counts,
        },
      };
    } catch (error: any) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }
  }

  /**
   * Check OpenCode connection
   */
  private async checkOpenCode(): Promise<ComponentHealth> {
    const start = Date.now();

    try {
      // Dynamic import
      const { openCodeClient } = await import('../opencode/OpenCodeClient.js');

      if (!openCodeClient) {
        return {
          status: 'unhealthy',
          message: 'OpenCode client not available',
        };
      }

      // Check if connected
      const isConnected = await Promise.race([
        openCodeClient.isConnected?.() ?? Promise.resolve(false),
        this.timeout(TIMEOUTS.HEALTH_CHECK_TIMEOUT),
      ]);

      if (isConnected === 'timeout') {
        return {
          status: 'degraded',
          latencyMs: TIMEOUTS.HEALTH_CHECK_TIMEOUT,
          message: 'OpenCode health check timeout',
        };
      }

      if (!isConnected) {
        return {
          status: 'degraded',
          latencyMs: Date.now() - start,
          message: 'OpenCode not connected',
        };
      }

      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        details: {
          connected: true,
        },
      };
    } catch (error: any) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }
  }

  /**
   * Check GitHub integration (optional)
   */
  async checkGitHub(token?: string): Promise<ComponentHealth> {
    if (!token) {
      return {
        status: 'degraded',
        message: 'No GitHub token configured',
      };
    }

    const start = Date.now();

    try {
      const { githubEnhancedService } = await import('../git/index.js');

      await githubEnhancedService.init(token);

      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        details: {
          authenticated: true,
        },
      };
    } catch (error: any) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private timeout(ms: number): Promise<'timeout'> {
    return new Promise(resolve => setTimeout(() => resolve('timeout'), ms));
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const healthService = new HealthServiceClass();
export default healthService;
