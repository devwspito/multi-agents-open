/**
 * Auth Routes
 *
 * GitHub OAuth + JWT token management.
 * Uses PostgreSQL for persistence.
 */

import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { UserRepository } from '../../database/repositories/UserRepository.js';
import { OAuthStateRepository } from '../../database/repositories/OAuthStateRepository.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Generate JWT token
 */
function generateToken(userId: string, githubId: string): string {
  return jwt.sign(
    { userId, githubId },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * GET /api/auth/github-auth/url
 * Get GitHub OAuth URL (redirects to backend callback)
 */
router.get('/github-auth/url', async (req: Request, res: Response) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');

    // Save state to PostgreSQL
    await OAuthStateRepository.create(state);
    console.log(`[Auth] OAuth state created: ${state}`);

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const redirectUri = `${backendUrl}/api/auth/github/callback`;
    const scope = 'user:email,repo,read:org';

    const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;

    res.json({ success: true, url, state });
  } catch (error) {
    console.error('[Auth] Error generating GitHub auth URL:', error);
    res.status(500).json({ success: false, message: 'Failed to generate auth URL' });
  }
});

/**
 * GET /api/auth/github/callback
 * GitHub OAuth callback (GET from GitHub redirect)
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}/auth/error?error=${error}`);
  }

  // Verify state from PostgreSQL
  if (!state) {
    console.error('[Auth] OAuth callback: missing state parameter');
    return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
  }

  const isValidState = await OAuthStateRepository.verifyAndConsume(state as string);
  if (!isValidState) {
    console.error(`[Auth] OAuth callback: state not found or expired: ${state}`);
    return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
  }

  console.log(`[Auth] OAuth state validated and consumed: ${state}`);

  if (!code || typeof code !== 'string') {
    return res.redirect(`${FRONTEND_URL}/auth/error?error=no_code`);
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
      return res.redirect(`${FRONTEND_URL}/auth/error?error=${tokenData.error}`);
    }

    const githubToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    const githubUser = await userResponse.json() as any;

    // Get email if not public
    let email = githubUser.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
        },
      });
      const emails: any = await emailsResponse.json();
      const primaryEmail = emails.find((e: any) => e.primary);
      email = primaryEmail?.email || emails[0]?.email;
    }

    // Create or update user in PostgreSQL
    const user = await UserRepository.findOrCreate({
      githubId: githubUser.id.toString(),
      username: githubUser.login,
      email,
      avatarUrl: githubUser.avatar_url,
      accessToken: githubToken,
      refreshToken: tokenData.refresh_token,
    });

    // Generate JWT
    const token = generateToken(user.id, user.githubId);

    // Redirect to frontend with token
    const params = new URLSearchParams({
      token,
      github: 'connected',
    });
    res.redirect(`${FRONTEND_URL}/?${params.toString()}`);
  } catch (error: any) {
    console.error('[Auth] GitHub callback error:', error);
    res.redirect(`${FRONTEND_URL}/auth/error?error=server_error`);
  }
});

/**
 * POST /api/auth/github/callback
 * Handle GitHub OAuth callback (POST from frontend)
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

    // Create or update user in PostgreSQL
    const user = await UserRepository.findOrCreate({
      githubId: githubUser.id.toString(),
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      accessToken: githubToken,
      refreshToken: tokenData.refresh_token,
    });

    // Generate JWT
    const token = generateToken(user.id, user.githubId);

    res.json({
      success: true,
      data: {
        accessToken: token,
        user: {
          id: user.id,
          name: user.username,
          email: user.email,
          avatar: user.avatarUrl,
        },
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
router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Get user from PostgreSQL
    const user = await UserRepository.findById(decoded.userId, true);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        githubId: user.githubId,
        name: user.username,
        username: user.username,
        email: user.email,
        avatar: user.avatarUrl,
        avatarUrl: user.avatarUrl,
        hasGithubConnected: !!user.accessToken,
      },
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * GET /api/auth/me/api-key
 * Get user's default API key
 */
router.get('/me/api-key', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const user = await UserRepository.findById(decoded.userId, true);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const apiKey = await UserRepository.getDecryptedApiKey(decoded.userId);
    const maskedKey = apiKey ? `sk-ant-...${apiKey.slice(-4)}` : null;

    res.json({
      success: true,
      data: {
        hasApiKey: !!apiKey,
        maskedKey,
        provider: 'anthropic',
      },
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token (JWT is self-contained, just verify and reissue)
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET) as any;

    const user = await UserRepository.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const accessToken = generateToken(user.id, user.githubId);
    res.json({ success: true, data: { accessToken } });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

/**
 * POST /api/auth/logout
 * Logout (JWT is stateless, just acknowledge)
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;

/**
 * Auth middleware for protected routes
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const user = await UserRepository.findById(decoded.userId, true);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    (req as any).userId = decoded.userId;
    (req as any).user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Get user's GitHub access token
 */
export async function getUserGitHubToken(userId: string): Promise<string | undefined> {
  return UserRepository.getAccessToken(userId);
}
