#!/usr/bin/env node
/**
 * One CLI, four verbs, mirroring the system's four jobs:
 *
 *   discover    an LLM works out how to do something, once
 *   replay      that recording runs deterministically, forever after
 *   catalog     what capabilities exist, and are they approved to run
 *   agent-demo  an AI agent picks a capability and invokes it by name
 */

import { Command } from 'commander';
import { runReplayCommand, printResult } from './replay-command.js';
import { DEFAULT_TENANT, TENANT_RUNTIMES } from '../config.js';

const program = new Command();

program
  .name('cua')
  .description('Record-once / replay-many computer-use automation for applications with no API')
  .showHelpAfterError();

function collectInputs(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=');
  if (idx === -1) throw new Error(`--input expects key=value, received "${value}"`);
  return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

program
  .command('replay')
  .description('Replay a saved capability deterministically. No model is involved.')
  .argument('<capability>', 'capability id, e.g. lookup_member_balance')
  .option('-i, --input <key=value>', 'capability input (repeatable)', collectInputs, {})
  .option('-v, --capability-version <n>', 'pin a specific artifact version', (v) => Number(v))
  .option('-t, --tenant <id>', `tenant to run against (${Object.keys(TENANT_RUNTIMES).join(', ')})`, DEFAULT_TENANT)
  .option('--headless', 'run without a visible browser window')
  .option('--fault <kind>', 'arm a fault in the target app before running (app_error, session_expired, slow, unexpected_dialog, validation_error, permission_denied)')
  .option('--fault-scope <scope>', 'which request the fault attaches to (any, search, member_detail, sub_account)', 'any')
  .option('--no-operator', 'fail instead of escalating to a human')
  .option('--json', 'print the raw result object')
  .action(async (capability: string, opts) => {
    const result = await runReplayCommand({
      capability,
      version: opts.capabilityVersion,
      inputs: opts.input,
      tenant: opts.tenant,
      headless: opts.headless,
      fault: opts.fault,
      faultScope: opts.faultScope,
      operator: opts.operator,
      json: opts.json,
    });
    printResult(result, Boolean(opts.json));
    // Exit codes let a caller branch without parsing stdout: 0 succeeded,
    // 2 is a real answer that isn't success, 1 is a genuine failure.
    process.exit(result.status === 'success' ? 0 : result.status === 'failure' ? 1 : 2);
  });

program
  .command('discover')
  .description('Drive a live application with an LLM until a goal is met, then emit a capability artifact.')
  .requiredOption('-g, --goal <text>', 'the goal, in natural language')
  .option('-t, --tenant <id>', 'tenant to explore against', DEFAULT_TENANT)
  .option('--target <url>', 'override the entry URL')
  .option('--capability-id <id>', 'id for the emitted artifact (default: derived from the goal)')
  .option('--headless', 'run without a visible browser window')
  .option('--max-steps <n>', 'stop after this many model turns', (v) => Number(v))
  .action(async (opts) => {
    const { runDiscoverCommand } = await import('./discover-command.js');
    const code = await runDiscoverCommand(opts);
    process.exit(code);
  });

program
  .command('catalog')
  .description('List, inspect and approve saved capabilities.')
  .argument('[action]', 'list | show | approve | schema', 'list')
  .argument('[capability]', 'capability id, for show/approve/schema')
  .option('--by <name>', 'approver name', 'operator')
  .option('--note <text>', 'approval note', 'reviewed and approved for unattended replay')
  .action(async (action: string, capability: string | undefined, opts) => {
    const { runCatalogCommand } = await import('./catalog-command.js');
    process.exit(await runCatalogCommand(action, capability, opts));
  });

program
  .command('agent-demo')
  .description('Give an AI agent a request and let it choose and invoke a capability from the catalog.')
  .argument('<request>', 'what to ask the agent, in natural language')
  .option('-t, --tenant <id>', 'tenant to run against', DEFAULT_TENANT)
  .option('--headless', 'run without a visible browser window')
  .action(async (request: string, opts) => {
    const { runAgentDemoCommand } = await import('./agent-demo-command.js');
    process.exit(await runAgentDemoCommand(request, opts));
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`);
  process.exit(1);
});
