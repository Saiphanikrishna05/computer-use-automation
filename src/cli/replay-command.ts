/**
 * `replay` — the production execution path, driven from a terminal.
 *
 * This is the command an AI agent's tool call ultimately reduces to. It reads
 * an artifact, binds typed inputs, drives the surface with no model in the
 * loop, and prints a structured result.
 */

import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { PolicyEngine, REPLAY_POLICY } from '../policy/engine.js';
import { Redactor } from '../policy/redaction.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { ReplayEngine } from '../replay/executor.js';
import { summarize, type ReplayResult } from '../replay/result.js';
import { loadArtifact, loadOverlay, applyOverlay } from '../artifact/store.js';
import { ControlLease } from '../escalation/lease.js';
import { ConsoleEscalationHandler } from '../escalation/handler.js';
import { DEFAULT_TENANT, TENANT_RUNTIMES, resolveCredentials, headless } from '../config.js';

export interface ReplayCommandOptions {
  capability: string;
  version?: number;
  inputs: Record<string, string>;
  tenant: string;
  headless?: boolean;
  /** Arms a fault in the target app immediately before the run. */
  fault?: string;
  faultScope?: string;
  operator?: boolean;
  json?: boolean;
}

export async function runReplayCommand(options: ReplayCommandOptions): Promise<ReplayResult> {
  const tenant = TENANT_RUNTIMES[options.tenant] ?? TENANT_RUNTIMES[DEFAULT_TENANT]!;
  const base = loadArtifact(options.capability, options.version);

  const overlay = tenant.overlayId ? loadOverlay(tenant.overlayId) : undefined;
  const specialized = applyOverlay(base, overlay);

  const runId = newRunId('replay');
  const redactor = new Redactor();
  const credentials = resolveCredentials(tenant.id);
  // The password is registered as a literal so it is scrubbed everywhere, even
  // from places no pattern would recognise it — an error message, a DOM dump.
  redactor.addLiteral(credentials.operatorPassword);

  const logger = new RunLogger({ runId, redactor, echo: !options.json });

  if (options.fault) {
    await armFault(tenant.baseUrl, options.fault, options.faultScope ?? 'any');
    logger.event('note', `armed fault "${options.fault}" on scope "${options.faultScope ?? 'any'}"`);
  }

  if (specialized.appliedChanges.length > 0) {
    logger.event('note', `tenant overlay "${tenant.id}" applied`, { changes: specialized.appliedChanges });
  }

  const lease = new ControlLease(runId);
  lease.on('transition', (t) => logger.event('control_transfer', `${t.from} → ${t.to} (${t.actor})`, { ...t }));

  const policy = new PolicyEngine({
    ...REPLAY_POLICY,
    allowedOrigins: [tenant.baseUrl],
  });

  const driver = await PlaywrightWebSurface.launch({
    policy,
    lease,
    redactor,
    headless: headless(options.headless),
    onEvent: (type, message, data) => {
      // Policy allows are the common case and would drown the log; only
      // denials and non-policy events are worth a line.
      if (type === 'policy_decision' && message.includes('allow')) return;
      logger.event(type as never, message, data);
    },
  });

  try {
    const engine = new ReplayEngine({
      artifact: specialized.artifact,
      inputs: {
        ...options.inputs,
        operatorId: credentials.operatorId,
        operatorPassword: credentials.operatorPassword,
      },
      driver,
      policy,
      logger,
      tenantId: tenant.id,
      bindings: { baseUrl: tenant.baseUrl, ...specialized.bindings },
      ...(options.operator === false ? {} : { escalation: new ConsoleEscalationHandler(lease, logger, driver) }),
    });

    const result = await engine.run();
    logger.writeJson('result.json', result);
    return result;
  } finally {
    await driver.close();
  }
}

async function armFault(baseUrl: string, kind: string, scope: string): Promise<void> {
  const response = await fetch(`${baseUrl}/_admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, scope }),
  });
  if (!response.ok) {
    throw new Error(`Could not arm fault "${kind}": ${response.status} ${await response.text()}`);
  }
}

export function printResult(result: ReplayResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const line = (label: string, value: string) => process.stdout.write(`  ${label.padEnd(22)}${value}\n`);
  process.stdout.write(`\n${'─'.repeat(72)}\n`);
  process.stdout.write(`  ${result.capabilityId} v${result.capabilityVersion} → ${result.status.toUpperCase()}\n`);
  process.stdout.write(`${'─'.repeat(72)}\n`);
  line('tenant', result.tenantId ?? '(none)');
  line('duration', `${result.durationMs}ms`);
  line('steps', `${result.steps.filter((s) => s.status !== 'failed').length}/${result.steps.length} completed`);
  line('degraded locators', String(result.degradedResolutions));

  switch (result.status) {
    case 'success':
      process.stdout.write('\n  outputs:\n');
      for (const [k, v] of Object.entries(result.outputs)) {
        process.stdout.write(`    ${k.padEnd(22)}${JSON.stringify(v)}\n`);
      }
      break;
    case 'business_outcome':
      process.stdout.write(`\n  outcome: ${result.outcome}\n  ${result.outcomeDescription}\n`);
      break;
    case 'escalated':
      process.stdout.write(`\n  intervention: ${result.interventionId}\n  ${result.reason}\n`);
      break;
    case 'failure':
      process.stdout.write(`\n  error: ${result.error.code}\n`);
      if (result.error.stepId) line('  at step', result.error.stepId);
      line('  expected', result.error.expected);
      line('  observed', result.error.observed.slice(0, 160));
      if (result.error.detail) line('  detail', result.error.detail.slice(0, 160));
      break;
  }

  process.stdout.write(`\n  evidence: ${result.evidence.bundlePath}\n`);
  process.stdout.write(`${'─'.repeat(72)}\n${summarize(result)}\n\n`);
}
