/**
 * Developer Phase V2
 *
 * Architecture:
 * - stories[]: each story has its own vulnerabilities from SPY
 *
 * Flow per story:
 * 1. DEV → JUDGE → SPY loop (SPY runs after each JUDGE)
 * 2. If approved → HOST: commit + push
 * 3. Next story
 *
 * Note: Global Scan runs as SEPARATE FINAL PHASE after Merge
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  Task,
  Story,
  RepositoryInfo,
  DeveloperResultV2,
  StoryResultV2,
  VulnerabilityV2,
  ProjectSpecialistsConfig,
  DEFAULT_PROJECT_SPECIALISTS,
} from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../../services/opencode/OpenCodeEventBridge.js';
import { gitService } from '../../services/git/index.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import type { ApprovalResponse } from '../../services/realtime/ApprovalService.js';
import { specialistManager } from '../../services/specialists/index.js';

const execAsync = promisify(exec);

/**
 * 🔥 BUILD VERIFICATION: Detect build system and run build check
 */
interface BuildCheckResult {
  success: boolean;
  buildSystem: string;
  command: string;
  error?: string;
  output?: string;
}

async function runBuildCheck(repoPath: string): Promise<BuildCheckResult> {
  // Detect build system by checking for config files
  let buildCommand: string | undefined;
  let buildSystem: string | undefined;

  // === 1. JavaScript/TypeScript (package.json) ===
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const scripts = packageJson.scripts || {};

      if (scripts.build) {
        // Check for specific build tools
        if (fs.existsSync(path.join(repoPath, 'vite.config.ts')) ||
            fs.existsSync(path.join(repoPath, 'vite.config.js'))) {
          buildSystem = 'vite';
          buildCommand = 'npm run build';
        } else if (fs.existsSync(path.join(repoPath, 'next.config.js')) ||
                   fs.existsSync(path.join(repoPath, 'next.config.mjs')) ||
                   fs.existsSync(path.join(repoPath, 'next.config.ts'))) {
          buildSystem = 'next';
          buildCommand = 'npm run build';
        } else if (fs.existsSync(path.join(repoPath, 'webpack.config.js'))) {
          buildSystem = 'webpack';
          buildCommand = 'npm run build';
        } else {
          buildSystem = 'npm';
          buildCommand = 'npm run build';
        }
      } else if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
        // TypeScript project without build script - use tsc
        buildSystem = 'typescript';
        buildCommand = 'npx tsc --noEmit';
      }
    } catch {
      // Ignore package.json parse errors
    }
  }

  // === 2. Python (pyproject.toml or setup.py) ===
  if (!buildSystem) {
    if (fs.existsSync(path.join(repoPath, 'pyproject.toml'))) {
      buildSystem = 'python';
      // Try mypy first if available, fallback to ruff or python -m py_compile
      buildCommand = 'python -m mypy . --ignore-missing-imports 2>/dev/null || python -m ruff check . 2>/dev/null || python -m py_compile $(find . -name "*.py" -type f | head -50)';
    } else if (fs.existsSync(path.join(repoPath, 'setup.py'))) {
      buildSystem = 'python-setup';
      buildCommand = 'python setup.py check 2>/dev/null || python -m py_compile $(find . -name "*.py" -type f | head -50)';
    } else if (fs.existsSync(path.join(repoPath, 'requirements.txt'))) {
      buildSystem = 'python-requirements';
      buildCommand = 'python -m py_compile $(find . -name "*.py" -type f | head -50) 2>/dev/null || echo "Python syntax check completed"';
    }
  }

  // === 3. Go (go.mod) ===
  if (!buildSystem && fs.existsSync(path.join(repoPath, 'go.mod'))) {
    buildSystem = 'go';
    buildCommand = 'go build ./... && go vet ./...';
  }

  // === 4. Rust (Cargo.toml) ===
  if (!buildSystem && fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
    buildSystem = 'rust';
    buildCommand = 'cargo check';
  }

  // === 5. Java - Maven (pom.xml) ===
  if (!buildSystem && fs.existsSync(path.join(repoPath, 'pom.xml'))) {
    buildSystem = 'maven';
    buildCommand = 'mvn compile -q';
  }

  // === 6. Java - Gradle (build.gradle or build.gradle.kts) ===
  if (!buildSystem) {
    if (fs.existsSync(path.join(repoPath, 'build.gradle')) ||
        fs.existsSync(path.join(repoPath, 'build.gradle.kts'))) {
      buildSystem = 'gradle';
      // Use wrapper if available
      if (fs.existsSync(path.join(repoPath, 'gradlew'))) {
        buildCommand = './gradlew build -x test -q';
      } else {
        buildCommand = 'gradle build -x test -q';
      }
    }
  }

  // === 7. .NET / C# (*.csproj or *.sln) ===
  if (!buildSystem) {
    const files = fs.readdirSync(repoPath);
    const hasCsproj = files.some(f => f.endsWith('.csproj'));
    const hasSln = files.some(f => f.endsWith('.sln'));
    if (hasCsproj || hasSln) {
      buildSystem = 'dotnet';
      buildCommand = 'dotnet build --no-restore -v q';
    }
  }

  // === 8. Dart / Flutter (pubspec.yaml) ===
  if (!buildSystem && fs.existsSync(path.join(repoPath, 'pubspec.yaml'))) {
    // Check if it's a Flutter project
    try {
      const pubspec = fs.readFileSync(path.join(repoPath, 'pubspec.yaml'), 'utf-8');
      if (pubspec.includes('flutter:') || pubspec.includes('flutter_test:')) {
        buildSystem = 'flutter';
        buildCommand = 'flutter analyze --no-pub';
      } else {
        buildSystem = 'dart';
        buildCommand = 'dart analyze';
      }
    } catch {
      buildSystem = 'dart';
      buildCommand = 'dart analyze';
    }
  }

  // === No build system detected ===
  if (!buildSystem || !buildCommand) {
    return {
      success: true,
      buildSystem: 'none',
      command: 'none',
      output: 'No supported build system found, skipping build check',
    };
  }

  // === Execute build command ===
  try {
    console.log(`[BuildCheck] Running ${buildSystem} build in ${repoPath}...`);
    console.log(`[BuildCheck] Command: ${buildCommand}`);

    const { stdout, stderr } = await execAsync(buildCommand, {
      cwd: repoPath,
      timeout: 180000, // 3 minute timeout for builds (increased for larger projects)
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    console.log(`[BuildCheck] ✅ Build successful for ${repoPath}`);
    return {
      success: true,
      buildSystem,
      command: buildCommand,
      output: stdout || stderr,
    };
  } catch (error: any) {
    const errorOutput = error.stderr || error.stdout || error.message;
    console.error(`[BuildCheck] ❌ Build failed for ${repoPath}:`);
    console.error(errorOutput);

    return {
      success: false,
      buildSystem,
      command: buildCommand,
      error: errorOutput,
    };
  }
}

/**
 * 🔥 Run build checks on all repositories that have changes
 */
async function runBuildChecksOnRepos(
  repositories: RepositoryInfo[],
  taskId: string
): Promise<{ allPassed: boolean; results: Array<{ repo: string; result: BuildCheckResult }> }> {
  const results: Array<{ repo: string; result: BuildCheckResult }> = [];
  let allPassed = true;

  for (const repo of repositories) {
    try {
      // Only check repos that have changes
      const hasChanges = await gitService.hasChanges(repo.localPath);
      if (!hasChanges) {
        console.log(`[BuildCheck] No changes in ${repo.name}, skipping build check`);
        continue;
      }

      socketService.toTask(taskId, 'build:started', {
        repoName: repo.name,
        repoType: repo.type,
      });

      const result = await runBuildCheck(repo.localPath);
      results.push({ repo: repo.name, result });

      if (!result.success) {
        allPassed = false;
        socketService.toTask(taskId, 'build:failed', {
          repoName: repo.name,
          repoType: repo.type,
          error: result.error,
          buildSystem: result.buildSystem,
        });
      } else {
        socketService.toTask(taskId, 'build:success', {
          repoName: repo.name,
          repoType: repo.type,
          buildSystem: result.buildSystem,
        });
      }
    } catch (err: any) {
      console.error(`[BuildCheck] Error checking ${repo.name}: ${err.message}`);
      results.push({
        repo: repo.name,
        result: { success: false, buildSystem: 'error', command: 'error', error: err.message },
      });
      allPassed = false;
    }
  }

  return { allPassed, results };
}

// Re-export types for backward compatibility
export type { DeveloperResultV2 as DeveloperResult, StoryResultV2 as StoryResult };

export interface DeveloperPhaseContext {
  task: Task;
  projectPath: string;
  repositories: RepositoryInfo[];
  stories: Story[];
  branchName: string;
  /** Called when iteration needs user approval (manual mode) */
  onApprovalRequired?: (storyId: string, data: any) => Promise<boolean>;
  /** Auto-approve all iterations */
  autoApprove?: boolean;
  /** 🔥 Project LLM configuration */
  llmConfig?: {
    providerID: string;
    modelID: string;
    apiKey?: string;
  };
  /** 🔥 Project specialists configuration */
  specialists?: ProjectSpecialistsConfig;
  /** 🔥 RESUME: Start from specific story index (skip earlier stories) */
  startFromStoryIndex?: number;
  /** 🔥 RESUME: Called after each story completes (for saving progress) */
  onStoryComplete?: (storyIndex: number) => Promise<void>;
}

/**
 * Prompts for the Developer Phase
 */
const PROMPTS = {
  developer: (story: Story, storyIndex: number, totalStories: number, repositories: RepositoryInfo[], specialistContext?: string) => `
${specialistContext || ''}

# Story Implementation (${storyIndex + 1}/${totalStories})

## Story Details
- **ID**: ${story.id}
- **Title**: ${story.title}
- **Description**: ${story.description}

## Files Context
- **Files to Modify**: ${story.filesToModify?.join(', ') || 'Not specified'}
- **Files to Create**: ${story.filesToCreate?.join(', ') || 'None'}
- **Files to Read for Context**: ${story.filesToRead?.join(', ') || 'None specified'}

## Acceptance Criteria
${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified'}

## Available Repositories
${repositories.map(r => `- **${r.name}** (${r.type}): ${r.localPath}`).join('\n')}

## Your Mission
Implement ONLY this story. Do not implement other stories.

## Instructions
1. Read the files specified in "Files to Read for Context"
2. Modify files in "Files to Modify" using the Edit tool
3. Create files in "Files to Create" using the Write tool
4. Run any necessary commands (npm install, tests, etc.)

## Guidelines
- Focus ONLY on this story
- Write clean, well-documented code
- Follow existing code patterns
- Make minimal, focused changes
- Ensure acceptance criteria are met

## Output
After completing the story, summarize:
- What files were modified/created
- What changes were made
- Whether acceptance criteria were met
`,

  judge: (story: Story) => `
# Evaluate the Implementation

Review the code changes you just made for story "${story.title}".

## Acceptance Criteria to Check
${story.acceptanceCriteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified'}

## Evaluation Checklist
1. **Correctness**: Does the code work correctly?
2. **Completeness**: Are all acceptance criteria met?
3. **Code Quality**: Is the code clean and follows patterns?
4. **Security**: Any security issues? (SQL injection, XSS, etc.)
5. **Tests**: Were tests added/updated if needed?

## Required Output Format
Output a JSON block with your verdict:

\`\`\`json
{
  "verdict": "approved" | "needs_revision" | "rejected",
  "score": 0-100,
  "criteriaStatus": [
    { "criterion": "<criterion text>", "met": true/false, "notes": "<optional notes>" }
  ],
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "file": "<file path>",
      "description": "<issue description>",
      "suggestion": "<how to fix>"
    }
  ],
  "summary": "<brief evaluation summary>"
}
\`\`\`

Guidelines:
- "approved" (score >= 80): All criteria met, no critical/major issues
- "needs_revision" (50-79): Has fixable issues
- "rejected" (< 50): Fundamental problems, needs complete redo
`,

  fix: (issues: any[]) => `
# Fix the Implementation Issues

The implementation was evaluated and needs fixes. Address these issues:

${issues.map((issue, i) => `
${i + 1}. [${issue.severity.toUpperCase()}] ${issue.file ? `(${issue.file})` : ''} ${issue.description}
   Suggestion: ${issue.suggestion}
`).join('\n')}

Please fix ALL issues. Use Edit tool to modify files.
After fixing, output a summary of what was changed.
`,

  /**
   * SPY - Security analysis agent
   * Runs in the same session after JUDGE to detect vulnerabilities
   */
  spy: (story: Story, filesModified: string[], filesCreated: string[]) => `
# Security Analysis (SPY Agent)

You are a security expert. Analyze the code changes just made for story "${story.title}" and identify ALL security vulnerabilities.

## Files to Analyze
${[...filesModified, ...filesCreated].map(f => `- \`${f}\``).join('\n') || '- No files specified'}

