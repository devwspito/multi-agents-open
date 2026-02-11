/**
 * API Server
 *
 * Express + Socket.io server for the multi-agent platform.
 * Compatible with multi-agent-frontend.
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { socketService } from '../services/realtime/index.js';
import { approvalService } from '../services/realtime/index.js';
import { ptyProxyService } from '../services/realtime/PTYProxyService.js';
import { logger } from '../services/logging/Logger.js';

// Routes
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import repositoryRoutes from './routes/repositories.js';
import taskRoutes from './routes/tasks.js';
import ptyRoutes from './routes/pty.js';

const app: Express = express();
const httpServer = createServer(app);

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const correlationId = req.headers['x-correlation-id'] as string || `req-${Date.now()}`;

  // Add correlation ID to response
  res.setHeader('x-correlation-id', correlationId);

  // Log on response finish
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    // Skip health checks from logging to reduce noise
    if (req.path !== '/health') {
      logger.request(req.method, req.path, res.statusCode, durationMs, {
        correlationId,
        userAgent: req.headers['user-agent']?.substring(0, 100),
      });
    }
  });

  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/repositories', repositoryRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/pty', ptyRoutes);

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('API request error', err, {
    method: req.method,
    path: req.path,
    correlationId: res.getHeader('x-correlation-id') as string,
  });
  res.status(500).json({ error: err.message });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Start the server
 */
export async function startServer(port = 3000): Promise<void> {
  // Initialize Socket.io (notifications)
  socketService.init(httpServer);
  approvalService.init();

  // 🔥 Wire up task join callback to resend pending approvals
  socketService.setOnTaskJoinCallback((taskId, socketId) => {
    // Check if there's a pending approval for this task and resend it
    approvalService.resendApprovalRequest(taskId);
  });

  // Initialize PTY Proxy (terminal streaming)
  ptyProxyService.init(httpServer);

  // Start listening
  httpServer.listen(port, () => {
    logger.info('Server started', {
      port,
      websocket: `ws://localhost:${port}/ws/notifications`,
      pty: `ws://localhost:${port}/ws/pty`,
      event: 'server_start',
    });
  });
}

export { app, httpServer };
