/**
 * Test Generation Phase
 *
 * Runs after Developer Phase to:
 * 1. Analyze code coverage gaps
 * 2. Detect missing edge cases
 * 3. Generate comprehensive tests
 * 4. Execute tests and validate
 *
 * If tests fail, loops back to Developer Phase for fixes.
 */

import { Task, StoryResultV2 } from '../../types/index.js';
import { openCodeClient } from '../../services/opencode/OpenCodeClient.js';
import { openCodeEventBridge } from '../../services/opencode/OpenCodeEventBridge.js';
import { socketService } from '../../services/realtime/SocketService.js';
import { approvalService } from '../../services/realtime/ApprovalService.js';
import { SessionRepository } from '../../database/repositories/index.js';
import { agentSpy, VulnerabilityType } from '../../services/security/AgentSpy.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TestGenerationContext {
  task: Task;
  projectPath: string;
  stories: StoryResultV2[];
  autoApprove: boolean;
  llmConfig?: {
    providerID: string;
    modelID: string;
    apiKey?: string;
  };
  testFramework?: 'jest' | 'vitest' | 'pytest' | 'go-test' | 'auto';
  coverageThreshold?: number; // 0-100
  maxIterations?: number;
}

export interface EdgeCase {
  id: string;
  type: 'boundary' | 'null' | 'error' | 'async' | 'concurrency' | 'security';
  description: string;
  targetFunction: string;
  targetFile: string;
  suggestedTest: string;
  priority: 'high' | 'medium' | 'low';
}

export interface CoverageGap {
  file: string;
  function?: string;
  line?: number;
  type: 'branch' | 'statement' | 'function';
  description: string;
}

export interface GeneratedTest {
  file: string;
  testName: string;
  testCode: string;
  targetFile: string;
  targetFunction?: string;
  edgeCases: string[];
}

export interface FixAttempt {
  iteration: number;
  failedTests: {
    name: string;
    file: string;
    error: string;
  }[];
  fixesApplied: {
    type: 'test' | 'source' | 'both';
    file: string;
    description: string;
  }[];
  testsPassedAfter: number;
  testsFailedAfter: number;
  success: boolean;
}

export interface TestGenerationResult {
  success: boolean;
  sessionId: string;
  testsGenerated: GeneratedTest[];
  edgeCasesDetected: EdgeCase[];
  coverageGaps: CoverageGap[];
  testsPassed: boolean;
  testsRun: number;
  testsFailed: number;
  coverageBefore?: number;
  coverageAfter?: number;
  iterations: number;
  /** Track each fix attempt with details */
  fixAttempts: FixAttempt[];
  error?: string;
}

// ============================================================================
// PROMPTS
// ============================================================================

