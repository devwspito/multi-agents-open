/**
 * Approval Service
 *
 * Promise-based approval queue for phase approvals.
 * Waits for user response via WebSocket.
 *
 * Supports three actions:
 * - approve: User approves, proceed to commit
 * - reject: User rejects, abort story
 * - request_changes: User provides feedback, OpenCode continues to iterate
 */

import { socketService } from './SocketService.js';

export interface ApprovalResponse {
  action: 'approve' | 'reject' | 'request_changes';
  feedback?: string;
}

interface PendingApproval {
  resolve: (response: ApprovalResponse) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout; // 🔥 Optional - no timeout by default (human is never bypassed)
  // 🔥 Store approval data for resending on reconnect
  taskId: string;
  phase: string;
  output: any;
  requestedAt: string;
}

export interface PendingApprovalInfo {
  taskId: string;
  phase: string;
  output: any;
  requestedAt: string;
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
        this.resolveWithAction(taskId, phase, { action: 'approve' });
      });

      socket.on('phase:reject', ({ taskId, phase }: { taskId: string; phase: string }) => {
        this.resolveWithAction(taskId, phase, { action: 'reject' });
      });

      // Handle request_changes: User provides feedback to continue iteration
      socket.on('phase:request_changes', ({ taskId, phase, feedback }: { taskId: string; phase: string; feedback: string }) => {
        console.log(`[Approval] 📝 Received request_changes for ${phase} with feedback: ${feedback?.substring(0, 50)}...`);
        this.resolveWithAction(taskId, phase, { action: 'request_changes', feedback });
      });
    });

    this.initialized = true;
    console.log('[Approval] Service initialized');
  }

  /**
   * Request approval for a phase (returns promise with action)
   *
   * 🔥 CRITICAL: No timeout by default - the human is NEVER bypassed.
   * The system waits indefinitely for human approval/rejection.
   * Only set timeoutMs if you have a specific use case that requires it.
   *
   * @returns ApprovalResponse with action and optional feedback
   */
  async requestApproval(
    taskId: string,
    phase: string,
    output: any,
    timeoutMs?: number // 🔥 No default timeout - wait forever for human
  ): Promise<ApprovalResponse> {
    const key = `${taskId}:${phase}`;

    console.log(`[Approval] 🔔 Requesting approval for phase "${phase}" on task ${taskId}`);
    console.log(`[Approval] ⏳ Waiting indefinitely for human response (no timeout)`);

    // Emit approval request to frontend
    socketService.toTask(taskId, 'phase:approval_required', {
      taskId,
      phase,
      output,
      requestedAt: new Date().toISOString(),
    });

    console.log(`[Approval] 📤 Emitted phase:approval_required to task room ${taskId}`);

    const requestedAt = new Date().toISOString();

    return new Promise((resolve, reject) => {
      // 🔥 Only set timeout if explicitly requested - human is never bypassed by default
      let timeout: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        console.log(`[Approval] ⚠️ Timeout set to ${timeoutMs}ms (not recommended)`);
        timeout = setTimeout(() => {
          this.pending.delete(key);
          reject(new Error(`Approval timeout for ${phase}`));
        }, timeoutMs);
      }

      // 🔥 Store approval data for resending on reconnect
      this.pending.set(key, {
        resolve,
        reject,
        timeout, // 🔥 May be undefined - no timeout means wait forever for human
        taskId,
        phase,
        output,
        requestedAt,
      });
    });
  }

  /**
   * Resolve a pending approval with an action response
   * (public - can be called from HTTP endpoints)
   */
  resolveWithAction(taskId: string, phase: string, response: ApprovalResponse): boolean {
    const key = `${taskId}:${phase}`;
    const pending = this.pending.get(key);

    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout); // 🔥 May be undefined if no timeout set
      pending.resolve(response);
      this.pending.delete(key);
      console.log(`[Approval] ${phase} action=${response.action} for task ${taskId}${response.feedback ? ` (feedback: ${response.feedback.substring(0, 50)}...)` : ''}`);
      return true;
    }

    console.warn(`[Approval] No pending approval found for ${taskId}:${phase}`);
    return false;
  }

  /**
   * Legacy resolve method for backward compatibility
   * @deprecated Use resolveWithAction instead
   */
  resolve(taskId: string, phase: string, approved: boolean): boolean {
    return this.resolveWithAction(taskId, phase, { action: approved ? 'approve' : 'reject' });
  }

  /**
   * Check if there's a pending approval for a task/phase
   */
  hasPendingApproval(taskId: string, phase: string): boolean {
    return this.pending.has(`${taskId}:${phase}`);
  }

  /**
   * Cancel all pending approvals for a task
   */
  cancelTask(taskId: string): void {
    for (const [key, pending] of this.pending) {
      if (key.startsWith(`${taskId}:`)) {
        if (pending.timeout) clearTimeout(pending.timeout); // 🔥 May be undefined if no timeout set
        pending.reject(new Error('Task cancelled'));
        this.pending.delete(key);
      }
    }
  }

  /**
   * 🔥 Get pending approval info for a task (for API response / client reconnect)
   */
  getPendingApprovalForTask(taskId: string): PendingApprovalInfo | null {
    for (const [key, pending] of this.pending) {
      if (key.startsWith(`${taskId}:`)) {
        return {
          taskId: pending.taskId,
          phase: pending.phase,
          output: pending.output,
          requestedAt: pending.requestedAt,
        };
      }
    }
    return null;
  }

  /**
   * 🔥 Resend approval request to a specific task room
   * Called when a client joins a task room that has a pending approval
   */
  resendApprovalRequest(taskId: string): boolean {
    const pending = this.getPendingApprovalForTask(taskId);
    if (!pending) {
      return false;
    }

    console.log(`[Approval] 🔄 Resending approval request for task ${taskId} phase ${pending.phase}`);

    socketService.toTask(taskId, 'phase:approval_required', {
      taskId: pending.taskId,
      phase: pending.phase,
      output: pending.output,
      requestedAt: pending.requestedAt,
    });

    return true;
  }
}

export const approvalService = new ApprovalServiceClass();
export default approvalService;
