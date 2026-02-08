/**
 * OAuth State Repository
 *
 * Database operations for OAuth state tokens (CSRF protection) - PostgreSQL
 */

import { postgresService } from '../postgres/PostgresService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface IOAuthState {
  id: string;
  state: string;
  createdAt: Date;
}

interface OAuthStateRow {
  id: string;
  state: string;
  created_at: Date;
}

function rowToOAuthState(row: OAuthStateRow): IOAuthState {
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
  };
}

export class OAuthStateRepository {
  /**
   * Create a new OAuth state
   */
  static async create(state: string): Promise<IOAuthState> {
    const id = generateId();

    const result = await postgresService.query(
      'INSERT INTO oauth_states (id, state) VALUES ($1, $2) RETURNING *',
      [id, state]
    );

    console.log(`[OAuthState] Created state in DB: ${state}, rows affected: ${result.rowCount}`);

    return {
      id,
      state,
      createdAt: new Date(),
    };
  }

  /**
   * Find OAuth state by state value
   */
  static async findByState(state: string): Promise<IOAuthState | null> {
    console.log(`[OAuthState] Looking for state: ${state}`);

    const result = await postgresService.query<OAuthStateRow>(
      'SELECT * FROM oauth_states WHERE state = $1',
      [state]
    );

    console.log(`[OAuthState] Found ${result.rowCount} rows for state: ${state}`);

    const row = result.rows[0];
    return row ? rowToOAuthState(row) : null;
  }

  /**
   * Delete OAuth state by state value
   */
  static async deleteByState(state: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM oauth_states WHERE state = $1',
      [state]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Clean up expired states (older than 24 hours)
   */
  static async cleanupExpired(): Promise<number> {
    const result = await postgresService.query(
      "DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '24 hours'"
    );
    return result.rowCount ?? 0;
  }

  /**
   * Verify and consume OAuth state (one-time use)
   * Returns true if state was valid, false otherwise
   * Uses PostgreSQL's NOW() to avoid timezone issues
   */
  static async verifyAndConsume(state: string): Promise<boolean> {
    console.log(`[OAuthState] Verifying state: ${state}`);

    // Delete the state if it exists and is not expired (within 24 hours)
    // Using PostgreSQL's NOW() to avoid timezone issues between Node.js and PostgreSQL
    const result = await postgresService.query(
      `DELETE FROM oauth_states
       WHERE state = $1
       AND created_at > NOW() - INTERVAL '24 hours'
       RETURNING *`,
      [state]
    );

    const deleted = (result.rowCount ?? 0) > 0;
    console.log(`[OAuthState] State ${deleted ? 'consumed successfully' : 'not found or expired'}: ${state}`);

    // If not deleted, try to clean up expired state
    if (!deleted) {
      await postgresService.query(
        `DELETE FROM oauth_states WHERE state = $1`,
        [state]
      );
    }

    return deleted;
  }
}

export default OAuthStateRepository;