const PROMPTS = {
  analyzeForTests: (task: Task, stories: StoryResultV2[], projectContext: string) => `
You are a Test Engineering Specialist. Analyze the code changes and identify what tests need to be written.

## Task
${task.title}
${task.description || ''}

## Stories Implemented
${stories.map((s, i) => `
### Story ${i + 1}: ${s.title}
- Files modified: ${s.filesToModify?.join(', ') || 'N/A'}
- Files created: ${s.filesToCreate?.join(', ') || 'N/A'}
`).join('\n')}

## Project Context
${projectContext}

## Your Analysis Should Include

1. **Coverage Gaps**: Identify code that lacks test coverage
   - New functions without tests
   - Modified functions with outdated tests
   - Branches not covered (if/else, try/catch, switch cases)

2. **Edge Cases**: For each function, identify missing edge case tests:
   - Boundary values (0, -1, MAX_INT, empty arrays, empty strings)
   - Null/undefined handling
   - Error conditions (network failures, invalid inputs)
   - Async edge cases (timeouts, race conditions)
   - Security edge cases (injection, overflow)

3. **Test Framework**: Detect which test framework is used (Jest, Vitest, Pytest, Go test, etc.)

Respond with JSON:
\`\`\`json
{
  "testFramework": "jest|vitest|pytest|go-test|other",
  "coverageGaps": [
    {
      "file": "src/services/auth.ts",
      "function": "validateToken",
      "type": "branch",
      "description": "Error handling branch not tested"
    }
  ],
  "edgeCases": [
    {
      "id": "EC001",
      "type": "null",
      "description": "validateToken should handle null token",
      "targetFunction": "validateToken",
      "targetFile": "src/services/auth.ts",
      "priority": "high"
    }
  ],
  "existingTestFiles": ["src/__tests__/auth.test.ts"]
}
\`\`\`
`,

  generateTests: (gaps: CoverageGap[], edgeCases: EdgeCase[], framework: string) => `
You are a Test Engineering Specialist. Generate comprehensive tests for the identified gaps.

## Test Framework: ${framework}

## Coverage Gaps to Address
${gaps.map(g => `- ${g.file}${g.function ? `:${g.function}` : ''} - ${g.description}`).join('\n')}

## Edge Cases to Test
${edgeCases.map(e => `
### ${e.id} (${e.priority})
- Type: ${e.type}
- Target: ${e.targetFile}:${e.targetFunction}
- Description: ${e.description}
`).join('\n')}

## Requirements
1. Write tests that cover ALL identified gaps and edge cases
2. Use appropriate mocking for external dependencies
3. Include descriptive test names that explain what is being tested
4. Group related tests using describe blocks
5. Include setup/teardown when needed
6. Assert specific expected behaviors

Generate the test files. For each test file, provide:
\`\`\`json
{
  "tests": [
    {
      "file": "src/__tests__/auth.test.ts",
      "testName": "validateToken handles null input",
      "targetFile": "src/services/auth.ts",
      "targetFunction": "validateToken",
      "edgeCases": ["null input", "undefined input"],
      "testCode": "... full test code ..."
    }
  ]
}
\`\`\`

After the JSON, write the actual test files using the Write tool.
`,

  runTests: (testFiles: string[], framework: string) => `
Run the tests and report results.

## Test Framework: ${framework}
## Test Files
${testFiles.join('\n')}

Run the appropriate test command:
- Jest: npx jest ${testFiles.join(' ')} --coverage
- Vitest: npx vitest run ${testFiles.join(' ')} --coverage
- Pytest: pytest ${testFiles.join(' ')} --cov
- Go: go test ${testFiles.join(' ')} -cover

After running, report:
\`\`\`json
{
  "success": true|false,
  "testsRun": 15,
  "testsPassed": 14,
  "testsFailed": 1,
  "coveragePercent": 85.5,
  "failedTests": [
    {
      "name": "test name",
      "file": "file path",
      "error": "error message"
    }
  ]
}
\`\`\`
`,

  fixFailedTests: (failedTests: any[], iteration: number) => `
You are a Test Fixer Specialist. Fix the following failed tests (Iteration ${iteration}).

## Failed Tests
${failedTests.map(t => `
### ${t.name}
- File: ${t.file}
- Error: ${t.error}
`).join('\n')}

## Analysis Steps
1. Read the test file and the source code it's testing
2. Understand why the test is failing
3. Determine if the issue is in the test or the source code
4. Apply the minimal fix needed

## Fix Strategy
- If the test has incorrect expectations → fix the test
- If there's an actual bug in source code → fix the source
- If both need changes → fix both

After applying fixes, report what you changed:
\`\`\`json
{
  "fixesApplied": [
    {
      "type": "test|source|both",
      "file": "path/to/file.ts",
      "description": "Brief description of what was fixed"
    }
  ]
}
\`\`\`

Then run the tests again to verify the fixes work.
`,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract balanced JSON from a string (handles nested braces properly)
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

/**
 * Robust JSON extraction with multiple fallback strategies
 */
function extractJsonFromOutput(output: string): any {
  if (!output || output.length === 0) {
    console.warn('[TestGeneration] extractJsonFromOutput: Empty output');
    return null;
  }

  // 1. Try code block first (most common)
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e: any) {
      console.warn('[TestGeneration] Failed to parse JSON from code block:', e.message?.substring(0, 100));
    }
  }

  // 2. Try raw JSON patterns with specific keys
  const rawJsonPatterns = [
    /\{[\s\S]*?"tests"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"testFramework"\s*:[\s\S]*\}/,
    /\{[\s\S]*?"coverageGaps"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"edgeCases"\s*:\s*\[[\s\S]*\]/,
    /\{[\s\S]*?"success"\s*:[\s\S]*\}/,
    /\{[\s\S]*?"fixesApplied"\s*:\s*\[[\s\S]*\]/,
  ];

  for (const pattern of rawJsonPatterns) {
    const match = output.match(pattern);
    if (match) {
      const balanced = extractBalancedJson(match[0]);
      if (balanced) {
        try {
          return JSON.parse(balanced);
        } catch (e: any) {
          console.warn('[TestGeneration] Pattern matched but JSON parse failed:', e.message?.substring(0, 100));
        }
      }
    }
  }

  // 3. Try parsing whole output
  try {
    return JSON.parse(output);
  } catch (e) {
    // Not valid JSON
  }

  // 4. Last resort: find ANY valid JSON object
  const balanced = extractBalancedJson(output);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch (e: any) {
      console.warn('[TestGeneration] Balanced extraction failed:', e.message?.substring(0, 100));
    }
  }

  console.error('[TestGeneration] extractJsonFromOutput: No valid JSON found in output');
  return null;
}

