#!/usr/bin/env node
/**
 * One CLI, five verbs, mirroring the system's jobs:
 *
 *   discover    an LLM works out how to do something, once
 *   probe       the outcomes it declared are provoked and checked, no model
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
  .argument('<capability>', 'capability id, e.g. lookup_member_savings_balance')
  .option('-i, --input <key=value>', 'capability input (repeatable)', collectInputs, {})
  .option('-v, --capability-version <n>', 'pin a specific artifact version', (v) => Number(v))
  .option('-t, --tenant <id>', `tenant to run against (${Object.keys(TENANT_RUNTIMES).join(', ')})`, DEFAULT_TENANT)
  .option('--headless', 'run without a visible browser window')
  .option('--fault <kind>', 'arm a fault in the target app before running (app_error, session_expired, slow, unexpected_dialog, validation_error, permission_denied)')
  .option('--fault-scope <scope>', 'which request the fault attaches to (any, search, member_detail, sub_account)', 'any')
  .option('--no-operator', 'fail instead of escalating to a human')
  .option('--base-url <url>', 'override the base URL and the allowlist (e.g. a staging deployment)')
  .option('--assist', 'allow one model call to locate a control the artifact can no longer find')
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
      baseUrl: opts.baseUrl,
      assist: opts.assist,
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
  .option('--vendor <name>', 'vendor the capability is recorded against')
  .option('--product <name>', 'product the capability is recorded against')
  .option('--no-probe', 'skip provoking declared outcomes; leaves them unverified hypotheses')
  .option('--max-probes <n>', 'ceiling on probe runs this discovery may spend', (v) => Number(v))
  .action(async (opts) => {
    const { runDiscoverCommand } = await import('./discover-command.js');
    const code = await runDiscoverCommand(opts);
    process.exit(code);
  });

program
  .command('probe')
  .description('Provoke a capability\'s declared outcomes and check whether they actually fire. No model involved.')
  .argument('<capability>', 'capability id, e.g. lookup_member_savings_balance')
  .option('-v, --capability-version <n>', 'pin a specific artifact version', (v) => Number(v))
  .option('-t, --tenant <id>', `tenant to run against (${Object.keys(TENANT_RUNTIMES).join(', ')})`, DEFAULT_TENANT)
  .option('-i, --input <key=value>', 'baseline input override (repeatable)', collectInputs, {})
  .option('--headless', 'run without a visible browser window')
  .option('--max-probes <n>', 'ceiling on probe runs', (v) => Number(v))
  .option('--dry-run', 'report findings without writing them back to the artifact')
  .option('--stale-only', 'only re-verify outcomes whose evidence has aged out or is missing')
  .action(async (capability: string, opts) => {
    const { runProbeCommand } = await import('./probe-command.js');
    process.exit(
      await runProbeCommand({
        capability,
        version: opts.capabilityVersion,
        tenant: opts.tenant,
        inputs: opts.input,
        headless: opts.headless,
        maxProbes: opts.maxProbes,
        dryRun: opts.dryRun,
        staleOnly: opts.staleOnly,
      }),
    );
  });

program
  .command('voice')
  .description('Serve the voice front door: speak a request, hear the answer, see where the time went.')
  .option('-p, --port <n>', 'port', (v) => Number(v), 7319)
  .option('-t, --tenant <id>', 'tenant to run capabilities against', DEFAULT_TENANT)
  .option('--route <mode>', 'how an utterance becomes a call: llm | rules', 'llm')
  .option('--no-headless', 'show the browser the capability drives')
  .action(async (opts) => {
    const { startVoiceServer } = await import('../voice/server.js');
    const route = opts.route === 'rules' ? 'rules' : 'llm';
    await startVoiceServer({ port: opts.port, tenant: opts.tenant, route, headless: opts.headless !== false });
    process.stdout.write(
      `\nVoice front door on http://localhost:${opts.port}\n` +
        `  routing: ${route}${route === 'llm' ? ' (needs ANTHROPIC_API_KEY)' : ' (deterministic, no key needed)'}\n` +
        `  tenant:  ${opts.tenant}\n\n` +
        `Speech happens in the browser. Ctrl-C to stop.\n\n`,
    );
  });

program
  .command('catalog')
  .description('List, inspect, price and approve saved capabilities.')
  .argument('[action]', 'list | show | approve | schema | economics', 'list')
  .argument('[capability]', 'capability id, for show/approve/schema/economics')
  .option('--by <name>', 'approver name', 'operator')
  .option('--note <text>', 'approval note', 'reviewed and approved for unattended replay')
  .option('--force', 'approve despite outcomes that were probed and did not fire')
  .option('--invocations <n>', 'projection horizon for `economics`', (v) => Number(v))
  .option('--from <bundle>', 'read `economics` from a committed run bundle rather than the catalog')
  .action(async (action: string, capability: string | undefined, opts) => {
    const { runCatalogCommand } = await import('./catalog-command.js');
    process.exit(await runCatalogCommand(action, capability, opts));
  });

program
  .command('fleet')
  .description('What needs attention across every capability and every institution, worst first.')
  .option('--json', 'emit the findings as JSON')
  .action(async (opts) => {
    const { runFleetCommand } = await import('./fleet-command.js');
    process.exit(await runFleetCommand({ json: opts.json }));
  });

program
  .command('audit')
  .description('Generate the audit pack for a capability: what it does, what backs it, and what it cannot vouch for.')
  .argument('[capability]', 'capability id; omit for every capability in the catalog')
  .option('-v, --capability-version <n>', 'pin a specific artifact version', (v) => Number(v))
  .option('-o, --out <path>', 'write to this path instead of audit/<id>.v<n>.md')
  .option('--stdout', 'print the document instead of writing it')
  .action(async (capability: string | undefined, opts) => {
    const { runAuditCommand } = await import('./audit-command.js');
    process.exit(
      await runAuditCommand({
        capability,
        version: opts.capabilityVersion,
        out: opts.out,
        stdout: opts.stdout,
      }),
    );
  });

program
  .command('console')
  .description('Serve the read-only capability console.')
  .option('-p, --port <n>', 'port', (v) => Number(v), 7318)
  .action(async (opts) => {
    const { startConsole } = await import('../console/server.js');
    await startConsole(opts.port);
  });

program
  .command('stability')
  .description('Replay a capability N times and report per-step locator stability.')
  .argument('<capability>', 'capability id')
  .option('-i, --input <key=value>', 'capability input (repeatable)', collectInputs, {})
  .option('-t, --tenant <id>', 'tenant to run against', DEFAULT_TENANT)
  .option('-n, --runs <n>', 'how many times to replay', (v) => Number(v), 5)
  .option('--headless', 'run without a visible browser window')
  .action(async (capability: string, opts) => {
    const { runStabilityCommand } = await import('./stability-command.js');
    process.exit(
      await runStabilityCommand({
        capability,
        inputs: opts.input,
        tenant: opts.tenant,
        runs: opts.runs,
        headless: opts.headless ?? true,
      }),
    );
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
