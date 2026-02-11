/**
 * Structured Logging Service
 *
 * Provides consistent, structured logging across the application.
 * Uses pino for high performance and proper JSON serialization.
 *
 * Features:
 * - Log levels (debug, info, warn, error, fatal)
 * - Structured metadata (taskId, sessionId, phase)
 * - Request correlation IDs
 * - Environment-aware (dev = pretty, prod = JSON)
 * - Sensitive data redaction
 * - Domain-specific logging methods
 *
 * Usage:
 *   import { logger } from './Logger.js';
 *   logger.info('Task started', { taskId: '123' });
 *
 *   // Or create a scoped logger
 *   const taskLog = logger.child({ taskId: '123' });
 *   taskLog.info('Processing');
 */

import pino from 'pino';

// ============================================================================
// TYPES
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogContext {
  taskId?: string;
  sessionId?: string;
  phase?: string;
  correlationId?: string;
  userId?: string;
  projectId?: string;
  storyId?: string;
  tool?: string;
  duration?: number;
  durationMs?: number;
  cost?: number;
  tokens?: number;
  [key: string]: any;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: LogContext;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
  [key: string]: any;
}

// ============================================================================
// PINO CONFIGURATION
// ============================================================================

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

/**
 * Create pino logger with environment-appropriate settings
 */
function createPinoLogger(): pino.Logger {
  const options: pino.LoggerOptions = {
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,

    // Base context
    base: {
      service: 'open-multi-agents',
      env: NODE_ENV,
    },

    // Redact sensitive fields
    redact: {
      paths: [
        'password',
        'token',
        'accessToken',
        'refreshToken',
        'apiKey',
        'secret',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },

    // Custom serializers
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },

    // Format output based on environment
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  // Use pretty printing in development
  if (!IS_PRODUCTION) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          singleLine: false,
        },
      },
    });
  }

  return pino(options);
}

const pinoInstance = createPinoLogger();

// ============================================================================
// LOGGER CLASS (using pino)
// ============================================================================

class LoggerClass {
  private pino: pino.Logger;
  private defaultContext: LogContext = {};

  constructor(pinoLogger?: pino.Logger, context?: LogContext) {
    this.pino = pinoLogger || pinoInstance;
    this.defaultContext = context || {};
  }

  /**
   * Set the minimum log level
   */
  setLevel(level: LogLevel): void {
    this.pino.level = level;
  }

