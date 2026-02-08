/**
 * Approval Mode Service
 *
 * Manages auto-approval modes for OpenCode sessions and orchestration phases.
 *
 * Modes:
 * - manual: All permissions require user approval
 * - work: Auto-approve OpenCode permissions (edit, bash, webfetch)
 * - all: Auto-approve OpenCode + auto-approve all orchestration phases
 *
 * Commands:
 * - /auto-approval-work: Enable work mode for current task
 * - /auto-approval-all: Enable all mode for current task
 */

import { SessionRepository, ApprovalMode } from '../../database/repositories/SessionRepository.js';
import { openCodeClient } from '../opencode/OpenCodeClient.js';
import { socketService } from '../realtime/SocketService.js';

interface PendingPermission {
  taskId: string;
  sessionId: string;
  permissionId: string;
  tool: string;
  description: string;
  timestamp: Date;
}

class ApprovalModeServiceClass {
  private pendingPermissions: Map<string, PendingPermission> = new Map(); // permissionId -> data
  private taskApprovalModes: Map<string, ApprovalMode> = new Map(); // taskId -> mode (in-memory cache)

  /**
   * Set approval mode for a task (and all its sessions)
   */
  async setApprovalMode(taskId: string, mode: ApprovalMode): Promise<void> {
    console.log(`[ApprovalMode] Setting mode '${mode}' for task ${taskId}`);

    // Update in-memory cache
    this.taskApprovalModes.set(taskId, mode);

    // Update all active sessions for this task in database
    const updated = await SessionRepository.updateApprovalModeByTaskId(taskId, mode);
    console.log(`[ApprovalMode] Updated ${updated} session(s) in database`);

    // Get active sessions and update OpenCode permissions
    const sessions = await SessionRepository.findByTaskId(taskId);
    for (const session of sessions) {
      if (session.status === 'active') {
        try {
          if (mode === 'work' || mode === 'all') {
            await openCodeClient.enableAutoApproval(session.sessionId, session.directory);
          } else {
            await openCodeClient.disableAutoApproval(session.sessionId, session.directory);
          }
        } catch (error: any) {
          console.warn(`[ApprovalMode] Failed to update OpenCode session ${session.sessionId}: ${error.message}`);
        }
      }
    }

    // Notify frontend about mode change
    socketService.toTask(taskId, 'approval:mode_changed', {
      taskId,
      mode,
      timestamp: new Date().toISOString(),
    });

    // If changing to auto-approve, process any pending permissions
    if (mode === 'work' || mode === 'all') {
      await this.processAllPendingPermissions(taskId);
    }
  }

  /**
   * Get approval mode for a task
   */
  async getApprovalMode(taskId: string): Promise<ApprovalMode> {
    // Check cache first
    if (this.taskApprovalModes.has(taskId)) {
      return this.taskApprovalModes.get(taskId)!;
    }

    // Check database
    const session = await SessionRepository.findActiveByTaskId(taskId);
    const mode = session?.approvalMode || 'manual';
    this.taskApprovalModes.set(taskId, mode);

    return mode;
  }

  /**
   * Register a new session and apply current approval mode
   */
  async registerSession(
    sessionId: string,
    taskId: string,
    directory: string,
    phaseName?: string
  ): Promise<void> {
    // Get current approval mode for task
    const mode = await this.getApprovalMode(taskId);

    // Create session record
    await SessionRepository.create({
      sessionId,
      taskId,
      directory,
      phaseName,
      approvalMode: mode,
    });

    console.log(`[ApprovalMode] Registered session ${sessionId} with mode '${mode}'`);

    // Apply auto-approval if needed
    if (mode === 'work' || mode === 'all') {
      try {
        await openCodeClient.enableAutoApproval(sessionId, directory);
      } catch (error: any) {
        console.warn(`[ApprovalMode] Failed to enable auto-approval: ${error.message}`);
      }
    }
  }