function extractFinalOutput(events: any[]): string {
  // 🔥 FIX: Handle raw OpenCode events which have different structure:
  // - message.part.updated: { properties: { part: { type: 'text', text: '...' } } }
  // - message.complete: { properties: { content: '...' } }
  // - message.delta/chunk: { properties: { content: '...', text: '...' } }
  const textContent: string[] = [];

  for (const e of events) {
    // Raw OpenCode events (from waitForIdle)
    if (e.type === 'message.part.updated' && e.properties?.part?.type === 'text') {
      const text = e.properties.part.text;
      if (text) textContent.push(text);
    } else if (e.type === 'message.complete' && e.properties?.content) {
      textContent.push(e.properties.content);
    } else if ((e.type === 'message.delta' || e.type === 'message.chunk') && e.properties) {
      const text = e.properties.content || e.properties.text;
      if (text) textContent.push(text);
    }
    // Also handle transformed events (in case they come from a different source)
    else if (e.type === 'text' || e.type === 'assistant' || e.type === 'message') {
      const text = e.content || e.text;
      if (text) textContent.push(text);
    }
    // Handle agent_output/agent_message transformed events
    else if ((e.type === 'agent_output' || e.type === 'agent_message') && e.data?.content) {
      textContent.push(e.data.content);
    }
  }

  const output = textContent.join('');
  console.log(`[TestGeneration] extractFinalOutput: Found ${textContent.length} text chunks, total length: ${output.length}`);
  return output;
}

// ============================================================================
// MAIN PHASE FUNCTION
// ============================================================================

