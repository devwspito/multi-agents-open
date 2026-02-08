/**
 * Project Routes
 *
 * CRUD for projects with repository management.
 * Matches agents-software-arq pattern.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from './auth.js';
import { ProjectRepository, type IProject } from '../../database/repositories/ProjectRepository.js';
import { RepositoryRepository } from '../../database/repositories/RepositoryRepository.js';
import { specialistManager } from '../../services/specialists/index.js';
import {
  LLM_PROVIDERS,
  getDefaultLLMConfig,
  getPhaseConfig,
  migrateLegacyConfig,
  hasPhaseOverrides,
  validateApiKey,
  toOpenCodeProvider,
  type ProjectLLMConfig,
  type LLMConfig,
  type LLMProviderType,
  type PhaseType,
  type PhaseLLMConfigs,
} from '../../config/llmProviders.js';

const router = Router();

// Apply auth to all routes
router.use(authMiddleware);

/**
 * GET /api/projects
 * List all projects for user with their repositories
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const projects = await ProjectRepository.findByUserId(userId);

    // Get repositories for each project
    const projectsWithRepos = await Promise.all(projects.map(async (project) => {
      const repositories = await RepositoryRepository.findByProjectId(project.id);

      return {
        _id: project.id,
        name: project.name,
        description: project.description,
        type: project.type,
        status: project.status,
        userId: project.userId,
        settings: project.settings,
        isActive: project.isActive,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        repositories: repositories.map(r => ({
          _id: r.id,
          name: r.name,
          description: r.description,
          githubRepoUrl: r.githubRepoUrl,
          githubRepoName: r.githubRepoName,
          githubBranch: r.githubBranch,
          type: r.type,
        })),
      };
    }));

    res.json({
      success: true,
      data: {
        projects: projectsWithRepos,
        pagination: {
          total: projectsWithRepos.length,
          page: 1,
          limit: 50,
        },
      },
      count: projectsWithRepos.length,
    });
  } catch (error: any) {
    console.error('[Projects] Error listing projects:', error);
    res.status(500).json({ success: false, error: 'Failed to list projects' });
  }
});

/**
 * POST /api/projects
 * Create new project with repositories
 */
router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { name, description, type, repositories } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: 'Name required' });
  }

  try {
    // Create project
    const project = await ProjectRepository.create({
      name,
      description,
      type: type || 'web-app',
      userId,
      settings: {
        approvalMode: 'manual',
        defaultPipeline: 'full',
      },
    });

    // Create repositories if provided
    const createdRepositories: any[] = [];
    if (repositories && Array.isArray(repositories) && repositories.length > 0) {
      for (const repo of repositories) {
        // Get default config based on type
        const repoConfig = RepositoryRepository.getDefaultConfig(
          repo.type || 'backend',
          repo.name
        );

        const repository = await RepositoryRepository.create({
          name: repo.name,
          description: repo.description || `Repository ${repo.name}`,
          projectId: project.id,
          githubRepoUrl: repo.clone_url || repo.html_url || `https://github.com/${repo.full_name}`,
          githubRepoName: repo.full_name,
          githubBranch: repo.default_branch || 'main',
          type: repo.type || 'backend',
          pathPatterns: repoConfig.pathPatterns,
          executionOrder: repoConfig.executionOrder,
        });

        createdRepositories.push(repository);
      }
    }

    res.status(201).json({
      success: true,
      data: {
        project: {
          _id: project.id,
          name: project.name,
          description: project.description,
          type: project.type,
          status: project.status,
          userId: project.userId,
          isActive: project.isActive,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          repositories: createdRepositories.map(r => ({
            _id: r.id,
            name: r.name,
            description: r.description,
            githubRepoUrl: r.githubRepoUrl,
            githubRepoName: r.githubRepoName,
            githubBranch: r.githubBranch,
            type: r.type,
          })),
        },
      },
      message: `Project created successfully with ${createdRepositories.length} repositories!`,
    });
  } catch (error: any) {
    console.error('[Projects] Error creating project:', error);
    res.status(500).json({ success: false, error: 'Failed to create project' });
  }
});

