/**
 * Product Planning Phase (BrainGrid-style)
 *
 * A pre-analysis phase that transforms rough product ideas into
 * structured specifications, UX flows, and enriched prompts.
 *
 * Flow:
 * 1. Clarifying Questions - Identify edge cases and hidden complexity
 * 2. UX Flow Generation - Map complete user experiences
 * 3. Task Breakdown - Decompose into scoped tasks with acceptance criteria
 * 4. Prompt Enrichment - Generate optimized prompts for Analysis
 *
 * This phase ensures proper product-level planning before any code is written.
 */

import {
  Task,
  RepositoryInfo,
  ProjectSpecialistsConfig,
} from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../../services/opencode/OpenCodeEventBridge.js';
import { SessionRepository } from '../../database/repositories/SessionRepository.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { socketService, approvalService } from '../../services/realtime/index.js';
import { specialistManager } from '../../services/specialists/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ClarifyingQuestion {
  id: string;
  question: string;
  category: 'technical' | 'scope' | 'business' | 'ui' | 'integration' | 'data';
  impact: string;
  options?: string[]; // Optional predefined options
  required: boolean;
}

export interface UXFlow {
  id: string;
  name: string;
  description: string;
  steps: {
    step: number;
    action: string;
    screen?: string;
    component?: string;
    notes?: string;
  }[];
  edgeCases: string[];
  errorHandling: string[];
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[]; // IDs of tasks this depends on
  estimatedComplexity: 'low' | 'medium' | 'high';
  affectedAreas: string[]; // Files/modules that will be modified
}

export interface ProductPlanningResult {
  success: boolean;
  sessionId: string;

  // Planning outputs
  clarifications?: {
    questions: ClarifyingQuestion[];
    answers: Record<string, string>;
    skipped: boolean;
  };

  uxFlows?: UXFlow[];

  plannedTasks?: PlannedTask[];

  enrichedPrompt?: string;

  // Metadata
  originalPrompt: string;
  planningDurationMs: number;
}

export interface ProductPlanningContext {
  task: Task;
  projectPath: string;
  repositories: RepositoryInfo[];
  autoApprove?: boolean;
  llmConfig?: {
    providerID: string;
    modelID: string;
    apiKey?: string;
  };
  specialists?: ProjectSpecialistsConfig;
  /** Skip planning for simple tasks */
  skipForSimpleTasks?: boolean;
}

// ============================================================================
// PROMPTS
// ============================================================================

