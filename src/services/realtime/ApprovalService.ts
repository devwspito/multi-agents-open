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
import { ApprovalLogRepository } from '../../database/repositories/ApprovalLogRepository.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { logger } from '../logging/Logger.js';

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
      logger.warn('SocketService not initialized, approval service cannot start');
      return;
    }

    io.on('connection', (socket) => {
      // 🔥 FIX: Include feedback in phase:approve (for clarification answers)
      socket.on('phase:approve', ({ taskId, phase, feedback, userId }: { taskId: string; phase: string; feedback?: string; userId?: string }) => {
        this.resolveWithAction(taskId, phase, { action: 'approve', feedback }, socket.id, userId);
      });

      socket.on('phase:reject', ({ taskId, phase, userId }: { taskId: string; phase: string; userId?: string }) => {
        this.resolveWithAction(taskId, phase, { action: 'reject' }, socket.id, userId);
      });

      // Handle request_changes: User provides feedback to continue iteration
      socket.on('phase:request_changes', ({ taskId, phase, feedback, userId }: { taskId: string; phase: string; feedback: string; userId?: string }) => {
        logger.approval(taskId, phase, 'requested', { event: 'request_changes_received', feedback: feedback?.substring(0, 100) });
        this.resolveWithAction(taskId, phase, { action: 'request_changes', feedback }, socket.id, userId);
      });
    });

    this.initialized = true;
    logger.info('Approval service initialized');
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

    logger.approval(taskId, phase, 'requested', { event: 'approval_request_start' });

    // Emit approval request to frontend
    socketService.toTask(taskId, 'phase:approval_required', {
      taskId,
      phase,
      output,
      requestedAt: new Date().toISOString(),
    });

    logger.debug('Emitted phase:approval_required', { taskId, phase, event: 'approval_emitted' });

    const requestedAt = new Date().toISOString();

    return new Promise((resolve, reject) => {
      // 🔥 Only set timeout if explicitly requested - human is never bypassed by default
      let timeout: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        logger.warn('Approval timeout configured (not recommended)', { taskId, phase, timeoutMs });
        timeout = setTimeout(() => {
          this.pending.delete(key);
          // 🔒 Audit log: record timeout
          ApprovalLogRepository.log({
            taskId,
            phase,
            action: 'timeout',
            metadata: { requestedAt, timeoutMs },
          }).catch(err => logger.warn('Failed to write timeout audit log', { taskId, phase, error: (err as Error).message }));
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
  resolveWithAction(taskId: string, phase: string, response: ApprovalResponse, clientId?: string, userId?: string): boolean {
    const key = `${taskId}:${phase}`;
    const pending = this.pending.get(key);

    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout); // 🔥 May be undefined if no timeout set
      pending.resolve(response);
      this.pending.delete(key);
      logger.approval(taskId, phase, response.action === 'approve' ? 'approved' : response.action === 'reject' ? 'rejected' : 'requested', {
        feedback: response.feedback?.substring(0, 100),
      });

      // 🔒 Audit log: record this approval decision
      ApprovalLogRepository.log({
        taskId,
        phase,
        action: response.action === 'request_changes' ? 'approve' : response.action as 'approve' | 'reject',
        clientId,
        userId,
        metadata: {
          feedback: response.feedback,
          requestedAt: pending.requestedAt,
          resolvedAt: new Date().toISOString(),
        },
      }).catch(err => logger.warn('Failed to write approval audit log', { taskId, phase, error: (err as Error).message }));

      // 🔥 REMOVED: Text entries like "✅ Planning Phase approved" - user wants completed phases shown via StageIndicator only
      // The phase:complete event is emitted elsewhere and handled by ClaudeStyleConsole to show completed StageIndicator

      return true;
    }

    logger.warn('No pending approval found', { taskId, phase });
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
        // 🔒 Audit log: record cancellation
        ApprovalLogRepository.log({
          taskId,
          phase: pending.phase,
          action: 'reject',
          metadata: {
            reason: 'task_cancelled',
            requestedAt: pending.requestedAt,
            cancelledAt: new Date().toISOString(),
          },
        }).catch(err => logger.warn('Failed to write cancel audit log', { taskId, error: (err as Error).message }));
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

    logger.info('Resending approval request', { taskId, phase: pending.phase, event: 'approval_resend' });

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
