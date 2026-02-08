/**
 * Repository Repository
 *
 * Database operations for git repositories (PostgreSQL)
 * Matches agents-software-arq schema (sin workspaceId - es por task)
 */

import { postgresService } from '../postgres/PostgresService.js';
import { CryptoService } from '../../services/security/CryptoService.js';

// Generate unique IDs
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

export interface IEnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
  description?: string;
}

export interface IRepository {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  githubRepoUrl: string;
  githubRepoName: string;
  githubBranch: string;
  type: 'backend' | 'frontend' | 'mobile' | 'shared';
  pathPatterns: string[];
  executionOrder?: number;
  dependencies?: string[];
  envVariables: IEnvVariable[];
  isActive: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface RepositoryRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string;
  github_repo_url: string;
  github_repo_name: string;
  github_branch: string;
  type: string;
  path_patterns: string[] | null;
  execution_order: number | null;
  dependencies: string[] | null;
  env_variables: IEnvVariable[] | null;
  is_active: boolean;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRepository(row: RepositoryRow): IRepository {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    projectId: row.project_id,
    githubRepoUrl: row.github_repo_url,
    githubRepoName: row.github_repo_name,
    githubBranch: row.github_branch,
    type: row.type as 'backend' | 'frontend' | 'mobile' | 'shared',
    pathPatterns: row.path_patterns || [],
    executionOrder: row.execution_order || undefined,
    dependencies: row.dependencies || undefined,
    envVariables: row.env_variables || [],
    isActive: row.is_active,
    lastSyncedAt: row.last_synced_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate default pathPatterns and executionOrder based on repository type
 */
function getRepositoryConfig(type: 'backend' | 'frontend' | 'mobile' | 'shared', repoName: string) {
  const config = {
    backend: {
      pathPatterns: [
        'backend/**/*',
        'src/models/**/*',
        'src/routes/**/*',
        'src/services/**/*',
        'src/middleware/**/*',
        'src/utils/**/*',
        'src/app.js',
        'src/app.ts',
        'server.js',
        'server.ts',
      ],
      executionOrder: 1,
    },
    frontend: {
      pathPatterns: [
        `${repoName}/**/*`,
        'src/components/**/*',
        'src/views/**/*',
        'src/pages/**/*',
        'src/hooks/**/*',
        'src/contexts/**/*',
        'src/services/**/*',
        'src/styles/**/*',
        'public/**/*',
      ],
      executionOrder: 2,
    },
    mobile: {
      pathPatterns: [
        `${repoName}/**/*`,
        'src/**/*',
        'ios/**/*',
        'android/**/*',
      ],
      executionOrder: 3,
    },
    shared: {
      pathPatterns: [
        'shared/**/*',
        'lib/**/*',
        'types/**/*',
        'common/**/*',
      ],
      executionOrder: 0,
    },
  };

  return config[type] || config.backend;
}

export class RepositoryRepository {
  /**
   * Find repository by ID
   */
  static async findById(id: string): Promise<IRepository | null> {
    const result = await postgresService.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? rowToRepository(row) : null;
  }

  /**
   * Find repositories by project ID
   */
  static async findByProjectId(projectId: string): Promise<IRepository[]> {
    const result = await postgresService.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE project_id = $1 AND is_active = true ORDER BY execution_order, created_at',
      [projectId]
    );
    return result.rows.map(rowToRepository);
  }

  /**
   * Find repository by GitHub repo name within a project
   */
  static async findByGithubRepoName(projectId: string, githubRepoName: string): Promise<IRepository | null> {
    const result = await postgresService.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE project_id = $1 AND github_repo_name = $2',
      [projectId, githubRepoName]
    );
    const row = result.rows[0];
    return row ? rowToRepository(row) : null;
  }

