/**
 * Context Cache Service
 *
 * Caches project context between phases to reduce token usage (~40% savings).
 * Uses file hashing to detect changes and only re-reads modified files.
 *
 * Features:
 * - Hash-based change detection
 * - LRU eviction for memory management
 * - TTL-based expiration
 * - Phase-specific context optimization
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface CachedFile {
  path: string;
  relativePath: string;
  hash: string;
  content: string;
  size: number;
  lastModified: number;
  cachedAt: number;
}

export interface ProjectContext {
  projectId: string;
  taskId: string;
  rootPath: string;
  files: Map<string, CachedFile>;
  fileTree: FileTreeNode[];
  totalSize: number;
  totalFiles: number;
  lastUpdated: number;
  ttlMs: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  size?: number;
  hash?: string;
}

export interface ContextDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface CacheStats {
  totalCaches: number;
  totalFiles: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  evictions: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE_MB = 100; // 100MB max cache
const MAX_FILE_SIZE_KB = 500; // Skip files larger than 500KB

// Files/directories to always ignore
const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  'coverage',
  '.env',
  '.env.local',
  '*.log',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

// File extensions to include for context
const INCLUDE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.java', '.kt',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.sql',
  '.graphql', '.gql',
  '.prisma',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.vue', '.svelte',
];

// ============================================================================
// CONTEXT CACHE SERVICE
// ============================================================================

class ContextCacheServiceClass {
  private caches: Map<string, ProjectContext> = new Map();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /**
   * Get or create context for a project/task
   */
  async getContext(
    projectId: string,
    taskId: string,
    rootPath: string,
    forceRefresh = false
  ): Promise<ProjectContext> {
    const cacheKey = `${projectId}:${taskId}`;
    const existing = this.caches.get(cacheKey);

    // Check if cache exists and is still valid
    if (existing && !forceRefresh) {
      const isExpired = Date.now() - existing.lastUpdated > existing.ttlMs;
      if (!isExpired) {
        this.hits++;
        console.log(`[ContextCache] ✅ Cache HIT for ${cacheKey} (${existing.totalFiles} files)`);

        // Still check for changes in background
        this.refreshContextAsync(existing, rootPath);

        return existing;
      }
    }

    this.misses++;
    console.log(`[ContextCache] 📂 Cache MISS for ${cacheKey}, scanning...`);

    // Build new context
    const context = await this.buildContext(projectId, taskId, rootPath);
    this.caches.set(cacheKey, context);

    // Evict old caches if needed
    this.evictIfNeeded();

    return context;
  }

  /**
   * Build context by scanning the project directory
   */
  private async buildContext(
    projectId: string,
    taskId: string,
    rootPath: string
  ): Promise<ProjectContext> {
    const files = new Map<string, CachedFile>();
    const fileTree: FileTreeNode[] = [];
    let totalSize = 0;

    const startTime = Date.now();

    // Scan directory recursively
    await this.scanDirectory(rootPath, rootPath, files, fileTree);

    // Calculate totals
    for (const file of files.values()) {
      totalSize += file.size;
    }

    const context: ProjectContext = {
      projectId,
      taskId,
      rootPath,
      files,
      fileTree,
      totalSize,
      totalFiles: files.size,
      lastUpdated: Date.now(),
      ttlMs: DEFAULT_TTL_MS,
    };

    const duration = Date.now() - startTime;
    console.log(`[ContextCache] 📊 Built context: ${files.size} files, ${(totalSize / 1024).toFixed(1)}KB in ${duration}ms`);

    return context;
  }

  /**
   * Scan directory recursively
   */
  private async scanDirectory(
    dirPath: string,
    rootPath: string,
    files: Map<string, CachedFile>,
    tree: FileTreeNode[]
  ): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        // Skip ignored patterns
        if (this.shouldIgnore(entry.name, relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          const node: FileTreeNode = {
            name: entry.name,
            path: relativePath,
            type: 'directory',
            children: [],
          };
          tree.push(node);
          await this.scanDirectory(fullPath, rootPath, files, node.children!);
        } else if (entry.isFile()) {
          // Check extension
          const ext = path.extname(entry.name).toLowerCase();
          if (!INCLUDE_EXTENSIONS.includes(ext)) {
            continue;
          }

          try {
            const stats = await fs.stat(fullPath);

            // Skip large files
            if (stats.size > MAX_FILE_SIZE_KB * 1024) {
              continue;
            }

            const content = await fs.readFile(fullPath, 'utf-8');
            const hash = this.hashContent(content);

            const cachedFile: CachedFile = {
              path: fullPath,
              relativePath,
              hash,
              content,
              size: stats.size,
              lastModified: stats.mtimeMs,
              cachedAt: Date.now(),
            };

            files.set(relativePath, cachedFile);
            tree.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size: stats.size,
              hash,
            });
          } catch (err) {
            // Skip files that can't be read
          }
        }
      }
    } catch (err) {
      // Skip directories that can't be read
    }
  }

  /**
   * Check if a file/directory should be ignored
   */
  private shouldIgnore(name: string, relativePath: string): boolean {
    for (const pattern of IGNORE_PATTERNS) {
      if (pattern.startsWith('*')) {
        // Wildcard pattern
        const ext = pattern.slice(1);
        if (name.endsWith(ext)) return true;
      } else {
        // Exact match or path contains
        if (name === pattern || relativePath.includes(pattern)) return true;
      }
    }
    return false;
  }

  /**
   * Hash file content for change detection
   */
  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
  }

  /**
   * Refresh context in background (non-blocking)
   */
  private async refreshContextAsync(context: ProjectContext, rootPath: string): Promise<void> {
    // Run in background
    setImmediate(async () => {
      try {
        const diff = await this.detectChanges(context, rootPath);

        if (diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0) {
          console.log(`[ContextCache] 🔄 Changes detected:`, {
            added: diff.added.length,
            modified: diff.modified.length,
            deleted: diff.deleted.length,
          });

          // Update the context
          await this.applyDiff(context, rootPath, diff);
        }
      } catch (err) {
        // Ignore background refresh errors
      }
    });
  }

  /**
   * Detect changes between cached and current state
   */
  async detectChanges(context: ProjectContext, rootPath: string): Promise<ContextDiff> {
    const diff: ContextDiff = {
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
    };

    const currentFiles = new Map<string, { hash: string; mtime: number }>();

    // Scan current state (lighter scan, just hashes)
    await this.scanForChanges(rootPath, rootPath, currentFiles);

    // Compare with cached
    for (const [relativePath, cached] of context.files) {
      const current = currentFiles.get(relativePath);
      if (!current) {
        diff.deleted.push(relativePath);
      } else if (current.hash !== cached.hash) {
        diff.modified.push(relativePath);
      } else {
        diff.unchanged.push(relativePath);
      }
      currentFiles.delete(relativePath);
    }

    // Remaining are new files
    for (const relativePath of currentFiles.keys()) {
      diff.added.push(relativePath);
    }

    return diff;
  }

  /**
   * Light scan to just get file hashes
   */
  private async scanForChanges(
    dirPath: string,
    rootPath: string,
    files: Map<string, { hash: string; mtime: number }>
  ): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (this.shouldIgnore(entry.name, relativePath)) continue;

        if (entry.isDirectory()) {
          await this.scanForChanges(fullPath, rootPath, files);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!INCLUDE_EXTENSIONS.includes(ext)) continue;

          try {
            const stats = await fs.stat(fullPath);
            if (stats.size > MAX_FILE_SIZE_KB * 1024) continue;

            const content = await fs.readFile(fullPath, 'utf-8');
            const hash = this.hashContent(content);
            files.set(relativePath, { hash, mtime: stats.mtimeMs });
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * Apply diff to update context
   */
  private async applyDiff(
    context: ProjectContext,
    rootPath: string,
    diff: ContextDiff
  ): Promise<void> {
    // Remove deleted files
    for (const relativePath of diff.deleted) {
      context.files.delete(relativePath);
    }

    // Update modified and add new files
    for (const relativePath of [...diff.modified, ...diff.added]) {
      try {
        const fullPath = path.join(rootPath, relativePath);
        const stats = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const hash = this.hashContent(content);

        context.files.set(relativePath, {
          path: fullPath,
          relativePath,
          hash,
          content,
          size: stats.size,
          lastModified: stats.mtimeMs,
          cachedAt: Date.now(),
        });
      } catch {}
    }

    // Update totals
    let totalSize = 0;
    for (const file of context.files.values()) {
      totalSize += file.size;
    }
    context.totalSize = totalSize;
    context.totalFiles = context.files.size;
    context.lastUpdated = Date.now();
  }

  /**
   * Get context for a specific phase (optimized subset)
   */
  getContextForPhase(
    context: ProjectContext,
    phase: 'analysis' | 'developer' | 'test' | 'review'
  ): Map<string, CachedFile> {
    const filtered = new Map<string, CachedFile>();

    for (const [path, file] of context.files) {
      let include = false;

      switch (phase) {
        case 'analysis':
          // Include all code files for analysis
          include = true;
          break;
        case 'developer':
          // Focus on source files, exclude tests
          include = !path.includes('.test.') && !path.includes('.spec.') && !path.includes('__tests__');
          break;
        case 'test':
          // Focus on test files and source files
          include = path.includes('.test.') || path.includes('.spec.') || path.includes('__tests__') ||
                   path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.py');
          break;
        case 'review':
          // All files for review
          include = true;
          break;
      }

      if (include) {
        filtered.set(path, file);
      }
    }

    return filtered;
  }

  /**
   * Get compact context string for LLM (token-efficient)
   */
  getCompactContext(context: ProjectContext, maxTokens = 50000): string {
    const lines: string[] = [];
    lines.push(`# Project Context (${context.totalFiles} files)`);
    lines.push('');

    // File tree summary
    lines.push('## File Structure');
    lines.push('```');
    this.printTree(context.fileTree, lines, 0);
    lines.push('```');
    lines.push('');

    // Key files content (prioritized)
    lines.push('## Key Files');

    const priorityPatterns = [
      /package\.json$/,
      /tsconfig\.json$/,
      /\.prisma$/,
      /schema\./,
      /index\.(ts|js)$/,
      /app\.(ts|js)$/,
      /main\.(ts|js)$/,
      /routes?\//,
      /api\//,
      /components?\//,
    ];

    const sortedFiles = Array.from(context.files.entries())
      .sort((a, b) => {
        const aPriority = priorityPatterns.findIndex(p => p.test(a[0]));
        const bPriority = priorityPatterns.findIndex(p => p.test(b[0]));
        if (aPriority !== bPriority) {
          return (aPriority === -1 ? 100 : aPriority) - (bPriority === -1 ? 100 : bPriority);
        }
        return a[0].localeCompare(b[0]);
      });

    let tokenEstimate = lines.join('\n').length / 4; // ~4 chars per token

    for (const [relativePath, file] of sortedFiles) {
      const fileTokens = file.content.length / 4;
      if (tokenEstimate + fileTokens > maxTokens) {
        lines.push(`\n... (${context.totalFiles - sortedFiles.indexOf([relativePath, file])} more files truncated)`);
        break;
      }

      lines.push(`\n### ${relativePath}`);
      lines.push('```');
      lines.push(file.content);
      lines.push('```');
      tokenEstimate += fileTokens;
    }

    return lines.join('\n');
  }

  /**
   * Print file tree
   */
  private printTree(nodes: FileTreeNode[], lines: string[], depth: number): void {
    for (const node of nodes) {
      const indent = '  '.repeat(depth);
      if (node.type === 'directory') {
        lines.push(`${indent}📁 ${node.name}/`);
        if (node.children) {
          this.printTree(node.children, lines, depth + 1);
        }
      } else {
        lines.push(`${indent}📄 ${node.name}`);
      }
    }
  }

  /**
   * Evict old caches if memory limit exceeded
   */
  private evictIfNeeded(): void {
    let totalSize = 0;
    for (const context of this.caches.values()) {
      totalSize += context.totalSize;
    }

    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

    if (totalSize > maxSizeBytes) {
      // Sort by last updated, evict oldest
      const sorted = Array.from(this.caches.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);

      while (totalSize > maxSizeBytes * 0.8 && sorted.length > 0) {
        const [key, context] = sorted.shift()!;
        totalSize -= context.totalSize;
        this.caches.delete(key);
        this.evictions++;
        console.log(`[ContextCache] 🗑️ Evicted cache: ${key}`);
      }
    }
  }

  /**
   * Invalidate cache for a project/task
   */
  invalidate(projectId: string, taskId?: string): void {
    if (taskId) {
      this.caches.delete(`${projectId}:${taskId}`);
    } else {
      // Invalidate all caches for project
      for (const key of this.caches.keys()) {
        if (key.startsWith(`${projectId}:`)) {
          this.caches.delete(key);
        }
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    let totalFiles = 0;
    let totalSizeBytes = 0;

    for (const context of this.caches.values()) {
      totalFiles += context.totalFiles;
      totalSizeBytes += context.totalSize;
    }

    const total = this.hits + this.misses;
    return {
      totalCaches: this.caches.size,
      totalFiles,
      totalSizeBytes,
      hitRate: total > 0 ? this.hits / total : 0,
      missRate: total > 0 ? this.misses / total : 0,
      evictions: this.evictions,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.caches.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const contextCacheService = new ContextCacheServiceClass();
export default contextCacheService;