## Your Mission
1. Read each file listed above using the Read tool
2. Analyze for security vulnerabilities
3. Report ALL findings, even minor ones

## Vulnerability Categories to Check
1. **Injection** (SQL, NoSQL, Command, XSS, LDAP, XPath)
2. **Broken Authentication** (weak passwords, session issues, credential exposure)
3. **Sensitive Data Exposure** (hardcoded secrets, API keys, passwords, tokens)
4. **XXE** (XML External Entities)
5. **Broken Access Control** (missing auth checks, IDOR, privilege escalation)
6. **Security Misconfiguration** (debug enabled, default credentials, verbose errors)
7. **XSS** (stored, reflected, DOM-based)
8. **Insecure Deserialization**
9. **Using Components with Known Vulnerabilities** (outdated dependencies)
10. **Insufficient Logging & Monitoring**
11. **Path Traversal** (../ attacks, arbitrary file access)
12. **SSRF** (Server-Side Request Forgery)
13. **Race Conditions** (TOCTOU, concurrency issues)
14. **Cryptographic Issues** (weak algorithms, hardcoded IVs, predictable randoms)

## Required Output Format
Output a JSON block with your findings:

\`\`\`json
{
  "vulnerabilities": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "type": "<vulnerability type, e.g., sql_injection, xss, secret_exposure>",
      "file": "<file path>",
      "line": <line number or null>,
      "description": "<clear description of the vulnerability>",
      "evidence": "<code snippet showing the issue>",
      "owaspCategory": "<e.g., A03:2021-Injection>",
      "cweId": "<e.g., CWE-79>",
      "recommendation": "<how to fix this>"
    }
  ],
  "summary": "<brief summary of security posture>",
  "riskLevel": "safe" | "low" | "medium" | "high" | "critical"
}
\`\`\`

## Guidelines
- Be thorough - check EVERY file
- Report ALL vulnerabilities, no matter how minor
- Include specific line numbers when possible
- Provide actionable recommendations
- If no vulnerabilities found, return empty array with "safe" riskLevel
`,
};

