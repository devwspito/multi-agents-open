/**
 * Open Multi-Agents
 *
 * Multi-Agent Development Platform powered by OpenCode SDK.
 * OpenCode handles: LLM calls, tools, retries, context management.
 * We handle: Orchestration, tracking, security monitoring, ML export.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';

import { connectDatabase, closeDatabase } from './database/index.js';
import { openCodeClient } from './services/opencode/OpenCodeClient.js';
import { executionTracker } from './services/training/ExecutionTracker.js';
import { trainingExportService } from './services/training/TrainingExportService.js';
import { sentinentalWebhook } from './services/training/SentinentalWebhook.js';
import { TaskRepository } from './database/repositories/TaskRepository.js';
import { agentSpy } from './services/security/AgentSpy.js';
import { orchestrator, initializePipelines } from './orchestration/index.js';

const PORT = parseInt(process.env.PORT || '3001');

async function main() {
  console.log('='.repeat(60));
  console.log(' Open Multi-Agents - Starting Server');
  console.log(' Powered by OpenCode SDK');
  console.log('='.repeat(60));

  // Initialize database
  await connectDatabase();

  // Initialize pipelines
  initializePipelines();

  // Connect to OpenCode server
  try {
    await openCodeClient.connect();
    console.log('[Server] Connected to OpenCode');
  } catch (error: any) {
    console.warn(`[Server] Warning: Could not connect to OpenCode: ${error.message}`);
    console.warn('[Server] Agent execution will fail until OpenCode is available');
    console.warn('[Server] Start OpenCode with: opencode serve');
  }

  // Create Express app
  const app = express();
  const httpServer = createServer(app);

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Socket.IO for real-time updates
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Health check endpoint
  app.get('/health', async (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      opencode: {
        connected: openCodeClient.isConnected(),
      },
    });
  });

  // ===========================================
  // Task Management Endpoints
  // ===========================================

  /**
   * Create a task
   * POST /api/tasks
   */
  app.post('/api/tasks', (req, res) => {
    try {
      const { projectId, title, description } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Missing required field: title' });
      }

      const task = TaskRepository.create({ projectId, title, description });
      res.status(201).json(task);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get all tasks
   * GET /api/tasks
   */
  app.get('/api/tasks', (req, res) => {
    try {
      const { projectId, status, limit, offset } = req.query;

      const tasks = TaskRepository.findAll({
        projectId: projectId as string,
        status: status as any,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      res.json(tasks);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get a task by ID
   * GET /api/tasks/:taskId
   */
  app.get('/api/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const task = TaskRepository.findById(taskId);

      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      res.json(task);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Update a task
   * PUT /api/tasks/:taskId
   */
  app.put('/api/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const { title, description, status } = req.body;

      const task = TaskRepository.update(taskId, { title, description, status });

      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      res.json(task);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Delete a task
   * DELETE /api/tasks/:taskId
   */
  app.delete('/api/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const deleted = TaskRepository.delete(taskId);

      if (!deleted) {
        return res.status(404).json({ error: 'Task not found' });
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get task statistics
   * GET /api/tasks/stats/summary
   */
  app.get('/api/tasks/stats/summary', (req, res) => {
    try {
      const stats = TaskRepository.getStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===========================================
  // Orchestration Endpoints (OpenCode-powered)
  // ===========================================

  /**
   * Run a pipeline for a task
   * POST /api/orchestration/run
   */
  app.post('/api/orchestration/run', async (req, res) => {
    try {
      const { taskId, pipeline, projectPath } = req.body;

      if (!taskId || !pipeline) {
        return res.status(400).json({ error: 'Missing required fields: taskId, pipeline' });
      }

      // Get task
      const task = TaskRepository.findById(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Update task status
      TaskRepository.updateStatus(taskId, 'running');

      // Emit start event
      io.to(taskId).emit('pipeline_start', { pipeline, taskId });

      // Run pipeline
      const result = await orchestrator.execute(taskId, pipeline, {
        projectPath: projectPath || process.cwd(),
        onPhaseStart: (phaseName) => {
          io.to(taskId).emit('phase_start', { phaseName });
        },
        onPhaseComplete: (phaseName, phaseResult) => {
          io.to(taskId).emit('phase_complete', { phaseName, success: phaseResult.success });
        },
      });

      // Status is already updated by orchestrator

      // Emit completion event
      io.to(taskId).emit('pipeline_complete', { success: result.success, result });

      res.json(result);
    } catch (error: any) {
      console.error('[API] Pipeline execution error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get available pipelines
   * GET /api/orchestration/pipelines
   */
  app.get('/api/orchestration/pipelines', (req, res) => {
    const pipelines = orchestrator.getAllPipelines();
    res.json(pipelines.map(p => ({
      name: p.name,
      description: p.description,
      phases: p.phases.map(ph => ({
        name: ph.name,
        description: ph.description,
        agentType: ph.agentType,
      })),
    })));
  });

  /**
   * Abort a running session
   * POST /api/orchestration/abort
   */
  app.post('/api/orchestration/abort', async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }

      await openCodeClient.abortSession(sessionId);
      res.json({ success: true, message: `Aborted session ${sessionId}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get execution history for a task
   * GET /api/tasks/:taskId/history
   */
  app.get('/api/tasks/:taskId/history', (req, res) => {
    const { taskId } = req.params;
    const history = executionTracker.getExecutionHistory(taskId);
    res.json(history);
  });

  /**
   * Get execution statistics for a task
   * GET /api/tasks/:taskId/stats
   */
  app.get('/api/tasks/:taskId/stats', (req, res) => {
    const { taskId } = req.params;
    const stats = executionTracker.getStats(taskId);
    res.json(stats);
  });

  /**
   * Get security vulnerabilities for a task
   * GET /api/tasks/:taskId/vulnerabilities
   */
  app.get('/api/tasks/:taskId/vulnerabilities', (req, res) => {
    const { taskId } = req.params;
    const summary = agentSpy.getSummary(taskId);
    res.json(summary);
  });

  // ===========================================
  // Training Export Endpoints
  // ===========================================

  /**
   * Export training data for a task
   * GET /api/training/export/:taskId
   */
  app.get('/api/training/export/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const record = await trainingExportService.exportTask(taskId);
      res.json(record);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Export training data as JSONL
   * GET /api/training/export-jsonl
   */
  app.get('/api/training/export-jsonl', async (req, res) => {
    try {
      const { startDate, endDate, status, limit, offset } = req.query;

      const jsonl = await trainingExportService.exportAsJSONL({
        startDate: startDate as string,
        endDate: endDate as string,
        status: status as 'completed' | 'failed' | 'all',
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', 'attachment; filename="training_data.jsonl"');
      res.send(jsonl);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Get export statistics
   * GET /api/training/stats
   */
  app.get('/api/training/stats', async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const stats = await trainingExportService.getExportStats({
        startDate: startDate as string,
        endDate: endDate as string,
      });
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===========================================
  // OpenCode Endpoints
  // ===========================================

  /**
   * Get OpenCode status
   * GET /api/opencode/status
   */
  app.get('/api/opencode/status', async (req, res) => {
    try {
      if (!openCodeClient.isConnected()) {
        return res.json({ connected: false });
      }

      const client = openCodeClient.getClient();
      const agents = await openCodeClient.getAgents();
      const providers = await openCodeClient.getProviders();

      res.json({
        connected: true,
        agents,
        providers,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===========================================
  // Sentinental Core Endpoints (ML Training)
  // ===========================================

  /**
   * Get Sentinental webhook status
   * GET /api/sentinental/status
   */
  app.get('/api/sentinental/status', (req, res) => {
    res.json(sentinentalWebhook.getStatus());
  });

  /**
   * Configure Sentinental webhook
   * POST /api/sentinental/configure
   */
  app.post('/api/sentinental/configure', (req, res) => {
    const { url, apiKey, batchSize, flushIntervalMs, enabled, minSeverity } = req.body;
    sentinentalWebhook.configure({ url, apiKey, batchSize, flushIntervalMs, enabled, minSeverity });
    res.json({ success: true, status: sentinentalWebhook.getStatus() });
  });

  /**
   * Manually flush buffered data to Sentinental
   * POST /api/sentinental/flush
   */
  app.post('/api/sentinental/flush', async (req, res) => {
    try {
      await sentinentalWebhook.flush();
      res.json({ success: true, status: sentinentalWebhook.getStatus() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===========================================
  // Socket.IO Events
  // ===========================================

  io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    socket.on('subscribe', (taskId: string) => {
      socket.join(taskId);
      console.log(`[Socket.IO] Client ${socket.id} subscribed to task ${taskId}`);
    });

    socket.on('unsubscribe', (taskId: string) => {
      socket.leave(taskId);
      console.log(`[Socket.IO] Client ${socket.id} unsubscribed from task ${taskId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  // ===========================================
  // Start Server
  // ===========================================

  httpServer.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log(` Server running on http://localhost:${PORT}`);
    console.log(' ');
    console.log(' Task Endpoints:');
    console.log('   POST /api/tasks               - Create task');
    console.log('   GET  /api/tasks               - List tasks');
    console.log('   GET  /api/tasks/:id           - Get task');
    console.log('   PUT  /api/tasks/:id           - Update task');
    console.log('   DELETE /api/tasks/:id         - Delete task');
    console.log(' ');
    console.log(' Orchestration Endpoints (OpenCode-powered):');
    console.log('   POST /api/orchestration/run   - Run pipeline');
    console.log('   GET  /api/orchestration/pipelines - List pipelines');
    console.log('   POST /api/orchestration/abort - Abort session');
    console.log('   GET  /api/tasks/:id/history   - Execution history');
    console.log('   GET  /api/tasks/:id/stats     - Execution stats');
    console.log('   GET  /api/tasks/:id/vulnerabilities - Security report');
    console.log(' ');
    console.log(' Training Endpoints:');
    console.log('   GET  /api/training/export/:id - Export task data');
    console.log('   GET  /api/training/export-jsonl - Export JSONL');
    console.log('   GET  /api/training/stats      - Export stats');
    console.log(' ');
    console.log(' Sentinental Core (ML Training on DGX Spark):');
    console.log('   GET  /api/sentinental/status  - Webhook status');
    console.log('   POST /api/sentinental/configure - Configure webhook');
    console.log('   POST /api/sentinental/flush   - Flush buffered data');
    console.log(' ');
    console.log(' Other:');
    console.log('   GET  /api/opencode/status     - OpenCode status');
    console.log('   GET  /health                  - Server health');
    console.log('='.repeat(60));
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await sentinentalWebhook.shutdown();
    openCodeClient.disconnect();
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    await sentinentalWebhook.shutdown();
    openCodeClient.disconnect();
    closeDatabase();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
