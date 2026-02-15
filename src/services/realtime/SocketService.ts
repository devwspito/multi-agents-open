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
  private userRooms: Map<string, Set<string>> = new Map(); // userId -> socketIds
  // 🔥 Callback for when a client joins a task room (used by ApprovalService)
  private onTaskJoinCallback: ((taskId: string, socketId: string) => void) | null = null;

  /**
   * Initialize with HTTP server
   */
  init(server: HttpServer): Server {
    this.io = new Server(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      path: '/ws/notifications',
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`[Socket] Client connected: ${socket.id}`);

      // Helper to join task room
      const joinTask = (taskId: string) => {
        socket.join(taskId);
        if (!this.taskRooms.has(taskId)) {
          this.taskRooms.set(taskId, new Set());
        }
        this.taskRooms.get(taskId)!.add(socket.id);
        const roomSize = this.taskRooms.get(taskId)!.size;
        console.log(`[Socket] ✅ ${socket.id} joined task ${taskId} (room size: ${roomSize})`);

        // 🔥 Notify callback (used by ApprovalService to resend pending approvals)
        if (this.onTaskJoinCallback) {
          this.onTaskJoinCallback(taskId, socket.id);
        }
      };

      // Helper to leave task room
      const leaveTask = (taskId: string) => {
        socket.leave(taskId);
        this.taskRooms.get(taskId)?.delete(socket.id);
        console.log(`[Socket] ${socket.id} left task ${taskId}`);
      };

      // Helper to join user room
      const joinUser = (userId: string) => {
        socket.join(`user:${userId}`);
        if (!this.userRooms.has(userId)) {
          this.userRooms.set(userId, new Set());
        }
        this.userRooms.get(userId)!.add(socket.id);
        console.log(`[Socket] ${socket.id} joined user room ${userId}`);
      };

      // Helper to leave user room
      const leaveUser = (userId: string) => {
        socket.leave(`user:${userId}`);
        this.userRooms.get(userId)?.delete(socket.id);
        console.log(`[Socket] ${socket.id} left user room ${userId}`);
      };

      // Support multiple event names (frontend compatibility)
      socket.on('task:join', joinTask);
      socket.on('join-task', joinTask);
      socket.on('subscribe', joinTask);

      socket.on('task:leave', leaveTask);
      socket.on('leave-task', leaveTask);
      socket.on('unsubscribe', leaveTask);

      // User room events
      socket.on('user:join', joinUser);
      socket.on('user:leave', leaveUser);
      socket.on('authenticate', (data: { userId: string }) => {
        if (data?.userId) joinUser(data.userId);
      });

      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        // Cleanup task rooms
        for (const [taskId, sockets] of this.taskRooms) {
          sockets.delete(socket.id);
        }
        // Cleanup user rooms
        for (const [userId, sockets] of this.userRooms) {
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
    const roomSize = this.taskRooms.get(taskId)?.size || 0;

    // 🔥 Always log phase:approval_required events (critical for debugging)
    if (event === 'phase:approval_required') {
      console.log(`[Socket] 🔔 Emitting phase:approval_required to task ${taskId} (room size: ${roomSize})`);
      if (roomSize === 0) {
        console.log(`[Socket] ⚠️ WARNING: No clients in task room ${taskId} - approval event will be lost!`);
      }
    }

    // Debug: log if anyone is in the room for activity events
    if (roomSize === 0 && event === 'agent:activity') {
      // Only log once every 50 events to avoid spam
      if (Math.random() < 0.02) {
        console.log(`[Socket] ⚠️ No clients in task room ${taskId} for event ${event}`);
      }
    }
    this.io?.to(taskId).emit(event, data);

    // 🔥 PERSIST: Save important events to activity_log for page refresh recovery
    this.persistIfImportant(taskId, event, data);
  }

  /**
   * 🔥 Persist ALL significant events to activity_log for page refresh recovery
   * Save everything except high-frequency noise events
   */
  private persistIfImportant(taskId: string, event: string, data: any): void {
    // Skip high-frequency noise events that would bloat the DB
    const skipEvents = [
      'cost:update',           // Tracked separately in cost tracker
      'typing',                // UI feedback only
      'heartbeat', 'ping', 'pong',
    ];

    if (skipEvents.includes(event)) return;

    // Skip agent:activity if it's just a duplicate (OpenCodeEventBridge already saves these)
    // But keep it if it has unique content from phases
    if (event === 'agent:activity' && data?.type === 'tool_call') return;

    // Lazy import to avoid circular dependency
    import('../../database/repositories/TaskRepository.js').then(({ TaskRepository }) => {
      const content = data?.message || data?.phase || data?.content || data?.title || event;
      TaskRepository.appendActivityLog(taskId, {
        type: event,
        content: typeof content === 'string' ? content.substring(0, 5000) : JSON.stringify(content).substring(0, 5000),
        timestamp: new Date().toISOString(),
        toolInput: data,
      }).catch(err => {
        console.warn(`[Socket] Failed to persist event ${event}: ${err.message}`);
      });
    }).catch(() => {
      // Ignore import errors
    });
  }

  /**
   * Emit to a specific user (by userId)
   */
  emitToUser(userId: string, event: string, data: any): void {
    this.io?.to(`user:${userId}`).emit(event, data);
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

  /**
   * Check if a user is connected
   */
  isUserConnected(userId: string): boolean {
    const sockets = this.userRooms.get(userId);
    return sockets ? sockets.size > 0 : false;
  }

  /**
   * Get number of connected users
   */
  getConnectedUsersCount(): number {
    return this.userRooms.size;
  }

  /**
   * 🔥 Set callback for when a client joins a task room
   * Used by ApprovalService to resend pending approvals
   */
  setOnTaskJoinCallback(callback: (taskId: string, socketId: string) => void): void {
    this.onTaskJoinCallback = callback;
    console.log('[Socket] Task join callback registered');
  }
}

export const socketService = new SocketServiceClass();
export default socketService;
