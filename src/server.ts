/**
 * Server Entry Point
 *
 * Starts the API server with all services.
 * Uses PostgreSQL + Redis for scalability.
 */

import 'dotenv/config';
import { startServer } from './api/index.js';
import { openCodeClient } from './services/opencode/OpenCodeClient.js';

// PostgreSQL services
import { postgresService } from './database/postgres/PostgresService.js';
import { initializeSchema, recoverStaleTasks } from './database/postgres/schema.js';

// Queue services (optional)
import { redisService } from './services/queue/RedisService.js';
import { taskQueue } from './services/queue/TaskQueue.js';
import { taskWorker } from './workers/TaskWorker.js';

// Feature flags
const USE_QUEUE = process.env.USE_QUEUE === 'true';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  console.log('Starting Open Multi-Agents Server...');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Mode: PostgreSQL + ${USE_QUEUE ? 'BullMQ Queue' : 'Direct Execution'}`);

  // =============================================
  // DATABASE INITIALIZATION (PostgreSQL)
  // =============================================
  console.log('[Database] Connecting to PostgreSQL...');
  await postgresService.connect();
  await initializeSchema();
  await recoverStaleTasks();
  console.log('[Database] PostgreSQL ready');

  // =============================================
  // QUEUE INITIALIZATION (Redis + BullMQ)
  // =============================================
  if (USE_QUEUE) {
    console.log('[Queue] Connecting to Redis...');
    await redisService.connect();
    await taskQueue.initialize();
    await taskWorker.initialize();
    console.log(`[Queue] BullMQ ready (${process.env.WORKER_CONCURRENCY || 3} workers)`);
  }

  // Start OpenCode connection in background (auto-retry)
  openCodeClient.startBackgroundReconnect();

  // Start the HTTP server
  await startServer(PORT);

  // Graceful shutdown
  const gracefulShutdown = async () => {
    console.log('\n[Server] Shutting down gracefully...');

    if (USE_QUEUE) {
      console.log('[Shutdown] Stopping workers...');
      await taskWorker.shutdown();
      await taskQueue.close();
      await redisService.disconnect();
    }

    await postgresService.close();
    openCodeClient.disconnect();
    console.log('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