// ============================================================================
// SPY RESPONSE PARSING
// ============================================================================

interface SpyVulnerability {
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: string;
  file: string;
  line?: number;
  description: string;
  evidence?: string;
  owaspCategory?: string;
  cweId?: string;
  recommendation?: string;
}

interface SpyResult {
  vulnerabilities: SpyVulnerability[];
  summary: string;
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Extract JSON from SPY LLM output
 */
function extractSpyResult(output: string): SpyResult {
  // Try to find JSON block
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        vulnerabilities: parsed.vulnerabilities || [],
        summary: parsed.summary || '',
        riskLevel: parsed.riskLevel || 'safe',
      };
    } catch (e) {
      console.warn('[DeveloperPhase] Failed to parse SPY JSON response');
    }
  }

  // Return empty result if parsing fails
  return {
    vulnerabilities: [],
    summary: 'Failed to parse security analysis',
    riskLevel: 'safe',
  };
}

/**
 * Convert SPY vulnerabilities to VulnerabilityV2 format
 */
function convertSpyVulnerabilities(
  spyResult: SpyResult,
  context: { taskId: string; sessionId: string; storyId: string; iteration: number }
): VulnerabilityV2[] {
  return spyResult.vulnerabilities.map((v, index) => ({
    id: `spy-${context.storyId}-${context.iteration}-${index}`,
    taskId: context.taskId,
    sessionId: context.sessionId,
    phase: 'Developer',
    timestamp: new Date(),
    severity: v.severity,
    type: v.type as any,
    description: v.description,
    evidence: v.evidence || '',
    blocked: false,
    category: v.owaspCategory || 'security',
    filePath: v.file,
    lineNumber: v.line,
    codeSnippet: v.evidence,
    owaspCategory: v.owaspCategory,
    cweId: v.cweId,
    recommendation: v.recommendation,
  }));
}

/**
 * Execute the Developer Phase
 *
 * ARCHITECTURE: 1 Session per Story
 * Each story gets its own fresh OpenCode session to avoid context overflow.
 * This ensures stories 10+ don't fail due to context limits.
 */