  /**
   * Set default context (added to all log entries)
   */
  setDefaultContext(context: LogContext): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): LoggerClass {
    return new LoggerClass(
      this.pino.child(context),
      { ...this.defaultContext, ...context }
    );
  }

  /**
   * Merge context with defaults
   */
  private mergeContext(context?: LogContext): LogContext {
    return { ...this.defaultContext, ...context };
  }

  // ============================================================================
  // LOG METHODS
  // ============================================================================

  debug(message: string, context?: LogContext): void {
    this.pino.debug(this.mergeContext(context), message);
  }

  info(message: string, context?: LogContext): void {
    this.pino.info(this.mergeContext(context), message);
  }

  warn(message: string, context?: LogContext): void {
    this.pino.warn(this.mergeContext(context), message);
  }

  error(message: string, error?: Error | LogContext, context?: LogContext): void {
    if (error instanceof Error) {
      this.pino.error({ ...this.mergeContext(context), err: error }, message);
    } else {
      this.pino.error(this.mergeContext(error as LogContext), message);
    }
  }

  fatal(message: string, error?: Error | LogContext, context?: LogContext): void {
    if (error instanceof Error) {
      this.pino.fatal({ ...this.mergeContext(context), err: error }, message);
    } else {
      this.pino.fatal(this.mergeContext(error as LogContext), message);
    }
  }

  // ============================================================================
  // SPECIALIZED LOGGERS
  // ============================================================================

  /**
   * Log with duration timing
   */
  timed(message: string, startTime: number, context?: LogContext): void {
    const durationMs = Date.now() - startTime;
    this.info(message, { ...context, durationMs });
  }

  /**
   * Start a timer and return a function to log completion
   */
  startTimer(message: string, context?: LogContext): () => void {
    const start = Date.now();
    this.debug(`Starting: ${message}`, context);
    return () => {
      this.timed(`Completed: ${message}`, start, context);
    };
  }

  // ============================================================================
  // PHASE-SPECIFIC LOGGING
  // ============================================================================

  phase(phase: string, message: string, context?: LogContext): void {
    this.info(`[${phase}] ${message}`, { ...context, phase });
  }

  phaseStart(phase: string, context?: LogContext): void {
    this.info(`[${phase}] Phase started`, { ...context, phase, event: 'phase_start' });
  }

  phaseComplete(phase: string, context?: LogContext): void {
    this.info(`[${phase}] Phase completed`, { ...context, phase, event: 'phase_complete' });
  }

  phaseFailed(phase: string, error: Error, context?: LogContext): void {
    this.error(`[${phase}] Phase failed: ${error.message}`, error, { ...context, phase, event: 'phase_failed' });
  }

  // ============================================================================
  // TASK-SPECIFIC LOGGING
  // ============================================================================

  task(taskId: string, message: string, context?: LogContext): void {
    this.info(message, { ...context, taskId });
  }

  taskStart(taskId: string, title: string): void {
    this.info(`Task started: ${title}`, { taskId, title, event: 'task_start' });
  }

  taskComplete(taskId: string, success: boolean, duration: number): void {
    if (success) {
      this.info('Task completed', { taskId, success, durationMs: duration, event: 'task_complete' });
    } else {
      this.error('Task failed', { taskId, success, durationMs: duration, event: 'task_failed' });
    }
  }

  // ============================================================================
  // APPROVAL LOGGING
  // ============================================================================

  approval(taskId: string, phase: string, action: 'requested' | 'approved' | 'rejected' | 'timeout', context?: LogContext): void {
    const ctx = { taskId, phase, action, event: `approval_${action}`, ...context };
    switch (action) {
      case 'requested':
        this.info(`Approval requested for ${phase}`, ctx);
        break;
      case 'approved':
        this.info(`${phase} approved`, ctx);
        break;
      case 'rejected':
        this.warn(`${phase} rejected`, ctx);
        break;
      case 'timeout':
        this.warn(`${phase} approval timeout`, ctx);
        break;
    }
  }

  // ============================================================================
  // COST LOGGING
  // ============================================================================

  cost(taskId: string, cost: number, inputTokens: number, outputTokens: number): void {
    this.info(`Cost: $${cost.toFixed(4)} (${inputTokens + outputTokens} tokens)`, {
      taskId,
      cost,
      inputTokens,
      outputTokens,
      event: 'cost_update',
    });
  }

  // ============================================================================
  // TOOL LOGGING
  // ============================================================================

  tool(taskId: string, tool: string, state: 'running' | 'completed' | 'error', context?: LogContext): void {
    const ctx = { taskId, tool, state, event: `tool_${state}`, ...context };
    if (state === 'error') {
      this.error(`Tool ${tool} failed`, ctx);
    } else {
      this.debug(`Tool ${tool} ${state}`, ctx);
    }
  }

  // ============================================================================
  // HTTP REQUEST LOGGING
  // ============================================================================

  request(method: string, path: string, statusCode: number, durationMs: number, context?: LogContext): void {
    const ctx = { method, path, statusCode, durationMs, event: 'http_request', ...context };
    if (statusCode >= 500) {
      this.error(`${method} ${path} ${statusCode}`, ctx);
    } else if (statusCode >= 400) {
      this.warn(`${method} ${path} ${statusCode}`, ctx);
    } else {
      this.info(`${method} ${path} ${statusCode}`, ctx);
    }
  }

  /**
   * Get the underlying pino instance
   */
  getPino(): pino.Logger {
    return this.pino;
  }
}

// ============================================================================
// CHILD LOGGER
// ============================================================================

class ChildLogger {
  constructor(
    private parent: LoggerClass,
    private context: LogContext
  ) {}

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, { ...this.context, ...context });
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, { ...this.context, ...context });
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, { ...this.context, ...context });
  }

  error(message: string, error?: Error | LogContext, context?: LogContext): void {
    if (error instanceof Error) {
      this.parent.error(message, error, { ...this.context, ...context });
    } else {
      this.parent.error(message, { ...this.context, ...error as LogContext });
    }
  }

  child(context: LogContext): ChildLogger {
    return new ChildLogger(this.parent, { ...this.context, ...context });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const logger = new LoggerClass();
export default logger;

// Re-export for convenience
export { LoggerClass, ChildLogger };
