/**
 * ApprovalService Unit Tests
 *
 * Tests for the human-in-the-loop approval service that manages
 * approval requests and audit logging.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('./SocketService.js', () => ({
  socketService: {
    getIO: vi.fn(),
    toTask: vi.fn(),
  },
}));

vi.mock('../../database/repositories/ApprovalLogRepository.js', () => ({
  ApprovalLogRepository: {
    log: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../logging/Logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    approval: vi.fn(),
  },
}));

// Import after mocks
import { approvalService } from './ApprovalService.js';
import { socketService } from './SocketService.js';
import { ApprovalLogRepository } from '../../database/repositories/ApprovalLogRepository.js';

describe('ApprovalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset internal state
    (approvalService as any).pending.clear();
    (approvalService as any).initialized = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('requestApproval', () => {
    it('should emit approval:required event', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {
        description: 'Test approval',
      });

      // Resolve the approval
      approvalService.resolveWithAction('task-1', 'Developer', { action: 'approve' });

      await expect(promise).resolves.toEqual({ action: 'approve' });

      expect(socketService.toTask).toHaveBeenCalledWith(
        'task-1',
        'phase:approval_required',
        expect.objectContaining({
          taskId: 'task-1',
          phase: 'Developer',
          output: expect.objectContaining({
            description: 'Test approval',
          }),
        })
      );
    });

    it('should store pending approval for later resolution', async () => {
      const promise = approvalService.requestApproval('task-1', 'Analysis', {});

      expect(approvalService.hasPendingApproval('task-1', 'Analysis')).toBe(true);

      approvalService.resolveWithAction('task-1', 'Analysis', { action: 'approve' });
      await promise;

      expect(approvalService.hasPendingApproval('task-1', 'Analysis')).toBe(false);
    });

    it('should timeout if timeoutMs is specified', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {}, 5000);

      // Advance time past timeout
      vi.advanceTimersByTime(6000);

      await expect(promise).rejects.toThrow('Approval timeout');

      // Should log timeout to audit
      expect(ApprovalLogRepository.log).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          phase: 'Developer',
          action: 'timeout',
        })
      );
    });

    it('should not timeout if timeoutMs is not specified', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      // Advance time significantly
      vi.advanceTimersByTime(60000);

      // Should still be pending
      expect(approvalService.hasPendingApproval('task-1', 'Developer')).toBe(true);

      // Clean up
      approvalService.resolveWithAction('task-1', 'Developer', { action: 'reject' });
      await promise;
    });
  });

  describe('resolveWithAction', () => {
    it('should resolve pending approval with approve action', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      const resolved = approvalService.resolveWithAction('task-1', 'Developer', {
        action: 'approve',
      });

      expect(resolved).toBe(true);
      await expect(promise).resolves.toEqual({ action: 'approve' });
    });

    it('should resolve pending approval with reject action', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      const resolved = approvalService.resolveWithAction('task-1', 'Developer', {
        action: 'reject',
      });

      expect(resolved).toBe(true);
      await expect(promise).resolves.toEqual({ action: 'reject' });
    });

    it('should resolve pending approval with request_changes action and feedback', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      const resolved = approvalService.resolveWithAction('task-1', 'Developer', {
        action: 'request_changes',
        feedback: 'Please add error handling',
      });

      expect(resolved).toBe(true);
      const result = await promise;
      expect(result.action).toBe('request_changes');
      expect(result.feedback).toBe('Please add error handling');
    });

    it('should log approval to audit repository', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      approvalService.resolveWithAction('task-1', 'Developer', {
        action: 'approve',
      }, 'client-123', 'user-456');

      await promise;

      expect(ApprovalLogRepository.log).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          phase: 'Developer',
          action: 'approve',
          clientId: 'client-123',
          userId: 'user-456',
        })
      );
    });

    it('should return false if no pending approval exists', () => {
      const resolved = approvalService.resolveWithAction('nonexistent', 'Developer', {
        action: 'approve',
      });

      expect(resolved).toBe(false);
    });

    it('should clear timeout when resolved', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {}, 10000);

      // Resolve before timeout
      approvalService.resolveWithAction('task-1', 'Developer', { action: 'approve' });

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(15000);

      // Should have resolved successfully, not timed out
      await expect(promise).resolves.toEqual({ action: 'approve' });
    });
  });

  describe('cancelTask', () => {
    it('should cancel all pending approvals for a task', async () => {
      const promise1 = approvalService.requestApproval('task-1', 'Analysis', {});
      const promise2 = approvalService.requestApproval('task-1', 'Developer', {});

      approvalService.cancelTask('task-1');

      await expect(promise1).rejects.toThrow('Task cancelled');
      await expect(promise2).rejects.toThrow('Task cancelled');
    });

    it('should log cancellation to audit repository', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      approvalService.cancelTask('task-1');

      try {
        await promise;
      } catch {
        // Expected to reject
      }

      expect(ApprovalLogRepository.log).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          phase: 'Developer',
          action: 'reject',
          metadata: expect.objectContaining({
            reason: 'task_cancelled',
          }),
        })
      );
    });

    it('should not affect other tasks', async () => {
      const promise1 = approvalService.requestApproval('task-1', 'Developer', {});
      const promise2 = approvalService.requestApproval('task-2', 'Developer', {});

      approvalService.cancelTask('task-1');

      await expect(promise1).rejects.toThrow('Task cancelled');

      // task-2 should still be pending
      expect(approvalService.hasPendingApproval('task-2', 'Developer')).toBe(true);

      // Clean up
      approvalService.resolveWithAction('task-2', 'Developer', { action: 'approve' });
      await promise2;
    });
  });

  describe('hasPendingApproval', () => {
    it('should return true when task has pending approval', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      expect(approvalService.hasPendingApproval('task-1', 'Developer')).toBe(true);

      approvalService.resolveWithAction('task-1', 'Developer', { action: 'approve' });
      await promise;
    });

    it('should return false when task has no pending approval', () => {
      expect(approvalService.hasPendingApproval('nonexistent', 'Developer')).toBe(false);
    });

    it('should return false after approval is resolved', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {});

      approvalService.resolveWithAction('task-1', 'Developer', { action: 'approve' });
      await promise;

      expect(approvalService.hasPendingApproval('task-1', 'Developer')).toBe(false);
    });
  });

  describe('resendApprovalRequest', () => {
    it('should resend approval request for pending approval', async () => {
      const promise = approvalService.requestApproval('task-1', 'Developer', {
        description: 'Original request',
      });

      vi.clearAllMocks(); // Clear the initial emit

      const resent = approvalService.resendApprovalRequest('task-1');

      expect(resent).toBe(true);
      expect(socketService.toTask).toHaveBeenCalledWith(
        'task-1',
        'phase:approval_required',
        expect.objectContaining({
          taskId: 'task-1',
          phase: 'Developer',
        })
      );

      // Clean up
      approvalService.resolveWithAction('task-1', 'Developer', { action: 'approve' });
      await promise;
    });

    it('should return false if no pending approval exists', () => {
      const resent = approvalService.resendApprovalRequest('nonexistent');
      expect(resent).toBe(false);
    });
  });
});
