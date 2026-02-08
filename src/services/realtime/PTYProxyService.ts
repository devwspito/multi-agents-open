/**
 * PTY Proxy Service
 *
 * WebSocket proxy para conectar el frontend (xterm.js) con OpenCode PTY.
 * Permite mostrar la terminal de OpenCode en tu UI.
 *
 * Uso en frontend:
 * ```typescript
 * import { Terminal } from 'xterm';
 * import { AttachAddon } from 'xterm-addon-attach';
 *
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 *
 * // Conectar al proxy
 * const ws = new WebSocket('ws://localhost:3001/ws/pty?taskId=xxx&sessionId=yyy');
 * const attachAddon = new AttachAddon(ws);
 * term.loadAddon(attachAddon);
 * ```
 */

import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { openCodePTY, PTYSession } from '../opencode/OpenCodePTY.js';

interface PTYConnection {
  frontendWs: WebSocket;
  openCodeWs: WebSocket;
  ptySession: PTYSession;
  taskId: string;
  sessionId?: string;
}

class PTYProxyServiceClass {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, PTYConnection> = new Map(); // frontendWs -> connection

  /**
   * Initialize PTY proxy WebSocket server
   * Uses noServer mode to avoid conflicts with Socket.IO
   */
  init(server: HttpServer): void {
    // Use noServer to avoid conflicts with Socket.IO's upgrade handler
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      try {
        await this.handleConnection(ws, req);
      } catch (error: any) {
        console.error('[PTYProxy] Connection error:', error.message);
        ws.close(1011, error.message);
      }
    });

    // Manually handle upgrade requests ONLY for /ws/pty path
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

      // Only handle /ws/pty - let Socket.IO handle /ws/notifications
      if (pathname === '/ws/pty') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Don't call socket.destroy() for other paths - Socket.IO will handle them
    });

    console.log('[PTYProxy] WebSocket server initialized at /ws/pty');
  }

  /**
   * Handle new frontend connection
   */
  private async handleConnection(frontendWs: WebSocket, req: IncomingMessage): Promise<void> {
    // Parse query parameters
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const taskId = url.searchParams.get('taskId');
    const sessionId = url.searchParams.get('sessionId');
    const directory = url.searchParams.get('directory');
    const ptyId = url.searchParams.get('ptyId'); // Optional: connect to existing PTY

    if (!taskId) {
      throw new Error('taskId is required');
    }

    console.log(`[PTYProxy] New connection for task: ${taskId}`);

    let ptySession: PTYSession;

    // Either connect to existing PTY or create new one
    if (ptyId) {
      const existing = await openCodePTY.getPTY(ptyId, directory || undefined);
      if (!existing) {
        throw new Error(`PTY session ${ptyId} not found`);
      }
      ptySession = existing;
    } else {
      // Create new PTY session
      ptySession = await openCodePTY.createPTY({
        title: `Task ${taskId}`,
        cwd: directory || undefined,
        directory: directory || undefined,
      });
    }

    // Connect to OpenCode PTY via WebSocket
    const openCodeWs = openCodePTY.connectToPTY(ptySession.id, directory || undefined);

    const connectionId = `${frontendWs}_${Date.now()}`;

    // Store connection info
    const connection: PTYConnection = {
      frontendWs,
      openCodeWs,
      ptySession,
      taskId,
      sessionId: sessionId || undefined,
    };
    this.connections.set(connectionId, connection);

    // Proxy data: OpenCode -> Frontend
    openCodeWs.on('message', (data: Buffer) => {
      if (frontendWs.readyState === WebSocket.OPEN) {
        frontendWs.send(data);
      }
    });

    // Proxy data: Frontend -> OpenCode (keyboard input)
    frontendWs.on('message', (data: Buffer) => {
      if (openCodeWs.readyState === WebSocket.OPEN) {
        openCodeWs.send(data);
      }
    });

    // Handle frontend disconnect
    frontendWs.on('close', () => {
      console.log(`[PTYProxy] Frontend disconnected from task: ${taskId}`);
      openCodeWs.close();
      this.connections.delete(connectionId);
    });

    // Handle OpenCode disconnect
    openCodeWs.on('close', () => {
      console.log(`[PTYProxy] OpenCode PTY closed for task: ${taskId}`);
      if (frontendWs.readyState === WebSocket.OPEN) {
        frontendWs.close(1000, 'PTY session ended');
      }
      this.connections.delete(connectionId);
    });

    // Handle errors
    openCodeWs.on('error', (error: Error) => {
      console.error(`[PTYProxy] OpenCode WS error:`, error.message);
      frontendWs.close(1011, 'PTY connection error');
    });

    frontendWs.on('error', (error: Error) => {
      console.error(`[PTYProxy] Frontend WS error:`, error.message);
      openCodeWs.close();
    });

    // Send initial message to frontend
    frontendWs.send(JSON.stringify({
      type: 'pty:connected',
      ptyId: ptySession.id,
      taskId,
      sessionId,
    }));

    console.log(`[PTYProxy] Proxy established: frontend <-> PTY ${ptySession.id}`);
  }

  /**
   * Resize PTY (called when terminal is resized in frontend)
   */
  async resizePTY(ptyId: string, cols: number, rows: number, directory?: string): Promise<void> {
    const client = (await import('../opencode/OpenCodeClient.js')).openCodeClient.getClient();

    await client.pty.update({
      ptyID: ptyId,
      directory,
      size: { rows, cols },
    });
  }

  /**
   * Get active connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Close all connections (for shutdown)
   */
  closeAll(): void {
    for (const [id, conn] of this.connections) {
      conn.frontendWs.close();
      conn.openCodeWs.close();
    }
    this.connections.clear();
    console.log('[PTYProxy] All connections closed');
  }
}

export const ptyProxyService = new PTYProxyServiceClass();
export default ptyProxyService;
