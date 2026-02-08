/**
 * LLM Providers Configuration
 *
 * Defines available providers and their models for project-level LLM selection.
 * Users can choose between:
 * - Local (free): Kimi-Dev, GLM, DeepSeek running on DGX
 * - Commercial: Claude, GPT, Gemini (requires user's API key)
 */

export type LLMProviderType = 'local' | 'anthropic' | 'openai' | 'google';

export interface LLMModel {
  id: string;
  name: string;
  contextWindow: number;
  description?: string;
  recommended?: boolean;
}

export interface LLMProvider {
  id: LLMProviderType;
  name: string;
  description: string;
  requiresApiKey: boolean;
  apiKeyPrefix?: string;        // For validation (e.g., 'sk-ant-' for Anthropic)
  apiKeyPlaceholder?: string;
  models: LLMModel[];
  defaultModel: string;
}

/**
 * Available LLM Providers
 */
export const LLM_PROVIDERS: Record<LLMProviderType, LLMProvider> = {
  local: {
    id: 'local',
    name: 'Local (Gratuito)',
    description: 'Modelos open source ejecutados en DGX. Sin coste adicional.',
    requiresApiKey: false,
    models: [
      {
        id: 'kimi-dev-72b',
        name: 'Kimi-Dev 72B',
        contextWindow: 131072,
        description: 'Optimizado para coding agentic. SWE-bench 60.4%',
        recommended: true,
      },
      {
        id: 'glm-4.7',
        name: 'GLM 4.7',
        contextWindow: 131072,
        description: 'Excelente para análisis de código. SWE-bench 73.8%',
      },
      {
        id: 'deepseek-r1',
        name: 'DeepSeek R1',
        contextWindow: 65536,
        description: 'Modelo de razonamiento con chain-of-thought',
      },
      {
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        contextWindow: 131072,
        description: 'Meta\'s latest instruction-tuned model',
      },
    ],
    defaultModel: 'kimi-dev-72b',
  },

  anthropic: {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    description: 'Modelos Claude de Anthropic. Requiere API key.',
    requiresApiKey: true,
    apiKeyPrefix: 'sk-ant-',
    apiKeyPlaceholder: 'sk-ant-api03-...',
    models: [
      {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        contextWindow: 200000,
        description: 'El más potente. Ideal para tareas complejas.',
        recommended: true,
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        contextWindow: 200000,
        description: 'Balance entre velocidad y capacidad.',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        contextWindow: 200000,
        description: 'Más rápido y económico.',
      },
    ],
    defaultModel: 'claude-sonnet-4-5-20250929',
  },

  openai: {
    id: 'openai',
    name: 'GPT (OpenAI)',
    description: 'Modelos GPT de OpenAI. Requiere API key.',
    requiresApiKey: true,
    apiKeyPrefix: 'sk-',
    apiKeyPlaceholder: 'sk-proj-...',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        description: 'Multimodal, rápido y capaz.',
        recommended: true,
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        contextWindow: 128000,
        description: 'Versión optimizada de GPT-4.',
      },
      {
        id: 'o1',
        name: 'o1 (Reasoning)',
        contextWindow: 128000,
        description: 'Especializado en razonamiento complejo.',
      },
      {
        id: 'o1-mini',
        name: 'o1 Mini',
        contextWindow: 128000,
        description: 'Razonamiento rápido y económico.',
      },
    ],
    defaultModel: 'gpt-4o',
  },

  google: {
    id: 'google',
    name: 'Gemini (Google)',
    description: 'Modelos Gemini de Google. Requiere API key.',
    requiresApiKey: true,
    apiKeyPrefix: 'AIza',
    apiKeyPlaceholder: 'AIza...',
    models: [
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        contextWindow: 1000000,
        description: 'Muy rápido con contexto masivo.',
        recommended: true,
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        contextWindow: 2000000,
        description: '2M de contexto. Ideal para proyectos grandes.',
      },
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        contextWindow: 1000000,
        description: 'Balance entre velocidad y capacidad.',
      },
    ],
    defaultModel: 'gemini-2.0-flash',
  },
};

/**
 * Phase Types for per-phase LLM configuration
 */
export type PhaseType = 'analysis' | 'developer' | 'merge' | 'security';

/**
 * Single LLM Configuration (provider + model)
 */
export interface LLMConfig {
  provider: LLMProviderType;
  model: string;
  apiKey?: string;  // Encrypted, only for commercial providers
}

/**
 * Per-Phase LLM Configuration
 * Each phase can optionally have its own LLM config
 * If not specified, falls back to the project's default config
 */
export interface PhaseLLMConfigs {
  analysis?: LLMConfig;
  developer?: LLMConfig;
  merge?: LLMConfig;
  security?: LLMConfig;
}

/**
 * Full Project LLM Configuration
 * Supports both a default config and per-phase overrides
 */
export interface ProjectLLMConfig {
  // Default config used when phase-specific config is not set
  default: LLMConfig;
  // Optional per-phase overrides for hybrid configurations
  phases?: PhaseLLMConfigs;
}

/**
 * Legacy single config type for backwards compatibility
 */
export interface LegacyProjectLLMConfig {
  provider: LLMProviderType;
  model: string;
  apiKey?: string;
}

/**
 * Get default LLM config (local/free)
 */
export function getDefaultLLMConfig(): ProjectLLMConfig {
  return {
    default: {
      provider: 'local',
      model: 'kimi-dev-72b',
    },
  };
}

/**
 * Get LLM config for a specific phase
 * Falls back to default if phase-specific config is not set
 */
export function getPhaseConfig(config: ProjectLLMConfig, phase: PhaseType): LLMConfig {
  // Check if there's a phase-specific config
  const phaseConfig = config.phases?.[phase];
  if (phaseConfig) {
    // Inherit apiKey from default if not specified in phase config
    // but only if they use the same provider
    if (!phaseConfig.apiKey && phaseConfig.provider === config.default.provider) {
      return {
        ...phaseConfig,
        apiKey: config.default.apiKey,
      };
    }
    return phaseConfig;
  }
  // Fall back to default
  return config.default;
}

/**
 * Migrate legacy config to new format
 */
export function migrateLegacyConfig(legacy: LegacyProjectLLMConfig): ProjectLLMConfig {
  return {
    default: {
      provider: legacy.provider,
      model: legacy.model,
      apiKey: legacy.apiKey,
    },
  };
}

/**
 * Check if config has any phase-specific overrides
 */
export function hasPhaseOverrides(config: ProjectLLMConfig): boolean {
  if (!config.phases) return false;
  return Object.values(config.phases).some(c => c !== undefined);
}

/**
 * Validate API key format for a provider
 */
export function validateApiKey(provider: LLMProviderType, apiKey: string): boolean {
  const providerConfig = LLM_PROVIDERS[provider];

  if (!providerConfig.requiresApiKey) {
    return true; // Local doesn't need API key
  }

  if (!apiKey || apiKey.length < 10) {
    return false;
  }

  if (providerConfig.apiKeyPrefix && !apiKey.startsWith(providerConfig.apiKeyPrefix)) {
    return false;
  }

  return true;
}

/**
 * Get model info
 */
export function getModelInfo(provider: LLMProviderType, modelId: string): LLMModel | undefined {
  return LLM_PROVIDERS[provider]?.models.find(m => m.id === modelId);
}

/**
 * Convert provider type to OpenCode provider ID
 */
export function toOpenCodeProvider(provider: LLMProviderType): string {
  switch (provider) {
    case 'local':
      return 'dgx-spark';
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    default:
      return 'dgx-spark';
  }
}
