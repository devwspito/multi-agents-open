/**
 * Scaffolding Service - Auto-provisioning for new projects
 *
 * Inspired by Neon-instagres: Automatically provisions infrastructure
 * when users create new projects (databases, environment files, templates).
 *
 * Features:
 * - Auto-detect project type and suggest templates
 * - Provision Neon Postgres database (if needed)
 * - Generate environment files with secrets
 * - Create starter templates based on stack
 * - Initialize project structure
 */

import { EnvService, type IEnvVariable } from '../env/EnvService.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ScaffoldingOptions {
  projectId: string;
  projectType: 'web-app' | 'api' | 'fullstack' | 'mobile' | 'library' | 'cli';
  stack?: DetectedStack;
  provisionDatabase?: boolean;
  generateEnvFiles?: boolean;
  createTemplates?: boolean;
  skipInteractive?: boolean; // Skip user prompts, use defaults
}

export interface DetectedStack {
  frontend?: 'react' | 'vue' | 'angular' | 'svelte' | 'nextjs' | 'nuxt' | 'none';
  backend?: 'nodejs' | 'python' | 'go' | 'rust' | 'java' | 'none';
  database?: 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'none';
  orm?: 'prisma' | 'drizzle' | 'typeorm' | 'sequelize' | 'mongoose' | 'none';
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  infrastructure?: 'docker' | 'kubernetes' | 'serverless' | 'none';
}

export interface ScaffoldingResult {
  success: boolean;
  projectId: string;
  provisions: ProvisionedResource[];
  envVariables: IEnvVariable[];
  templates: GeneratedTemplate[];
  suggestions: ScaffoldingSuggestion[];
  errors: string[];
}

export interface ProvisionedResource {
  type: 'database' | 'storage' | 'cache' | 'queue' | 'secret';
  provider: string;
  name: string;
  connectionString?: string;
  credentials?: Record<string, string>;
  status: 'provisioned' | 'pending' | 'failed';
}

export interface GeneratedTemplate {
  path: string;
  content: string;
  description: string;
  overwrite: boolean;
}

export interface ScaffoldingSuggestion {
  category: 'infrastructure' | 'security' | 'performance' | 'devex';
  title: string;
  description: string;
  action?: string; // Slash command or action to take
  priority: 'high' | 'medium' | 'low';
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  stack: DetectedStack;
  files: GeneratedTemplate[];
  envVariables: IEnvVariable[];
}

// ============================================================================
// TEMPLATES
// ============================================================================

const TEMPLATES: Record<string, ProjectTemplate> = {
  'fullstack-nextjs': {
    id: 'fullstack-nextjs',
    name: 'Fullstack Next.js + Postgres',
    description: 'Modern fullstack app with Next.js, Prisma, and PostgreSQL',
    stack: {
      frontend: 'nextjs',
      backend: 'nodejs',
      database: 'postgres',
      orm: 'prisma',
      packageManager: 'npm',
    },
    files: [
      {
        path: '.env.example',
        content: `# Database
DATABASE_URL="postgresql://user:password@localhost:5432/mydb"

# Auth (if using NextAuth)
NEXTAUTH_SECRET="your-secret-here"
NEXTAUTH_URL="http://localhost:3000"

# API Keys
OPENAI_API_KEY=""
`,
        description: 'Environment variables template',
        overwrite: false,
      },
      {
        path: 'prisma/schema.prisma',
        content: `// Prisma Schema
// Learn more: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Add your models here
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`,
        description: 'Prisma schema with User model',
        overwrite: false,
      },
    ],
    envVariables: [
      { key: 'DATABASE_URL', value: '', isSecret: true, description: 'PostgreSQL connection string' },
      { key: 'NEXTAUTH_SECRET', value: '', isSecret: true, description: 'NextAuth encryption secret' },
    ],
  },
  'api-express': {
    id: 'api-express',
    name: 'Express.js API',
    description: 'REST API with Express, TypeScript, and PostgreSQL',
    stack: {
      frontend: 'none',
      backend: 'nodejs',
      database: 'postgres',
      orm: 'prisma',
      packageManager: 'npm',
    },
    files: [
      {
        path: '.env.example',
        content: `# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/mydb"

# JWT
JWT_SECRET="your-jwt-secret"
JWT_EXPIRES_IN="7d"

# API Keys
API_KEY=""
`,
        description: 'Environment variables template',
        overwrite: false,
      },
    ],
    envVariables: [
      { key: 'DATABASE_URL', value: '', isSecret: true, description: 'PostgreSQL connection string' },
      { key: 'JWT_SECRET', value: '', isSecret: true, description: 'JWT signing secret' },
      { key: 'PORT', value: '3000', isSecret: false, description: 'Server port' },
    ],
  },
  'react-vite': {
    id: 'react-vite',
    name: 'React + Vite',
    description: 'Modern React SPA with Vite',
    stack: {
      frontend: 'react',
      backend: 'none',
      database: 'none',
      packageManager: 'npm',
    },
    files: [
      {
        path: '.env.example',
        content: `# API
VITE_API_URL="http://localhost:3000/api"

# Feature Flags
VITE_ENABLE_ANALYTICS=false
`,
        description: 'Environment variables template',
        overwrite: false,
      },
    ],
    envVariables: [
      { key: 'VITE_API_URL', value: 'http://localhost:3000/api', isSecret: false, description: 'Backend API URL' },
    ],
  },
};