/**
 * GET /api/projects/:id
 * Get project by ID with repositories
 */
router.get('/:id', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Get associated repositories
    const repositories = await RepositoryRepository.findByProjectId(project.id);

    res.json({
      success: true,
      data: {
        _id: project.id,
        name: project.name,
        description: project.description,
        type: project.type,
        status: project.status,
        userId: project.userId,
        settings: project.settings,
        isActive: project.isActive,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        repositories: repositories.map(r => ({
          _id: r.id,
          name: r.name,
          description: r.description,
          githubRepoUrl: r.githubRepoUrl,
          githubRepoName: r.githubRepoName,
          githubBranch: r.githubBranch,
          type: r.type,
          pathPatterns: r.pathPatterns,
          executionOrder: r.executionOrder,
          isActive: r.isActive,
        })),
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error getting project:', error);
    res.status(500).json({ success: false, error: 'Failed to get project' });
  }
});

/**
 * PUT /api/projects/:id
 * Update project
 */
router.put('/:id', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { name, description, type, status, isActive } = req.body;
    const updated = await ProjectRepository.update(req.params.id, {
      name,
      description,
      type,
      status,
      isActive,
    });

    res.json({
      success: true,
      data: {
        _id: updated!.id,
        name: updated!.name,
        description: updated!.description,
        type: updated!.type,
        status: updated!.status,
        isActive: updated!.isActive,
        createdAt: updated!.createdAt,
        updatedAt: updated!.updatedAt,
      },
      message: 'Project updated successfully',
    });
  } catch (error: any) {
    console.error('[Projects] Error updating project:', error);
    res.status(500).json({ success: false, error: 'Failed to update project' });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete project and all its repositories
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Get all repositories for the project
    const repositories = await RepositoryRepository.findByProjectId(project.id);

    // Delete repositories
    for (const repo of repositories) {
      await RepositoryRepository.delete(repo.id);
    }

    // Soft delete project
    await ProjectRepository.delete(req.params.id);

    res.json({
      success: true,
      message: 'Project and all its repositories deleted successfully',
      deletedRepositories: repositories.length,
    });
  } catch (error: any) {
    console.error('[Projects] Error deleting project:', error);
    res.status(500).json({ success: false, error: 'Failed to delete project' });
  }
});

/**
 * GET /api/projects/:id/api-key
 * Get project's API key status
 */
router.get('/:id/api-key', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id, true);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const apiKey = project.apiKey;

    res.json({
      success: true,
      data: {
        hasApiKey: !!apiKey,
        maskedKey: apiKey ? `sk-ant-...${apiKey.slice(-4)}` : null,
        source: apiKey ? 'project' : 'environment',
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error getting API key:', error);
    res.status(500).json({ success: false, error: 'Failed to get API key' });
  }
});

/**
 * PUT /api/projects/:id/api-key
 * Update project's API key
 */
router.put('/:id/api-key', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { apiKey } = req.body;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Validate API key format if provided
    if (apiKey && !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({ success: false, error: 'Invalid Anthropic API key format' });
    }

    await ProjectRepository.update(req.params.id, { apiKey: apiKey || undefined });

    res.json({
      success: true,
      message: 'Project API key updated successfully',
      data: {
        hasApiKey: !!apiKey,
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error updating API key:', error);
    res.status(500).json({ success: false, error: 'Failed to update API key' });
  }
});

/**
 * GET /api/projects/:projectId/settings
 * Get project settings
 */
router.get('/:projectId/settings', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    res.json({
      success: true,
      data: {
        settings: project.settings || {
          defaultBranch: 'main',
          autoDeployment: false,
          autoRecoveryEnabled: true,
          autoMergeEnabled: false,
          requiredReviews: 0,
        },
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error getting settings:', error);
    res.status(500).json({ success: false, error: 'Failed to get settings' });
  }
});

/**
 * PATCH /api/projects/:projectId/settings
 * Update project settings (partial update)
 */
router.patch('/:projectId/settings', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.projectId);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const updated = await ProjectRepository.updateSettings(req.params.projectId, req.body);

    res.json({
      success: true,
      message: 'Project settings updated successfully',
      data: {
        settings: updated?.settings,
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error updating settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM CONFIGURATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/projects/llm/providers
 * Get available LLM providers and their models
 * (No auth required - public info)
 */
router.get('/llm/providers', (_req: Request, res: Response) => {
  // Return providers with models, but mask internal details
  const providers = Object.values(LLM_PROVIDERS).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    requiresApiKey: p.requiresApiKey,
    apiKeyPlaceholder: p.apiKeyPlaceholder,
    models: p.models.map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      description: m.description,
      recommended: m.recommended,
    })),
    defaultModel: p.defaultModel,
  }));

  res.json({
    success: true,
    data: {
      providers,
      defaultProvider: 'local',
      defaultModel: 'kimi-dev-72b',
    },
  });
});

