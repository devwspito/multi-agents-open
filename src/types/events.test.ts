/**
 * Event Types Utility Functions Tests
 *
 * Tests for the shared utility functions that ensure
 * consistent event handling between frontend and backend.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFilePath,
  normalizeToolEvent,
  isLifecycleEvent,
  isVisibleTool,
  VISIBLE_TOOLS,
} from './events.js';

describe('Event Type Utilities', () => {
  describe('extractFilePath', () => {
    it('should extract file_path from top-level property', () => {
      const event = { file_path: '/path/to/file.ts' };
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should extract filePath (camelCase) from top-level', () => {
      const event = { filePath: '/path/to/file.ts' } as any;
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should extract path from top-level', () => {
      const event = { path: '/path/to/file.ts' } as any;
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should extract file_path from input object', () => {
      const event = {
        input: { file_path: '/path/to/file.ts' },
      };
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should extract filePath from input object', () => {
      const event = {
        input: { filePath: '/path/to/file.ts' },
      };
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should parse file path from content string with colon format', () => {
      const event = {
        content: '🔧 read: /path/to/file.ts',
      };
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should parse file path from content string with parentheses', () => {
      const event = {
        content: 'Reading file (/path/to/file.ts)',
      };
      expect(extractFilePath(event)).toBe('/path/to/file.ts');
    });

    it('should prioritize top-level over input', () => {
      const event = {
        file_path: '/top-level.ts',
        input: { file_path: '/input-level.ts' },
      };
      expect(extractFilePath(event)).toBe('/top-level.ts');
    });

    it('should prioritize input over content parsing', () => {
      const event = {
        input: { file_path: '/input-level.ts' },
        content: 'read: /content-level.ts',
      };
      expect(extractFilePath(event)).toBe('/input-level.ts');
    });

    it('should return empty string if no path found', () => {
      const event = { tool: 'bash', content: 'some command' };
      expect(extractFilePath(event)).toBe('');
    });

    it('should handle null/undefined input', () => {
      expect(extractFilePath(null as any)).toBe('');
      expect(extractFilePath(undefined as any)).toBe('');
      expect(extractFilePath({})).toBe('');
    });
  });

  describe('normalizeToolEvent', () => {
    it('should create a normalized tool event with defaults', () => {
      const event = {
        taskId: 'task-1',
        tool: 'read',
        state: 'running' as const,
      };

      const normalized = normalizeToolEvent(event);

      expect(normalized.id).toBeDefined();
      expect(normalized.taskId).toBe('task-1');
      expect(normalized.type).toBe('tool');
      expect(normalized.tool).toBe('read');
      expect(normalized.state).toBe('running');
      expect(normalized.timestamp).toBeDefined();
    });

    it('should extract and set file_path at top level', () => {
      const event = {
        taskId: 'task-1',
        tool: 'read',
        state: 'completed' as const,
        input: { file_path: '/path/to/file.ts' },
      };

      const normalized = normalizeToolEvent(event);

      expect(normalized.file_path).toBe('/path/to/file.ts');
    });

    it('should preserve existing properties', () => {
      const event = {
        taskId: 'task-1',
        tool: 'edit',
        state: 'completed' as const,
        content: 'Edited file',
        duration: 150,
        error: undefined,
      };

      const normalized = normalizeToolEvent(event);

      expect(normalized.content).toBe('Edited file');
      expect(normalized.duration).toBe(150);
    });

    it('should generate unique IDs', () => {
      const event1 = normalizeToolEvent({ taskId: 't1', tool: 'x', state: 'running' });
      const event2 = normalizeToolEvent({ taskId: 't2', tool: 'y', state: 'running' });

      expect(event1.id).not.toBe(event2.id);
    });
  });

  describe('isLifecycleEvent', () => {
    it('should return true for phase events', () => {
      expect(isLifecycleEvent('phase_start')).toBe(true);
      expect(isLifecycleEvent('phase_complete')).toBe(true);
      expect(isLifecycleEvent('phase_failed')).toBe(true);
    });

    it('should return true for story events', () => {
      expect(isLifecycleEvent('story_start')).toBe(true);
      expect(isLifecycleEvent('story_complete')).toBe(true);
      expect(isLifecycleEvent('story_failed')).toBe(true);
    });

    it('should return true for agent completion events', () => {
      expect(isLifecycleEvent('agent_completed')).toBe(true);
      expect(isLifecycleEvent('agent_failed')).toBe(true);
    });

    it('should return true for success/error status', () => {
      expect(isLifecycleEvent('success')).toBe(true);
      expect(isLifecycleEvent('error')).toBe(true);
    });

    it('should return false for tool events', () => {
      expect(isLifecycleEvent('tool')).toBe(false);
      expect(isLifecycleEvent('tool_call')).toBe(false);
      expect(isLifecycleEvent('tool_result')).toBe(false);
    });

    it('should return false for progress events', () => {
      expect(isLifecycleEvent('thinking')).toBe(false);
      expect(isLifecycleEvent('agent_progress')).toBe(false);
    });
  });

  describe('isVisibleTool', () => {
    it('should return true for visible tools', () => {
      expect(isVisibleTool('bash')).toBe(true);
      expect(isVisibleTool('edit')).toBe(true);
      expect(isVisibleTool('write')).toBe(true);
      expect(isVisibleTool('read')).toBe(true);
    });

    it('should return true for uppercase tool names', () => {
      expect(isVisibleTool('BASH')).toBe(true);
      expect(isVisibleTool('Edit')).toBe(true);
    });

    it('should return false for hidden tools', () => {
      expect(isVisibleTool('glob')).toBe(false);
      expect(isVisibleTool('grep')).toBe(false);
      expect(isVisibleTool('task')).toBe(false);
    });
  });

  describe('VISIBLE_TOOLS constant', () => {
    it('should contain expected tools', () => {
      expect(VISIBLE_TOOLS).toContain('bash');
      expect(VISIBLE_TOOLS).toContain('edit');
      expect(VISIBLE_TOOLS).toContain('write');
      expect(VISIBLE_TOOLS).toContain('read');
    });

    it('should not contain noisy tools', () => {
      expect(VISIBLE_TOOLS).not.toContain('glob');
      expect(VISIBLE_TOOLS).not.toContain('grep');
    });
  });
});
