/**
 * User Repository
 *
 * Database operations for users (PostgreSQL)
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface IUser {
  id: string;
  githubId: string;
  username: string;
  email?: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  defaultApiKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  github_id: string;
  username: string;
  email: string | null;
  avatar_url: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expiry: Date | null;
  default_api_key: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToUser(row: UserRow, includeSecrets = false): IUser {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    email: row.email || undefined,
    avatarUrl: row.avatar_url || undefined,
    accessToken: includeSecrets ? row.access_token : '',
    refreshToken: includeSecrets ? (row.refresh_token || undefined) : undefined,
    tokenExpiry: row.token_expiry || undefined,
    defaultApiKey: includeSecrets ? (row.default_api_key || undefined) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  /**
   * Find user by ID
   */
  static async findById(id: string, includeSecrets = false): Promise<IUser | null> {
    const result = await postgresService.query<UserRow>(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? rowToUser(row, includeSecrets) : null;
  }

  /**
   * Find user by GitHub ID
   */
  static async findByGithubId(githubId: string, includeSecrets = false): Promise<IUser | null> {
    const result = await postgresService.query<UserRow>(
      'SELECT * FROM users WHERE github_id = $1',
      [githubId]
    );
    const row = result.rows[0];
    return row ? rowToUser(row, includeSecrets) : null;
  }

  /**
   * Find user by email
   */
  static async findByEmail(email: string, includeSecrets = false): Promise<IUser | null> {
    const result = await postgresService.query<UserRow>(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    const row = result.rows[0];
    return row ? rowToUser(row, includeSecrets) : null;
  }

  /**
   * Create a new user
   */
  static async create(data: {
    githubId: string;
    username: string;
    email?: string;
    avatarUrl?: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    defaultApiKey?: string;
  }): Promise<IUser> {
    const id = generateId();

    await postgresService.query(
      `INSERT INTO users (
        id, github_id, username, email, avatar_url,
        access_token, refresh_token, token_expiry, default_api_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        data.githubId,
        data.username,
        data.email || null,
        data.avatarUrl || null,
        data.accessToken,
        data.refreshToken || null,
        data.tokenExpiry || null,
        data.defaultApiKey || null,
      ]
    );

    const user = await this.findById(id, true);
    return user!;
  }

  /**
   * Update user
   */
  static async update(id: string, data: Partial<{
    username: string;
    email: string;
    avatarUrl: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiry: Date;
    defaultApiKey: string;
  }>): Promise<IUser | null> {
    const existing = await this.findById(id, true);
    if (!existing) return null;

    await postgresService.query(
      `UPDATE users SET
        username = COALESCE($1, username),
        email = COALESCE($2, email),
        avatar_url = COALESCE($3, avatar_url),
        access_token = COALESCE($4, access_token),
        refresh_token = COALESCE($5, refresh_token),
        token_expiry = COALESCE($6, token_expiry),
        default_api_key = COALESCE($7, default_api_key),
        updated_at = NOW()
      WHERE id = $8`,
      [
        data.username || null,
        data.email || null,
        data.avatarUrl || null,
        data.accessToken || null,
        data.refreshToken || null,
        data.tokenExpiry || null,
        data.defaultApiKey || null,
        id,
      ]
    );

    return this.findById(id, true);
  }

  /**
   * Find or create user by GitHub ID
   */
  static async findOrCreate(data: {
    githubId: string;
    username: string;
    email?: string;
    avatarUrl?: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
  }): Promise<IUser> {
    const existing = await this.findByGithubId(data.githubId, true);
    if (existing) {
      // Update tokens and info
      const updated = await this.update(existing.id, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiry: data.tokenExpiry,
        avatarUrl: data.avatarUrl,
        username: data.username,
        email: data.email,
      });
      return updated!;
    }
    return this.create(data);
  }

  /**
   * Delete user
   */
  static async delete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get access token (for GitHub API calls)
   */
  static async getAccessToken(id: string): Promise<string | undefined> {
    const result = await postgresService.query<{ access_token: string }>(
      'SELECT access_token FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0]?.access_token;
  }

  /**
   * Get decrypted API key
   */
  static async getDecryptedApiKey(id: string): Promise<string | undefined> {
    const result = await postgresService.query<{ default_api_key: string | null }>(
      'SELECT default_api_key FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0]?.default_api_key || undefined;
  }
}

export default UserRepository;