const PROMPTS = {
  /**
   * Complexity Assessment - Determine if task needs full planning
   */
  assessComplexity: (task: Task) => `
# Task Complexity Assessment

Analyze this task and determine if it requires full product planning or can proceed directly to implementation.

## Task
"${task.description || task.title}"

## Assessment Criteria
A task is SIMPLE if ALL of these are true:
- Single, well-defined change (e.g., "fix typo", "change color", "update text")
- No new features or user flows
- No database changes
- No API changes
- Affects 1-3 files maximum
- No ambiguity in requirements

A task is COMPLEX if ANY of these are true:
- Introduces new features or functionality
- Requires new user flows or screens
- Involves database schema changes
- Requires API design decisions
- Has multiple possible implementation approaches
- Contains ambiguous or incomplete requirements
- Affects multiple modules or systems

## Output Format
\`\`\`json
{
  "complexity": "simple" | "complex",
  "reason": "<brief explanation>",
  "suggestedApproach": "<if simple, brief implementation note>"
}
\`\`\`
`,

  /**
   * Clarifying Questions - Identify ambiguities
   */
  clarifyingQuestions: (task: Task, repositories: RepositoryInfo[], specialistContext?: string) => `
${specialistContext || ''}

# Product Planning: Clarifying Questions

Before building, we need to understand the complete picture. Analyze the task and identify questions that would reveal hidden complexity or prevent incorrect assumptions.

## Task
"${task.description || task.title}"

## Available Repositories
${repositories.map(r => `- ${r.name} (${r.type}): ${r.localPath}`).join('\n')}

## Instructions
1. First, explore the codebase to understand existing patterns, data models, and architecture
2. Identify 3-7 clarifying questions across these categories:
   - **Technical**: Stack choices, libraries, patterns
   - **Scope**: What's in/out, MVP vs full feature
   - **Business**: Rules, validations, edge cases
   - **UI/UX**: Design, layout, interactions
   - **Integration**: APIs, external services, data flow
   - **Data**: Schema, relationships, migrations

## Guidelines
- Questions should be SPECIFIC, not generic
- Each question should have clear impact on implementation
- Provide smart defaults/options when possible
- Mark questions as required only if answer significantly changes approach

## Output Format
\`\`\`json
{
  "questions": [
    {
      "id": "q1",
      "question": "How should users authenticate? OAuth (Google/GitHub), email/password, or both?",
      "category": "technical",
      "impact": "Determines auth flow, database schema, and UI components needed",
      "options": ["OAuth only", "Email/password only", "Both options"],
      "required": true
    }
  ],
  "contextDiscovered": {
    "existingPatterns": ["<relevant patterns found in codebase>"],
    "relatedCode": ["<files/modules that will be affected>"],
    "potentialConflicts": ["<things to watch out for>"]
  },
  "defaultAssumptions": [
    "If user skips clarification: <assumption 1>",
    "If user skips clarification: <assumption 2>"
  ]
}
\`\`\`
`,

  /**
   * UX Flow Generation - Map user journeys
   */
  uxFlows: (task: Task, clarifications: string, specialistContext?: string) => `
${specialistContext || ''}

# Product Planning: UX Flow Design

Design complete user experience flows for this feature. Think end-to-end, including error states and edge cases.

## Task
"${task.description || task.title}"

## User Clarifications
${clarifications}

## Instructions
1. Map out ALL user journeys (happy path + error paths)
2. Identify every screen/component involved
3. Define error handling for each step
4. Consider accessibility and edge cases

## Output Format
\`\`\`json
{
  "flows": [
    {
      "id": "flow-1",
      "name": "User Login Flow",
      "description": "Complete authentication journey from landing to dashboard",
      "userStory": "As a user, I want to log in so I can access my dashboard",
      "steps": [
        {
          "step": 1,
          "action": "User clicks 'Sign In' button",
          "screen": "Landing Page",
          "component": "Header/NavBar",
          "notes": "Button should be prominent, consider mobile placement"
        },
        {
          "step": 2,
          "action": "User enters credentials",
          "screen": "Login Modal/Page",
          "component": "LoginForm",
          "notes": "Include remember me option, show/hide password toggle"
        }
      ],
      "edgeCases": [
        "User has caps lock on",
        "User forgets password",
        "User doesn't have account yet"
      ],
      "errorHandling": [
        "Invalid credentials: Show error, keep email filled",
        "Account locked: Show support contact",
        "Network error: Show retry option"
      ]
    }
  ],
  "sharedComponents": [
    {
      "name": "LoadingSpinner",
      "usedIn": ["Login", "Dashboard"],
      "notes": "Consistent loading state across app"
    }
  ],
  "dataRequirements": {
    "newModels": ["Session", "RefreshToken"],
    "modifiedModels": ["User"],
    "apiEndpoints": [
      {"method": "POST", "path": "/api/auth/login", "purpose": "Authenticate user"},
      {"method": "POST", "path": "/api/auth/logout", "purpose": "End session"}
    ]
  }
}
\`\`\`
`,

  /**
   * Task Breakdown - Decompose into implementable units
   */
  taskBreakdown: (task: Task, uxFlows: string, clarifications: string, specialistContext?: string) => `
${specialistContext || ''}

# Product Planning: Task Breakdown

Break down the feature into small, implementable tasks with clear acceptance criteria.

## Original Task
"${task.description || task.title}"

## User Clarifications
${clarifications}

## UX Flows Designed
${uxFlows}

## Instructions
1. Create tasks that are SMALL (5-20 lines of code each)
2. Each task should be independently testable
3. Order tasks by dependencies
4. Include acceptance criteria that are SPECIFIC and TESTABLE

## Output Format
\`\`\`json
{
  "tasks": [
    {
      "id": "T1",
      "title": "Create User model with auth fields",
      "description": "Add email, passwordHash, and session fields to User model",
      "acceptanceCriteria": [
        "User model has email field with unique constraint",
        "User model has passwordHash field (never store plain passwords)",
        "User model has lastLogin timestamp",
        "Migration runs without errors"
      ],
      "dependencies": [],
      "estimatedComplexity": "low",
      "affectedAreas": ["prisma/schema.prisma", "src/models/User.ts"],
      "testCases": [
        "Can create user with valid email",
        "Rejects duplicate emails",
        "passwordHash is not readable directly"
      ]
    },
    {
      "id": "T2",
      "title": "Implement login API endpoint",
      "description": "POST /api/auth/login - validate credentials and return JWT",
      "acceptanceCriteria": [
        "Returns 200 with JWT token on valid credentials",
        "Returns 401 on invalid password",
        "Returns 404 on non-existent email",
        "Rate limits after 5 failed attempts"
      ],
      "dependencies": ["T1"],
      "estimatedComplexity": "medium",
      "affectedAreas": ["src/api/routes/auth.ts", "src/services/auth.ts"],
      "testCases": [
        "Valid login returns token",
        "Invalid password returns 401",
        "Rate limiting works"
      ]
    }
  ],
  "implementationOrder": ["T1", "T2", "T3"],
  "riskAreas": [
    {
      "area": "Security",
      "concern": "Password handling must use bcrypt with proper salt rounds",
      "mitigation": "Use established auth library, never roll custom crypto"
    }
  ],
  "estimatedTotalComplexity": "medium",
  "suggestedBranchName": "feature/user-authentication"
}
\`\`\`
`,

  /**
   * Prompt Enrichment - Create optimized prompt for Analysis
   */
  enrichPrompt: (task: Task, clarifications: string, uxFlows: string, taskBreakdown: string) => `
# Product Planning: Prompt Enrichment

Create an enriched, comprehensive prompt that captures all planning decisions for the Analysis phase.

## Original Task
"${task.description || task.title}"

## Planning Results
### Clarifications
${clarifications}

### UX Flows
${uxFlows}

### Task Breakdown
${taskBreakdown}

## Instructions
Generate a single, comprehensive prompt that:
1. Clearly states what to build
2. Includes all clarified requirements
3. References UX flows and edge cases
4. Lists acceptance criteria for each component
5. Notes any constraints or considerations

## Output Format
\`\`\`json
{
  "enrichedPrompt": "<the complete, enriched prompt ready for Analysis phase>",
  "keyDecisions": [
    "<decision 1 made during planning>",
    "<decision 2 made during planning>"
  ],
  "outOfScope": [
    "<explicitly excluded items>"
  ]
}
\`\`\`
`,

  /**
   * JUDGE - Evaluate the planning output quality
   */
  judge: (task: Task, planningData: {
    questions?: any[];
    uxFlows?: any[];
    tasks?: any[];
    enrichedPrompt?: string;
  }) => `
# Evaluate Product Planning Output

You are a senior product manager and technical architect. Review the planning output and evaluate its quality.

## Original Task
"${task.description || task.title}"

## Planning Output to Evaluate

### Clarifying Questions (${planningData.questions?.length || 0})
${planningData.questions?.map((q, i) => `${i + 1}. [${q.category}] ${q.question}`).join('\n') || 'None generated'}

### UX Flows (${planningData.uxFlows?.length || 0})
${planningData.uxFlows?.map((f, i) => `${i + 1}. ${f.name}: ${f.steps?.length || 0} steps`).join('\n') || 'None generated'}

### Planned Tasks (${planningData.tasks?.length || 0})
${planningData.tasks?.map((t, i) => `${i + 1}. [${t.estimatedComplexity}] ${t.title}`).join('\n') || 'None generated'}

### Enriched Prompt
${planningData.enrichedPrompt?.substring(0, 500) || 'None generated'}...

## Evaluation Criteria
1. **Completeness**: Are all aspects of the task covered?
2. **Clarity**: Are requirements and flows clearly defined?
3. **Feasibility**: Is the breakdown realistic and achievable?
4. **Edge Cases**: Are error states and edge cases considered?
5. **Security**: Are security considerations identified?
6. **Scope**: Is scope well-defined (what's in/out)?

## Required Output Format
\`\`\`json
{
  "verdict": "approved" | "needs_revision" | "rejected",
  "score": 0-100,
  "evaluation": {
    "completeness": { "score": 0-100, "notes": "<feedback>" },
    "clarity": { "score": 0-100, "notes": "<feedback>" },
    "feasibility": { "score": 0-100, "notes": "<feedback>" },
    "edgeCases": { "score": 0-100, "notes": "<feedback>" },
    "security": { "score": 0-100, "notes": "<feedback>" },
    "scope": { "score": 0-100, "notes": "<feedback>" }
  },
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "area": "<questions|uxFlows|tasks|prompt>",
      "description": "<issue description>",
      "suggestion": "<how to fix>"
    }
  ],
  "strengths": ["<what was done well>"],
  "summary": "<brief evaluation summary>"
}
\`\`\`

## Scoring Guidelines
- **approved** (score >= 80): Planning is comprehensive and ready for Analysis
- **needs_revision** (50-79): Has gaps that should be addressed
- **rejected** (< 50): Fundamental issues, needs complete redo
`,

  /**
   * SELF-ANSWER - When in autopilot mode, answer your own questions
   * The agent identifies ambiguities AND decides the best answer itself
   */
  selfAnswer: (task: Task, questions: any[], repositories: RepositoryInfo[], specialistContext?: string) => `
${specialistContext || ''}

# 🤖 AUTOPILOT MODE: Self-Answer Clarifying Questions

You are running in **AUTOPILOT MODE**. You identified ${questions.length} clarifying questions.
Now you must DECIDE the best answer for each question using your expert judgment.

## Task
"${task.description || task.title}"

## Available Repositories
${repositories.map(r => `- ${r.name} (${r.type}): ${r.localPath}`).join('\n')}

## Questions You Identified (ANSWER ALL)
${questions.map((q, i) => `
### Question ${i + 1}: ${q.question}
- **Category**: ${q.category}
- **Impact**: ${q.impact}
${q.options ? `- **Options**: ${q.options.join(', ')}` : ''}
`).join('\n')}

## Your Mission
1. For each question, decide the BEST answer based on:
   - Industry best practices
   - What you found in the codebase exploration
   - Common patterns for this type of feature
   - Simplicity and maintainability

2. Briefly justify each decision (1-2 sentences)

## Guidelines
- Be decisive - pick the most practical option
- Prefer simpler solutions when complexity isn't justified
- Follow existing codebase patterns when detected
- Choose options that reduce technical debt

## Required Output Format
\`\`\`json
{
  "selfAnswers": [
    {
      "questionId": "q1",
      "question": "<the original question>",
      "answer": "<your decided answer>",
      "reasoning": "<brief justification>"
    }
  ],
  "decisionSummary": "<1-2 sentence summary of key decisions made>"
}
\`\`\`
`,

  /**
   * FIX - Address issues found by JUDGE
   */
  fix: (issues: any[]) => `
# Fix Planning Issues

The planning output was evaluated and needs revision. Address these issues:

${issues.map((issue, i) => `
${i + 1}. [${issue.severity.toUpperCase()}] (${issue.area}) ${issue.description}
   Suggestion: ${issue.suggestion}
`).join('\n')}

Please revise the planning to address ALL issues.
Output the corrected planning data in the same JSON format as before.
`,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function extractJsonFromOutput(output: string): any {
  if (!output || output.length === 0) {
    console.warn('[ProductPlanning] extractJsonFromOutput: Empty output');
    return null;
  }

  // 1. Try code block first (most common)
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e: any) {
      console.warn(`[ProductPlanning] Failed to parse JSON code block: ${e.message}`);
    }
  }

  // 2. Try to find raw JSON object (no code block)
  // Look for patterns like { "tasks": or { "flows": or { "questions":
  const rawJsonPatterns = [
    /\{[\s\S]*?"tasks"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"flows"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"questions"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"enrichedPrompt"\s*:[\s\S]*\}/,
    /\{[\s\S]*?"complexity"\s*:[\s\S]*\}/,
    /\{[\s\S]*?"verdict"\s*:[\s\S]*\}/,
  ];

  for (const pattern of rawJsonPatterns) {
    const rawMatch = output.match(pattern);
    if (rawMatch) {
      try {
        // Find the balanced JSON by counting braces
        const jsonStr = extractBalancedJson(rawMatch[0]);
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr);
          console.log(`[ProductPlanning] Extracted raw JSON successfully`);
          return parsed;
        }
      } catch (e: any) {
        console.warn(`[ProductPlanning] Failed to parse raw JSON: ${e.message}`);
      }
    }
  }

  // 3. Last resort: try to find ANY valid JSON object
  const anyJsonMatch = output.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (anyJsonMatch) {
    // Try each match, starting from the largest
    const sorted = anyJsonMatch.sort((a, b) => b.length - a.length);
    for (const candidate of sorted) {
      try {
        const parsed = JSON.parse(candidate);
        // Check if it has expected keys
        if (parsed.tasks || parsed.flows || parsed.questions || parsed.enrichedPrompt || parsed.complexity || parsed.verdict) {
          console.log(`[ProductPlanning] Extracted JSON from fallback pattern`);
          return parsed;
        }
      } catch {
        // Continue to next candidate
      }
    }
  }

  console.warn(`[ProductPlanning] No valid JSON found in output (${output.length} chars)`);
  return null;
}