// ============================================================================
// SCAFFOLDING SERVICE
// ============================================================================

class ScaffoldingServiceClass {
  private neonApiKey?: string;
  private neonProjectId?: string;

  constructor() {
    this.neonApiKey = process.env.NEON_API_KEY;
    this.neonProjectId = process.env.NEON_PROJECT_ID;
  }

  /**
   * Main scaffolding entry point
   * Called after project creation to auto-provision resources
   */
  async scaffoldProject(options: ScaffoldingOptions): Promise<ScaffoldingResult> {
    const result: ScaffoldingResult = {
      success: true,
      projectId: options.projectId,
      provisions: [],
      envVariables: [],
      templates: [],
      suggestions: [],
      errors: [],
    };

    console.log(`[Scaffolding] 🏗️ Starting scaffolding for project ${options.projectId}`);
    console.log(`[Scaffolding] Type: ${options.projectType}, Stack:`, options.stack);

    try {
      // 1. Detect or use provided stack
      const stack = options.stack || this.detectStack(options.projectType);

      // 2. Provision database if requested and stack needs one
      if (options.provisionDatabase && stack.database && stack.database !== 'none') {
        const dbResult = await this.provisionDatabase(options.projectId, stack.database);
        if (dbResult) {
          result.provisions.push(dbResult);
          // Add database URL to env variables
          if (dbResult.connectionString) {
            result.envVariables.push({
              key: 'DATABASE_URL',
              value: dbResult.connectionString,
              isSecret: true,
              description: `${stack.database} connection string (provisioned by Neon)`,
            });
          }
        }
      }

      // 3. Generate environment files
      if (options.generateEnvFiles) {
        const template = this.getTemplateForStack(stack);
        if (template) {
          result.envVariables.push(...template.envVariables);
          result.templates.push(...template.files);
        }
      }

      // 4. Generate suggestions based on stack
      result.suggestions = this.generateSuggestions(stack, options.projectType);

      console.log(`[Scaffolding] ✅ Scaffolding complete:`, {
        provisions: result.provisions.length,
        envVariables: result.envVariables.length,
        templates: result.templates.length,
        suggestions: result.suggestions.length,
      });

    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      console.error(`[Scaffolding] ❌ Error:`, error);
    }

    return result;
  }

  /**
   * Detect stack from project type (when no files to analyze)
   */
  private detectStack(projectType: string): DetectedStack {
    const defaultStacks: Record<string, DetectedStack> = {
      'web-app': {
        frontend: 'react',
        backend: 'nodejs',
        database: 'postgres',
        orm: 'prisma',
        packageManager: 'npm',
      },
      'api': {
        frontend: 'none',
        backend: 'nodejs',
        database: 'postgres',
        orm: 'prisma',
        packageManager: 'npm',
      },
      'fullstack': {
        frontend: 'nextjs',
        backend: 'nodejs',
        database: 'postgres',
        orm: 'prisma',
        packageManager: 'npm',
      },
      'mobile': {
        frontend: 'react', // React Native
        backend: 'nodejs',
        database: 'postgres',
        packageManager: 'npm',
      },
      'library': {
        frontend: 'none',
        backend: 'nodejs',
        database: 'none',
        packageManager: 'npm',
      },
      'cli': {
        frontend: 'none',
        backend: 'nodejs',
        database: 'none',
        packageManager: 'npm',
      },
    };

    return defaultStacks[projectType] || defaultStacks['web-app'];
  }

