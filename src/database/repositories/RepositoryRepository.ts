/**
 * Repository Repository
 *
 * Database operations for git repositories (SQLite)
 * Matches agents-software-arq schema (sin workspaceId - es por task)
 */

import { db, generateId, now } from '../index.js';
import { CryptoService } from '../../services/security/CryptoService.js';

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
  path_patterns: string | null;
  execution_order: number | null;
  dependencies: string | null;
  env_variables: string | null;
  is_active: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJSON<T>(value: string | null, defaultValue: T): T {
  if (!value) return defaultValue;
  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}

function toJSON(value: any): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
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
    pathPatterns: parseJSON(row.path_patterns, []),
    executionOrder: row.execution_order || undefined,
    dependencies: parseJSON(row.dependencies, undefined),
    envVariables: parseJSON(row.env_variables, []),
    isActive: row.is_active === 1,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
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
  static findById(id: string): IRepository | null {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE id = ?`);
    const row = stmt.get(id) as RepositoryRow | undefined;
    return row ? rowToRepository(row) : null;
  }

  /**
   * Find repositories by project ID
   */
  static findByProjectId(projectId: string): IRepository[] {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE project_id = ? AND is_active = 1 ORDER BY execution_order, created_at`);
    const rows = stmt.all(projectId) as RepositoryRow[];
    return rows.map(rowToRepository);
  }

  /**
   * Find repository by GitHub repo name within a project
   */
  static findByGithubRepoName(projectId: string, githubRepoName: string): IRepository | null {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE project_id = ? AND github_repo_name = ?`);
    const row = stmt.get(projectId, githubRepoName) as RepositoryRow | undefined;
    return row ? rowToRepository(row) : null;
  }

  /**
   * Create a new repository
   */
  static create(data: {
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
  }): IRepository {
    const id = generateId();
    const timestamp = now();

    // Get default config if not provided
    const defaultConfig = getRepositoryConfig(data.type, data.name);
    const pathPatterns = data.pathPatterns || defaultConfig.pathPatterns;
    const executionOrder = data.executionOrder ?? defaultConfig.executionOrder;

    const stmt = db.prepare(`
      INSERT INTO repositories (
        id, name, description, project_id,
        github_repo_url, github_repo_name, github_branch,
        type, path_patterns, execution_order, dependencies, env_variables,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      data.description || null,
      data.projectId,
      data.githubRepoUrl,
      data.githubRepoName,
      data.githubBranch || 'main',
      data.type,
      toJSON(pathPatterns),
      executionOrder,
      toJSON(data.dependencies || []),
      toJSON(data.envVariables || []),
      1,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Update repository
   */
  static update(id: string, data: Partial<{
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
  }>): IRepository | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const stmt = db.prepare(`
      UPDATE repositories SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        github_repo_url = COALESCE(?, github_repo_url),
        github_repo_name = COALESCE(?, github_repo_name),
        github_branch = COALESCE(?, github_branch),
        type = COALESCE(?, type),
        path_patterns = COALESCE(?, path_patterns),
        execution_order = COALESCE(?, execution_order),
        dependencies = COALESCE(?, dependencies),
        env_variables = COALESCE(?, env_variables),
        is_active = COALESCE(?, is_active),
        last_synced_at = COALESCE(?, last_synced_at),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.name || null,
      data.description || null,
      data.githubRepoUrl || null,
      data.githubRepoName || null,
      data.githubBranch || null,
      data.type || null,
      data.pathPatterns ? toJSON(data.pathPatterns) : null,
      data.executionOrder ?? null,
      data.dependencies ? toJSON(data.dependencies) : null,
      data.envVariables ? toJSON(data.envVariables) : null,
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
      data.lastSyncedAt ? data.lastSyncedAt.toISOString() : null,
      now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Delete repository (soft delete)
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`UPDATE repositories SET is_active = 0, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Hard delete repository
   */
  static hardDelete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM repositories WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Update last synced timestamp
   */
  static updateLastSynced(id: string): void {
    const stmt = db.prepare(`UPDATE repositories SET last_synced_at = ?, updated_at = ? WHERE id = ?`);
    const timestamp = now();
    stmt.run(timestamp, timestamp, id);
  }

  /**
   * Count repositories by project
   */
  static countByProject(projectId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM repositories WHERE project_id = ? AND is_active = 1`);
    const row = stmt.get(projectId) as { count: number };
    return row.count;
  }

  /**
   * Find multiple repositories by IDs
   */
  static findByIds(ids: string[]): IRepository[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM repositories WHERE id IN (${placeholders}) AND is_active = 1`);
    const rows = stmt.all(...ids) as RepositoryRow[];
    return rows.map(rowToRepository);
  }

  /**
   * Get default repository config based on type
   */
  static getDefaultConfig = getRepositoryConfig;

  /**
   * Get decrypted environment variables for a repository
   */
  static getDecryptedEnvVariables(id: string): IEnvVariable[] {
    const repo = this.findById(id);
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
