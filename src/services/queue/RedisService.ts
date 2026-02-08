/**
 * Redis Service
 *
 * Manages Redis connections for BullMQ queues and pub/sub.
 * Optimized for high throughput with connection pooling.
 */

import { Redis } from 'ioredis';

// Redis configuration
const config = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0'),

  // Connection options
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: true,
  retryStrategy: (times: number) => {
    if (times > 10) {
      console.error('[Redis] Max retries reached, giving up');
      return null;
    }
    return Math.min(times * 100, 3000);
  },
};

class RedisServiceClass {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private workerClient: Redis | null = null;
  private connected = false;

  /**
   * Initialize and connect to Redis
   */
  async connect(): Promise<void> {
    // Initialize the main client
    this.client = this.createConnection();

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 10000);

      this.client!.on('connect', () => {
        clearTimeout(timeout);
        console.log('[Redis] Connected');
        this.connected = true;
        resolve();
      });

      this.client!.on('error', (err: Error) => {
        clearTimeout(timeout);
        console.error('[Redis] Connection error:', err.message);
        this.connected = false;
        reject(err);
      });
    });
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    await this.close();
  }

  /**
   * Get the main Redis client (for BullMQ queues)
   */
  getClient(): Redis {
    if (!this.client) {
      this.client = this.createConnection();

      this.client.on('connect', () => {
        console.log('[Redis] Connected');
        this.connected = true;
      });

      this.client.on('error', (err: Error) => {
        console.error('[Redis] Connection error:', err.message);
        this.connected = false;
      });

      this.client.on('close', () => {
        console.log('[Redis] Connection closed');
        this.connected = false;
      });
    }

    return this.client;
  }

  /**
   * Get a subscriber client (for pub/sub)
   */
  getSubscriber(): Redis {
    if (!this.subscriber) {
      this.subscriber = this.createConnection();

      this.subscriber.on('error', (err: Error) => {
        console.error('[Redis Subscriber] Error:', err.message);
      });
    }

    return this.subscriber;
  }

  /**
   * Get worker client (dedicated connection for workers)
   */
  getWorkerClient(): Redis {
    if (!this.workerClient) {
      this.workerClient = this.createConnection();

      this.workerClient.on('error', (err: Error) => {
        console.error('[Redis Worker] Error:', err.message);
      });
    }

    return this.workerClient;
  }

  /**
   * Create a new connection (for workers)
   */
  createConnection(): Redis {
    return new Redis(config);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      const client = this.getClient();
      const pong = await client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Get Redis info/stats
   */
  async getStats(): Promise<{
    connected: boolean;
    usedMemory: string;
    connectedClients: number;
    queuedCommands: number;
  }> {
    try {
      const client = this.getClient();
      const info = await client.info('memory');
      const clientsInfo = await client.info('clients');

      const usedMemoryMatch = info.match(/used_memory_human:(\S+)/);
      const connectedClientsMatch = clientsInfo.match(/connected_clients:(\d+)/);

      return {
        connected: this.connected,
        usedMemory: usedMemoryMatch?.[1] || 'unknown',
        connectedClients: parseInt(connectedClientsMatch?.[1] || '0'),
        queuedCommands: 0,
      };
    } catch {
      return {
        connected: false,
        usedMemory: 'unknown',
        connectedClients: 0,
        queuedCommands: 0,
      };
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.workerClient) {
      await this.workerClient.quit();
      this.workerClient = null;
    }
    this.connected = false;
    console.log('[Redis] All connections closed');
  }
}

export const redisService = new RedisServiceClass();
export default redisService;
