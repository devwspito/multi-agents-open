/**
 * Provider Factory
 *
 * Creates and manages LLM provider instances.
 * Handles provider selection, initialization, and lifecycle.
 */

import { ILLMProvider } from './BaseProvider.js';
import { DGXSparkProvider } from './DGXSparkProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { ProviderConfig, ProviderType } from '../../types/index.js';

/**
 * Provider factory for creating LLM provider instances
 */
class ProviderFactoryClass {
  private providers: Map<string, ILLMProvider> = new Map();
  private defaultProvider: ILLMProvider | null = null;

  /**
   * Create a provider instance
   */
  async create(config: ProviderConfig): Promise<ILLMProvider> {
    const key = this.getProviderKey(config);

    // Check if already exists
    if (this.providers.has(key)) {
      return this.providers.get(key)!;
    }

    // Create new provider
    let provider: ILLMProvider;

    switch (config.type) {
      case 'dgx-spark':
        provider = new DGXSparkProvider({
          ...config,
          host: config.host || process.env.DGX_SPARK_HOST || 'http://localhost:8000',
        });
        break;

      case 'ollama':
        provider = new OllamaProvider({
          ...config,
          host: config.host || process.env.OLLAMA_HOST || 'http://localhost:11434',
        });
        break;

      default:
        throw new Error(`[ProviderFactory] Unknown provider type: ${config.type}`);
    }

    // Initialize provider
    await provider.initialize();

    // Cache it
    this.providers.set(key, provider);

    // Set as default if first provider
    if (!this.defaultProvider) {
      this.defaultProvider = provider;
    }

    console.log(`[ProviderFactory] Created ${config.type} provider: ${config.model}`);
    return provider;
  }

  /**
   * Get the default provider (auto-configure from environment)
   */
  async getDefault(): Promise<ILLMProvider> {
    if (this.defaultProvider) {
      return this.defaultProvider;
    }

    // Auto-configure from environment
    const config = this.getConfigFromEnv();
    return this.create(config);
  }

  /**
   * Get a specific provider by type
   */
  async get(type: ProviderType): Promise<ILLMProvider> {
    // Find existing provider of this type
    for (const [_, provider] of this.providers) {
      if (provider.type === type) {
        return provider;
      }
    }

    // Create new one with default config
    const config = this.getDefaultConfig(type);
    return this.create(config);
  }

  /**
   * Dispose all providers
   */
  async disposeAll(): Promise<void> {
    for (const [key, provider] of this.providers) {
      await provider.dispose();
      this.providers.delete(key);
    }
    this.defaultProvider = null;
    console.log('[ProviderFactory] All providers disposed');
  }

  /**
   * Health check all providers
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [key, provider] of this.providers) {
      results[key] = await provider.healthCheck();
    }

    return results;
  }

  // ==================== Private Helpers ====================

  private getProviderKey(config: ProviderConfig): string {
    return `${config.type}:${config.host || 'default'}:${config.model}`;
  }

  private getConfigFromEnv(): ProviderConfig {
    // Priority: DGX Spark > Ollama

    if (process.env.DGX_SPARK_ENABLED === 'true') {
      return {
        type: 'dgx-spark',
        host: process.env.DGX_SPARK_HOST || 'http://localhost:8000',
        model: process.env.DGX_SPARK_MODEL || 'llama-3.3-70b',
      };
    }

    if (process.env.OLLAMA_ENABLED === 'true') {
      return {
        type: 'ollama',
        host: process.env.OLLAMA_HOST || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'llama3.2',
      };
    }

    // Default to DGX Spark
    return {
      type: 'dgx-spark',
      host: process.env.DGX_SPARK_HOST || 'http://localhost:8000',
      model: process.env.DGX_SPARK_MODEL || 'llama-3.3-70b',
    };
  }

  private getDefaultConfig(type: ProviderType): ProviderConfig {
    switch (type) {
      case 'dgx-spark':
        return {
          type: 'dgx-spark',
          host: process.env.DGX_SPARK_HOST || 'http://localhost:8000',
          model: process.env.DGX_SPARK_MODEL || 'llama-3.3-70b',
        };

      case 'ollama':
        return {
          type: 'ollama',
          host: process.env.OLLAMA_HOST || 'http://localhost:11434',
          model: process.env.OLLAMA_MODEL || 'llama3.2',
        };

      default:
        throw new Error(`[ProviderFactory] Unknown provider type: ${type}`);
    }
  }
}

export const providerFactory = new ProviderFactoryClass();
export default providerFactory;
