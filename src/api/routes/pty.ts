/**
 * PTY Routes
 *
 * API para gestionar sesiones de terminal (PTY) de OpenCode.
 * Permite al frontend crear/listar terminales para mostrar con xterm.js.
 */

import { Router, Request, Response } from 'express';
import { openCodePTY } from '../../services/opencode/OpenCodePTY.js';

const router = Router();

/**
 * POST /api/pty
 * Create a new PTY session
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { taskId, sessionId, directory, title, command, args } = req.body;

    const pty = await openCodePTY.createPTY({
      title: title || `Terminal - ${taskId || 'New'}`,
      command,
      args,
      cwd: directory,
      directory,
    });

    res.json({
      success: true,
      pty,
      // WebSocket URL for xterm.js
      wsUrl: `/ws/pty?ptyId=${pty.id}&taskId=${taskId || ''}&directory=${encodeURIComponent(directory || '')}`,
    });
  } catch (error: any) {
    console.error('[PTY] Create error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pty
 * List all PTY sessions
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { directory } = req.query;
    const ptys = await openCodePTY.listPTYs(directory as string | undefined);
    res.json({ ptys });
  } catch (error: any) {
    console.error('[PTY] List error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pty/:id
 * Get PTY session info
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { directory } = req.query;

    const pty = await openCodePTY.getPTY(id, directory as string | undefined);

    if (!pty) {
      return res.status(404).json({ error: 'PTY session not found' });
    }

    res.json({ pty });
  } catch (error: any) {
    console.error('[PTY] Get error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/pty/:id
 * Remove a PTY session
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { directory } = req.query;

    const removed = await openCodePTY.removePTY(id, directory as string | undefined);

    if (!removed) {
      return res.status(404).json({ error: 'PTY session not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[PTY] Remove error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pty/:id/ws-url
 * Get WebSocket URL for connecting to PTY
 */
router.get('/:id/ws-url', (req: Request, res: Response) => {
  const { id } = req.params;
  const { directory, taskId } = req.query;

  const wsUrl = openCodePTY.getPTYWebSocketURL(id, directory as string | undefined);

  // Also return the proxy URL for use through our backend
  const proxyUrl = `/ws/pty?ptyId=${id}&taskId=${taskId || ''}&directory=${encodeURIComponent((directory as string) || '')}`;

  res.json({
    wsUrl,      // Direct to OpenCode (if accessible)
    proxyUrl,   // Through our backend proxy
  });
});

export default router;
