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
  console.error('[API] Error:', err.message);
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
    console.log(`[API] Server running on http://localhost:${port}`);
    console.log(`[API] WebSocket available at ws://localhost:${port}/ws/notifications`);
    console.log(`[API] PTY Terminal available at ws://localhost:${port}/ws/pty`);
  });
}

export { app, httpServer };