  /**
   * Provision a Neon PostgreSQL database
   */
  async provisionDatabase(
    projectId: string,
    dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite'
  ): Promise<ProvisionedResource | null> {
    // Only Postgres via Neon is currently supported
    if (dbType !== 'postgres') {
      console.log(`[Scaffolding] Database type ${dbType} not auto-provisionable`);
      return null;
    }

    if (!this.neonApiKey) {
      console.log(`[Scaffolding] NEON_API_KEY not configured, skipping DB provisioning`);
      return {
        type: 'database',
        provider: 'neon',
        name: `db-${projectId.slice(0, 8)}`,
        status: 'pending',
      };
    }

    try {
      console.log(`[Scaffolding] 🐘 Provisioning Neon database...`);

      // Create a new Neon branch for this project
      const branchName = `project-${projectId.slice(0, 8)}`;

      // Call Neon API to create branch
      const response = await fetch(`https://console.neon.tech/api/v2/projects/${this.neonProjectId}/branches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.neonApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branch: {
            name: branchName,
          },
          endpoints: [{
            type: 'read_write',
          }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Neon API error: ${error}`);
      }

      const data = await response.json() as {
        endpoints?: Array<{ connection_uri?: string; host?: string }>;
        role?: { name?: string };
      };
      const endpoint = data.endpoints?.[0];
      const connectionUri = endpoint?.connection_uri;

      console.log(`[Scaffolding] ✅ Neon database provisioned: ${branchName}`);

      return {
        type: 'database',
        provider: 'neon',
        name: branchName,
        connectionString: connectionUri,
        credentials: {
          host: endpoint?.host || '',
          database: 'neondb',
          user: data.role?.name || 'neondb_owner',
        },
        status: 'provisioned',
      };

    } catch (error: any) {
      console.error(`[Scaffolding] ❌ Neon provisioning failed:`, error.message);
      return {
        type: 'database',
        provider: 'neon',
        name: `db-${projectId.slice(0, 8)}`,
        status: 'failed',
      };
    }
  }

  /**
   * Get template based on detected stack
   */
  private getTemplateForStack(stack: DetectedStack): ProjectTemplate | null {
    // Match template based on stack
    if (stack.frontend === 'nextjs') {
      return TEMPLATES['fullstack-nextjs'];
    }
    if (stack.frontend === 'react' && stack.backend === 'none') {
      return TEMPLATES['react-vite'];
    }
    if (stack.backend === 'nodejs' && stack.frontend === 'none') {
      return TEMPLATES['api-express'];
    }

    return null;
  }

  /**
   * Generate suggestions based on stack and project type
   */
  private generateSuggestions(stack: DetectedStack, projectType: string): ScaffoldingSuggestion[] {
    const suggestions: ScaffoldingSuggestion[] = [];

    // Database suggestions
    if (stack.database === 'postgres' && !stack.orm) {
      suggestions.push({
        category: 'devex',
        title: 'Add an ORM',
        description: 'Consider using Prisma or Drizzle for type-safe database access',
        action: '/plan Add Prisma ORM to the project',
        priority: 'medium',
      });
    }

    // Security suggestions
    suggestions.push({
      category: 'security',
      title: 'Environment Variables',
      description: 'Make sure all secrets are stored in environment variables, never committed to git',
      priority: 'high',
    });

    if (stack.backend !== 'none') {
      suggestions.push({
        category: 'security',
        title: 'Add Authentication',
        description: 'Consider adding authentication early in the development process',
        action: '/brainstorm Authentication options for the project',
        priority: 'high',
      });
    }

    // Infrastructure suggestions
    if (stack.infrastructure !== 'docker') {
      suggestions.push({
        category: 'infrastructure',
        title: 'Add Docker',
        description: 'Containerize your application for consistent development and deployment',
        action: '/plan Add Docker configuration',
        priority: 'medium',
      });
    }

    // Testing suggestions
    suggestions.push({
      category: 'devex',
      title: 'Set up Testing',
      description: 'Add unit and integration tests for better code quality',
      action: '/test Set up testing framework',
      priority: 'medium',
    });

    return suggestions;
  }

  /**
   * Generate .env file content from variables
   */
  generateEnvContent(variables: IEnvVariable[]): string {
    return EnvService.generateEnvFileContent(variables);
  }

  /**
   * Get available templates
   */
  getAvailableTemplates(): ProjectTemplate[] {
    return Object.values(TEMPLATES);
  }

  /**
   * Apply a specific template to a project
   */
  async applyTemplate(
    projectId: string,
    templateId: string,
    workspacePath: string
  ): Promise<GeneratedTemplate[]> {
    const template = TEMPLATES[templateId];
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    console.log(`[Scaffolding] Applying template ${templateId} to ${workspacePath}`);

    // In a real implementation, we'd write these files to the workspace
    // For now, we return them for the orchestrator to apply
    return template.files;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const scaffoldingService = new ScaffoldingServiceClass();
export default scaffoldingService;
