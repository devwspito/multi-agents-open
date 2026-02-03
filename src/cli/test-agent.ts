#!/usr/bin/env tsx
/**
 * Test Agent Execution
 *
 * Simple CLI to test agent execution with tracking.
 * Usage: npm run test:agent
 */

import 'dotenv/config';
import { connectDatabase, closeDatabase } from '../database/index.js';
import { providerFactory } from '../services/providers/ProviderFactory.js';
import { agentExecutor } from '../services/agents/AgentExecutorService.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { trainingExportService } from '../services/training/TrainingExportService.js';
import { toolDefinitions, toolHandlers } from '../tools/index.js';

async function main() {
  console.log('='.repeat(60));
  console.log(' Open Multi-Agents - Test Agent Execution');
  console.log('='.repeat(60));

  // Initialize database
  await connectDatabase();
  console.log('[Test] Database initialized');

  // Check provider
  let provider;
  try {
    provider = await providerFactory.getDefault();
    console.log(`[Test] Provider: ${provider.type} (${provider.model})`);
  } catch (error: any) {
    console.error(`[Test] ERROR: Cannot connect to LLM provider`);
    console.error(`[Test] Make sure DGX Spark or Ollama is running`);
    console.error(`[Test] Error: ${error.message}`);
    process.exit(1);
  }

  // Create a test task
  const task = TaskRepository.create({
    title: 'Test Agent Execution',
    description: 'Simple test to verify agent execution with tracking',
  });
  console.log(`[Test] Created task: ${task.id}`);

  // Update task status
  TaskRepository.updateStatus(task.id, 'running');

  // Define test prompt
  const testPrompt = `You are a helpful coding assistant.

Please do the following:
1. Use the Glob tool to find all TypeScript files in the current directory (pattern: "**/*.ts")
2. Pick one of the files and use the Read tool to read its first 20 lines
3. Summarize what you found

Be concise in your response.`;

  console.log('\n[Test] Starting agent execution...');
  console.log('[Test] Prompt:', testPrompt.substring(0, 100) + '...');
  console.log('');

  try {
    // Execute agent with streaming
    for await (const event of agentExecutor.executeStream(
      {
        taskId: task.id,
        agentType: 'test-agent',
        phaseName: 'TestPhase',
        prompt: testPrompt,
        systemPrompt: 'You are a helpful coding assistant. Use the available tools to complete tasks.',
        tools: toolDefinitions,
        maxTurns: 10,
        temperature: 0.7,
      },
      {
        toolHandlers,
      }
    )) {
      switch (event.type) {
        case 'turn_start':
          console.log(`\n--- Turn ${event.data.turn} ---`);
          break;

        case 'content':
          process.stdout.write(event.data.content);
          break;

        case 'tool_start':
          console.log(`\n[Tool] ${event.data.toolName}(${JSON.stringify(event.data.input).substring(0, 100)}...)`);
          break;

        case 'tool_result':
          const resultPreview = event.data.output?.substring(0, 200) || '';
          console.log(`[Tool Result] ${event.data.success ? '✓' : '✗'} ${resultPreview}${resultPreview.length >= 200 ? '...' : ''}`);
          break;

        case 'done':
          console.log('\n\n[Test] Execution completed!');
          console.log(`[Test] Turns: ${event.data.turns}`);
          console.log(`[Test] Tool calls: ${event.data.toolCalls.length}`);
          console.log(`[Test] Tokens: ${event.data.usage.totalTokens}`);
          console.log(`[Test] Duration: ${event.data.durationMs}ms`);
          break;

        case 'error':
          console.error('\n[Test] ERROR:', event.data.error);
          break;
      }
    }

    // Update task status
    TaskRepository.updateStatus(task.id, 'completed');

    // Export training data
    console.log('\n[Test] Exporting training data...');
    const trainingData = await trainingExportService.exportTask(task.id);

    console.log('[Test] Training data exported:');
    console.log(`  - Executions: ${trainingData.summary.totalExecutions}`);
    console.log(`  - Turns: ${trainingData.summary.totalTurns}`);
    console.log(`  - Tool calls: ${trainingData.summary.totalToolCalls}`);
    console.log(`  - Status: ${trainingData.summary.status}`);

    // Save to file
    const exportPath = `./data/training/test_${task.id}.json`;
    await trainingExportService.exportToFile(task.id, exportPath);
    console.log(`[Test] Saved to: ${exportPath}`);

  } catch (error: any) {
    console.error('\n[Test] Execution failed:', error.message);
    TaskRepository.updateStatus(task.id, 'failed');
  }

  // Cleanup
  closeDatabase();
  console.log('\n[Test] Done!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
