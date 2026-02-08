/**
 * Specialist Manager
 *
 * Manages specialist activation and prompt generation.
 * Builds context from project configuration to enhance prompts.
 */

import {
  type SpecialistType,
  type SpecialistDefinition,
  type SpecialistContext,
  type ProjectSpecialistsConfig,
  type StackConfig,
  type StandardSpecialist,
  type TechSpecialist,
  DEFAULT_SPECIALISTS_CONFIG,
} from './types.js';
import { SPECIALIST_REGISTRY } from './prompts.js';

// Stack to specialist mapping
const STACK_TO_SPECIALIST: Record<string, TechSpecialist> = {
  // Frontend
  react: 'react-expert',
  vue: 'vue-expert',
  angular: 'angular-expert',
  nextjs: 'nextjs-architect',
  svelte: 'svelte-expert',
  // Backend
  nodejs: 'nodejs-pro',
  python: 'python-pro',
  go: 'go-expert',
  java: 'java-specialist',
  rust: 'rust-expert',
  dotnet: 'dotnet-expert',
  // Mobile
  flutter: 'flutter-dart-expert',
  dart: 'flutter-dart-expert',
  // Database
  postgresql: 'postgresql-architect',
  mongodb: 'mongodb-expert',
  mysql: 'mysql-specialist',
  redis: 'redis-expert',
  // Infrastructure
  docker: 'docker-expert',
  kubernetes: 'kubernetes-architect',
  aws: 'aws-specialist',
  gcp: 'gcp-expert',
  azure: 'azure-specialist',
  vercel: 'nextjs-architect', // Vercel uses Next.js patterns
};

// Standard specialist to config key mapping
const STANDARD_CONFIG_MAP: Record<string, StandardSpecialist> = {
  contextManager: 'context-manager',
  taskDecomposition: 'task-decomposition',
  codeArchitect: 'code-architect',
  debugger: 'debugger',
  testEngineer: 'test-engineer',
  securityAuditor: 'security-auditor',
  gitFlowManager: 'git-flow-manager',
};

class SpecialistManagerClass {
  /**
   * Get active specialists based on project configuration
   */
  getActiveSpecialists(
    config: ProjectSpecialistsConfig,
    phase: 'analysis' | 'developer'
  ): SpecialistType[] {
    const active: SpecialistType[] = [];

    // 1. Add enabled standard specialists
    for (const [key, specialistId] of Object.entries(STANDARD_CONFIG_MAP)) {
      const configKey = key as keyof typeof config.standard;
      if (config.standard[configKey]) {
        active.push(specialistId);
      }
    }

    // 2. Add technology specialists based on stack
    const stackSpecialists = this.getStackSpecialists(config.stack);
    active.push(...stackSpecialists);

    // 3. Add domain specialists
    if (config.domainSpecialists) {
      active.push(...config.domainSpecialists);
    }

    // 4. Filter by phase (some specialists only apply to certain phases)
    return active.filter(id => {
      const spec = SPECIALIST_REGISTRY[id];
      if (!spec) return false;

      // If no phase restrictions, include
      if (!spec.activationConditions?.phases) return true;

      // Check if phase matches
      return spec.activationConditions.phases.includes(phase);
    });
  }

  /**
   * Get technology specialists based on stack configuration
   */
  private getStackSpecialists(stack: StackConfig): TechSpecialist[] {
    const specialists: TechSpecialist[] = [];

    if (stack.frontend && STACK_TO_SPECIALIST[stack.frontend]) {
      specialists.push(STACK_TO_SPECIALIST[stack.frontend]);
    }
    if (stack.backend && STACK_TO_SPECIALIST[stack.backend]) {
      specialists.push(STACK_TO_SPECIALIST[stack.backend]);
    }
    if (stack.database && STACK_TO_SPECIALIST[stack.database]) {
      specialists.push(STACK_TO_SPECIALIST[stack.database]);
    }
    if (stack.infrastructure && STACK_TO_SPECIALIST[stack.infrastructure]) {
      specialists.push(STACK_TO_SPECIALIST[stack.infrastructure]);
    }

    return specialists;
  }

