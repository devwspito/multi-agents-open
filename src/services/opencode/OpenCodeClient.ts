/**
 * OpenCode Client Service
 *
 * Manages connection to OpenCode server and provides
 * methods for session management and event handling.
 *
 * KEY FEATURE: Sessions persist in OpenCode's SQLite database.
 * This allows pause/resume/retry without losing context.
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

export interface OpenCodeConfig {
  baseUrl: string;
  directory?: string;
}

/**
 * 🔥 MODEL CONFIGURATION
 * Switch between providers here (Anthropic Claude vs Local Kimi-Dev)
 *
 * Environment variables:
 * - OPENCODE_PROVIDER: 'anthropic' | 'dgx-spark' | 'ollama' (default: 'dgx-spark')
 * - OPENCODE_MODEL: model ID (default: 'kimi-dev-72b')
 */
export const DEFAULT_MODEL = {
  providerID: process.env.OPENCODE_PROVIDER || 'dgx-spark',
  modelID: process.env.OPENCODE_MODEL || 'kimi-dev-72b',
};

// Quick reference for switching:
// Claude:     { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' }
// Kimi-Dev:   { providerID: 'dgx-spark', modelID: 'kimi-dev-72b' }
// GLM 4.7:    { providerID: 'dgx-spark', modelID: 'glm-4.7' }
// DeepSeek:   { providerID: 'dgx-spark', modelID: 'deepseek-r1' }

export interface SessionOptions {
  title: string;
  agent?: string;
  /** Working directory for this session (where repo is cloned) */
  directory?: string;
}

export interface PromptPart {
  type: 'text';
  text: string;
}

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, any>;
}

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

export type SessionStatus = 'idle' | 'running' | 'paused' | 'error';

class OpenCodeClientService {
  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private config: OpenCodeConfig;
  private connected = false;
  private reconnecting = false;

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