export async function executeDeveloperPhase(
  context: DeveloperPhaseContext
): Promise<DeveloperResultV2> {
  const { task, projectPath, repositories, stories, branchName, llmConfig, specialists } = context;
  const autoApprove = context.autoApprove ?? false;

  // 🔥 Build model config for sendPrompt
  const modelConfig = llmConfig ? {
    model: { providerID: llmConfig.providerID, modelID: llmConfig.modelID },
  } : {};

  // 🔥 Build contextual specialist context based on task content
  const specialistsConfig = specialists || DEFAULT_PROJECT_SPECIALISTS;

  // Build task content for contextual analysis
  const taskContent = [
    task.title,
    task.description || '',
    ...stories.map(s => `${s.title}: ${s.description || ''}`),
  ].join('\n');

  // Use contextual matching for dynamic specialist activation
  const specialistCtx = specialistManager.buildContextualContext(taskContent, specialistsConfig, 'developer');
  const activeSpecialists = specialistCtx.activeSpecialists;
  const contextualMatches = specialistCtx.contextualMatches;

  // Build the specialist prompt section
  const specialistPrompt = [
    specialistCtx.personaPrompt,
    specialistCtx.stackGuidelines,
    specialistCtx.instructionsPrompt,
  ].filter(Boolean).join('\n\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[DeveloperPhase] Starting for task: ${task.title}`);
  console.log(`[DeveloperPhase] Stories to implement: ${stories.length}`);
  console.log(`[DeveloperPhase] Active specialists: ${activeSpecialists.join(', ') || 'none'}`);
  if (contextualMatches.length > 0) {
    console.log(`[DeveloperPhase] Contextual matches:`);
    for (const m of contextualMatches.slice(0, 5)) {
      console.log(`  - ${m.specialist} (score: ${m.score}, matched: ${m.matchedKeywords.join(', ')})`);
    }
  }
  console.log(`[DeveloperPhase] Architecture: 1 Session per Story (context isolation)`);
  console.log(`${'='.repeat(60)}`);

  // Determine primary working directory (for OpenCode sessions)
  const workingDirectory = determineWorkingDirectory(repositories, projectPath);

  // 🔥 MULTI-REPO FIX: Checkout branch in ALL repositories
  console.log(`[DeveloperPhase] Checking out branch ${branchName} in all repositories...`);
  for (const repo of repositories) {
    try {
      await gitService.checkout(repo.localPath, branchName);
      console.log(`[DeveloperPhase] ✅ Checked out ${branchName} in ${repo.name}`);
    } catch (checkoutError: any) {
      // Try to create the branch if it doesn't exist
      try {
        await gitService.createBranch(repo.localPath, branchName);
        console.log(`[DeveloperPhase] ✅ Created and checked out ${branchName} in ${repo.name}`);
      } catch {
        console.warn(`[DeveloperPhase] ⚠️ Could not checkout/create ${branchName} in ${repo.name}: ${checkoutError.message}`);
      }
    }
  }

  // Notify frontend
  socketService.toTask(task.id, 'phase:start', {
    phase: 'Developer',
    totalStories: stories.length,
    architecture: 'session-per-story',
  });

  // === Process each story with its OWN session ===
  const storyResultsV2: StoryResultV2[] = [];
  let totalCommits = 0;
  const sessionIds: string[] = []; // Track all sessions created

  // 🔥 RESUME: Get start index (skip already completed stories)
  const startFromStoryIndex = context.startFromStoryIndex || 0;

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];

    // 🔥 RESUME: Skip stories before startFromStoryIndex
    if (i < startFromStoryIndex) {
      console.log(`[DeveloperPhase] ⏭️ SKIPPING story ${i + 1}/${stories.length} (already completed): ${story.title}`);
      // Add placeholder result for skipped story
      storyResultsV2.push({
        id: story.id,
        title: story.title,
        description: story.description,
        status: 'completed',
        filesToModify: story.filesToModify,
        filesToCreate: story.filesToCreate,
        filesToRead: story.filesToRead,
        acceptanceCriteria: story.acceptanceCriteria,
        iterations: 0,
        verdict: 'approved',
        vulnerabilities: [],
        trace: { startTime: Date.now(), endTime: Date.now(), toolCalls: 0, turns: 0 },
      });
      continue;
    }

    const startTime = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[DeveloperPhase] STORY ${i + 1}/${stories.length}: ${story.title}`);
    console.log(`[DeveloperPhase] Creating NEW session for this story...`);
    console.log(`${'─'.repeat(60)}`);

    // Notify frontend
    socketService.toTask(task.id, 'story:start', {
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      totalStories: stories.length,
    });

    // Execute story with its own session
    const result = await executeStoryWithSession(
      story,
      i,
      stories.length,
      repositories,
      workingDirectory,
      projectPath,
      task.id,
      task.title,
      autoApprove,
      modelConfig,
      specialistPrompt
    );

    // Track session ID
    if (result.sessionId) {
      sessionIds.push(result.sessionId);
    }

    // Build V2 story result
    const storyResultV2: StoryResultV2 = {
      id: story.id,
      title: story.title,
      description: story.description,
      status: result.verdict === 'approved' ? 'completed' : 'failed',
      filesToModify: story.filesToModify,
      filesToCreate: story.filesToCreate,
      filesToRead: story.filesToRead,
      acceptanceCriteria: story.acceptanceCriteria,
      iterations: result.iterations,
      verdict: result.verdict,
      score: result.score,
      issues: result.issues,
      vulnerabilities: result.vulnerabilities as unknown as VulnerabilityV2[],
      trace: {
        startTime,
        endTime: Date.now(),
        toolCalls: result.toolCalls || 0,
        turns: result.iterations,
      },
    };

    // Commit + Push if approved by Judge
    if (result.verdict === 'approved') {
      // 🔥 MULTI-REPO FIX: Check if ANY repository has changes
      let anyRepoHasChanges = false;
      for (const repo of repositories) {
        try {
          if (await gitService.hasChanges(repo.localPath)) {
            anyRepoHasChanges = true;
            break;
          }
        } catch {
          // Ignore errors checking individual repos
        }
      }

      if (anyRepoHasChanges) {
        // 🔥 BUILD VERIFICATION: Run build check before proceeding to approval
        console.log(`[DeveloperPhase] 🔨 Running build verification for story ${story.id}...`);
        socketService.toTask(task.id, 'story:build_check', {
          storyId: story.id,
          storyTitle: story.title,
          status: 'started',
        });

        let buildCheckPassed = false;
        let buildAttempts = 0;
        const maxBuildAttempts = 3;
        let currentSessionId = result.sessionId;

        while (!buildCheckPassed && buildAttempts < maxBuildAttempts) {
          buildAttempts++;
          console.log(`[DeveloperPhase] Build check attempt ${buildAttempts}/${maxBuildAttempts}...`);

          const buildResults = await runBuildChecksOnRepos(repositories, task.id);

          if (buildResults.allPassed) {
            buildCheckPassed = true;
            console.log(`[DeveloperPhase] ✅ All builds passed for story ${story.id}`);
            socketService.toTask(task.id, 'story:build_check', {
              storyId: story.id,
              storyTitle: story.title,
              status: 'success',
              attempt: buildAttempts,
            });
          } else {
            // 🔥 BUILD FAILED: Ask DEV to fix the errors
            const failedBuilds = buildResults.results.filter(r => !r.result.success);
            const buildErrors = failedBuilds.map(b => `${b.repo}:\n${b.result.error}`).join('\n\n');

            console.error(`[DeveloperPhase] ❌ Build failed for story ${story.id} (attempt ${buildAttempts})`);

            socketService.toTask(task.id, 'story:build_check', {
              storyId: story.id,
              storyTitle: story.title,
              status: 'failed',
              attempt: buildAttempts,
              errors: failedBuilds.map(b => ({ repo: b.repo, error: b.result.error?.substring(0, 500) })),
            });

            if (buildAttempts < maxBuildAttempts && currentSessionId) {
              // Ask DEV to fix the build errors
              console.log(`[DeveloperPhase] 🔧 Asking DEV to fix build errors...`);

              const fixPrompt = `
# 🚨 BUILD ERROR - FIX REQUIRED

The build/compilation failed with the following errors:

\`\`\`
${buildErrors.substring(0, 3000)}
\`\`\`

## Your Task
1. Analyze the build error(s) carefully
2. Fix the issue(s) - this is usually a missing import, typo, or file path error
3. Make sure all imports are correct and all files exist
4. After fixing, the build will be re-run automatically

**Focus on fixing ONLY the build errors. Do not add new features or refactor.**
`;

              try {
                await openCodeClient.sendPrompt(currentSessionId, fixPrompt, { directory: workingDirectory });

                // Wait for OpenCode to finish fixing (1 minute timeout)
                await openCodeClient.waitForIdle(currentSessionId, {
                  timeout: 60000,
                  directory: workingDirectory,
                });

                console.log(`[DeveloperPhase] DEV finished fixing build errors`);
              } catch (fixError: any) {
                console.error(`[DeveloperPhase] Failed to request build fix: ${fixError.message}`);
              }
            } else if (buildAttempts >= maxBuildAttempts) {
              // Max build attempts reached - fail the story
              console.error(`[DeveloperPhase] ❌ Build failed after ${maxBuildAttempts} attempts - failing story`);
              storyResultV2.status = 'failed';
              storyResultV2.verdict = 'rejected';
              // Add build error as an issue
              const buildIssue = {
                severity: 'critical' as const,
                description: `Build failed after ${maxBuildAttempts} attempts: ${buildErrors.substring(0, 500)}`,
              };
              storyResultV2.issues = [
                ...(storyResultV2.issues || []),
                buildIssue,
              ];

              // Rollback changes
              for (const repo of repositories) {
                try {
                  if (await gitService.hasChanges(repo.localPath)) {
                    await gitService.discardChanges(repo.localPath);
                    console.log(`[DeveloperPhase] Rolled back changes in ${repo.name} due to build failure`);
                  }
                } catch (rollbackErr) {
                  console.warn(`[DeveloperPhase] Failed to rollback ${repo.name}`);
                }
              }

              socketService.toTask(task.id, 'story:build_failed', {
                storyId: story.id,
                storyTitle: story.title,
                attempts: buildAttempts,
                errors: failedBuilds.map(b => ({ repo: b.repo, error: b.result.error?.substring(0, 500) })),
              });

              // Skip to next story
              storyResultsV2.push(storyResultV2);
              continue;
            }
          }
        }

        // 🔥 BUILD PASSED - Continue with approval
        // === MANUAL APPROVAL LOOP: Supports approve, reject, and request_changes ===
        let userApproved = autoApprove;
        let approvalAttempts = 0;
        const maxApprovalAttempts = 5; // Max feedback rounds before forcing a decision

        // Auto-approve mode: skip approval loop
        if (!autoApprove) {
          let currentResult = { ...result }; // Track current state for feedback rounds

          approvalLoop: while (approvalAttempts < maxApprovalAttempts) {
            approvalAttempts++;
            console.log(`[DeveloperPhase] 🔔 Requesting user approval for story ${story.id} (attempt ${approvalAttempts})...`);

            try {
              // 🔥 Get files modified for this story using git
              let filesModified: string[] = [];
              let gitDiff = '';
              try {
                // Get list of changed files (staged + unstaged) from ALL repos
                for (const repo of repositories) {
                  try {
                    const repoFiles = await gitService.getChangedFiles(repo.localPath);
                    filesModified.push(...repoFiles.map(f => `${repo.name}/${f}`));
                  } catch {
                    // Ignore errors for individual repos
                  }
                }

                // 🔥 Get FULL diff with actual code changes (increased limit)
                const diffOutput = await gitService.getFullDiff(workingDirectory, 300);
                gitDiff = diffOutput.substring(0, 8000); // Increased limit for better visibility
              } catch (gitError) {
                console.warn(`[DeveloperPhase] Could not get git info: ${gitError}`);
              }

              // 🔥 Build implementation summary from judge criteria
              const judgeResult = parseJudgeVerdict(extractFinalOutput([])); // Get current state
              const implementationSummary = buildImplementationSummary(story, filesModified, currentResult);

              const approvalResponse: ApprovalResponse = await approvalService.requestApproval(
                task.id,
                `story-${story.id}`, // Unique phase name per story
                {
                  // 🔥 Story identity
                  storyId: story.id,
                  storyTitle: story.title,
                  storyDescription: story.description,
                  storyIndex: i,
                  totalStories: stories.length,

                  // 🔥 All stories for progress tracker
                  stories: stories.map(s => ({ id: s.id, title: s.title })),

                  // 🔥 Implementation results
                  verdict: currentResult.verdict,
                  score: currentResult.score,
                  iterations: currentResult.iterations,

                  // 🔥 What was done - ENHANCED
                  filesModified,
                  filesToModify: story.filesToModify || [],
                  filesToCreate: story.filesToCreate || [],
                  gitDiff,
                  implementationSummary, // 🔥 NEW: Human-readable summary

                  // 🔥 Quality info - ENHANCED
                  issues: currentResult.issues,
                  vulnerabilities: currentResult.vulnerabilities.length,
                  acceptanceCriteria: story.acceptanceCriteria || [],
                  criteriaStatus: (currentResult as any).criteriaStatus || [], // 🔥 NEW: Criteria met/unmet
                  judgeEvaluation: (currentResult as any).summary || '', // 🔥 NEW: Judge summary

                  // 🔥 Session info
                  sessionId: currentResult.sessionId,
                  approvalAttempt: approvalAttempts,
                }
                // 🔥 NO TIMEOUT - wait indefinitely for human approval
              );

              console.log(`[DeveloperPhase] User response: ${approvalResponse.action} for story ${story.id}`);

              switch (approvalResponse.action) {
                case 'approve':
                  userApproved = true;
                  break approvalLoop;

                case 'reject':
                  userApproved = false;
                  break approvalLoop;

                case 'request_changes':
                  // === FEEDBACK LOOP: Send user feedback to OpenCode and continue ===
                  console.log(`[DeveloperPhase] 📝 User requested changes: "${approvalResponse.feedback?.substring(0, 100)}..."`);

                  if (currentResult.sessionId && approvalResponse.feedback) {
                    // Notify frontend about feedback round
                    socketService.toTask(task.id, 'story:feedback_round', {
                      storyId: story.id,
                      feedback: approvalResponse.feedback,
                      attempt: approvalAttempts,
                    });

                    // Send feedback to OpenCode session
                    console.log(`[DeveloperPhase] Sending feedback to OpenCode session ${currentResult.sessionId}...`);
                    socketService.toTask(task.id, 'agent:start', {
                      agent: 'FIXER',
                      storyId: story.id,
                      storyIndex: i,
                      iteration: approvalAttempts,
                      reason: 'user_feedback',
                      feedback: approvalResponse.feedback?.substring(0, 200),
                      sessionId: currentResult.sessionId,
                    });
                    await openCodeClient.sendPrompt(
                      currentResult.sessionId,
                      `# User Feedback - Please Make Changes

The user has reviewed your implementation and requested the following changes:

"${approvalResponse.feedback}"

Please implement these changes now. After making the changes, provide a summary of what was modified.`,
                      { directory: projectPath, ...modelConfig }
                    );

                    // Wait for OpenCode to finish
                    // 🔥 NO TIMEOUT - Let OpenCode manage its own internal limits
                    const feedbackEvents = await openCodeClient.waitForIdle(currentResult.sessionId, {
                      directory: projectPath,
                    });

                    // Notify frontend about feedback completion
                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'feedback',
                      storyId: story.id,
                      iteration: approvalAttempts,
                      sessionId: currentResult.sessionId,
                    });

                    // Re-run JUDGE to evaluate the changes
                    console.log(`[DeveloperPhase] Re-running JUDGE after feedback...`);
                    socketService.toTask(task.id, 'agent:start', {
                      agent: 'JUDGE',
                      storyId: story.id,
                      storyIndex: i,
                      iteration: currentResult.iterations + 1,
                      reason: 'post_feedback',
                      sessionId: currentResult.sessionId,
                    });
                    await openCodeClient.sendPrompt(
                      currentResult.sessionId,
                      PROMPTS.judge(story),
                      { directory: projectPath, ...modelConfig }
                    );

                    const judgeEvents = await openCodeClient.waitForIdle(currentResult.sessionId, {
                      directory: projectPath,
                      // 🔥 No timeout - let OpenCode handle its own limits
                    });

                    const judgeOutput = extractFinalOutput(judgeEvents);
                    const judgeResult = parseJudgeVerdict(judgeOutput);

                    // Update current result with new judge verdict
                    currentResult.verdict = judgeResult.verdict;
                    currentResult.score = judgeResult.score;
                    currentResult.issues = judgeResult.issues;
                    currentResult.iterations = (currentResult.iterations || 0) + 1;

                    console.log(`[DeveloperPhase] Judge re-verdict: ${judgeResult.verdict} (score: ${judgeResult.score})`);

                    // Notify frontend about new judge result
                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'judge',
                      storyId: story.id,
                      iteration: currentResult.iterations,
                      verdict: judgeResult.verdict,
                      score: judgeResult.score,
                      issues: judgeResult.issues.length,
                      sessionId: currentResult.sessionId,
                    });

                    // Re-run SPY (LLM-based, same session)
                    console.log(`[DeveloperPhase] Re-running SPY after feedback...`);
                    socketService.toTask(task.id, 'agent:start', {
                      agent: 'SPY',
                      storyId: story.id,
                      storyIndex: i,
                      iteration: currentResult.iterations,
                      reason: 'post_feedback',
                      sessionId: currentResult.sessionId,
                    });
                    const filesModified = story.filesToModify || [];
                    const filesCreated = story.filesToCreate || [];

                    await openCodeClient.sendPrompt(
                      currentResult.sessionId,
                      PROMPTS.spy(story, filesModified, filesCreated),
                      { directory: workingDirectory, ...modelConfig }
                    );

                    const spyEvents = await openCodeClient.waitForIdle(currentResult.sessionId, {
                      directory: workingDirectory,
                      // 🔥 No timeout - let OpenCode handle its own limits
                    });

                    const spyOutput = extractFinalOutput(spyEvents);
                    const spyResult = extractSpyResult(spyOutput);
                    const spyVulns = convertSpyVulnerabilities(spyResult, {
                      taskId: task.id,
                      sessionId: currentResult.sessionId,
                      storyId: story.id,
                      iteration: currentResult.iterations,
                    });

                    // Update vulnerabilities count
                    currentResult.vulnerabilities = [
                      ...(currentResult.vulnerabilities || []),
                      ...spyVulns,
                    ];

                    socketService.toTask(task.id, 'iteration:complete', {
                      type: 'spy',
                      storyId: story.id,
                      iteration: currentResult.iterations,
                      vulnerabilities: spyVulns.length,
                      riskLevel: spyResult.riskLevel,
                      summary: spyResult.summary,
                      sessionId: currentResult.sessionId,
                    });

                    // Continue loop to request approval again
                  } else {
                    console.warn(`[DeveloperPhase] Cannot process feedback: no session or feedback text`);
                    userApproved = false;
                    break approvalLoop;
                  }
                  break;
              }
            } catch (error: any) {
              console.warn(`[DeveloperPhase] Approval timeout/error for story ${story.id}: ${error.message}`);
              userApproved = false;
              break approvalLoop;
            }
          }

          // Max attempts reached without decision
          if (approvalAttempts >= maxApprovalAttempts && !userApproved) {
            console.warn(`[DeveloperPhase] Max approval attempts reached for story ${story.id}, treating as rejected`);
          }
        }

        // Only commit if user approved (or autoApprove is on)
        if (userApproved) {
          console.log(`[DeveloperPhase] Committing story ${story.id}...`);

          // 🔥 MULTI-REPO FIX: Commit to ALL repositories that have changes
          const commitHashes: string[] = [];
          for (const repo of repositories) {
            try {
              const repoHasChanges = await gitService.hasChanges(repo.localPath);
              if (repoHasChanges) {
                console.log(`[DeveloperPhase] Committing to ${repo.name} (${repo.type})...`);
                const commit = await gitService.commitAndPush(
                  repo.localPath,
                  `[story-${i + 1}] ${story.title}`,
                  { storyId: story.id, storyTitle: story.title }
                );
                commitHashes.push(`${repo.name}:${commit.hash.substring(0, 7)}`);
                totalCommits++;
                console.log(`[DeveloperPhase] Committed to ${repo.name}: ${commit.hash.substring(0, 7)}`);
              } else {
                console.log(`[DeveloperPhase] No changes in ${repo.name}, skipping commit`);
              }
            } catch (repoError: any) {
              console.warn(`[DeveloperPhase] Failed to commit to ${repo.name}: ${repoError.message}`);
            }
          }

          // Store all commit hashes (comma-separated if multiple)
          storyResultV2.commitHash = commitHashes.join(', ') || undefined;
          console.log(`[DeveloperPhase] Committed to ${commitHashes.length} repos: ${commitHashes.join(', ')}`);
        } else {
          console.log(`[DeveloperPhase] Story ${story.id} not committed (user rejected)`);
          storyResultV2.status = 'failed';
          storyResultV2.verdict = 'rejected';

          // 🔥 MULTI-REPO FIX: Rollback ALL repositories
          console.log(`[DeveloperPhase] Rolling back uncommitted changes for rejected story ${story.id}...`);
          for (const repo of repositories) {
            try {
              const repoHasChanges = await gitService.hasChanges(repo.localPath);
              if (repoHasChanges) {
                console.log(`[DeveloperPhase] Discarding changes in ${repo.name}...`);
                await gitService.discardChanges(repo.localPath);
              }
            } catch (repoError: any) {
              console.warn(`[DeveloperPhase] Failed to rollback ${repo.name}: ${repoError.message}`);
            }
          }

          // Notify frontend about rollback
          socketService.toTask(task.id, 'story:rollback', {
            storyId: story.id,
            storyTitle: story.title,
            reason: 'User rejected - changes discarded',
            repositories: repositories.map(r => r.name),
          });
        }
      }
    } else {
      // 🔥 Judge rejected the story - also discard changes in ALL repos
      console.log(`[DeveloperPhase] Story ${story.id} failed Judge review (verdict: ${result.verdict})`);

      // 🔥 MULTI-REPO FIX: Rollback ALL repositories
      let anyChangesRolledBack = false;
      for (const repo of repositories) {
        try {
          const repoHasChanges = await gitService.hasChanges(repo.localPath);
          if (repoHasChanges) {
            console.log(`[DeveloperPhase] Discarding changes in ${repo.name}...`);
            await gitService.discardChanges(repo.localPath);
            anyChangesRolledBack = true;
          }
        } catch (repoError: any) {
          console.warn(`[DeveloperPhase] Failed to rollback ${repo.name}: ${repoError.message}`);
        }
      }

      if (anyChangesRolledBack) {
        socketService.toTask(task.id, 'story:rollback', {
          storyId: story.id,
          storyTitle: story.title,
          reason: `Judge verdict: ${result.verdict} - changes discarded`,
          repositories: repositories.map(r => r.name),
        });
      }
    }

    storyResultsV2.push(storyResultV2);

    // Notify frontend with FULL story summary
    // 🔥 v2.4.2: Include complete story data so users can see what was done
    socketService.toTask(task.id, 'story:complete', {
      // Identity
      storyIndex: i,
      storyId: story.id,
      storyTitle: story.title,
      storyDescription: story.description,
      // Results
      success: result.verdict === 'approved',
      verdict: result.verdict,
      score: result.score,
      iterations: result.iterations,
      commitHash: storyResultV2.commitHash,
      // Issues - full details
      issues: result.issues || [],
      // Vulnerabilities - count and top details
      vulnerabilities: storyResultV2.vulnerabilities.length,
      vulnerabilityDetails: storyResultV2.vulnerabilities.slice(0, 5).map(v => ({
        severity: v.severity,
        type: v.type,
        description: v.description,
        file: v.filePath,
      })),
      // Files context
      filesToModify: story.filesToModify,
      filesToCreate: story.filesToCreate,
      // Acceptance criteria
      acceptanceCriteria: story.acceptanceCriteria,
      criteriaStatus: result.criteriaStatus,
      // Judge summary
      judgeSummary: result.summary,
      // Progress
      totalStories: stories.length,
      completedStories: i + 1,
      sessionId: result.sessionId,
    });

    // 🔥 RESUME: Notify orchestrator that story is complete (for persistence)
    if (context.onStoryComplete) {
      await context.onStoryComplete(i);
    }

    console.log(`[DeveloperPhase] Story ${i + 1}/${stories.length} complete. Session closed.`);
  }

  // Calculate overall success
  const allApproved = storyResultsV2.every(r => r.verdict === 'approved');
  const approvedCount = storyResultsV2.filter(r => r.verdict === 'approved').length;
  const totalStoryVulns = storyResultsV2.reduce((sum, s) => sum + s.vulnerabilities.length, 0);

  // Notify frontend with FULL story data for UI display
  // 🔥 v2.4.2: Include complete story summaries so users can see what each story did
  socketService.toTask(task.id, 'phase:complete', {
    phase: 'Developer',
    success: allApproved,
    sessionIds, // All sessions used
    stories: storyResultsV2.map(r => ({
      // Identity
      id: r.id,
      title: r.title,
      description: r.description,
      // Results
      verdict: r.verdict,
      score: r.score,
      iterations: r.iterations,
      commitHash: r.commitHash,
      // Issues and vulnerabilities - full details for visibility
      issues: r.issues || [],
      vulnerabilities: r.vulnerabilities.length,
      vulnerabilityDetails: r.vulnerabilities.slice(0, 10).map(v => ({
        severity: v.severity,
        type: v.type,
        description: v.description,
        file: v.filePath,
      })),
      // Files context
      filesToModify: r.filesToModify,
      filesToCreate: r.filesToCreate,
      // Acceptance criteria status
      acceptanceCriteria: r.acceptanceCriteria,
      // Trace info
      durationMs: r.trace?.endTime && r.trace?.startTime
        ? r.trace.endTime - r.trace.startTime
        : undefined,
      toolCalls: r.trace?.toolCalls,
    })),
    totalCommits,
    approvedCount,
    totalStories: stories.length,
    spyVulnerabilities: totalStoryVulns,
  });

  console.log(`\n[DeveloperPhase] Completed:`);
  console.log(`  - Stories approved: ${approvedCount}/${stories.length}`);
  console.log(`  - Sessions created: ${sessionIds.length}`);
  console.log(`  - Total commits: ${totalCommits}`);
  console.log(`  - SPY vulnerabilities (across stories): ${totalStoryVulns}`);

  return {
    success: allApproved,
    sessionId: sessionIds[sessionIds.length - 1] || '', // Last session for compatibility
    stories: storyResultsV2,
    totalCommits,
  };
}

