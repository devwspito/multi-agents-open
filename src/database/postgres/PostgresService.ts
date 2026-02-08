/**
 * PostgreSQL Service
 *
 * High-performance PostgreSQL connection pool for production workloads.
 * Replaces SQLite for better concurrency and scalability.
 *
 * Features:
 * - Connection pooling (50+ concurrent connections)
 * - Prepared statements for security
 * - Transaction support
 * - Health checks
 * - Automatic reconnection
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// Configuration from environment
const config = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'multiagents',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',

  // Pool configuration for high concurrency
  max: parseInt(process.env.POSTGRES_POOL_MAX || '50'), // Max connections
  min: parseInt(process.env.POSTGRES_POOL_MIN || '5'),  // Min idle connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Timeout for new connections
  maxUses: 7500, // Close connection after N uses (prevents memory leaks)

  // Statement timeout for long queries
  statement_timeout: 60000, // 60 seconds
};

class PostgresServiceClass {
  private pool: Pool | null = null;
  private connected = false;

  /**
   * Initialize the connection pool
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    console.log(`[PostgreSQL] Connecting to ${config.host}:${config.port}/${config.database}...`);

    this.pool = new Pool(config);

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('[PostgreSQL] Pool error:', err.message);
    });

    this.pool.on('connect', () => {
      console.log('[PostgreSQL] New client connected');
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      this.connected = true;
      console.log(`[PostgreSQL] Connected. Pool size: ${config.max}`);
    } catch (error: any) {
      console.error('[PostgreSQL] Connection failed:', error.message);
      throw error;
    }
  }

  /**
   * Get the pool instance
   */
  getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgreSQL not connected. Call connect() first.');
    }
    return this.pool;
  }

  /**
   * Execute a query with automatic connection handling
   */
  async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const result = await pool.query<T>(text, params);
      const duration = Date.now() - start;

      // Log slow queries
      if (duration > 100) {
        console.log(`[PostgreSQL] Slow query (${duration}ms):`, text.substring(0, 100));
      }

      return result;
    } catch (error: any) {
      console.error('[PostgreSQL] Query error:', error.message);
      throw error;
    }
  }

  /**
   * Execute a query and return first row
   */
  async queryOne<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T | null> {
    const result = await this.query<T>(text, params);
    return result.rows[0] || null;
  }

  /**
   * Execute a query and return all rows
   */
  async queryAll<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T[]> {
    const result = await this.query<T>(text, params);
    return result.rows;
  }

  /**
   * Get a client for transaction
   */
  async getClient(): Promise<PoolClient> {
    return this.getPool().connect();
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    total: number;
    idle: number;
    waiting: number;
  } {
    const pool = this.getPool();
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
      console.log('[PostgreSQL] Connection pool closed');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}

export const postgresService = new PostgresServiceClass();
export default postgresService;
