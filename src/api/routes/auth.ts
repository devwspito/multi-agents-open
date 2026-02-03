/**
 * Auth Routes
 *
 * GitHub OAuth + JWT token management.
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

interface User {
  id: string;
  email?: string;
  name: string;
  avatar?: string;
  githubId?: string;
  githubToken?: string;
}

// In-memory user store (replace with DB in production)
const users = new Map<string, User>();
const refreshTokens = new Map<string, string>(); // refreshToken -> userId

/**
 * Generate tokens
 */
function generateTokens(user: User) {
  const accessToken = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  const refreshToken = jwt.sign(
    { userId: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  refreshTokens.set(refreshToken, user.id);
  return { accessToken, refreshToken };
}

/**
 * GET /api/auth/github-auth/url
 * Get GitHub OAuth URL
 */
router.get('/github-auth/url', (req: Request, res: Response) => {
  const state = Math.random().toString(36).substring(7);
  const redirectUri = `${FRONTEND_URL}/auth/callback`;
  const scope = 'user:email,repo,read:org';

  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;

  res.json({ url, state });
});

/**
 * POST /api/auth/github/callback
 * Handle GitHub OAuth callback
 */
router.post('/github/callback', async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Code required' });
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json() as any;
    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description });
    }

    const githubToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    const githubUser = await userResponse.json() as any;

    // Create or update user
    const userId = `github_${githubUser.id}`;
    const user: User = {
      id: userId,
      email: githubUser.email,
      name: githubUser.name || githubUser.login,
      avatar: githubUser.avatar_url,
      githubId: githubUser.id.toString(),
      githubToken,
    };
    users.set(userId, user);

    // Generate tokens
    const tokens = generateTokens(user);

    res.json({
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
      },
    });
  } catch (error: any) {
    console.error('[Auth] GitHub callback error:', error);
    res.status(500).json({ error: 'GitHub authentication failed' });
  }
});

/**
 * GET /api/auth/me
 * Get current user
 */
router.get('/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = users.get(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({
      data: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post('/refresh', (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET) as any;
    const userId = refreshTokens.get(refreshToken);

    if (!userId || decoded.userId !== userId) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const user = users.get(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ data: { accessToken } });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

/**
 * POST /api/auth/logout
 * Logout and revoke refresh token
 */
router.post('/logout', (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    refreshTokens.delete(refreshToken);
  }
  res.json({ success: true });
});

export default router;

// Export middleware for protected routes
export function authMiddleware(req: Request, res: Response, next: Function) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as any).userId = decoded.userId;
    (req as any).user = users.get(decoded.userId);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Export function to get user's GitHub token
export function getUserGitHubToken(userId: string): string | undefined {
  return users.get(userId)?.githubToken;
}
