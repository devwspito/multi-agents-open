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
import { TaskRepository } from './database/repositories/TaskRepository.js';
import { toolDefinitions, toolHandlers } from './tools/index.js';

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

  /**
   * Get available tools
   * GET /api/tools
   */
  app.get('/api/tools', (req, res) => {
    res.json(toolDefinitions);
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
    console.log(' ');
    console.log(' Task Endpoints:');
    console.log('   POST /api/tasks               - Create task');
    console.log('   GET  /api/tasks               - List tasks');
    console.log('   GET  /api/tasks/:id           - Get task');
    console.log('   PUT  /api/tasks/:id           - Update task');
    console.log('   DELETE /api/tasks/:id         - Delete task');
    console.log(' ');
    console.log(' Agent Endpoints:');
    console.log('   POST /api/agents/execute      - Execute agent');
    console.log('   POST /api/agents/cancel       - Cancel execution');
    console.log('   GET  /api/tasks/:id/history   - Execution history');
    console.log('   GET  /api/tasks/:id/stats     - Execution stats');
    console.log(' ');
    console.log(' Training Endpoints:');
    console.log('   GET  /api/training/export/:id - Export task data');
    console.log('   GET  /api/training/export-jsonl - Export JSONL');
    console.log('   GET  /api/training/stats      - Export stats');
    console.log(' ');
    console.log(' Other:');
    console.log('   GET  /api/tools               - Available tools');
    console.log('   GET  /api/providers/health    - Provider health');
    console.log('   GET  /health                  - Server health');
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