        // Configure provider authentication
        await this.configureProviderAuth();
      } else {
        throw new Error('Server not healthy');
      }
    } catch (error: any) {
      console.error(`[OpenCode] Failed to connect: ${error.message}`);
      throw new Error(`Cannot connect to OpenCode server at ${this.config.baseUrl}`);
    }
  }

  /**
   * Configure provider authentication (API keys)
   * SDK v2 uses flat params: { providerID, auth }
   */
  private async configureProviderAuth(): Promise<void> {
    const client = this.getClient();

    // Configure Anthropic if API key is available
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        await client.auth.set({
          providerID: 'anthropic',
          auth: { type: 'api', key: anthropicKey },
        });
        console.log('[OpenCode] Configured Anthropic authentication');
      } catch (error: any) {
        console.warn(`[OpenCode] Failed to set Anthropic auth: ${error.message}`);
      }
    }

    // Configure OpenAI if API key is available
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        await client.auth.set({
          providerID: 'openai',
          auth: { type: 'api', key: openaiKey },
        });
        console.log('[OpenCode] Configured OpenAI authentication');
      } catch (error: any) {
        console.warn(`[OpenCode] Failed to set OpenAI auth: ${error.message}`);
      }
    }
  }

  /**
   * 🔥 Configure provider auth for a specific project
   * Used when project has custom API key (commercial provider)
   */
  async configureProjectAuth(providerID: string, apiKey: string): Promise<boolean> {
    if (!apiKey) return false;

    const client = this.getClient();

    try {
      await client.auth.set({
        providerID,
        auth: { type: 'api', key: apiKey },
      });
      console.log(`[OpenCode] Configured ${providerID} auth for project`);
      return true;
    } catch (error: any) {
      console.warn(`[OpenCode] Failed to set ${providerID} auth: ${error.message}`);
      return false;
    }
  }

  /**
   * Connect with automatic retries (runs in background)
   * Will keep trying until connected or maxRetries reached
   */
  async connectWithRetry(options?: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
  }): Promise<void> {
    if (this.connected || this.reconnecting) return;

    const maxRetries = options?.maxRetries ?? 30; // ~5 minutes with backoff
    const initialDelay = options?.initialDelay ?? 1000;
    const maxDelay = options?.maxDelay ?? 10000;

    this.reconnecting = true;
    let attempt = 0;
    let delay = initialDelay;

    while (attempt < maxRetries && !this.connected) {
      try {
        await this.connect();
        this.reconnecting = false;
        return;
      } catch {
        attempt++;
        if (attempt < maxRetries) {
          console.log(`[OpenCode] Retry ${attempt}/${maxRetries} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, maxDelay);
        }
      }
    }

    this.reconnecting = false;
    if (!this.connected) {
      console.error(`[OpenCode] Failed to connect after ${maxRetries} attempts`);
    }
  }

  /**
   * Start background reconnection (non-blocking)
   */
  startBackgroundReconnect(): void {
    if (this.connected || this.reconnecting) return;
    this.connectWithRetry().catch(() => {});
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
   * Create a new session with auto-approve permissions
   * @param options.directory - Working directory for this session (overrides default)
   * @param options.autoApprove - If true, creates session with all permissions allowed (default: true)
   */
  async createSession(options: SessionOptions & { autoApprove?: boolean }): Promise<string> {
    const client = this.getClient();
    const directory = options.directory || this.config.directory;
    const autoApprove = options.autoApprove !== false; // Default to true

    // Build permission rules for auto-approve mode
    // OpenCode SDK expects PermissionRuleset = Array<{ permission, pattern, action }>
    // pattern: '*' matches all patterns, '**' matches all directories recursively
    const permission = autoApprove
      ? [
          { permission: 'Edit', pattern: '**', action: 'allow' as const },
          { permission: 'Write', pattern: '**', action: 'allow' as const },
          { permission: 'Bash', pattern: '**', action: 'allow' as const },
          { permission: 'WebFetch', pattern: '**', action: 'allow' as const },
          { permission: 'WebSearch', pattern: '**', action: 'allow' as const },
          { permission: 'Read', pattern: '**', action: 'allow' as const },
          { permission: 'Glob', pattern: '**', action: 'allow' as const },
          { permission: 'Grep', pattern: '**', action: 'allow' as const },
          { permission: 'TodoWrite', pattern: '**', action: 'allow' as const },
          { permission: 'TodoRead', pattern: '**', action: 'allow' as const },
          { permission: 'List', pattern: '**', action: 'allow' as const },
          { permission: 'Task', pattern: '**', action: 'allow' as const },
          { permission: 'ExternalDirectory', pattern: '**', action: 'allow' as const },
          { permission: 'DoomLoop', pattern: '**', action: 'allow' as const },
          { permission: 'Skill', pattern: '**', action: 'allow' as const },
          { permission: 'CodeSearch', pattern: '**', action: 'allow' as const },
          { permission: 'LSP', pattern: '**', action: 'allow' as const },
        ]
      : undefined;

    const session = await client.session.create({
      title: options.title,
      directory,
      permission,
    });

    if (!session.data?.id) {
      throw new Error('Failed to create session');
    }

    console.log(`[OpenCode] Created session: ${session.data.id} (dir: ${directory || 'default'}, autoApprove: ${autoApprove})`);
    return session.data.id;
  }

  /**
   * Send a prompt to a session
   * @param options.directory - Working directory (overrides default)
   * @param options.model - Model to use (defaults to DEFAULT_MODEL)
   */
  async sendPrompt(sessionId: string, text: string, options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
    system?: string;
    directory?: string;
  }): Promise<void> {
    const client = this.getClient();
    const directory = options?.directory || this.config.directory;
    const model = options?.model || DEFAULT_MODEL;

    console.log(`[OpenCode] Sending prompt (async) to session ${sessionId}...`);
    console.log(`[OpenCode] Model: ${model.providerID}/${model.modelID}`);
    console.log(`[OpenCode] Directory: ${directory}`);
    console.log(`[OpenCode] Prompt length: ${text.length} chars`);

    try {
      // Use promptAsync to send message and return immediately
      // We use waitForIdle() separately to track completion via events
      await client.session.promptAsync({
        sessionID: sessionId,
        directory,
        parts: [{ type: 'text', text }],
        model,
        ...(options?.agent && { agent: options.agent }),
        ...(options?.system && { system: options.system }),
      });
      console.log(`[OpenCode] Prompt queued for session ${sessionId}`);
    } catch (error: any) {
      console.error(`[OpenCode] Error sending prompt: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send a prompt with images to a session
   * Images are converted to base64 Data URLs (no external hosting required)
   * @param sessionId - The session ID
   * @param text - The text prompt
   * @param images - Array of images to include
   * @param options - Additional options (model, agent, system, directory)
   */
  async sendPromptWithImages(
    sessionId: string,
    text: string,
    images: Array<{
      data: Buffer | string; // Buffer or base64 string
      mime?: string; // defaults to 'image/png'
      filename?: string;
    }>,
    options?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      system?: string;
      directory?: string;
    }
  ): Promise<void> {
    const client = this.getClient();
    const directory = options?.directory || this.config.directory;

    // Build parts array with text and images
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; mime: string; url: string; filename?: string }
    > = [];

    // Add text part first
    if (text) {
      parts.push({ type: 'text', text });
    }

    // Convert images to FilePartInput with base64 Data URLs
    for (const image of images) {
      const mime = image.mime || 'image/png';

      // Convert Buffer to base64 if needed
      let base64Data: string;
      if (Buffer.isBuffer(image.data)) {
        base64Data = image.data.toString('base64');
      } else {
        // Assume it's already a base64 string
        base64Data = image.data;
      }

      // Create Data URL
      const dataUrl = `data:${mime};base64,${base64Data}`;

      parts.push({
        type: 'file',
        mime,
        url: dataUrl,
        ...(image.filename && { filename: image.filename }),
      });
    }

    // Use promptAsync for non-blocking behavior
    const model = options?.model || DEFAULT_MODEL;
    await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts,
      model,
      ...(options?.agent && { agent: options.agent }),
      ...(options?.system && { system: options.system }),
    });

    console.log(`[OpenCode] Prompt with ${images.length} image(s) queued for session ${sessionId} (model: ${model.providerID}/${model.modelID})`);
  }

  /**
   * Subscribe to events and yield them
   * @param directory - Directory to subscribe to (REQUIRED for session events)
   */
  async *subscribeToEvents(directory: string): AsyncGenerator<OpenCodeEvent> {
    const client = this.getClient();

    console.log(`[OpenCode] Subscribing to events for directory: ${directory}`);

    const events = await client.event.subscribe({
      directory,
    });
    console.log(`[OpenCode] Event subscription established for ${directory}`);

    // The SDK returns a ServerSentEventsResult with a stream property
    for await (const event of events.stream as AsyncIterable<OpenCodeEvent>) {
      yield event;
    }
  }

  /**
   * Wait for session to become idle (finished processing)
   * IMPORTANT: Uses the centralized EventBridge subscription - does NOT create a new subscription
   * @param directory - The working directory where the session was created (used for logging only now)
   */
  async waitForIdle(sessionId: string, options?: {
    timeout?: number;
    onEvent?: (event: OpenCodeEvent) => void;
    directory?: string;
  }): Promise<OpenCodeEvent[]> {
    // Import EventBridge dynamically to avoid circular dependency
    const { openCodeEventBridge } = await import('./OpenCodeEventBridge.js');

    console.log(`[OpenCode] Waiting for session ${sessionId} to become idle via EventBridge (dir: ${options?.directory || 'default'})`);

    // Use the centralized EventBridge - NO additional subscription created
    return openCodeEventBridge.waitForSessionIdle(sessionId, {
      timeout: options?.timeout,
      onEvent: options?.onEvent,
    });
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

  // ============================================
  // SESSION PERSISTENCE & CONTROL
  // Sessions persist in OpenCode's SQLite DB
  // ============================================

  /**
   * List all sessions (persisted in OpenCode)
   */
  async listSessions(): Promise<SessionInfo[]> {
    const client = this.getClient();
    const result = await client.session.list({
      directory: this.config.directory,
    });
    return (result.data || []) as SessionInfo[];
  }

  /**
   * Pause a running session (abort but keep state)
   * Session can be resumed later with resumeSession()
   */
  async pauseSession(sessionId: string): Promise<void> {
    await this.abortSession(sessionId);
    console.log(`[OpenCode] Session ${sessionId} paused (can resume later)`);
  }

  /**
   * Resume a paused/existing session with a new prompt
   * This continues the conversation from where it left off
   */
  async resumeSession(sessionId: string, prompt: string, options?: {
    model?: { providerID: string; modelID: string };
    system?: string;
  }): Promise<void> {
    const client = this.getClient();

    // Verify session exists
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Send prompt to existing session (continues conversation)
    await client.session.prompt({
      sessionID: sessionId,
      directory: this.config.directory,
      parts: [{ type: 'text', text: prompt }],
      ...(options?.model && { model: options.model }),
      ...(options?.system && { system: options.system }),
    });

    console.log(`[OpenCode] Resumed session ${sessionId}`);
  }

  /**
   * Retry a session - useful after errors or rejections
   * Can optionally provide a different prompt
   */
  async retrySession(sessionId: string, options?: {
    newPrompt?: string;
    model?: { providerID: string; modelID: string };
  }): Promise<void> {
    const prompt = options?.newPrompt || 'Please try again with the previous task.';
    await this.resumeSession(sessionId, prompt, { model: options?.model });
    console.log(`[OpenCode] Retrying session ${sessionId}`);
  }

  /**
   * Continue session and wait for completion
   * Combines resumeSession + waitForIdle
   */
  async continueAndWait(sessionId: string, prompt: string, options?: {
    model?: { providerID: string; modelID: string };
    timeout?: number;
    onEvent?: (event: OpenCodeEvent) => void;
  }): Promise<OpenCodeEvent[]> {
    await this.resumeSession(sessionId, prompt, { model: options?.model });
    return this.waitForIdle(sessionId, {
      timeout: options?.timeout,
      onEvent: options?.onEvent,
    });
  }

  /**
   * Check if a session exists and get its info
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId);
      return !!session;
    } catch {
      return false;
    }
  }

  /**
   * Delete a session permanently
   */
  async deleteSession(sessionId: string): Promise<void> {
    const client = this.getClient();
    await client.session.delete({
      sessionID: sessionId,
      directory: this.config.directory,
    });
    console.log(`[OpenCode] Deleted session ${sessionId}`);
  }

  /**
   * Fork a session - creates a new session with full context from the original
   * This is ideal for "continuing" a completed task with all previous context preserved.
   *
   * @param sessionId - The session to fork
   * @param messageId - Optional: fork from a specific message (defaults to latest)
   * @param directory - Optional: override directory
   * @returns The new forked session ID
   */
  async forkSession(sessionId: string, options?: {
    messageId?: string;
    directory?: string;
  }): Promise<string> {
    const client = this.getClient();
    const directory = options?.directory || this.config.directory;

    console.log(`[OpenCode] Forking session ${sessionId}...`);

    const result = await client.session.fork({
      sessionID: sessionId,
      directory,
      ...(options?.messageId && { messageID: options.messageId }),
    });

    if (!result.data?.id) {
      throw new Error(`Failed to fork session ${sessionId}`);
    }

    console.log(`[OpenCode] Forked session ${sessionId} -> ${result.data.id}`);
    return result.data.id;
  }

  /**
   * Get messages from a session
   * Useful for extracting context to build continuation prompts
   */
  async getSessionMessages(sessionId: string, directory?: string): Promise<any[]> {
    const client = this.getClient();

    const result = await client.session.messages({
      sessionID: sessionId,
      directory: directory || this.config.directory,
    });

    return result.data || [];
  }

  /**
   * Summarize a session (triggers AI compaction)
   * Note: This returns boolean - the summary is applied to the session internally
   */
  async summarizeSession(sessionId: string, options?: {
    providerID?: string;
    modelID?: string;
    directory?: string;
  }): Promise<boolean> {
    const client = this.getClient();

    const result = await client.session.summarize({
      sessionID: sessionId,
      directory: options?.directory || this.config.directory,
      providerID: options?.providerID || DEFAULT_MODEL.providerID,
      modelID: options?.modelID || DEFAULT_MODEL.modelID,
    });

    console.log(`[OpenCode] Summarized session ${sessionId}: ${result.data}`);
    return result.data === true;
  }

  // ============================================
  // PERMISSION HANDLING
  // ============================================

  /**
   * Respond to a permission request
   * @param response - 'once' (allow this time), 'always' (allow forever), 'reject' (deny)
   */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    directory?: string
  ): Promise<boolean> {
    const client = this.getClient();

    try {
      // The SDK uses postSessionIdPermissionsPermissionId internally
      // but we use the flattened version
      const result = await (client as any).postSessionIdPermissionsPermissionId({
        id: sessionId,
        permissionID: permissionId,
        response,
        directory: directory || this.config.directory,
      });

      console.log(`[OpenCode] Permission ${permissionId} response: ${response}`);
      return result.data === true;
    } catch (error: any) {
      console.error(`[OpenCode] Failed to respond to permission: ${error.message}`);
      return false;
    }
  }

  /**
   * Update session configuration (including default permissions)
   */
  async updateSessionConfig(sessionId: string, config: {
    permission?: {
      edit?: 'ask' | 'allow' | 'deny';
      bash?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
      webfetch?: 'ask' | 'allow' | 'deny';
      doom_loop?: 'ask' | 'allow' | 'deny';
      external_directory?: 'ask' | 'allow' | 'deny';
    };
  }, directory?: string): Promise<void> {
    const client = this.getClient();

    try {
      await client.session.update({
        sessionID: sessionId,
        directory: directory || this.config.directory,
        ...config,
      });

      console.log(`[OpenCode] Updated session config for ${sessionId}`);
    } catch (error: any) {
      console.error(`[OpenCode] Failed to update session config: ${error.message}`);
      throw error;
    }
  }

  /**
   * Set session to auto-approve all permissions
   */
  async enableAutoApproval(sessionId: string, directory?: string): Promise<void> {
    await this.updateSessionConfig(sessionId, {
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
        doom_loop: 'allow',
        external_directory: 'allow',
      },
    }, directory);

    console.log(`[OpenCode] Auto-approval enabled for session ${sessionId}`);
  }

  /**
   * Set session to require approval for all permissions
   */
  async disableAutoApproval(sessionId: string, directory?: string): Promise<void> {
    await this.updateSessionConfig(sessionId, {
      permission: {
        edit: 'ask',
        bash: 'ask',
        webfetch: 'ask',
      },
    }, directory);

    console.log(`[OpenCode] Auto-approval disabled for session ${sessionId}`);
  }
}

export const openCodeClient = new OpenCodeClientService();
export default openCodeClient;
