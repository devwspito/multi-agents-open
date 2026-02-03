/**
 * Approval Service
 *
 * Promise-based approval queue for phase approvals.
 * Waits for user response via WebSocket.
 */

import { socketService } from './SocketService.js';

interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class ApprovalServiceClass {
  private pending: Map<string, PendingApproval> = new Map(); // taskId:phase -> resolver
  private initialized = false;

  /**
   * Initialize listeners (call after socketService.init)
   */
  init(): void {
    if (this.initialized) return;

    const io = socketService.getIO();
    if (!io) {
      console.warn('[Approval] SocketService not initialized');
      return;
    }

    io.on('connection', (socket) => {
      socket.on('phase:approve', ({ taskId, phase }: { taskId: string; phase: string }) => {
        this.resolve(taskId, phase, true);
      });

      socket.on('phase:reject', ({ taskId, phase }: { taskId: string; phase: string }) => {
        this.resolve(taskId, phase, false);
      });
    });

    this.initialized = true;
    console.log('[Approval] Service initialized');
  }

  /**
   * Request approval for a phase (returns promise)
   */
  async requestApproval(
    taskId: string,
    phase: string,
    output: any,
    timeoutMs = 300000 // 5 min default
  ): Promise<boolean> {
    const key = `${taskId}:${phase}`;

    // Emit approval request to frontend
    socketService.toTask(taskId, 'phase:approval_required', {
      taskId,
      phase,
      output,
      requestedAt: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Approval timeout for ${phase}`));
      }, timeoutMs);

      this.pending.set(key, { resolve, reject, timeout });
    });
  }

  /**
   * Resolve a pending approval
   */
  private resolve(taskId: string, phase: string, approved: boolean): void {
    const key = `${taskId}:${phase}`;
    const pending = this.pending.get(key);

    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(approved);
      this.pending.delete(key);
      console.log(`[Approval] ${phase} ${approved ? 'approved' : 'rejected'}`);
    }
  }

  /**
   * Cancel all pending approvals for a task
   */
  cancelTask(taskId: string): void {
    for (const [key, pending] of this.pending) {
      if (key.startsWith(`${taskId}:`)) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Task cancelled'));
        this.pending.delete(key);
      }
    }
  }
}

export const approvalService = new ApprovalServiceClass();
export default approvalService;