export async function runTestGenerationPhase(
  context: TestGenerationContext
): Promise<TestGenerationResult> {
  const {
    task,
    projectPath,
    stories,
    autoApprove,
    llmConfig,
    coverageThreshold = 70,
    maxIterations = 3,
  } = context;

  const startTime = Date.now();
  let iteration = 0;

  console.log('\n' + '═'.repeat(70));
  console.log('[TestGeneration] 🧪 Starting Test Generation Phase');
  console.log(`[TestGeneration] Task: "${task.title}"`);
  console.log(`[TestGeneration] Stories: ${stories.length}`);
  console.log(`[TestGeneration] Coverage Threshold: ${coverageThreshold}%`);
  console.log('═'.repeat(70));

  // 🔥 Build model config for sendPrompt (must be { model: { providerID, modelID } })
  const modelConfig = llmConfig ? {
    model: { providerID: llmConfig.providerID, modelID: llmConfig.modelID },
  } : {};

  socketService.toTask(task.id, 'phase:started', {
    phase: 'TestGeneration',
    phaseName: 'Test Generation',
  });

  let sessionId: string = '';

  try {
    // Create OpenCode session
    sessionId = await openCodeClient.createSession({
      title: `Tests: ${task.title}`,
      directory: projectPath,
      autoApprove: true, // Auto-approve tool calls for test generation
    });

    openCodeEventBridge.registerSession(task.id, sessionId, projectPath);

    await SessionRepository.create({
      sessionId,
      taskId: task.id,
      directory: projectPath,
      phaseName: 'TestGeneration',
      approvalMode: 'all',
    });

    // ========================================================================
    // STEP 1: ANALYZE FOR TESTS
    // ========================================================================
    console.log(`\n[TestGeneration] Step 1: Analyzing code for test gaps...`);

    socketService.toTask(task.id, 'agent:progress', {
      phase: 'TestGeneration',
      step: 'analyzing',
      message: 'Analyzing code for test gaps and edge cases...',
    });

    // Get project context (simplified for now)
    const projectContext = stories.map(s => `
Files: ${[...(s.filesToModify || []), ...(s.filesToCreate || [])].join(', ')}
    `).join('\n');

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.analyzeForTests(task, stories, projectContext),
      { directory: projectPath, ...modelConfig }
    );

    // 🔥 NO TIMEOUT - Let OpenCode manage its own internal limits
    const analysisEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
    });

    const analysisOutput = extractFinalOutput(analysisEvents);
    const analysisResult = extractJsonFromOutput(analysisOutput);

    if (!analysisResult) {
      throw new Error('Failed to analyze code for tests');
    }

    const testFramework = analysisResult.testFramework || 'jest';
    const coverageGaps: CoverageGap[] = analysisResult.coverageGaps || [];
    const edgeCases: EdgeCase[] = analysisResult.edgeCases || [];

    console.log(`[TestGeneration] Found ${coverageGaps.length} coverage gaps`);
    console.log(`[TestGeneration] Found ${edgeCases.length} edge cases`);
    console.log(`[TestGeneration] Test framework: ${testFramework}`);

    // 🔥 SENTINENTAL: Register security edge cases with AgentSpy
    // These will be picked up by sentinentalWebhook.push(taskId) at end of orchestration
    const securityEdgeCases = edgeCases.filter(e => e.type === 'security');
    if (securityEdgeCases.length > 0) {
      console.log(`[TestGeneration] 🛡️ Registering ${securityEdgeCases.length} security edge cases with AgentSpy`);
      for (const edgeCase of securityEdgeCases) {
        agentSpy.registerExternalVulnerability(task.id, {
          taskId: task.id,
          sessionId,
          phase: 'TestGeneration',
          severity: edgeCase.priority === 'high' ? 'high' : edgeCase.priority === 'medium' ? 'medium' : 'low',
          type: 'code_injection' as VulnerabilityType, // Security edge cases are typically injection-related
          description: `Security edge case: ${edgeCase.description}`,
          evidence: {
            targetFile: edgeCase.targetFile,
            targetFunction: edgeCase.targetFunction,
            suggestedTest: edgeCase.suggestedTest,
            edgeCaseId: edgeCase.id,
          },
          blocked: false,
          category: 'security_edge_case',
          filePath: edgeCase.targetFile,
          recommendation: edgeCase.suggestedTest,
          owaspCategory: 'A03:2021-Injection',
          cweId: 'CWE-20', // Improper Input Validation
        });
      }
    }

    // If no gaps or edge cases, skip test generation
    if (coverageGaps.length === 0 && edgeCases.length === 0) {
      console.log(`[TestGeneration] ✅ No gaps detected, skipping generation`);

      await openCodeClient.abortSession(sessionId);

      return {
        success: true,
        sessionId,
        testsGenerated: [],
        edgeCasesDetected: [],
        coverageGaps: [],
        testsPassed: true,
        testsRun: 0,
        testsFailed: 0,
        iterations: 0,
        fixAttempts: [],
      };
    }

    // ========================================================================
    // STEP 2: GENERATE TESTS
    // ========================================================================
    console.log(`\n[TestGeneration] Step 2: Generating tests...`);

    socketService.toTask(task.id, 'agent:progress', {
      phase: 'TestGeneration',
      step: 'generating',
      message: `Generating tests for ${coverageGaps.length} gaps and ${edgeCases.length} edge cases...`,
    });

    await openCodeClient.sendPrompt(
      sessionId,
      PROMPTS.generateTests(coverageGaps, edgeCases, testFramework),
      { directory: projectPath, ...modelConfig }
    );

    const generateEvents = await openCodeClient.waitForIdle(sessionId, {
      directory: projectPath,
      // 🔥 No timeout - let OpenCode handle its own limits
    });

    const generateOutput = extractFinalOutput(generateEvents);
    const generateResult = extractJsonFromOutput(generateOutput);

    const testsGenerated: GeneratedTest[] = generateResult?.tests || [];
    const testFiles = testsGenerated.map(t => t.file);

    console.log(`[TestGeneration] Generated ${testsGenerated.length} test files`);

    // ========================================================================
    // STEP 3: RUN TESTS (with internal Fixer loop)
    // ========================================================================
    let testsPassed = false;
    let testsRun = 0;
    let testsFailed = 0;
    let coverageAfter = 0;
    let failedTests: any[] = [];
    const fixAttempts: FixAttempt[] = [];

    while (!testsPassed && iteration < maxIterations) {
      iteration++;
      console.log(`\n[TestGeneration] Step 3: Running tests (iteration ${iteration}/${maxIterations})...`);

      socketService.toTask(task.id, 'agent:progress', {
        phase: 'TestGeneration',
        step: 'running',
        message: `Running tests (iteration ${iteration})...`,
        iteration,
      });

      await openCodeClient.sendPrompt(
        sessionId,
        PROMPTS.runTests(testFiles, testFramework),
        { directory: projectPath, ...modelConfig }
      );

      // 🔥 NO TIMEOUT - Let OpenCode manage its own internal limits
      const runEvents = await openCodeClient.waitForIdle(sessionId, {
        directory: projectPath,
      });

      const runOutput = extractFinalOutput(runEvents);
      const runResult = extractJsonFromOutput(runOutput);

      testsRun = runResult?.testsRun || 0;
      testsFailed = runResult?.testsFailed || 0;
      coverageAfter = runResult?.coveragePercent || 0;
      failedTests = runResult?.failedTests || [];

      testsPassed = testsFailed === 0;

      console.log(`[TestGeneration] Tests: ${testsRun - testsFailed}/${testsRun} passed`);
      console.log(`[TestGeneration] Coverage: ${coverageAfter}%`);

      if (!testsPassed && iteration < maxIterations) {
        // 🔧 INTERNAL FIXER: Fix failed tests in the same session
        console.log(`\n[TestGeneration] 🔧 Fixer: Fixing ${testsFailed} failed tests (iteration ${iteration})...`);

        socketService.toTask(task.id, 'agent:progress', {
          phase: 'TestGeneration',
          step: 'fixing',
          message: `🔧 Fixer: Analyzing and fixing ${testsFailed} failed tests...`,
          iteration,
          failedCount: testsFailed,
        });

        await openCodeClient.sendPrompt(
          sessionId,
          PROMPTS.fixFailedTests(failedTests, iteration),
          { directory: projectPath, ...modelConfig }
        );

        const fixEvents = await openCodeClient.waitForIdle(sessionId, {
          directory: projectPath,
          // 🔥 No timeout - let OpenCode handle its own limits
        });

        // Parse fix results
        const fixOutput = extractFinalOutput(fixEvents);
        const fixResult = extractJsonFromOutput(fixOutput);

        // Track this fix attempt
        const fixAttempt: FixAttempt = {
          iteration,
          failedTests: failedTests.map(t => ({
            name: t.name,
            file: t.file,
            error: t.error,
          })),
          fixesApplied: fixResult?.fixesApplied || [],
          testsPassedAfter: 0, // Will be updated after next test run
          testsFailedAfter: 0,
          success: false,
        };

        // Log fixes applied
        if (fixResult?.fixesApplied?.length > 0) {
          console.log(`[TestGeneration] 🔧 Applied ${fixResult.fixesApplied.length} fixes:`);
          for (const fix of fixResult.fixesApplied) {
            console.log(`  - [${fix.type}] ${fix.file}: ${fix.description}`);
          }
        }

        fixAttempts.push(fixAttempt);

        // Notify frontend about fix attempt
        socketService.toTask(task.id, 'testgen:fix_applied', {
          iteration,
          failedTests: failedTests.length,
          fixesApplied: fixResult?.fixesApplied || [],
        });
      }
    }

    // Update last fix attempt with final results
    if (fixAttempts.length > 0) {
      const lastAttempt = fixAttempts[fixAttempts.length - 1];
      lastAttempt.testsPassedAfter = testsRun - testsFailed;
      lastAttempt.testsFailedAfter = testsFailed;
      lastAttempt.success = testsPassed;
    }

    // ========================================================================
    // STEP 4: REQUEST APPROVAL (if not auto-approve)
    // ========================================================================
    if (!autoApprove) {
      console.log(`\n[TestGeneration] Step 4: Requesting approval...`);

      const approvalResponse = await approvalService.requestApproval(
        task.id,
        'TestGeneration',
        {
          testsGenerated: testsGenerated.length,
          edgeCasesDetected: edgeCases.length,
          coverageGaps: coverageGaps.length,
          testsPassed,
          testsRun,
          testsFailed,
          coverage: coverageAfter,
          iterations: iteration,
        }
      );

      if (approvalResponse.action === 'reject') {
        console.log(`[TestGeneration] Tests rejected by user`);

        await openCodeClient.abortSession(sessionId);

        return {
          success: false,
          sessionId,
          testsGenerated,
          edgeCasesDetected: edgeCases,
          coverageGaps,
          testsPassed: false,
          testsRun,
          testsFailed,
          coverageAfter,
          iterations: iteration,
          fixAttempts,
          error: 'Rejected by user',
        };
      }
    }

    // Close session
    await openCodeClient.abortSession(sessionId);

    // Log summary
    console.log(`\n[TestGeneration] ✅ Test Generation Phase complete`);
    console.log(`[TestGeneration] Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`[TestGeneration] Tests: ${testsRun} run, ${testsRun - testsFailed} passed`);
    console.log(`[TestGeneration] Coverage: ${coverageAfter}%`);

    if (fixAttempts.length > 0) {
      console.log(`[TestGeneration] 🔧 Fix iterations: ${fixAttempts.length}`);
      const totalFixes = fixAttempts.reduce((sum, a) => sum + a.fixesApplied.length, 0);
      console.log(`[TestGeneration] 🔧 Total fixes applied: ${totalFixes}`);
    }

    socketService.toTask(task.id, 'phase:completed', {
      phase: 'TestGeneration',
      testsGenerated: testsGenerated.length,
      testsPassed,
      coverage: coverageAfter,
      iterations: iteration,
      fixAttempts: fixAttempts.length,
      totalFixesApplied: fixAttempts.reduce((sum, a) => sum + a.fixesApplied.length, 0),
    });

    return {
      success: testsPassed,
      sessionId,
      testsGenerated,
      edgeCasesDetected: edgeCases,
      coverageGaps,
      testsPassed,
      testsRun,
      testsFailed,
      coverageAfter,
      iterations: iteration,
      fixAttempts,
    };

  } catch (error: any) {
    console.error(`[TestGeneration] ❌ Error:`, error);

    socketService.toTask(task.id, 'phase:failed', {
      phase: 'TestGeneration',
      error: error.message,
    });

    if (sessionId) {
      try {
        await openCodeClient.abortSession(sessionId);
      } catch {}
    }

    return {
      success: false,
      sessionId: sessionId || 'error-no-session',
      testsGenerated: [],
      edgeCasesDetected: [],
      coverageGaps: [],
      testsPassed: false,
      testsRun: 0,
      testsFailed: 0,
      iterations: iteration,
      fixAttempts: [],
      error: error.message,
    };
  }
}

export default { runTestGenerationPhase };
