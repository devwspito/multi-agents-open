/**
 * Socket Service
 *
 * WebSocket singleton for real-time communication.
 * Reusable across the entire application.
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

class SocketServiceClass {
  private io: Server | null = null;
  private taskRooms: Map<string, Set<string>> = new Map(); // taskId -> socketIds

  /**
   * Initialize with HTTP server
   */
  init(server: HttpServer): Server {
    this.io = new Server(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`[Socket] Client connected: ${socket.id}`);

      // Join task room
      socket.on('task:join', (taskId: string) => {
        socket.join(taskId);
        if (!this.taskRooms.has(taskId)) {
          this.taskRooms.set(taskId, new Set());
        }
        this.taskRooms.get(taskId)!.add(socket.id);
        console.log(`[Socket] ${socket.id} joined task ${taskId}`);
      });

      // Leave task room
      socket.on('task:leave', (taskId: string) => {
        socket.leave(taskId);
        this.taskRooms.get(taskId)?.delete(socket.id);
      });

      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        // Cleanup rooms
        for (const [taskId, sockets] of this.taskRooms) {
          sockets.delete(socket.id);
        }
      });
    });

    console.log('[Socket] WebSocket server initialized');
    return this.io;
  }

  /**
   * Emit to a specific task room
   */
  toTask(taskId: string, event: string, data: any): void {
    this.io?.to(taskId).emit(event, data);
  }

  /**
   * Emit to all connected clients
   */
  broadcast(event: string, data: any): void {
    this.io?.emit(event, data);
  }

  /**
   * Get the raw io instance
   */
  getIO(): Server | null {
    return this.io;
  }
}

export const socketService = new SocketServiceClass();
export default socketService;