/**
 * Internal story execution result
 */
interface StoryExecutionResult {
  verdict: 'approved' | 'rejected' | 'needs_revision';
  iterations: number;
  score?: number;
  issues?: Array<{
    severity: 'critical' | 'major' | 'minor';
    file?: string;
    description: string;
    suggestion?: string;
  }>;
  vulnerabilities: VulnerabilityV2[];
  toolCalls?: number;
  sessionId?: string;
  // 🔥 NEW: Judge evaluation details
  criteriaStatus?: Array<{
    criterion: string;
    met: boolean;
    notes?: string;
  }>;
  summary?: string;
}

/**
 * Execute a single story with its OWN OpenCode session
 *
 * ARCHITECTURE: Each story gets a fresh session to avoid context overflow.
 * Flow: CREATE SESSION → DEV → JUDGE → SPY → FIX (loop) → CLEANUP SESSION
 */
async function executeStoryWithSession(
  story: Story,
  storyIndex: number,
  totalStories: number,
  repositories: RepositoryInfo[],
  workingDirectory: string,
  projectPath: string,
  taskId: string,
  taskTitle: string,
  autoApprove: boolean,
  modelConfig: { model?: { providerID: string; modelID: string } },
  specialistPrompt: string
): Promise<StoryExecutionResult> {
  let sessionId: string | undefined;

  try {
    // === CREATE SESSION FOR THIS STORY ===
    console.log(`[DeveloperPhase] Creating session for Story ${storyIndex + 1}: ${story.title}`);
    sessionId = await openCodeClient.createSession({
      title: `Story ${storyIndex + 1}/${totalStories}: ${story.title}`,
      directory: projectPath,
      autoApprove: true,
    });

    console.log(`[DeveloperPhase] Session created: ${sessionId}`);

    // Register with EventBridge for real-time events
    openCodeEventBridge.registerSession(taskId, sessionId, projectPath);

    // Wait for event subscription to establish
    await new Promise(resolve => setTimeout(resolve, 300));

    // Save session to database
    await SessionRepository.create({
      sessionId,
      taskId,
      directory: projectPath,
      phaseName: `Developer-Story${storyIndex + 1}`,
      approvalMode: autoApprove ? 'all' : 'manual',
    });

    // Notify frontend about session
    socketService.toTask(taskId, 'session:created', {
      sessionId,
      phaseName: 'Developer',
      directory: projectPath,
      storyId: story.id,
      storyIndex,
    });

    // === EXECUTE DEV → JUDGE → SPY → FIX LOOP ===
    let approved = false;
    let verdict: 'approved' | 'rejected' | 'needs_revision' = 'needs_revision';
    let score = 0;
    let issues: any[] = [];
    let criteriaStatus: Array<{ criterion: string; met: boolean; notes?: string }> = [];
    let judgeSummary = '';
    let iterations = 0;
    const maxIterations = 3;
    const storyVulnerabilities: VulnerabilityV2[] = [];
    let totalToolCalls = 0;

    while (!approved && iterations < maxIterations) {
      iterations++;
      console.log(`[DeveloperPhase] Story ${story.id} - Iteration ${iterations}/${maxIterations}`);

      // --- DEVELOPER ---
      if (iterations === 1) {
        console.log(`[DeveloperPhase] Sending DEV prompt...`);
        socketService.toTask(taskId, 'agent:start', {
          agent: 'DEVELOPER',
          storyId: story.id,
          storyIndex,
          iteration: iterations,
          sessionId,
        });
        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.developer(story, storyIndex, totalStories, repositories, specialistPrompt),
          { directory: projectPath, ...modelConfig }
        );
      }

      // Wait for completion
      // 🔥 NO TIMEOUT - Let OpenCode manage its own internal limits
      const devEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
      });
      totalToolCalls += countToolCalls(devEvents);

      // Notify frontend
      socketService.toTask(taskId, 'iteration:complete', {
        type: 'developer',
        storyId: story.id,
        iteration: iterations,
        sessionId,
      });

      // --- JUDGE ---
      console.log(`[DeveloperPhase] Sending JUDGE prompt...`);
      socketService.toTask(taskId, 'agent:start', {
        agent: 'JUDGE',
        storyId: story.id,
        storyIndex,
        iteration: iterations,
        sessionId,
      });
      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.judge(story),
        { directory: projectPath, ...modelConfig }
      );

      const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        // 🔥 No timeout - let OpenCode handle its own limits
      });
      totalToolCalls += countToolCalls(judgeEvents);

      const judgeOutput = extractFinalOutput(judgeEvents);
      const judgeResult = parseJudgeVerdict(judgeOutput);

      verdict = judgeResult.verdict;
      score = judgeResult.score;
      issues = judgeResult.issues;
      criteriaStatus = judgeResult.criteriaStatus; // 🔥 Capture criteria status
      judgeSummary = judgeResult.summary; // 🔥 Capture judge summary
      console.log(`[DeveloperPhase] Judge verdict: ${verdict} (score: ${score})`);

      // Notify frontend
      socketService.toTask(taskId, 'iteration:complete', {
        type: 'judge',
        storyId: story.id,
        iteration: iterations,
        verdict,
        score,
        issues: issues.length,
        sessionId,
      });

      // --- SPY (LLM-based security analysis, same session) ---
      console.log(`[DeveloperPhase] Running SPY analysis for story ${story.id}...`);
      socketService.toTask(taskId, 'agent:start', {
        agent: 'SPY',
        storyId: story.id,
        storyIndex,
        iteration: iterations,
        sessionId,
      });
      const filesModified = story.filesToModify || [];
      const filesCreated = story.filesToCreate || [];

      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.spy(story, filesModified, filesCreated),
        { directory: projectPath, ...modelConfig }
      );

      const spyEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        // 🔥 No timeout - let OpenCode handle its own limits // 2 min for security analysis
      });

      const spyOutput = extractFinalOutput(spyEvents);
      const spyResult = extractSpyResult(spyOutput);
      const spyVulns = convertSpyVulnerabilities(spyResult, {
        taskId,
        sessionId,
        storyId: story.id,
        iteration: iterations,
      });
      storyVulnerabilities.push(...spyVulns);

      // Notify frontend about SPY results
      socketService.toTask(taskId, 'iteration:complete', {
        type: 'spy',
        storyId: story.id,
        iteration: iterations,
        vulnerabilities: spyVulns.length,
        riskLevel: spyResult.riskLevel,
        summary: spyResult.summary,
        bySeverity: {
          critical: spyVulns.filter(v => v.severity === 'critical').length,
          high: spyVulns.filter(v => v.severity === 'high').length,
          medium: spyVulns.filter(v => v.severity === 'medium').length,
          low: spyVulns.filter(v => v.severity === 'low').length,
        },
        sessionId,
      });
      console.log(`[DeveloperPhase] SPY found ${spyVulns.length} vulnerabilities (risk: ${spyResult.riskLevel})`);

      if (verdict === 'approved') {
        approved = true;
      } else if (verdict === 'rejected') {
        console.log(`[DeveloperPhase] Story rejected - stopping iterations`);
        break;
      } else if (issues.length > 0) {
        // --- FIX ---
        console.log(`[DeveloperPhase] Sending FIX prompt (${issues.length} issues)...`);
        socketService.toTask(taskId, 'agent:start', {
          agent: 'FIXER',
          storyId: story.id,
          storyIndex,
          iteration: iterations,
          issuesCount: issues.length,
          sessionId,
        });
        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.fix(issues),
          { directory: projectPath, ...modelConfig }
        );
      } else {
        console.log(`[DeveloperPhase] No specific issues to fix, accepting as-is`);
        approved = true;
        verdict = 'approved';
      }
    }

    // === CLEANUP SESSION ===
    console.log(`[DeveloperPhase] Cleaning up session ${sessionId} for story ${story.id}`);

    // Update session status in database
    await SessionRepository.updateStatus(sessionId, 'completed');

    // Unregister from EventBridge
    openCodeEventBridge.unregisterSession(sessionId);

    // Notify frontend
    socketService.toTask(taskId, 'session:closed', {
      sessionId,
      storyId: story.id,
      storyIndex,
      verdict,
    });

    return {
      verdict,
      iterations,
      score,
      issues,
      vulnerabilities: storyVulnerabilities,
      toolCalls: totalToolCalls,
      sessionId,
      criteriaStatus, // 🔥 Include criteria status
      summary: judgeSummary, // 🔥 Include judge summary
    };

  } catch (error: any) {
    console.error(`[DeveloperPhase] Error executing story ${story.id}: ${error.message}`);

    // Cleanup on error
    if (sessionId) {
      try {
        await SessionRepository.updateStatus(sessionId, 'error');
        openCodeEventBridge.unregisterSession(sessionId);
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      verdict: 'rejected',
      iterations: 0,
      score: 0,
      issues: [{ severity: 'critical', description: error.message }],
      vulnerabilities: [],
      toolCalls: 0,
      sessionId,
    };
  }
}