/**
 * Extract balanced JSON by counting braces
 */
function extractBalancedJson(str: string): string | null {
  let depth = 0;
  let start = -1;

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return str.substring(start, i + 1);
      }
    }
  }

  return null;
}

function extractFinalOutput(events: any[]): string {
  // 🔥 FIX: Use correct event format (message.part.updated with properties.part.text)
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

// ============================================================================
// MAIN PHASE FUNCTION
// ============================================================================

export async function runProductPlanningPhase(
  context: ProductPlanningContext
): Promise<ProductPlanningResult> {
  const { task, projectPath, repositories, autoApprove, llmConfig, specialists } = context;
  const startTime = Date.now();

  console.log('\n' + '═'.repeat(70));
  console.log('[ProductPlanning] 🧠 Starting Product Planning Phase');
  console.log(`[ProductPlanning] Task: "${task.title}"`);
  console.log('═'.repeat(70));

  // Get specialist context
  const specialistContext = specialists
    ? specialistManager.buildContext(specialists, 'analysis')
    : null;
  const specialistPrompt = specialistContext?.personaPrompt || '';

  // 🔥 Build model config for sendPrompt (must be { model: { providerID, modelID } })
  const modelConfig = llmConfig ? {
    model: { providerID: llmConfig.providerID, modelID: llmConfig.modelID },
  } : {};

  socketService.toTask(task.id, 'phase:started', {
    phase: 'ProductPlanning',
    phaseName: 'Product Planning',
  });

  // Create OpenCode session for planning
  let sessionId: string = '';

  try {
    // Create session
    sessionId = await openCodeClient.createSession({
      title: `Planning: ${task.title}`,
      directory: projectPath,
      autoApprove: true,
    });

    // Bridge events to frontend
    openCodeEventBridge.registerSession(task.id, sessionId, projectPath);

    // Register session
    await SessionRepository.create({
      sessionId,
      taskId: task.id,
      directory: projectPath,
      phaseName: 'ProductPlanning',
      approvalMode: autoApprove ? 'all' : 'manual',
    });

    // ========================================================================
    // STEP 1: COMPLEXITY ASSESSMENT
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 1: Assessing task complexity...`);
    await TaskRepository.setCurrentStep(task.id, 1, 'COMPLEXITY_ASSESSOR');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'COMPLEXITY_ASSESSOR',
      phase: 'ProductPlanning',
      step: 1,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.assessComplexity(task),
      { directory: projectPath, ...modelConfig }
    );

    const complexityEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits (default: 30 min safety net)
    });

    const complexityOutput = extractFinalOutput(complexityEvents);
    const complexityResult = extractJsonFromOutput(complexityOutput);

    if (complexityResult?.complexity === 'simple' && context.skipForSimpleTasks) {
      console.log(`[ProductPlanning] Task is SIMPLE, skipping detailed planning`);

      return {
        success: true,
        sessionId,
        originalPrompt: task.description || task.title,
        enrichedPrompt: task.description || task.title,
        planningDurationMs: Date.now() - startTime,
      };
    }

    console.log(`[ProductPlanning] Task complexity: ${complexityResult?.complexity || 'complex'}`);

    // ========================================================================
    // STEP 2: CLARIFYING QUESTIONS
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 2: Generating clarifying questions...`);
    await TaskRepository.setCurrentStep(task.id, 2, 'CLARIFIER');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'CLARIFIER',
      phase: 'ProductPlanning',
      step: 2,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.clarifyingQuestions(task, repositories, specialistPrompt),
      { directory: projectPath, ...modelConfig }
    );

    const clarifyEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
    });

    const clarifyOutput = extractFinalOutput(clarifyEvents);
    const clarifyResult = extractJsonFromOutput(clarifyOutput);

    let userAnswers: Record<string, string> = {};
    let clarificationsSkipped = false;
    let selfAnsweredMode = false;

    if (clarifyResult?.questions?.length > 0) {
      console.log(`[ProductPlanning] Found ${clarifyResult.questions.length} clarifying questions`);

      if (autoApprove) {
        // 🤖 AUTOPILOT MODE: Self-answer the questions instead of skipping
        console.log(`[ProductPlanning] 🤖 AUTOPILOT: Self-answering ${clarifyResult.questions.length} questions...`);
        await TaskRepository.setCurrentStep(task.id, 3, 'SELF_ANSWERER');
        socketService.toTask(task.id, 'agent:start', {
          agent: 'SELF_ANSWERER',
          phase: 'ProductPlanning',
          step: 3,
          mode: 'autopilot',
          questionsCount: clarifyResult.questions.length,
          sessionId,
        });

        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.selfAnswer(task, clarifyResult.questions, repositories, specialistPrompt),
          { directory: projectPath, ...modelConfig }
        );

        const selfAnswerEvents = await openCodeClient.waitForIdle(sessionId, {
          directory: projectPath,
          // 🔥 No timeout - let OpenCode handle its own limits
        });

        const selfAnswerOutput = extractFinalOutput(selfAnswerEvents);
        const selfAnswerResult = extractJsonFromOutput(selfAnswerOutput);

        if (selfAnswerResult?.selfAnswers) {
          // Convert self-answers to userAnswers format
          for (const sa of selfAnswerResult.selfAnswers) {
            userAnswers[sa.question] = `[AUTOPILOT] ${sa.answer} (Reasoning: ${sa.reasoning})`;
          }
          selfAnsweredMode = true;
          console.log(`[ProductPlanning] 🤖 AUTOPILOT: Self-answered ${selfAnswerResult.selfAnswers.length} questions`);
          console.log(`[ProductPlanning] Decision summary: ${selfAnswerResult.decisionSummary || 'N/A'}`);

          // Notify frontend about self-answered clarifications
          socketService.toTask(task.id, 'clarification:self-answered', {
            phase: 'ProductPlanning',
            mode: 'autopilot',
            questionsCount: clarifyResult.questions.length,
            selfAnswers: selfAnswerResult.selfAnswers,
            decisionSummary: selfAnswerResult.decisionSummary,
          });
        } else {
          console.warn(`[ProductPlanning] 🤖 AUTOPILOT: Failed to parse self-answers, using defaults`);
          clarificationsSkipped = true;
        }
      } else {
        // Manual mode: Request user approval with questions
        const clarificationResponse = await approvalService.requestApproval(
          task.id,
          'clarification',
          {
            type: 'clarification',
            phase: 'ProductPlanning',
            questions: clarifyResult.questions,
            contextDiscovered: clarifyResult.contextDiscovered,
            defaultAssumptions: clarifyResult.defaultAssumptions,
            message: 'Please answer these questions to help guide the implementation:',
          }
        );

        if (clarificationResponse.action === 'approve' && clarificationResponse.feedback) {
          // Parse answers from feedback
          try {
            userAnswers = JSON.parse(clarificationResponse.feedback);
          } catch {
            // Treat as free-form text
            userAnswers = { freeform: clarificationResponse.feedback };
          }
          console.log(`[ProductPlanning] User provided clarifications`);
        } else {
          clarificationsSkipped = true;
          console.log(`[ProductPlanning] User skipped clarifications, using defaults`);
        }
      }
    }

    // Build clarifications text for subsequent prompts
    const clarificationsText = clarificationsSkipped
      ? `Using default assumptions:\n${(clarifyResult?.defaultAssumptions || []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}`
      : Object.entries(userAnswers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n');

    // ========================================================================
    // STEP 3: UX FLOW GENERATION
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 3: Designing UX flows...`);
    await TaskRepository.setCurrentStep(task.id, 4, 'UX_DESIGNER');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'UX_DESIGNER',
      phase: 'ProductPlanning',
      step: 4,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.uxFlows(task, clarificationsText, specialistPrompt),
      { directory: projectPath, ...modelConfig }
    );

    const uxEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
    });

    const uxOutput = extractFinalOutput(uxEvents);
    const uxResult = extractJsonFromOutput(uxOutput);

    console.log(`[ProductPlanning] Generated ${uxResult?.flows?.length || 0} UX flows`);

    // ========================================================================
    // STEP 4: TASK BREAKDOWN
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 4: Breaking down into tasks...`);
    await TaskRepository.setCurrentStep(task.id, 5, 'TASK_PLANNER');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'TASK_PLANNER',
      phase: 'ProductPlanning',
      step: 5,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.taskBreakdown(
        task,
        JSON.stringify(uxResult?.flows || [], null, 2),
        clarificationsText,
        specialistPrompt
      ),
      { directory: projectPath, ...modelConfig }
    );

    const breakdownEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
    });

    const breakdownOutput = extractFinalOutput(breakdownEvents);
    const breakdownResult = extractJsonFromOutput(breakdownOutput);

    console.log(`[ProductPlanning] Created ${breakdownResult?.tasks?.length || 0} tasks`);

    // ========================================================================
    // STEP 5: PROMPT ENRICHMENT
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 5: Enriching prompt...`);
    await TaskRepository.setCurrentStep(task.id, 6, 'PROMPT_ENRICHER');
    socketService.toTask(task.id, 'agent:start', {
      agent: 'PROMPT_ENRICHER',
      phase: 'ProductPlanning',
      step: 6,
      sessionId,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.enrichPrompt(
        task,
        clarificationsText,
        JSON.stringify(uxResult?.flows || [], null, 2),
        JSON.stringify(breakdownResult?.tasks || [], null, 2)
      ),
      { directory: projectPath, ...modelConfig }
    );

    const enrichEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
    });

    const enrichOutput = extractFinalOutput(enrichEvents);
    let enrichResult = extractJsonFromOutput(enrichOutput);

    // ========================================================================
    // STEP 6: JUDGE - Evaluate planning quality
    // ========================================================================
    console.log(`\n[ProductPlanning] Step 6: JUDGE evaluating planning...`);

    const maxJudgeIterations = 3;
    let judgeIteration = 0;
    let planningApproved = false;

    while (!planningApproved && judgeIteration < maxJudgeIterations) {
      judgeIteration++;

      const planningData = {
        questions: clarifyResult?.questions || [],
        uxFlows: uxResult?.flows || [],
        tasks: breakdownResult?.tasks || [],
        enrichedPrompt: enrichResult?.enrichedPrompt,
      };

      await TaskRepository.setCurrentStep(task.id, 7, 'JUDGE');
      socketService.toTask(task.id, 'agent:start', {
        agent: 'JUDGE',
        phase: 'ProductPlanning',
        step: 7,
        iteration: judgeIteration,
        sessionId,
      });

      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.judge(task, planningData),
        { directory: projectPath, ...modelConfig }
      );

      const judgeEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
        // 🔥 No timeout - let OpenCode handle its own limits
      });

      const judgeOutput = extractFinalOutput(judgeEvents);
      const judgeResult = extractJsonFromOutput(judgeOutput);

      const verdict = judgeResult?.verdict || 'approved';
      const score = judgeResult?.score || 80;
      const issues = judgeResult?.issues || [];

      console.log(`[ProductPlanning] JUDGE verdict: ${verdict} (score: ${score}, iteration: ${judgeIteration})`);

      // Notify frontend
      socketService.toTask(task.id, 'iteration:complete', {
        type: 'judge',
        phase: 'ProductPlanning',
        iteration: judgeIteration,
        verdict,
        score,
        issues: issues.length,
        evaluation: judgeResult?.evaluation,
        strengths: judgeResult?.strengths,
        summary: judgeResult?.summary,
      });

      if (verdict === 'approved' || score >= 80) {
        planningApproved = true;
        console.log(`[ProductPlanning] Planning approved by JUDGE`);
      } else if (verdict === 'rejected') {
        console.log(`[ProductPlanning] Planning rejected by JUDGE - stopping`);
        break;
      } else if (issues.length > 0) {
        // --- FIX ---
        console.log(`[ProductPlanning] Sending FIX prompt (${issues.length} issues)...`);
        await TaskRepository.setCurrentStep(task.id, 7, 'FIXER');
        socketService.toTask(task.id, 'agent:start', {
          agent: 'FIXER',
          phase: 'ProductPlanning',
          step: 7,
          iteration: judgeIteration,
          issuesCount: issues.length,
          sessionId,
        });

        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.fix(issues),
          { directory: projectPath, ...modelConfig }
        );

        const fixEvents = await openCodeClient.waitForIdle(sessionId, {
          directory: projectPath,
          // 🔥 No timeout - let OpenCode handle its own limits
        });

        const fixOutput = extractFinalOutput(fixEvents);
        const fixResult = extractJsonFromOutput(fixOutput);

        // Update planning data with fixes
        if (fixResult) {
          if (fixResult.enrichedPrompt) enrichResult = { ...enrichResult, ...fixResult };
          if (fixResult.tasks) breakdownResult.tasks = fixResult.tasks;
          if (fixResult.flows) uxResult.flows = fixResult.flows;
        }

        console.log(`[ProductPlanning] Applied fixes, re-evaluating...`);
      } else {
        planningApproved = true;
      }
    }

    if (!planningApproved) {
      console.warn(`[ProductPlanning] Planning not approved after ${maxJudgeIterations} iterations`);
    }

    // ========================================================================
    // STEP 7: USER APPROVAL OF PLANNING RESULTS
    // ========================================================================
    if (!autoApprove) {
      console.log(`\n[ProductPlanning] Requesting approval of planning results...`);

      const planApprovalResponse = await approvalService.requestApproval(
        task.id,
        'ProductPlanning',
        {
          type: 'planning',
          phase: 'ProductPlanning',
          phaseName: 'Product Planning',

          // Show all planning outputs
          clarifications: {
            questions: clarifyResult?.questions || [],
            answers: userAnswers,
            skipped: clarificationsSkipped,
          },
          uxFlows: uxResult?.flows || [],
          plannedTasks: breakdownResult?.tasks || [],
          enrichedPrompt: enrichResult?.enrichedPrompt || task.description,

          // Metadata
          complexity: complexityResult?.complexity,
          estimatedTotalComplexity: breakdownResult?.estimatedTotalComplexity,
          suggestedBranchName: breakdownResult?.suggestedBranchName,
          riskAreas: breakdownResult?.riskAreas,
          keyDecisions: enrichResult?.keyDecisions,
          outOfScope: enrichResult?.outOfScope,
        }
      );

      if (planApprovalResponse.action === 'reject') {
        console.log(`[ProductPlanning] Planning rejected by user`);

        // Close session
        await openCodeClient.abortSession(sessionId);

        return {
          success: false,
          sessionId,
          originalPrompt: task.description || task.title,
          planningDurationMs: Date.now() - startTime,
        };
      }

      // If user provided feedback, they may have modified the enriched prompt
      if (planApprovalResponse.feedback) {
        console.log(`[ProductPlanning] User provided modified requirements`);
      }
    }

    // Close session
    await openCodeClient.abortSession(sessionId);

    const result: ProductPlanningResult = {
      success: true,
      sessionId,
      clarifications: {
        questions: clarifyResult?.questions || [],
        answers: userAnswers,
        skipped: clarificationsSkipped,
      },
      uxFlows: uxResult?.flows || [],
      plannedTasks: breakdownResult?.tasks || [],
      enrichedPrompt: enrichResult?.enrichedPrompt || task.description || task.title,
      originalPrompt: task.description || task.title,
      planningDurationMs: Date.now() - startTime,
    };

    console.log('\n' + '═'.repeat(70));
    console.log('[ProductPlanning] ✅ Product Planning Complete');
    console.log(`[ProductPlanning]   Questions: ${result.clarifications?.questions.length || 0}`);
    console.log(`[ProductPlanning]   UX Flows: ${result.uxFlows?.length || 0}`);
    console.log(`[ProductPlanning]   Tasks: ${result.plannedTasks?.length || 0}`);
    console.log(`[ProductPlanning]   Duration: ${result.planningDurationMs}ms`);
    console.log('═'.repeat(70) + '\n');

    socketService.toTask(task.id, 'phase:completed', {
      phase: 'ProductPlanning',
      phaseName: 'Product Planning',
      success: true,
      result,
    });

    return result;

  } catch (error: any) {
    console.error(`[ProductPlanning] ❌ Error:`, error);

    socketService.toTask(task.id, 'phase:failed', {
      phase: 'ProductPlanning',
      error: error.message,
    });

    // Try to close session (only if it was created)
    if (sessionId) {
      try {
        await openCodeClient.abortSession(sessionId);
      } catch {}
    }

    return {
      success: false,
      sessionId: sessionId || 'error-no-session',
      originalPrompt: task.description || task.title,
      planningDurationMs: Date.now() - startTime,
    };
  }
}

export default { runProductPlanningPhase };