  /**
   * Build specialist context for prompt generation
   */
  buildContext(
    config: ProjectSpecialistsConfig,
    phase: 'analysis' | 'developer'
  ): SpecialistContext {
    const activeSpecialists = this.getActiveSpecialists(config, phase);

    // Build persona prompt
    const personaParts: string[] = [];
    const instructionParts: string[] = [];
    let lowestTier: 1 | 2 | 3 = 3;

    for (const id of activeSpecialists) {
      const spec = SPECIALIST_REGISTRY[id];
      if (!spec) continue;

      // Add persona
      if (spec.persona) {
        personaParts.push(spec.persona.trim());
      }

      // Add phase-specific instructions
      const instructions = spec.instructions?.[phase];
      if (instructions) {
        instructionParts.push(instructions.trim());
      }

      // Track lowest (best) model tier
      if (spec.modelTier && spec.modelTier < lowestTier) {
        lowestTier = spec.modelTier;
      }
    }

    // Build stack-specific guidelines
    const stackGuidelines = this.buildStackGuidelines(config.stack);

    return {
      personaPrompt: personaParts.join('\n\n'),
      instructionsPrompt: instructionParts.join('\n\n'),
      activeSpecialists,
      stackGuidelines,
      recommendedModelTier: lowestTier,
    };
  }

  /**
   * Build stack-specific guidelines summary
   */
  private buildStackGuidelines(stack: StackConfig): string {
    const parts: string[] = [];

    if (stack.frontend) {
      parts.push(`Frontend: ${stack.frontend.toUpperCase()}`);
    }
    if (stack.backend) {
      parts.push(`Backend: ${stack.backend.toUpperCase()}`);
    }
    if (stack.database) {
      parts.push(`Database: ${stack.database.toUpperCase()}`);
    }
    if (stack.infrastructure) {
      parts.push(`Infrastructure: ${stack.infrastructure.toUpperCase()}`);
    }
    if (stack.additionalTech && stack.additionalTech.length > 0) {
      parts.push(`Additional: ${stack.additionalTech.join(', ')}`);
    }

    if (parts.length === 0) {
      return '';
    }

    return `## Project Stack\n${parts.map(p => `- ${p}`).join('\n')}`;
  }

  /**
   * Get a specific specialist definition
   */
  getSpecialist(id: SpecialistType): SpecialistDefinition | undefined {
    return SPECIALIST_REGISTRY[id];
  }

  /**
   * Get all available specialists
   */
  getAllSpecialists(): SpecialistDefinition[] {
    return Object.values(SPECIALIST_REGISTRY);
  }

  /**
   * Get specialists by category
   */
  getSpecialistsByCategory(): {
    standard: SpecialistDefinition[];
    frontend: SpecialistDefinition[];
    backend: SpecialistDefinition[];
    database: SpecialistDefinition[];
    infrastructure: SpecialistDefinition[];
    domain: SpecialistDefinition[];
  } {
    const all = this.getAllSpecialists();

    return {
      standard: all.filter(s =>
        ['context-manager', 'task-decomposition', 'code-architect', 'debugger',
         'test-engineer', 'security-auditor', 'git-flow-manager'].includes(s.id)
      ),
      frontend: all.filter(s =>
        ['react-expert', 'vue-expert', 'angular-expert', 'nextjs-architect', 'svelte-expert'].includes(s.id)
      ),
      backend: all.filter(s =>
        ['nodejs-pro', 'python-pro', 'go-expert', 'java-specialist', 'rust-expert', 'dotnet-expert'].includes(s.id)
      ),
      database: all.filter(s =>
        ['postgresql-architect', 'mongodb-expert', 'mysql-specialist', 'redis-expert'].includes(s.id)
      ),
      infrastructure: all.filter(s =>
        ['docker-expert', 'kubernetes-architect', 'aws-specialist', 'gcp-expert', 'azure-specialist'].includes(s.id)
      ),
      domain: all.filter(s =>
        ['ui-ux-designer', 'api-designer', 'performance-optimizer', 'accessibility-expert', 'fullstack-developer'].includes(s.id)
      ),
    };
  }

