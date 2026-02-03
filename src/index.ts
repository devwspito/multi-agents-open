/**
 * Open Multi-Agents
 *
 * Multi-Agent Development Platform with DGX Spark
 * Provider-agnostic design for flexibility.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';

import { connectDatabase, closeDatabase } from './database/index.js';
import { providerFactory } from './services/providers/ProviderFactory.js';
import { agentExecutor } from './services/agents/AgentExecutorService.js';
import { trainingExportService } from './services/training/TrainingExportService.js';
import { executionTracker } from './services/training/ExecutionTracker.js';

const PORT = parseInt(process.env.PORT || '3001');

async function main() {
  console.log('='.repeat(60));
  console.log(' Open Multi-Agents - Starting Server');
  console.log('='.repeat(60));

  // Initialize database
  await connectDatabase();

  // Initialize default provider
  try {
    const provider = await providerFactory.getDefault();
    console.log(`[Server] LLM Provider: ${provider.type} (${provider.model})`);
  } catch (error: any) {
    console.warn(`[Server] Warning: Could not initialize LLM provider: ${error.message}`);
    console.warn('[Server] Agent execution will fail until provider is available');
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
    const providerHealth = await providerFactory.healthCheckAll();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: providerHealth,
    });
  });

  // ===========================================
  // Agent Execution Endpoints
  // ===========================================

  /**
   * Execute an agent
   * POST /api/agents/execute
   */
  app.post('/api/agents/execute', async (req, res) => {
    try {
      const { taskId, agentType, phaseName, prompt, systemPrompt, tools, maxTurns, temperature } = req.body;

      if (!taskId || !agentType || !prompt) {
        return res.status(400).json({ error: 'Missing required fields: taskId, agentType, prompt' });
      }

      // Create tool handlers map (empty for now - tools implemented separately)
      const toolHandlers = new Map();

      const result = await agentExecutor.execute(
        {
          taskId,
          agentType,
          phaseName,
          prompt,
          systemPrompt,
          tools,
          maxTurns,
          temperature,
        },
        {
          toolHandlers,
          onTurnStart: (turn) => {
            io.to(taskId).emit('turn_start', { turn });
          },
          onContent: (content) => {
            io.to(taskId).emit('content', { content });
          },
          onToolCall: (toolName, input) => {
            io.to(taskId).emit('tool_call', { toolName, input });
          },
          onToolResult: (toolName, result) => {
            io.to(taskId).emit('tool_result', { toolName, ...result });
          },
        }
      );

      res.json(result);
    } catch (error: any) {
      console.error('[API] Agent execution error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Cancel an execution
   * POST /api/agents/cancel
   */
  app.post('/api/agents/cancel', (req, res) => {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ error: 'Missing taskId' });
    }

    agentExecutor.cancel(taskId);
    res.json({ success: true, message: `Cancelled execution for task ${taskId}` });
  });

  /**
   * Get execution history for a task
   * GET /api/tasks/:taskId/history
   */
  app.get('/api/tasks/:taskId/history', (req, res) => {
    const { taskId } = req.params;
    const history = agentExecutor.getHistory(taskId);
    res.json(history);
  });

  /**
   * Get execution statistics for a task
   * GET /api/tasks/:taskId/stats
   */
  app.get('/api/tasks/:taskId/stats', (req, res) => {
    const { taskId } = req.params;
    const stats = agentExecutor.getStats(taskId);
    res.json(stats);
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
  // Provider Endpoints
  // ===========================================

  /**
   * Get provider health
   * GET /api/providers/health
   */
  app.get('/api/providers/health', async (req, res) => {
    const health = await providerFactory.healthCheckAll();
    res.json(health);
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
    console.log(' Endpoints:');
    console.log('   GET  /health                  - Health check');
    console.log('   POST /api/agents/execute      - Execute agent');
    console.log('   POST /api/agents/cancel       - Cancel execution');
    console.log('   GET  /api/tasks/:id/history   - Execution history');
    console.log('   GET  /api/tasks/:id/stats     - Execution stats');
    console.log('   GET  /api/training/export/:id - Export task data');
    console.log('   GET  /api/training/export-jsonl - Export JSONL');
    console.log('   GET  /api/training/stats      - Export stats');
    console.log('='.repeat(60));
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await providerFactory.disposeAll();
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    await providerFactory.disposeAll();
    closeDatabase();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