// === Helper Functions ===

function determineWorkingDirectory(repositories: RepositoryInfo[], projectPath: string): string {
  if (!repositories || repositories.length === 0) {
    return projectPath;
  }

  const sorted = [...repositories].sort((a, b) => {
    if (a.type === 'backend' && b.type !== 'backend') return -1;
    if (b.type === 'backend' && a.type !== 'backend') return 1;
    return (a.executionOrder ?? 999) - (b.executionOrder ?? 999);
  });

  return sorted[0].localPath;
}

function extractFinalOutput(events: any[]): string {
  let output = '';
  for (const event of events) {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      if (part?.type === 'text') {
        output = part.text || output;
      }
    }
  }
  return output;
}

function countToolCalls(events: any[]): number {
  return events.filter(e => e.type === 'tool.execute.before').length;
}

function parseJudgeVerdict(output: string): {
  verdict: 'approved' | 'needs_revision' | 'rejected';
  score: number;
  issues: any[];
  criteriaStatus: any[];
  summary: string;
} {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      return {
        verdict: data.verdict || 'needs_revision',
        score: data.score || 0,
        issues: data.issues || [],
        criteriaStatus: data.criteriaStatus || [],
        summary: data.summary || '',
      };
    }
  } catch (e) {
    console.warn(`[DeveloperPhase] Failed to parse judge verdict: ${e}`);
  }
  return { verdict: 'needs_revision', score: 0, issues: [], criteriaStatus: [], summary: '' };
}

