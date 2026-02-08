/**
 * OpenCode PTY (Pseudo-Terminal) Service
 *
 * Permite crear y conectar a sesiones de terminal de OpenCode,
 * para mostrar la UI completa en el frontend via xterm.js
 *
 * Flujo:
 * 1. Frontend solicita PTY para una sesión
 * 2. Backend crea PTY en OpenCode
 * 3. Backend proxies WebSocket entre frontend y OpenCode
 * 4. Frontend renderiza con xterm.js
 */

import { openCodeClient } from './OpenCodeClient.js';
import WebSocket from 'ws';

export interface PTYSession {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
}

export interface PTYCreateOptions {
  title?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  directory?: string; // OpenCode project directory
}

class OpenCodePTYService {
  private activePTYs: Map<string, PTYSession> = new Map();

  /**
   * Create a new PTY session in OpenCode
   */
  async createPTY(options: PTYCreateOptions = {}): Promise<PTYSession> {
    const client = openCodeClient.getClient();

    const result = await client.pty.create({
      title: options.title || 'OpenCode Terminal',
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      directory: options.directory,
    });

    if (!result.data) {
      throw new Error('Failed to create PTY session');
    }

    const pty = result.data as PTYSession;
    this.activePTYs.set(pty.id, pty);

    console.log(`[PTY] Created session: ${pty.id} (${pty.title})`);
    return pty;
  }

  /**
   * List all active PTY sessions
   */
  async listPTYs(directory?: string): Promise<PTYSession[]> {
    const client = openCodeClient.getClient();

    const result = await client.pty.list({
      directory,
    });

    return (result.data || []) as PTYSession[];
  }

  /**
   * Get PTY session info
   */
  async getPTY(id: string, directory?: string): Promise<PTYSession | null> {
    const client = openCodeClient.getClient();

    try {
      const result = await client.pty.get({
        ptyID: id,
        directory,
      });

      return result.data as PTYSession;
    } catch {
      return null;
    }
  }

  /**
   * Remove a PTY session
   */
  async removePTY(id: string, directory?: string): Promise<boolean> {
    const client = openCodeClient.getClient();

    try {
      await client.pty.remove({
        ptyID: id,
        directory,
      });

      this.activePTYs.delete(id);
      console.log(`[PTY] Removed session: ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get WebSocket URL for PTY connection
   * This URL can be used directly by xterm.js addon-attach
   */
  getPTYWebSocketURL(ptyId: string, directory?: string): string {
    const baseUrl = process.env.OPENCODE_URL || 'http://localhost:4096';
    const wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');

    let url = `${wsUrl}/pty/${ptyId}/connect`;
    if (directory) {
      url += `?directory=${encodeURIComponent(directory)}`;
    }

    return url;
  }

  /**
   * Create a WebSocket connection to PTY
   * Use this for server-side proxying to frontend
   */
  connectToPTY(ptyId: string, directory?: string): WebSocket {
    const url = this.getPTYWebSocketURL(ptyId, directory);
    console.log(`[PTY] Connecting to: ${url}`);

    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[PTY] Connected to session: ${ptyId}`);
    });

    ws.on('error', (error: Error) => {
      console.error(`[PTY] WebSocket error:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[PTY] Disconnected from session: ${ptyId}`);
    });

    return ws;
  }

  /**
   * Create a PTY session for an OpenCode agent session
   * This creates a terminal that shows the agent's activity
   */
  async createAgentPTY(sessionId: string, workingDirectory: string): Promise<PTYSession> {
    // OpenCode's TUI can be started for a specific session
    return this.createPTY({
      title: `Agent Session: ${sessionId}`,
      cwd: workingDirectory,
      directory: workingDirectory,
      // OpenCode CLI command to attach to session
      command: 'opencode',
      args: ['--session', sessionId],
    });
  }

  /**
   * Get active PTY count
   */
  getActivePTYCount(): number {
    return this.activePTYs.size;
  }
}

export const openCodePTY = new OpenCodePTYService();
export default openCodePTY;