  /**
   * Create a new repository
   */
  static async create(data: {
    name: string;
    description?: string;
    projectId: string;
    githubRepoUrl: string;
    githubRepoName: string;
    githubBranch?: string;
    type: 'backend' | 'frontend' | 'mobile' | 'shared';
    pathPatterns?: string[];
    executionOrder?: number;
    dependencies?: string[];
    envVariables?: IEnvVariable[];
  }): Promise<IRepository> {
    const id = generateId();

    // Get default config if not provided
    const defaultConfig = getRepositoryConfig(data.type, data.name);
    const pathPatterns = data.pathPatterns || defaultConfig.pathPatterns;
    const executionOrder = data.executionOrder ?? defaultConfig.executionOrder;

    await postgresService.query(
      `INSERT INTO repositories (
        id, name, description, project_id,
        github_repo_url, github_repo_name, github_branch,
        type, path_patterns, execution_order, dependencies, env_variables,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        data.name,
        data.description || null,
        data.projectId,
        data.githubRepoUrl,
        data.githubRepoName,
        data.githubBranch || 'main',
        data.type,
        JSON.stringify(pathPatterns),
        executionOrder,
        JSON.stringify(data.dependencies || []),
        JSON.stringify(data.envVariables || []),
        true,
      ]
    );

    const repo = await this.findById(id);
    return repo!;
  }

  /**
   * Update repository
   */
  static async update(id: string, data: Partial<{
    name: string;
    description: string;
    githubRepoUrl: string;
    githubRepoName: string;
    githubBranch: string;
    type: 'backend' | 'frontend' | 'mobile' | 'shared';
    pathPatterns: string[];
    executionOrder: number;
    dependencies: string[];
    envVariables: IEnvVariable[];
    isActive: boolean;
    lastSyncedAt: Date;
  }>): Promise<IRepository | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    await postgresService.query(
      `UPDATE repositories SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        github_repo_url = COALESCE($3, github_repo_url),
        github_repo_name = COALESCE($4, github_repo_name),
        github_branch = COALESCE($5, github_branch),
        type = COALESCE($6, type),
        path_patterns = COALESCE($7, path_patterns),
        execution_order = COALESCE($8, execution_order),
        dependencies = COALESCE($9, dependencies),
        env_variables = COALESCE($10, env_variables),
        is_active = COALESCE($11, is_active),
        last_synced_at = COALESCE($12, last_synced_at),
        updated_at = NOW()
      WHERE id = $13`,
      [
        data.name || null,
        data.description || null,
        data.githubRepoUrl || null,
        data.githubRepoName || null,
        data.githubBranch || null,
        data.type || null,
        data.pathPatterns ? JSON.stringify(data.pathPatterns) : null,
        data.executionOrder ?? null,
        data.dependencies ? JSON.stringify(data.dependencies) : null,
        data.envVariables ? JSON.stringify(data.envVariables) : null,
        data.isActive !== undefined ? data.isActive : null,
        data.lastSyncedAt || null,
        id,
      ]
    );

    return this.findById(id);
  }

  /**
   * Delete repository (soft delete)
   */
  static async delete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'UPDATE repositories SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Hard delete repository
   */
  static async hardDelete(id: string): Promise<boolean> {
    const result = await postgresService.query(
      'DELETE FROM repositories WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Update last synced timestamp
   */
  static async updateLastSynced(id: string): Promise<void> {
    await postgresService.query(
      'UPDATE repositories SET last_synced_at = NOW(), updated_at = NOW() WHERE id = $1',
      [id]
    );
  }

  /**
   * Count repositories by project
   */
  static async countByProject(projectId: string): Promise<number> {
    const result = await postgresService.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM repositories WHERE project_id = $1 AND is_active = true',
      [projectId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Find multiple repositories by IDs
   */
  static async findByIds(ids: string[]): Promise<IRepository[]> {
    if (ids.length === 0) return [];

    const result = await postgresService.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE id = ANY($1) AND is_active = true',
      [ids]
    );
    return result.rows.map(rowToRepository);
  }

  /**
   * Get default repository config based on type
   */
  static getDefaultConfig = getRepositoryConfig;

  /**
   * Get decrypted environment variables for a repository
   */
  static async getDecryptedEnvVariables(id: string): Promise<IEnvVariable[]> {
    const repo = await this.findById(id);
    if (!repo) return [];

    return repo.envVariables.map(envVar => {
      if (envVar.isSecret && envVar.value) {
        return { ...envVar, value: CryptoService.decrypt(envVar.value) };
      }
      return envVar;
    });
  }
}

export default RepositoryRepository;
