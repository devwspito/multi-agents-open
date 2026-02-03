/**
 * OpenCode Client Service
 *
 * Manages connection to OpenCode server and provides
 * methods for session management and event handling.
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

export interface OpenCodeConfig {
  baseUrl: string;
  directory?: string;
}

export interface SessionOptions {
  title: string;
  agent?: string;
}

export interface PromptPart {
  type: 'text';
  text: string;
}

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, any>;
}

class OpenCodeClientService {
  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private config: OpenCodeConfig;
  private connected = false;

  constructor() {
    this.config = {
      baseUrl: process.env.OPENCODE_URL || 'http://localhost:4096',
      directory: process.env.OPENCODE_DIRECTORY,
    };
  }

  /**
   * Initialize connection to OpenCode server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    console.log(`[OpenCode] Connecting to ${this.config.baseUrl}...`);

    this.client = createOpencodeClient({
      baseUrl: this.config.baseUrl,
    });

    // Test connection
    try {
      const health = await this.client.global.health();
      if (health.data?.healthy) {
        console.log(`[OpenCode] Connected. Version: ${health.data.version}`);
        this.connected = true;
      } else {
        throw new Error('Server not healthy');
      }
    } catch (error: any) {
      console.error(`[OpenCode] Failed to connect: ${error.message}`);
      throw new Error(`Cannot connect to OpenCode server at ${this.config.baseUrl}`);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the raw client (for advanced usage)
   */
  getClient() {
    if (!this.client) {
      throw new Error('OpenCode client not initialized. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Create a new session
   */
  async createSession(options: SessionOptions): Promise<string> {
    const client = this.getClient();

    const session = await client.session.create({
      title: options.title,
      directory: this.config.directory,
    });

    if (!session.data?.id) {
      throw new Error('Failed to create session');
    }

    console.log(`[OpenCode] Created session: ${session.data.id}`);
    return session.data.id;
  }

  /**
   * Send a prompt to a session
   */
  async sendPrompt(sessionId: string, text: string, options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
    system?: string;
  }): Promise<void> {
    const client = this.getClient();

    await client.session.prompt({
      sessionID: sessionId,
      directory: this.config.directory,
      parts: [{ type: 'text', text }],
      ...(options?.model && { model: options.model }),
      ...(options?.agent && { agent: options.agent }),
      ...(options?.system && { system: options.system }),
    });

    console.log(`[OpenCode] Sent prompt to session ${sessionId}`);
  }

  /**
   * Subscribe to events and yield them
   */
  async *subscribeToEvents(): AsyncGenerator<OpenCodeEvent> {
    const client = this.getClient();

    const events = await client.event.subscribe({
      directory: this.config.directory,
    });

    // The SDK returns a ServerSentEventsResult with a stream property
    for await (const event of events.stream as AsyncIterable<OpenCodeEvent>) {
      yield event;
    }
  }

  /**
   * Wait for session to become idle (finished processing)
   */
  async waitForIdle(sessionId: string, options?: {
    timeout?: number;
    onEvent?: (event: OpenCodeEvent) => void;
  }): Promise<OpenCodeEvent[]> {
    const timeout = options?.timeout || 300000; // 5 minutes default
    const startTime = Date.now();
    const events: OpenCodeEvent[] = [];

    for await (const event of this.subscribeToEvents()) {
      events.push(event);
      options?.onEvent?.(event);

      // Check for completion
      if (event.type === 'session.idle') {
        const idleSessionId = event.properties?.sessionID;
        if (idleSessionId === sessionId) {
          return events;
        }
      }

      // Check for error
      if (event.type === 'session.error') {
        const errorSessionId = event.properties?.sessionID;
        if (errorSessionId === sessionId) {
          throw new Error(`Session error: ${event.properties?.error}`);
        }
      }

      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error(`Session ${sessionId} timed out after ${timeout}ms`);
      }
    }

    return events;
  }

  /**
   * Get session details
   */
  async getSession(sessionId: string) {
    const client = this.getClient();
    const session = await client.session.get({
      sessionID: sessionId,
      directory: this.config.directory,
    });
    return session.data;
  }

  /**
   * Abort a session
   */
  async abortSession(sessionId: string): Promise<void> {
    const client = this.getClient();
    await client.session.abort({
      sessionID: sessionId,
      directory: this.config.directory,
    });
    console.log(`[OpenCode] Aborted session ${sessionId}`);
  }

  /**
   * List available agents
   */
  async getAgents() {
    const client = this.getClient();
    const agents = await client.app.agents();
    return agents.data;
  }

  /**
   * Get available providers
   */
  async getProviders() {
    const client = this.getClient();
    const providers = await client.config.providers();
    return providers.data;
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.client = null;
    this.connected = false;
    console.log('[OpenCode] Disconnected');
  }
}

export const openCodeClient = new OpenCodeClientService();
export default openCodeClient;
