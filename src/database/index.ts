/**
 * Database Layer for Open Multi-Agents
 *
 * PostgreSQL database for:
 * - User authentication & GitHub tokens
 * - Projects & repositories
 * - Task orchestration state
 * - Agent execution tracking (for ML training)
 * - Turn-by-turn data capture
 * - Tool call granular tracking
 */

// Re-export PostgreSQL services
export { postgresService } from './postgres/PostgresService.js';
export { initializeSchema, recoverStaleTasks } from './postgres/schema.js';

// Re-export repositories
export { UserRepository } from './repositories/UserRepository.js';
export { ProjectRepository } from './repositories/ProjectRepository.js';
export { RepositoryRepository } from './repositories/RepositoryRepository.js';
export { TaskRepository } from './repositories/TaskRepository.js';
export { OAuthStateRepository } from './repositories/OAuthStateRepository.js';
export { SentinentalRepository } from './repositories/SentinentalRepository.js';
export { SessionRepository } from './repositories/SessionRepository.js';

/**
 * Generate unique IDs
 */
export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Get current timestamp in ISO format
 */
export function now(): string {
  return new Date().toISOString();
}