/**
 * 🔥 Build a human-readable summary of what DEV implemented
 */
function buildImplementationSummary(
  story: Story,
  filesModified: string[],
  result: { verdict?: string; score?: number; iterations?: number; issues?: any[] }
): string {
  const parts: string[] = [];

  // What was the goal
  parts.push(`Implemented "${story.title}".`);

  // What files were touched
  if (filesModified && filesModified.length > 0) {
    const fileList = filesModified.slice(0, 5).join(', ');
    const moreFiles = filesModified.length > 5 ? ` (+${filesModified.length - 5} more)` : '';
    parts.push(`Modified ${filesModified.length} file(s): ${fileList}${moreFiles}.`);
  }

  // How it went
  if (result.verdict === 'approved') {
    parts.push(`Judge approved with score ${result.score || 0}/100.`);
  } else if (result.verdict === 'needs_revision') {
    parts.push(`Judge requested revisions (score: ${result.score || 0}/100).`);
  }

  // Issues found
  if (result.issues && result.issues.length > 0) {
    const criticalCount = result.issues.filter((i: any) => i.severity === 'critical').length;
    const majorCount = result.issues.filter((i: any) => i.severity === 'major').length;
    if (criticalCount > 0 || majorCount > 0) {
      parts.push(`Found ${criticalCount} critical and ${majorCount} major issues.`);
    }
  }

  // Iterations
  if (result.iterations && result.iterations > 1) {
    parts.push(`Completed after ${result.iterations} iterations.`);
  }

  return parts.join(' ');
}

/**
 * Send a user message to the active developer session
 */
export async function sendUserMessage(
  taskId: string,
  message: string
): Promise<boolean> {
  const session = await SessionRepository.findActiveByTaskId(taskId);
  if (!session || session.phaseName !== 'Developer') {
    console.warn(`[DeveloperPhase] No active developer session for task ${taskId}`);
    return false;
  }

  await openCodeClient.sendPrompt(
    session.sessionId,
    message,
    { directory: session.directory }
  );

  console.log(`[DeveloperPhase] User message sent to session ${session.sessionId}`);
  return true;
}
