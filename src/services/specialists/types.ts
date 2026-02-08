/**
 * Specialist Types
 *
 * Defines the configuration and types for the specialist system.
 * Specialists are expert personas that enhance prompts with domain-specific knowledge.
 */

// ============================================================================
// STACK TYPES - Technology selections for a project
// ============================================================================

export type FrontendStack =
  | 'react'
  | 'vue'
  | 'angular'
  | 'nextjs'
  | 'svelte'
  | 'vanilla';

export type BackendStack =
  | 'nodejs'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'dotnet';

export type DatabaseStack =
  | 'postgresql'
  | 'mongodb'
  | 'mysql'
  | 'redis'
  | 'sqlite'
  | 'dynamodb';

export type InfraStack =
  | 'docker'
  | 'kubernetes'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'vercel';

export type MobileStack =
  | 'flutter'
  | 'dart'
  | 'react-native'
  | 'swift'
  | 'kotlin';

// ============================================================================
// SPECIALIST TYPES
// ============================================================================

/**
 * Standard specialists - always available, can be enabled/disabled
 */
export type StandardSpecialist =
  | 'context-manager'      // Explores and understands codebase
  | 'task-decomposition'   // Breaks down tasks into atomic stories
  | 'code-architect'       // Defines technical approach
  | 'debugger'             // Diagnoses and resolves errors
  | 'test-engineer'        // Generates and runs tests
  | 'security-auditor'     // Security scanning (OWASP, secrets)
  | 'git-flow-manager';    // Manages branches, commits, PRs

/**
 * Technology specialists - activated based on stack selection
 */
export type TechSpecialist =
  // Frontend
  | 'react-expert'
  | 'vue-expert'
  | 'angular-expert'
  | 'nextjs-architect'
  | 'svelte-expert'
  // Backend
  | 'nodejs-pro'
  | 'python-pro'
  | 'go-expert'
  | 'java-specialist'
  | 'rust-expert'
  | 'dotnet-expert'
  // Mobile
  | 'flutter-dart-expert'
  // Database
  | 'postgresql-architect'
  | 'mongodb-expert'
  | 'mysql-specialist'
  | 'redis-expert'
  // Infra
  | 'docker-expert'
  | 'kubernetes-architect'
  | 'aws-specialist'
  | 'gcp-expert'
  | 'azure-specialist';

/**
 * Domain specialists - optional, user-selectable
 */
export type DomainSpecialist =
  | 'ui-ux-designer'
  | 'api-designer'
  | 'performance-optimizer'
  | 'accessibility-expert'
  | 'fullstack-developer';

export type SpecialistType = StandardSpecialist | TechSpecialist | DomainSpecialist;

// ============================================================================
// SPECIALIST DEFINITION
// ============================================================================

/**
 * A specialist definition with persona and instructions
 */
export interface SpecialistDefinition {
  id: SpecialistType;
  name: string;
  description: string;
  /** The expert persona prompt */
  persona: string;
  /** Phase-specific instructions */
  instructions: {
    analysis?: string;
    developer?: string;
  };
  /** When this specialist should be active */
  activationConditions?: {
    /** Activate for these stacks */
    stacks?: Array<FrontendStack | BackendStack | DatabaseStack | InfraStack | MobileStack>;
    /** Activate for these phases */
    phases?: Array<'analysis' | 'developer'>;
    /** Activate for these file patterns */
    filePatterns?: string[];
  };
  /** Model tier recommendation (1=Opus, 2=Sonnet, 3=Haiku) */
  modelTier?: 1 | 2 | 3;
}

// ============================================================================
// PROJECT SPECIALISTS CONFIGURATION
// ============================================================================

/**
 * Stack configuration for a project
 */
export interface StackConfig {
  frontend?: FrontendStack;
  backend?: BackendStack;
  database?: DatabaseStack;
  infrastructure?: InfraStack;
  /** Additional frameworks/libraries */
  additionalTech?: string[];
}

/**
 * Standard specialists configuration
 */
export interface StandardSpecialistsConfig {
  contextManager: boolean;
  taskDecomposition: boolean;
  codeArchitect: boolean;
  debugger: boolean;
  testEngineer: boolean;
  securityAuditor: boolean;
  gitFlowManager: boolean;
}

/**
 * Complete project specialists configuration
 */
export interface ProjectSpecialistsConfig {
  /** Stack selection determines which tech specialists are active */
  stack: StackConfig;
  /** Standard specialists (enabled by default) */
  standard: StandardSpecialistsConfig;
  /** Additional domain specialists */
  domainSpecialists?: DomainSpecialist[];
  /** Custom specialist IDs (for future extensibility) */
  customSpecialists?: string[];
}

/**
 * Default specialists configuration
 */
export const DEFAULT_SPECIALISTS_CONFIG: ProjectSpecialistsConfig = {
  stack: {},
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
  customSpecialists: [],
};

// ============================================================================
// SPECIALIST CONTEXT - What gets passed to prompts
// ============================================================================

/**
 * Context built from active specialists for a phase
 */
export interface SpecialistContext {
  /** Combined persona text for the prompt */
  personaPrompt: string;
  /** Combined instructions for the phase */
  instructionsPrompt: string;
  /** List of active specialist IDs */
  activeSpecialists: SpecialistType[];
  /** Stack-specific guidelines */
  stackGuidelines: string;
  /** Recommended model tier (lowest = most capable) */
  recommendedModelTier: 1 | 2 | 3;
}