/**
 * GET /api/projects/:id/llm-config
 * Get project's LLM configuration (with per-phase support)
 */
router.get('/:id/llm-config', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Get LLM config from settings, or return default
    let llmConfig = project.settings?.llm;

    // Handle legacy format (direct provider/model instead of default.provider/model)
    if (llmConfig && 'provider' in llmConfig && !('default' in llmConfig)) {
      llmConfig = migrateLegacyConfig(llmConfig as any);
    }

    if (!llmConfig) {
      llmConfig = getDefaultLLMConfig();
    }

    // Get default provider/model info
    const defaultConfig = llmConfig.default;
    const defaultProvider = LLM_PROVIDERS[defaultConfig.provider as LLMProviderType];
    const defaultModelInfo = defaultProvider?.models.find(m => m.id === defaultConfig.model);

    // Build phase configs with full info
    const phasesInfo: Record<string, any> = {};
    const phases: PhaseType[] = ['analysis', 'developer', 'merge', 'security'];

    for (const phase of phases) {
      const phaseConfig = llmConfig.phases?.[phase];
      if (phaseConfig) {
        const phaseProvider = LLM_PROVIDERS[phaseConfig.provider as LLMProviderType];
        const phaseModelInfo = phaseProvider?.models.find(m => m.id === phaseConfig.model);
        phasesInfo[phase] = {
          provider: phaseConfig.provider,
          model: phaseConfig.model,
          hasApiKey: !!phaseConfig.apiKey,
          providerInfo: phaseProvider ? {
            name: phaseProvider.name,
            requiresApiKey: phaseProvider.requiresApiKey,
          } : null,
          modelInfo: phaseModelInfo ? {
            name: phaseModelInfo.name,
            contextWindow: phaseModelInfo.contextWindow,
          } : null,
        };
      }
    }

    res.json({
      success: true,
      data: {
        // Default config
        config: {
          provider: defaultConfig.provider,
          model: defaultConfig.model,
          hasApiKey: !!defaultConfig.apiKey,
        },
        providerInfo: defaultProvider ? {
          name: defaultProvider.name,
          description: defaultProvider.description,
          requiresApiKey: defaultProvider.requiresApiKey,
        } : null,
        modelInfo: defaultModelInfo ? {
          name: defaultModelInfo.name,
          contextWindow: defaultModelInfo.contextWindow,
          description: defaultModelInfo.description,
        } : null,
        // Per-phase overrides
        phases: Object.keys(phasesInfo).length > 0 ? phasesInfo : null,
        hasPhaseOverrides: hasPhaseOverrides(llmConfig),
        isDefault: !project.settings?.llm,
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error getting LLM config:', error);
    res.status(500).json({ success: false, error: 'Failed to get LLM config' });
  }
});

/**
 * Validate a single LLM config (provider + model + apiKey)
 */
function validateLLMConfig(
  config: { provider: string; model: string; apiKey?: string },
  existingApiKey?: string,
): { valid: boolean; error?: string; providerConfig?: any; modelInfo?: any } {
  const { provider, model, apiKey } = config;

  // Validate provider
  if (!provider || !LLM_PROVIDERS[provider as LLMProviderType]) {
    return {
      valid: false,
      error: 'Invalid provider. Valid options: local, anthropic, openai, google',
    };
  }

  const providerConfig = LLM_PROVIDERS[provider as LLMProviderType];

  // Validate model
  const modelInfo = providerConfig.models.find((m: any) => m.id === model);
  if (!modelInfo) {
    return {
      valid: false,
      error: `Invalid model for ${provider}. Valid options: ${providerConfig.models.map((m: any) => m.id).join(', ')}`,
    };
  }

  // Validate API key if required (allow keeping existing key)
  if (providerConfig.requiresApiKey && !apiKey && !existingApiKey) {
    return {
      valid: false,
      error: `API key required for ${providerConfig.name}`,
    };
  }

  if (apiKey && !validateApiKey(provider as LLMProviderType, apiKey)) {
    return {
      valid: false,
      error: `Invalid API key format for ${providerConfig.name}. Expected prefix: ${providerConfig.apiKeyPrefix}`,
    };
  }

  return { valid: true, providerConfig, modelInfo };
}

/**
 * PUT /api/projects/:id/llm-config
 * Update project's LLM configuration (with per-phase support)
 *
 * Body format:
 * {
 *   provider: string,        // Default provider
 *   model: string,           // Default model
 *   apiKey?: string,         // API key for default provider
 *   phases?: {               // Optional per-phase overrides
 *     analysis?: { provider, model, apiKey? },
 *     developer?: { provider, model, apiKey? },
 *     merge?: { provider, model, apiKey? },
 *     security?: { provider, model, apiKey? }
 *   }
 * }
 */
router.put('/:id/llm-config', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { provider, model, apiKey, phases } = req.body;

  try {
    const project = await ProjectRepository.findById(req.params.id, true);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Get existing config to preserve API keys if not updating
    const existingConfig = project.settings?.llm;
    const existingDefaultApiKey = existingConfig?.default?.apiKey || (existingConfig as any)?.apiKey;

    // Validate default config
    const defaultValidation = validateLLMConfig(
      { provider, model, apiKey },
      existingDefaultApiKey
    );
    if (!defaultValidation.valid) {
      return res.status(400).json({ success: false, error: defaultValidation.error });
    }

    // Build default config
    const defaultConfig: LLMConfig = {
      provider: provider as LLMProviderType,
      model,
      ...(apiKey ? { apiKey } : existingDefaultApiKey ? { apiKey: existingDefaultApiKey } : {}),
    };

    // Validate and build phase configs if provided
    let phaseConfigs: PhaseLLMConfigs | undefined;
    if (phases && typeof phases === 'object') {
      phaseConfigs = {};
      const validPhases: PhaseType[] = ['analysis', 'developer', 'merge', 'security'];

      for (const phase of validPhases) {
        const phaseInput = phases[phase];
        if (phaseInput && phaseInput.provider && phaseInput.model) {
          // Get existing phase API key
          const existingPhaseApiKey = existingConfig?.phases?.[phase]?.apiKey;

          const phaseValidation = validateLLMConfig(
            phaseInput,
            existingPhaseApiKey || (phaseInput.provider === provider ? existingDefaultApiKey : undefined)
          );

          if (!phaseValidation.valid) {
            return res.status(400).json({
              success: false,
              error: `${phase} phase: ${phaseValidation.error}`,
            });
          }

          phaseConfigs[phase] = {
            provider: phaseInput.provider as LLMProviderType,
            model: phaseInput.model,
            ...(phaseInput.apiKey ? { apiKey: phaseInput.apiKey } :
              existingPhaseApiKey ? { apiKey: existingPhaseApiKey } : {}),
          };
        }
      }

      // Remove phaseConfigs if empty
      if (Object.keys(phaseConfigs).length === 0) {
        phaseConfigs = undefined;
      }
    }

    // Build final LLM config
    const llmConfig: ProjectLLMConfig = {
      default: defaultConfig,
      ...(phaseConfigs ? { phases: phaseConfigs } : {}),
    };

    // Update settings
    const currentSettings = project.settings || {};
    await ProjectRepository.update(req.params.id, {
      settings: {
        ...currentSettings,
        llm: llmConfig,
      },
    });

    // Log phase overrides
    const phaseOverrideStr = phaseConfigs
      ? ` with phase overrides: ${Object.entries(phaseConfigs).map(([p, c]) => `${p}=${c.provider}/${c.model}`).join(', ')}`
      : '';
    console.log(`[Projects] LLM config updated for project ${req.params.id}: default=${provider}/${model}${phaseOverrideStr}`);

    res.json({
      success: true,
      message: 'LLM configuration updated successfully',
      data: {
        config: {
          provider: defaultConfig.provider,
          model: defaultConfig.model,
          hasApiKey: !!defaultConfig.apiKey,
        },
        providerInfo: {
          name: defaultValidation.providerConfig.name,
          description: defaultValidation.providerConfig.description,
        },
        modelInfo: {
          name: defaultValidation.modelInfo.name,
          contextWindow: defaultValidation.modelInfo.contextWindow,
          description: defaultValidation.modelInfo.description,
        },
        phases: phaseConfigs ? Object.fromEntries(
          Object.entries(phaseConfigs).map(([phase, cfg]) => [
            phase,
            { provider: cfg.provider, model: cfg.model, hasApiKey: !!cfg.apiKey }
          ])
        ) : null,
        hasPhaseOverrides: !!phaseConfigs,
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error updating LLM config:', error);
    res.status(500).json({ success: false, error: 'Failed to update LLM config' });
  }
});

/**
 * DELETE /api/projects/:id/llm-config
 * Reset project's LLM config to default (local)
 */
router.delete('/:id/llm-config', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  try {
    const project = await ProjectRepository.findById(req.params.id);

    if (!project || project.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Remove LLM config from settings (reverts to default)
    const currentSettings = project.settings || {};
    delete currentSettings.llm;

    await ProjectRepository.update(req.params.id, {
      settings: currentSettings,
    });

    console.log(`[Projects] LLM config reset to default for project ${req.params.id}`);

    res.json({
      success: true,
      message: 'LLM configuration reset to default (local/free)',
      data: {
        config: getDefaultLLMConfig(),
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error resetting LLM config:', error);
    res.status(500).json({ success: false, error: 'Failed to reset LLM config' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SPECIALISTS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/projects/detect-stack
 * Detect technology stack from a GitHub repository URL
 * Used when creating a project to auto-configure specialists
 */
router.post('/detect-stack', async (req: Request, res: Response) => {
  const { repoUrl, branch = 'main' } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ success: false, error: 'Repository URL is required' });
  }

  // Validate GitHub URL
  const githubUrlPattern = /^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+/;
  if (!githubUrlPattern.test(repoUrl)) {
    return res.status(400).json({ success: false, error: 'Invalid GitHub repository URL' });
  }

  try {
    console.log(`[Projects] Detecting stack for: ${repoUrl} (branch: ${branch})`);

    const stack = await specialistManager.detectStackFromRepo(repoUrl, branch);

    // Get recommended specialists based on detected stack
    const specialists = specialistManager.getActiveSpecialists({
      stack,
      standard: {
        contextManager: true,
        taskDecomposition: true,
        codeArchitect: true,
        debugger: true,
        testEngineer: true,
        securityAuditor: true,
        gitFlowManager: true,
      },
      domainSpecialists: [],
    }, 'developer');

    console.log(`[Projects] Detected stack:`, stack);
    console.log(`[Projects] Active specialists: ${specialists.length}`);

    res.json({
      success: true,
      data: {
        stack,
        specialists,
        summary: buildStackSummary(stack),
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error detecting stack:', error);
    res.status(500).json({ success: false, error: 'Failed to detect stack' });
  }
});

/**
 * POST /api/projects/:id/detect-stack
 * Auto-detect stack from project's repositories and update settings
 * Used for existing projects to configure specialists
 */
router.post('/:id/detect-stack', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const projectId = req.params.id;

  try {
    // Get project
    const project = await ProjectRepository.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Get project's repositories
    const repositories = await RepositoryRepository.findByProjectId(projectId);
    if (!repositories || repositories.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No repositories found for this project. Add repositories first.'
      });
    }

    console.log(`[Projects] Auto-detecting stack for project ${projectId} (${repositories.length} repos)`);

    // Detect stack for each repository
    const detectedStacks: any[] = [];
    for (const repo of repositories) {
      if (repo.githubRepoUrl) {
        try {
          const stack = await specialistManager.detectStackFromRepo(
            repo.githubRepoUrl,
            repo.githubBranch || 'main'
          );
          detectedStacks.push({
            repoName: repo.name,
            stack,
            summary: buildStackSummary(stack)
          });
          console.log(`[Projects] Detected stack for ${repo.name}:`, stack);
        } catch (err: any) {
          console.warn(`[Projects] Failed to detect stack for ${repo.name}: ${err.message}`);
        }
      }
    }

    if (detectedStacks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Could not detect stack from any repository'
      });
    }

    // Merge detected stacks (priority: first detected wins)
    const mergedStack: any = {};
    const additionalTech: string[] = [];

    for (const { stack } of detectedStacks) {
      if (stack.frontend && !mergedStack.frontend) mergedStack.frontend = stack.frontend;
      if (stack.backend && !mergedStack.backend) mergedStack.backend = stack.backend;
      if (stack.database && !mergedStack.database) mergedStack.database = stack.database;
      if (stack.infrastructure && !mergedStack.infrastructure) mergedStack.infrastructure = stack.infrastructure;
      if (stack.additionalTech) {
        additionalTech.push(...stack.additionalTech);
      }
    }

    // Unique additional tech
    mergedStack.additionalTech = [...new Set(additionalTech)];

    // Get recommended specialists
    const specialists = specialistManager.getActiveSpecialists({
      stack: mergedStack,
      standard: {
        contextManager: true,
        taskDecomposition: true,
        codeArchitect: true,
        debugger: true,
        testEngineer: true,
        securityAuditor: true,
        gitFlowManager: true,
      },
      domainSpecialists: [],
    }, 'developer');

    // Update project settings with detected stack
    const currentSettings = project.settings || {};
    const updatedSettings = {
      ...currentSettings,
      specialists: {
        ...currentSettings.specialists,
        stack: mergedStack,
        standard: {
          contextManager: true,
          taskDecomposition: true,
          codeArchitect: true,
          debugger: true,
          testEngineer: true,
          securityAuditor: true,
          gitFlowManager: true,
        },
      },
    };

    await ProjectRepository.updateSettings(projectId, updatedSettings);

    console.log(`[Projects] Updated project ${projectId} with detected stack:`, mergedStack);

    res.json({
      success: true,
      data: {
        stack: mergedStack,
        specialists,
        summary: buildStackSummary(mergedStack),
        detectedFromRepos: detectedStacks.map(d => ({ name: d.repoName, summary: d.summary })),
      },
    });
  } catch (error: any) {
    console.error('[Projects] Error auto-detecting stack:', error);
    res.status(500).json({ success: false, error: 'Failed to auto-detect stack' });
  }
});

/**
 * Build a human-readable stack summary
 */
function buildStackSummary(stack: any): string {
  const parts: string[] = [];

  if (stack.frontend) parts.push(`Frontend: ${stack.frontend}`);
  if (stack.backend) parts.push(`Backend: ${stack.backend}`);
  if (stack.database) parts.push(`Database: ${stack.database}`);
  if (stack.infrastructure) parts.push(`Infrastructure: ${stack.infrastructure}`);
  if (stack.additionalTech?.length > 0) {
    parts.push(`Additional: ${stack.additionalTech.join(', ')}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'No specific stack detected';
}

/**
 * GET /api/projects/specialists
 * Get all available specialists organized by category
 */
router.get('/specialists', (_req: Request, res: Response) => {
  const categories = specialistManager.getSpecialistsByCategory();

  res.json({
    success: true,
    data: {
      categories: {
        standard: categories.standard.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
        frontend: categories.frontend.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          stack: s.activationConditions?.stacks?.[0],
        })),
        backend: categories.backend.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          stack: s.activationConditions?.stacks?.[0],
        })),
        database: categories.database.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          stack: s.activationConditions?.stacks?.[0],
        })),
        infrastructure: categories.infrastructure.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          stack: s.activationConditions?.stacks?.[0],
        })),
        domain: categories.domain.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
      },
    },
  });
});

/**
 * POST /api/projects/specialists/contextual
 * Get contextually relevant specialists based on task content
 * Analyzes task description and returns prioritized specialists
 */
router.post('/specialists/contextual', async (req: Request, res: Response) => {
  const { taskContent, projectId, maxSpecialists = 5, phase = 'developer' } = req.body;

  if (!taskContent) {
    return res.status(400).json({
      success: false,
      error: 'taskContent is required'
    });
  }

  try {
    // Get project's specialist config if projectId provided
    let specialistsConfig = specialistManager.getDefaultConfig();

    if (projectId) {
      const project = await ProjectRepository.findById(projectId);
      if (project?.settings?.specialists) {
        specialistsConfig = project.settings.specialists;
      }
    }

    // Get contextual matches
    const contextualMatches = specialistManager.getContextualSpecialists(
      taskContent,
      specialistsConfig,
      { maxSpecialists, phase }
    );

    // Build full context for the matched specialists
    const fullContext = specialistManager.buildContextualContext(
      taskContent,
      specialistsConfig,
      phase
    );

    res.json({
      success: true,
      data: {
        contextualMatches,
        activeSpecialists: fullContext.activeSpecialists,
        recommendedModelTier: fullContext.recommendedModelTier,
        stackGuidelines: fullContext.stackGuidelines,
      }
    });
  } catch (error: any) {
    console.error('[Projects] Error getting contextual specialists:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get contextual specialists'
    });
  }
});

export default router;

/**
 * Get project by ID (for other modules)
 */
export async function getProject(projectId: string): Promise<IProject | undefined> {
  return await ProjectRepository.findById(projectId) || undefined;
}

/**
 * Get project's LLM config for OpenCode
 * Supports per-phase configuration
 *
 * @param projectId - Project ID
 * @param phase - Optional phase to get specific config for
 * @returns { providerID, modelID, apiKey? }
 */
export async function getProjectLLMConfig(
  projectId: string,
  phase?: PhaseType
): Promise<{
  providerID: string;
  modelID: string;
  apiKey?: string;
}> {
  const project = await ProjectRepository.findById(projectId, true); // include API key

  if (!project) {
    // Return default if project not found
    return {
      providerID: 'dgx-spark',
      modelID: 'kimi-dev-72b',
    };
  }

  // Get stored config or default
  let llmConfig = project.settings?.llm;

  // Handle legacy format (direct provider/model instead of default.provider/model)
  if (llmConfig && 'provider' in llmConfig && !('default' in llmConfig)) {
    llmConfig = migrateLegacyConfig(llmConfig as any);
  }

  if (!llmConfig) {
    llmConfig = getDefaultLLMConfig();
  }

  // Get config for specific phase (or default)
  const config = phase ? getPhaseConfig(llmConfig, phase) : llmConfig.default;

  return {
    providerID: toOpenCodeProvider(config.provider as LLMProviderType),
    modelID: config.model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
}

/**
 * Get full project LLM configuration (for phases that need all info)
 */
export async function getFullProjectLLMConfig(projectId: string): Promise<ProjectLLMConfig> {
  const project = await ProjectRepository.findById(projectId, true);

  if (!project) {
    return getDefaultLLMConfig();
  }

  let llmConfig = project.settings?.llm;

  // Handle legacy format
  if (llmConfig && 'provider' in llmConfig && !('default' in llmConfig)) {
    llmConfig = migrateLegacyConfig(llmConfig as any);
  }

  return llmConfig || getDefaultLLMConfig();
}