  /**
   * Handle incoming permission request from OpenCode
   */
  async handlePermissionRequest(
    sessionId: string,
    permissionId: string,
    tool: string,
    description: string,
    args?: any
  ): Promise<'auto_approved' | 'pending' | 'error'> {
    // Find session
    const session = await SessionRepository.findBySessionId(sessionId);
    if (!session) {
      console.warn(`[ApprovalMode] Unknown session: ${sessionId}`);
      return 'error';
    }

    const { taskId, approvalMode } = session;

    console.log(`[ApprovalMode] Permission request for ${tool} (mode: ${approvalMode})`);

    // Check if should auto-approve
    if (approvalMode === 'work' || approvalMode === 'all') {
      // Auto-approve
      try {
        await openCodeClient.respondToPermission(
          sessionId,
          permissionId,
          'always', // Allow always since we're in auto-approve mode
          session.directory
        );

        console.log(`[ApprovalMode] Auto-approved permission ${permissionId}`);

        // Notify frontend about auto-approval
        socketService.toTask(taskId, 'approval:auto_approved', {
          taskId,
          sessionId,
          permissionId,
          tool,
          description,
          timestamp: new Date().toISOString(),
        });

        return 'auto_approved';
      } catch (error: any) {
        console.error(`[ApprovalMode] Failed to auto-approve: ${error.message}`);
        return 'error';
      }
    }

    // Manual mode - store pending and notify frontend
    const pending: PendingPermission = {
      taskId,
      sessionId,
      permissionId,
      tool,
      description,
      timestamp: new Date(),
    };

    this.pendingPermissions.set(permissionId, pending);

    // Store in database
    await SessionRepository.setPendingPermission(sessionId, permissionId, {
      tool,
      description,
      args,
    });

    // Notify frontend to show approval dialog
    socketService.toTask(taskId, 'approval:permission_required', {
      taskId,
      sessionId,
      permissionId,
      tool,
      description,
      args,
      timestamp: new Date().toISOString(),
    });

    console.log(`[ApprovalMode] Permission ${permissionId} pending user approval`);
    return 'pending';
  }

  /**
   * User responds to a permission request
   */
  async respondToPermission(
    permissionId: string,
    response: 'once' | 'always' | 'reject'
  ): Promise<boolean> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      console.warn(`[ApprovalMode] Unknown pending permission: ${permissionId}`);
      return false;
    }

    const { taskId, sessionId } = pending;

    // Find session to get directory
    const session = await SessionRepository.findBySessionId(sessionId);
    if (!session) {
      console.warn(`[ApprovalMode] Session not found: ${sessionId}`);
      return false;
    }

    try {
      // Send response to OpenCode
      await openCodeClient.respondToPermission(
        sessionId,
        permissionId,
        response,
        session.directory
      );

      // Clear pending
      this.pendingPermissions.delete(permissionId);
      await SessionRepository.clearPendingPermission(sessionId);

      // Notify frontend
      socketService.toTask(taskId, 'approval:permission_responded', {
        taskId,
        sessionId,
        permissionId,
        response,
        timestamp: new Date().toISOString(),
      });

      console.log(`[ApprovalMode] Permission ${permissionId} responded: ${response}`);
      return true;
    } catch (error: any) {
      console.error(`[ApprovalMode] Failed to respond: ${error.message}`);
      return false;
    }
  }

  /**
   * Process all pending permissions for a task (when switching to auto-approve)
   */
  private async processAllPendingPermissions(taskId: string): Promise<void> {
    const toProcess: PendingPermission[] = [];

    for (const [id, pending] of this.pendingPermissions) {
      if (pending.taskId === taskId) {
        toProcess.push(pending);
      }
    }

    for (const pending of toProcess) {
      await this.respondToPermission(pending.permissionId, 'always');
    }

    if (toProcess.length > 0) {
      console.log(`[ApprovalMode] Auto-approved ${toProcess.length} pending permission(s)`);
    }
  }

  /**
   * Check if orchestration phases should auto-proceed (for 'all' mode)
   */
  async shouldAutoApprovePhase(taskId: string): Promise<boolean> {
    const mode = await this.getApprovalMode(taskId);
    return mode === 'all';
  }

  /**
   * Mark session as completed
   */
  async completeSession(sessionId: string): Promise<void> {
    await SessionRepository.updateStatus(sessionId, 'completed');

    // Clean up pending permissions for this session
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
      }
    }
  }

  /**
   * Get pending permissions for a task
   */
  getPendingPermissions(taskId: string): PendingPermission[] {
    const result: PendingPermission[] = [];
    for (const pending of this.pendingPermissions.values()) {
      if (pending.taskId === taskId) {
        result.push(pending);
      }
    }
    return result;
  }

  /**
   * Clear task from cache (on task completion)
   */
  clearTask(taskId: string): void {
    this.taskApprovalModes.delete(taskId);

    // Clear pending permissions
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.taskId === taskId) {
        this.pendingPermissions.delete(id);
      }
    }
  }
}

export const approvalModeService = new ApprovalModeServiceClass();
export default approvalModeService;
