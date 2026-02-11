/**
 * CostTracker Unit Tests
 *
 * Tests for the cost tracking service that accumulates costs
 * from OpenCode step_finish events and persists to database.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the dependencies before importing CostTracker
vi.mock('../realtime/SocketService.js', () => ({
  socketService: {
    toTask: vi.fn(),
  },
}));

vi.mock('../../database/postgres/PostgresService.js', () => ({
  postgresService: {
    query: vi.fn(),
  },
}));

vi.mock('../logging/Logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    cost: vi.fn(),
  },
}));

// Import after mocks are set up
import { costTracker, CostTrackerClass } from './CostTracker.js';
import { socketService } from '../realtime/SocketService.js';
import { postgresService } from '../../database/postgres/PostgresService.js';

describe('CostTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear internal state by accessing the private map through any
    (costTracker as any).taskCosts.clear();
  });

  describe('recordCost', () => {
    it('should record cost for a new task', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });

      const taskCost = costTracker.getTaskCost('task-1');
      expect(taskCost).not.toBeNull();
      expect(taskCost?.totalCost).toBe(0.01);
      expect(taskCost?.totalInputTokens).toBe(100);
      expect(taskCost?.totalOutputTokens).toBe(50);
    });

    it('should accumulate costs for multiple events', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.02,
        tokens: { input: 200, output: 100 },
      });

      const taskCost = costTracker.getTaskCost('task-1');
      expect(taskCost?.totalCost).toBe(0.03);
      expect(taskCost?.totalInputTokens).toBe(300);
      expect(taskCost?.totalOutputTokens).toBe(150);
    });

    it('should track costs per session', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });
      costTracker.recordCost('task-1', 'session-2', {
        cost: 0.02,
        tokens: { input: 200, output: 100 },
      });

      const taskCost = costTracker.getTaskCost('task-1');
      expect(taskCost?.sessions.size).toBe(2);
      expect(taskCost?.totalCost).toBe(0.03);

      const session1 = costTracker.getSessionCost('task-1', 'session-1');
      expect(session1?.cost).toBe(0.01);

      const session2 = costTracker.getSessionCost('task-1', 'session-2');
      expect(session2?.cost).toBe(0.02);
    });

    it('should skip events with no cost data', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0,
        tokens: { input: 0, output: 0 },
      });

      const taskCost = costTracker.getTaskCost('task-1');
      expect(taskCost).toBeNull();
    });

    it('should emit cost update to WebSocket', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });

      expect(socketService.toTask).toHaveBeenCalledWith(
        'task-1',
        'cost:update',
        expect.objectContaining({
          taskId: 'task-1',
          totalCost: 0.01,
          totalInputTokens: 100,
          totalOutputTokens: 50,
        })
      );
    });

    it('should store session metadata', () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      }, { storyId: 'story-1', phase: 'Developer' });

      const session = costTracker.getSessionCost('task-1', 'session-1');
      expect(session?.storyId).toBe('story-1');
      expect(session?.phase).toBe('Developer');
    });
  });

  describe('persistCostToDb', () => {
    it('should persist cost to database', async () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.05,
        tokens: { input: 500, output: 250 },
      });

      await costTracker.persistCostToDb('task-1');

      expect(postgresService.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE tasks SET'),
        [0.05, 500, 250, 'task-1']
      );
    });

    it('should not persist if task has no cost data', async () => {
      await costTracker.persistCostToDb('nonexistent-task');

      expect(postgresService.query).not.toHaveBeenCalled();
    });
  });

  describe('loadCostFromDb', () => {
    it('should load cost from database', async () => {
      vi.mocked(postgresService.query).mockResolvedValueOnce({
        rows: [{
          total_cost: '0.05',
          total_input_tokens: 500,
          total_output_tokens: 250,
        }],
      } as any);

      const cost = await costTracker.loadCostFromDb('task-1');

      expect(cost).toEqual({
        totalCost: 0.05,
        totalInputTokens: 500,
        totalOutputTokens: 250,
      });
    });

    it('should return null if task not found', async () => {
      vi.mocked(postgresService.query).mockResolvedValueOnce({
        rows: [],
      } as any);

      const cost = await costTracker.loadCostFromDb('nonexistent');
      expect(cost).toBeNull();
    });
  });

  describe('getTaskCostDetailsAsync', () => {
    it('should return in-memory cost for running tasks', async () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });

      const details = await costTracker.getTaskCostDetailsAsync('task-1');

      expect(details).not.toBeNull();
      expect(details?.totalCost).toBe(0.01);
      expect(details?.sessions.length).toBe(1);
      // Should not query database
      expect(postgresService.query).not.toHaveBeenCalled();
    });

    it('should fallback to database for completed tasks', async () => {
      vi.mocked(postgresService.query).mockResolvedValueOnce({
        rows: [{
          total_cost: '0.10',
          total_input_tokens: 1000,
          total_output_tokens: 500,
        }],
      } as any);

      const details = await costTracker.getTaskCostDetailsAsync('completed-task');

      expect(details).not.toBeNull();
      expect(details?.totalCost).toBe(0.10);
      expect(details?.sessions).toEqual([]); // No session details from DB
    });
  });

  describe('clearTask', () => {
    it('should persist and clear task data', async () => {
      costTracker.recordCost('task-1', 'session-1', {
        cost: 0.01,
        tokens: { input: 100, output: 50 },
      });

      await costTracker.clearTask('task-1');

      expect(postgresService.query).toHaveBeenCalled();
      expect(costTracker.getTaskCost('task-1')).toBeNull();
    });
  });

  describe('getAllTaskCosts', () => {
    it('should return all active task costs', () => {
      costTracker.recordCost('task-1', 'session-1', { cost: 0.01 });
      costTracker.recordCost('task-2', 'session-2', { cost: 0.02 });

      const allCosts = costTracker.getAllTaskCosts();

      expect(allCosts.size).toBe(2);
      expect(allCosts.has('task-1')).toBe(true);
      expect(allCosts.has('task-2')).toBe(true);
    });
  });
});