  /**
   * Enhance a base prompt with specialist context
   */
  enhancePrompt(
    basePrompt: string,
    context: SpecialistContext,
    options: {
      includePersona?: boolean;
      includeInstructions?: boolean;
      includeStackGuidelines?: boolean;
    } = {}
  ): string {
    const {
      includePersona = true,
      includeInstructions = true,
      includeStackGuidelines = true,
    } = options;

    const parts: string[] = [];

    // Add persona at the beginning
    if (includePersona && context.personaPrompt) {
      parts.push('# Your Expert Identity\n' + context.personaPrompt);
    }

    // Add stack guidelines
    if (includeStackGuidelines && context.stackGuidelines) {
      parts.push(context.stackGuidelines);
    }

    // Add the base prompt
    parts.push(basePrompt);

    // Add instructions at the end
    if (includeInstructions && context.instructionsPrompt) {
      parts.push('# Specialist Guidelines\n' + context.instructionsPrompt);
    }

    return parts.join('\n\n');
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(): ProjectSpecialistsConfig {
    return { ...DEFAULT_SPECIALISTS_CONFIG };
  }

  /**
   * Auto-detect stack from project files (comprehensive heuristics)
   */
  async detectStack(projectPath: string): Promise<StackConfig> {
    const stack: StackConfig = {};
    const additionalTech: string[] = [];

    try {
      const { readdir, readFile, stat } = await import('fs/promises');
      const { join } = await import('path');

      const files: string[] = await readdir(projectPath).catch(() => [] as string[]);
      const fileSet = new Set(files.map(f => f.toLowerCase()));

      // Check package.json for JS/TS projects
      if (files.includes('package.json')) {
        try {
          const pkgPath = join(projectPath, 'package.json');
          const pkgContent = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(pkgContent);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          const depKeys = Object.keys(deps);

          // === FRONTEND DETECTION ===
          if (deps['next']) {
            stack.frontend = 'nextjs';
          } else if (deps['@angular/core']) {
            stack.frontend = 'angular';
          } else if (deps['vue']) {
            stack.frontend = 'vue';
          } else if (deps['svelte'] || deps['@sveltejs/kit']) {
            stack.frontend = 'svelte';
          } else if (deps['react'] || deps['react-dom']) {
            stack.frontend = 'react';
          }

          // === BACKEND DETECTION (Node.js frameworks) ===
          if (deps['express'] || deps['fastify'] || deps['koa'] || deps['hono'] ||
              deps['@nestjs/core'] || deps['@hapi/hapi'] || deps['restify']) {
            stack.backend = 'nodejs';
          }

          // === DATABASE DETECTION ===
          // PostgreSQL
          if (deps['pg'] || deps['@prisma/client'] || deps['drizzle-orm'] ||
              deps['typeorm'] || deps['sequelize'] || deps['knex']) {
            // Check Prisma schema for specific DB
            const hasPrisma = deps['@prisma/client'] || deps['prisma'];
            if (hasPrisma) {
              try {
                const prismaPath = join(projectPath, 'prisma', 'schema.prisma');
                const prismaContent = await readFile(prismaPath, 'utf-8').catch(() => '');
                if (prismaContent.includes('postgresql') || prismaContent.includes('postgres')) {
                  stack.database = 'postgresql';
                } else if (prismaContent.includes('mysql')) {
                  stack.database = 'mysql';
                } else if (prismaContent.includes('mongodb')) {
                  stack.database = 'mongodb';
                } else if (prismaContent.includes('sqlite')) {
                  stack.database = 'sqlite';
                }
              } catch {
                // Default to PostgreSQL if Prisma is present
                stack.database = 'postgresql';
              }
            } else if (deps['pg'] || deps['postgres']) {
              stack.database = 'postgresql';
            }
          }

          // MongoDB
          if (deps['mongoose'] || deps['mongodb']) {
            stack.database = 'mongodb';
          }

          // MySQL
          if (deps['mysql'] || deps['mysql2']) {
            stack.database = 'mysql';
          }

          // Redis
          if (deps['redis'] || deps['ioredis'] || deps['@upstash/redis']) {
            if (!stack.database) {
              stack.database = 'redis';
            } else {
              additionalTech.push('Redis');
            }
          }

          // === ADDITIONAL TECH ===
          if (deps['typescript']) additionalTech.push('TypeScript');
          if (deps['tailwindcss']) additionalTech.push('Tailwind CSS');
          if (deps['@trpc/server'] || deps['@trpc/client']) additionalTech.push('tRPC');
          if (deps['graphql']) additionalTech.push('GraphQL');
          if (deps['socket.io'] || deps['ws']) additionalTech.push('WebSockets');
          if (deps['jest'] || deps['vitest'] || deps['mocha']) additionalTech.push('Testing');

        } catch {
          // Ignore parse errors
        }
      }

      // === PYTHON DETECTION ===
      if (files.includes('requirements.txt') || files.includes('pyproject.toml') ||
          files.includes('setup.py') || files.includes('Pipfile')) {
        stack.backend = 'python';

        // Try to detect Python framework
        try {
          let content = '';
          if (files.includes('requirements.txt')) {
            content = await readFile(join(projectPath, 'requirements.txt'), 'utf-8');
          } else if (files.includes('pyproject.toml')) {
            content = await readFile(join(projectPath, 'pyproject.toml'), 'utf-8');
          }

          if (content.includes('fastapi')) additionalTech.push('FastAPI');
          if (content.includes('django')) additionalTech.push('Django');
          if (content.includes('flask')) additionalTech.push('Flask');
          if (content.includes('sqlalchemy')) stack.database = stack.database || 'postgresql';
          if (content.includes('pymongo') || content.includes('motor')) stack.database = 'mongodb';
          if (content.includes('psycopg')) stack.database = 'postgresql';
        } catch {
          // Ignore read errors
        }
      }

      // === GO DETECTION ===
      if (files.includes('go.mod')) {
        stack.backend = 'go';

        try {
          const goMod = await readFile(join(projectPath, 'go.mod'), 'utf-8');
          if (goMod.includes('gin-gonic')) additionalTech.push('Gin');
          if (goMod.includes('echo')) additionalTech.push('Echo');
          if (goMod.includes('fiber')) additionalTech.push('Fiber');
        } catch {
          // Ignore
        }
      }

      // === JAVA DETECTION ===
      if (files.includes('pom.xml') || files.includes('build.gradle') || files.includes('build.gradle.kts')) {
        stack.backend = 'java';
        additionalTech.push('Spring Boot'); // Assume Spring Boot for Java projects
      }

      // === RUST DETECTION ===
      if (files.includes('Cargo.toml')) {
        stack.backend = 'rust';
      }

      // === FLUTTER/DART DETECTION ===
      if (files.includes('pubspec.yaml')) {
        try {
          const pubspecContent = await readFile(join(projectPath, 'pubspec.yaml'), 'utf-8');
          if (pubspecContent.includes('flutter:') || pubspecContent.includes('sdk: flutter')) {
            stack.frontend = 'flutter' as any; // Mobile framework
            additionalTech.push('Flutter');
            if (pubspecContent.includes('riverpod')) additionalTech.push('Riverpod');
            if (pubspecContent.includes('flutter_bloc')) additionalTech.push('Bloc');
            if (pubspecContent.includes('provider:')) additionalTech.push('Provider');
          } else {
            // Pure Dart project (like Dart Frog backend)
            stack.backend = 'dart' as any;
            additionalTech.push('Dart');
          }
        } catch {
          // If we can't read pubspec, assume Flutter
          stack.frontend = 'flutter' as any;
        }
      }

      // === .NET DETECTION ===
      const hasCsproj = files.some(f => f.endsWith('.csproj'));
      const hasFsproj = files.some(f => f.endsWith('.fsproj'));
      if (hasCsproj || hasFsproj || files.includes('global.json')) {
        stack.backend = 'dotnet';
      }

      // === INFRASTRUCTURE DETECTION ===
      // Docker
      if (files.includes('Dockerfile') || files.includes('dockerfile') ||
          files.includes('docker-compose.yml') || files.includes('docker-compose.yaml') ||
          files.includes('compose.yml') || files.includes('compose.yaml')) {
        stack.infrastructure = 'docker';
      }

      // Kubernetes
      const hasK8sDir = files.includes('k8s') || files.includes('kubernetes') ||
                        files.includes('helm') || files.includes('charts');
      if (hasK8sDir) {
        stack.infrastructure = 'kubernetes';
      }

      // Vercel
      if (files.includes('vercel.json')) {
        stack.infrastructure = 'vercel';
      }

      // AWS
      if (files.includes('serverless.yml') || files.includes('serverless.yaml') ||
          files.includes('sam.yaml') || files.includes('template.yaml') ||
          files.includes('cdk.json')) {
        stack.infrastructure = 'aws';
      }

      // Set additional tech if any
      if (additionalTech.length > 0) {
        stack.additionalTech = [...new Set(additionalTech)]; // Remove duplicates
      }

    } catch (error) {
      console.warn(`[SpecialistManager] Could not detect stack: ${error}`);
    }

    return stack;
  }

  /**
   * Contextual keyword patterns for specialist matching
   */
  private readonly CONTEXTUAL_PATTERNS: Record<SpecialistType, { keywords: RegExp[]; weight: number }> = {
    // Frontend specialists
    'react-expert': {
      keywords: [/\breact\b/i, /\bcomponent/i, /\bhook/i, /\buseState\b/i, /\buseEffect\b/i, /\bjsx\b/i, /\btsx\b/i, /\.tsx?\b/],
      weight: 1.0
    },
    'vue-expert': {
      keywords: [/\bvue\b/i, /\bvuex\b/i, /\bpinia\b/i, /\bcomposition api\b/i, /\.vue\b/],
      weight: 1.0
    },
    'nextjs-architect': {
      keywords: [/\bnext\.?js\b/i, /\bserver component/i, /\bapp router\b/i, /\bgetServerSideProps\b/i, /\bgetStaticProps\b/i, /\buse server\b/i],
      weight: 1.0
    },
    'angular-expert': {
      keywords: [/\bangular\b/i, /\bngModule\b/i, /\binjectable\b/i, /\.component\.ts\b/],
      weight: 1.0
    },
    'svelte-expert': {
      keywords: [/\bsvelte\b/i, /\bsveltekit\b/i, /\.svelte\b/],
      weight: 1.0
    },

    // Backend specialists
    'nodejs-pro': {
      keywords: [/\bnode\.?js\b/i, /\bexpress\b/i, /\bfastify\b/i, /\bnestjs\b/i, /\bmiddleware\b/i, /\broute/i],
      weight: 1.0
    },
    'python-pro': {
      keywords: [/\bpython\b/i, /\bfastapi\b/i, /\bdjango\b/i, /\bflask\b/i, /\bpydantic\b/i, /\.py\b/],
      weight: 1.0
    },
    'go-expert': {
      keywords: [/\bgolang\b/i, /\bgo\s+\w+\b/i, /\bgoroutine/i, /\bchannel/i, /\.go\b/],
      weight: 1.0
    },
    'java-specialist': {
      keywords: [/\bjava\b/i, /\bspring\s*boot\b/i, /\bspring\b/i, /\bmaven\b/i, /\bgradle\b/i, /\.java\b/],
      weight: 1.0
    },
    'rust-expert': {
      keywords: [/\brust\b/i, /\bcargo\b/i, /\bownership\b/i, /\bborrow\b/i, /\.rs\b/],
      weight: 1.0
    },
    'dotnet-expert': {
      keywords: [/\.net\b/i, /\bcsharp\b/i, /\bc#\b/i, /\baspnet\b/i, /\.cs\b/],
      weight: 1.0
    },

    // Database specialists
    'postgresql-architect': {
      keywords: [/\bpostgres/i, /\bpostgresql\b/i, /\bprisma\b/i, /\bdrizzle\b/i, /\bSQL\b/, /\bmigration/i, /\bschema\b/i],
      weight: 1.0
    },
    'mongodb-expert': {
      keywords: [/\bmongodb\b/i, /\bmongoose\b/i, /\bnosql\b/i, /\baggregate/i, /\bcollection/i],
      weight: 1.0
    },
    'mysql-specialist': {
      keywords: [/\bmysql\b/i, /\bmariadb\b/i],
      weight: 1.0
    },
    'redis-expert': {
      keywords: [/\bredis\b/i, /\bcach(e|ing)\b/i, /\bpubsub\b/i],
      weight: 1.0
    },

    // Infrastructure specialists
    'docker-expert': {
      keywords: [/\bdocker\b/i, /\bcontainer/i, /\bDockerfile\b/i, /\bcompose\b/i, /\bimage\b/i],
      weight: 1.0
    },
    'kubernetes-architect': {
      keywords: [/\bkubernetes\b/i, /\bk8s\b/i, /\bhelm\b/i, /\bpod/i, /\bdeployment/i, /\bservice\b/i, /\bingress\b/i],
      weight: 1.0
    },
    'aws-specialist': {
      keywords: [/\baws\b/i, /\blambda\b/i, /\bs3\b/i, /\bec2\b/i, /\bdynamodb\b/i, /\bcognito\b/i, /\bsqs\b/i],
      weight: 1.0
    },
    'gcp-expert': {
      keywords: [/\bgcp\b/i, /\bgoogle cloud\b/i, /\bcloud run\b/i, /\bbigquery\b/i, /\bfirestore\b/i],
      weight: 1.0
    },
    'azure-specialist': {
      keywords: [/\bazure\b/i, /\bcosmosdb\b/i, /\bazure function/i],
      weight: 1.0
    },

    // Standard specialists (with task-type patterns)
    'context-manager': {
      keywords: [/\bunderstand/i, /\banalyze/i, /\bexplore/i, /\bresearch/i],
      weight: 0.5
    },
    'task-decomposition': {
      keywords: [/\bcomplex\b/i, /\bmultiple/i, /\bstep/i, /\bplan/i, /\bbreak down/i],
      weight: 0.5
    },
    'code-architect': {
      keywords: [/\barchitect/i, /\bdesign/i, /\bstructure/i, /\bpattern/i, /\brefactor/i, /\borganiz/i],
      weight: 0.8
    },
    'debugger': {
      keywords: [/\bbug\b/i, /\bdebug/i, /\bfix\b/i, /\berror\b/i, /\bissue\b/i, /\bcrash/i, /\bbroken/i, /\bnot working/i],
      weight: 0.9
    },
    'test-engineer': {
      keywords: [/\btest/i, /\bjest\b/i, /\bvitest\b/i, /\bpytest\b/i, /\bspec\b/i, /\bcoverage\b/i, /\bmock/i, /\bunit\b/i, /\bintegration\b/i, /\be2e\b/i],
      weight: 0.9
    },
    'security-auditor': {
      keywords: [/\bsecurity\b/i, /\bvulnerabil/i, /\bauth/i, /\bencrypt/i, /\binjection/i, /\bxss\b/i, /\bcsrf\b/i, /\bcors\b/i, /\bsanitiz/i],
      weight: 0.9
    },
    'git-flow-manager': {
      keywords: [/\bgit\b/i, /\bbranch/i, /\bmerge/i, /\bcommit/i, /\bpull request/i, /\bpr\b/i, /\brebase/i],
      weight: 0.7
    },

    // Domain specialists
    'ui-ux-designer': {
      keywords: [/\bui\b/i, /\bux\b/i, /\bdesign/i, /\blayout/i, /\bresponsive/i, /\bstyle/i, /\bcss\b/i, /\btailwind/i, /\bsass\b/i, /\banimation/i],
      weight: 0.8
    },
    'api-designer': {
      keywords: [/\bapi\b/i, /\brest\b/i, /\bgraphql\b/i, /\bendpoint/i, /\broute/i, /\bhttp/i, /\brequest/i, /\bresponse\b/i, /\bopenapi\b/i, /\bswagger\b/i],
      weight: 0.8
    },
    'performance-optimizer': {
      keywords: [/\bperformance\b/i, /\boptimiz/i, /\bslow\b/i, /\bfast/i, /\bspeed/i, /\bcach/i, /\blatency/i, /\bbundle/i, /\blazy/i, /\bmemoiz/i],
      weight: 0.8
    },
    'accessibility-expert': {
      keywords: [/\ba11y\b/i, /\baccessib/i, /\baria\b/i, /\bscreen reader/i, /\bwcag\b/i, /\bkeyboard/i],
      weight: 0.9
    },
    'fullstack-developer': {
      keywords: [/\bfullstack\b/i, /\bfull-stack\b/i, /\bfrontend and backend\b/i, /\bend-to-end\b/i],
      weight: 0.6
    },

    // Mobile specialists
    'flutter-dart-expert': {
      keywords: [/\bflutter\b/i, /\bdart\b/i, /\bwidget/i, /\briverpod\b/i, /\bbloc\b/i, /\bprovider\b/i, /\bpubspec\b/i, /\.dart\b/, /\bmobile app\b/i],
      weight: 1.0
    },
  };

  /**
   * Get contextually relevant specialists based on task content
   * Analyzes task description and returns prioritized specialists
   */
  getContextualSpecialists(
    taskContent: string,
    config: ProjectSpecialistsConfig,
    options: {
      maxSpecialists?: number;
      minScore?: number;
      phase?: 'analysis' | 'developer';
    } = {}
  ): { specialist: SpecialistType; score: number; matchedKeywords: string[] }[] {
    const { maxSpecialists = 5, minScore = 0.1, phase = 'developer' } = options;

    const scores: Map<SpecialistType, { score: number; matches: string[] }> = new Map();

    // Score each specialist based on keyword matches
    for (const [specialistId, patterns] of Object.entries(this.CONTEXTUAL_PATTERNS)) {
      let matchCount = 0;
      const matchedKeywords: string[] = [];

      for (const regex of patterns.keywords) {
        const matches = taskContent.match(regex);
        if (matches) {
          matchCount++;
          matchedKeywords.push(matches[0]);
        }
      }

      if (matchCount > 0) {
        // Score = (matches / total patterns) * weight
        const score = (matchCount / patterns.keywords.length) * patterns.weight;
        scores.set(specialistId as SpecialistType, {
          score,
          matches: [...new Set(matchedKeywords)] // Unique matches
        });
      }
    }

    // Boost scores for specialists already in project config
    const activeFromConfig = new Set(this.getActiveSpecialists(config, phase));
    for (const specialist of activeFromConfig) {
      const current = scores.get(specialist);
      if (current) {
        // Boost by 30% for config-enabled specialists
        scores.set(specialist, {
          score: current.score * 1.3,
          matches: current.matches
        });
      } else {
        // Add with minimum score if from config
        scores.set(specialist, {
          score: minScore,
          matches: ['from-config']
        });
      }
    }

    // Sort by score and filter
    const sorted = Array.from(scores.entries())
      .filter(([_, data]) => data.score >= minScore)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, maxSpecialists)
      .map(([specialist, data]) => ({
        specialist,
        score: Math.round(data.score * 100) / 100,
        matchedKeywords: data.matches
      }));

    return sorted;
  }

  /**
   * Build enhanced context with contextual specialists
   */
  buildContextualContext(
    taskContent: string,
    config: ProjectSpecialistsConfig,
    phase: 'analysis' | 'developer'
  ): SpecialistContext & { contextualMatches: { specialist: SpecialistType; score: number; matchedKeywords: string[] }[] } {
    // Get contextually relevant specialists
    const contextualMatches = this.getContextualSpecialists(taskContent, config, { phase });

    // Build active specialists list combining config + contextual
    const contextualIds = contextualMatches.map(m => m.specialist);
    const configActiveIds = this.getActiveSpecialists(config, phase);

    // Merge: contextual first (priority), then config
    const allActive = [...new Set([...contextualIds, ...configActiveIds])];

    // Build persona and instructions from active specialists
    const personaParts: string[] = [];
    const instructionParts: string[] = [];
    let lowestTier: 1 | 2 | 3 = 3;

    for (const id of allActive) {
      const spec = SPECIALIST_REGISTRY[id];
      if (!spec) continue;

      if (spec.persona) {
        personaParts.push(spec.persona.trim());
      }

      const instructions = spec.instructions?.[phase];
      if (instructions) {
        instructionParts.push(instructions.trim());
      }

      if (spec.modelTier && spec.modelTier < lowestTier) {
        lowestTier = spec.modelTier;
      }
    }

    const stackGuidelines = this.buildStackGuidelines(config.stack);

    return {
      personaPrompt: personaParts.join('\n\n'),
      instructionsPrompt: instructionParts.join('\n\n'),
      activeSpecialists: allActive,
      stackGuidelines,
      recommendedModelTier: lowestTier,
      contextualMatches
    };
  }

  /**
   * Detect stack from a GitHub repository URL
   * Clones temporarily to detect, then cleans up
   */
  async detectStackFromRepo(repoUrl: string, branch = 'main'): Promise<StackConfig> {
    const { mkdtemp, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const tempDir = await mkdtemp(join(tmpdir(), 'stack-detect-'));

    try {
      // Shallow clone just the root files
      await execAsync(
        `git clone --depth 1 --single-branch --branch ${branch} ${repoUrl} .`,
        { cwd: tempDir, timeout: 30000 }
      );

      // Detect stack
      const stack = await this.detectStack(tempDir);

      return stack;
    } catch (error) {
      console.warn(`[SpecialistManager] Could not detect stack from repo: ${error}`);
      return {};
    } finally {
      // Cleanup
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const specialistManager = new SpecialistManagerClass();
export default specialistManager;
