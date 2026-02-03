/**
 * Tools System
 *
 * Provider-agnostic tool implementations for agent execution.
 * These tools work with any LLM provider (DGX Spark, Ollama, etc.)
 */

import { ToolDefinition } from '../types/index.js';
import { ToolHandler } from '../services/agents/AgentExecutorService.js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

// ==================== Tool Definitions ====================

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read the contents of a file. Returns the file content as text.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read (optional)',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (optional)',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates the file if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit a file by replacing a specific string with a new string.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to replace',
        },
        new_string: {
          type: 'string',
          description: 'The replacement string',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences (default: false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a bash command and return the output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match (e.g., "**/*.ts")',
        },
        path: {
          type: 'string',
          description: 'The directory to search in (default: current directory)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for a pattern in files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'The file or directory to search in',
        },
        include: {
          type: 'string',
          description: 'File pattern to include (e.g., "*.ts")',
        },
      },
      required: ['pattern'],
    },
  },
];

// ==================== Tool Handlers ====================

const readTool: ToolHandler = async (input) => {
  try {
    const { file_path, limit, offset } = input;

    if (!fs.existsSync(file_path)) {
      return { output: '', success: false, error: `File not found: ${file_path}` };
    }

    let content = fs.readFileSync(file_path, 'utf-8');
    const lines = content.split('\n');

    // Apply offset and limit
    let startLine = offset || 0;
    let endLine = limit ? startLine + limit : lines.length;

    const selectedLines = lines.slice(startLine, endLine);

    // Add line numbers
    const numberedLines = selectedLines.map((line, i) => {
      const lineNum = startLine + i + 1;
      return `${lineNum.toString().padStart(6)}  ${line}`;
    });

    return { output: numberedLines.join('\n'), success: true };
  } catch (error: any) {
    return { output: '', success: false, error: error.message };
  }
};

const writeTool: ToolHandler = async (input) => {
  try {
    const { file_path, content } = input;

    // Ensure directory exists
    const dir = path.dirname(file_path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(file_path, content);
    return { output: `File written: ${file_path}`, success: true };
  } catch (error: any) {
    return { output: '', success: false, error: error.message };
  }
};

const editTool: ToolHandler = async (input) => {
  try {
    const { file_path, old_string, new_string, replace_all } = input;

    if (!fs.existsSync(file_path)) {
      return { output: '', success: false, error: `File not found: ${file_path}` };
    }

    let content = fs.readFileSync(file_path, 'utf-8');

    if (!content.includes(old_string)) {
      return { output: '', success: false, error: 'old_string not found in file' };
    }

    if (replace_all) {
      content = content.replaceAll(old_string, new_string);
    } else {
      content = content.replace(old_string, new_string);
    }

    fs.writeFileSync(file_path, content);
    return { output: `File edited: ${file_path}`, success: true };
  } catch (error: any) {
    return { output: '', success: false, error: error.message };
  }
};

const bashTool: ToolHandler = async (input) => {
  try {
    const { command, timeout = 30000, cwd } = input;

    const result = execSync(command, {
      cwd: cwd || process.cwd(),
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { output: result, success: true, bashExitCode: 0 };
  } catch (error: any) {
    const exitCode = error.status || 1;
    const output = error.stdout || '';
    const stderr = error.stderr || error.message;

    return {
      output: output + (stderr ? `\nSTDERR: ${stderr}` : ''),
      success: exitCode === 0,
      error: exitCode !== 0 ? stderr : undefined,
      bashExitCode: exitCode,
    };
  }
};

const globTool: ToolHandler = async (input) => {
  try {
    const { pattern, path: searchPath } = input;

    const files = await glob(pattern, {
      cwd: searchPath || process.cwd(),
      nodir: true,
      absolute: true,
    });

    return { output: files.join('\n'), success: true };
  } catch (error: any) {
    return { output: '', success: false, error: error.message };
  }
};

const grepTool: ToolHandler = async (input) => {
  try {
    const { pattern, path: searchPath, include } = input;

    let command = `grep -rn "${pattern.replace(/"/g, '\\"')}"`;

    if (include) {
      command += ` --include="${include}"`;
    }

    command += ` ${searchPath || '.'}`;

    const result = execSync(command, {
      cwd: process.cwd(),
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });

    return { output: result, success: true };
  } catch (error: any) {
    // grep returns exit code 1 when no matches found
    if (error.status === 1 && !error.stderr) {
      return { output: 'No matches found', success: true };
    }
    return { output: '', success: false, error: error.message };
  }
};

// ==================== Tool Registry ====================

export const toolHandlers: Map<string, ToolHandler> = new Map([
  ['Read', readTool],
  ['Write', writeTool],
  ['Edit', editTool],
  ['Bash', bashTool],
  ['Glob', globTool],
  ['Grep', grepTool],
]);

/**
 * Get all tool definitions
 */
export function getToolDefinitions(): ToolDefinition[] {
  return toolDefinitions;
}

/**
 * Get a specific tool handler
 */
export function getToolHandler(name: string): ToolHandler | undefined {
  return toolHandlers.get(name);
}

/**
 * Get all tool handlers as a Map
 */
export function getAllToolHandlers(): Map<string, ToolHandler> {
  return toolHandlers;
}
