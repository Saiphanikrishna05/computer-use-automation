/**
 * `discover`, the one path in the system that costs money and is not
 * deterministic, run once per capability.
 */

import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { PolicyEngine, DISCOVERY_POLICY } from '../policy/engine.js';
import { Redactor } from '../policy/redaction.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { runDiscovery } from '../discovery/agent.js';
import { StepRecorder } from '../discovery/recorder.js';
import { saveArtifact } from '../artifact/store.js';
import { validateAgainstEntryState } from '../discovery/validate.js';
import { DEFAULT_TENANT, TENANT_RUNTIMES, headless, modelConfig, resolveCredentials } from '../config.js';

export interface DiscoverCommandOptions {
  goal: string;
  tenant: string;
  target?: string;
  capabilityId?: string;
  headless?: boolean;
  maxSteps?: number;
  /** Vendor/product the capability is recorded against. Defaults to the
   *  stand-in console; overridden when exploring a different application. */
  vendor?: string;
  product?: string;
}

export async function runDiscoverCommand(opts: DiscoverCommandOptions): Promise<number> {
  const model = modelConfig();
  if (!model.apiKey) {
    process.stderr.write(
      '\nANTHROPIC_API_KEY is not set.\n\n' +
        'Discovery is the one path that needs a model. Copy .env.example to .env and add your key:\n' +
        '  cp .env.example .env && $EDITOR .env\n\n' +
        'Replay never needs it, `npm run replay` works with no key at all.\n\n',
    );
    return 1;
  }

  const tenant = TENANT_RUNTIMES[opts.tenant] ?? TENANT_RUNTIMES[DEFAULT_TENANT]!;
  const entryUrl = opts.target ?? `${tenant.baseUrl}/`;
  const entryOrigin = new URL(entryUrl).origin;
  // Canonicalisation and validation follow the application actually being
  // explored, which is not necessarily the configured tenant.
  const baseUrl = opts.target ? entryOrigin : tenant.baseUrl;

  const runId = newRunId('discovery');
  const credentials = resolveCredentials(tenant.id);
  const redactor = new Redactor();
  redactor.addLiteral(credentials.operatorPassword);

  const logger = new RunLogger({ runId, redactor });
  logger.event('run_started', `discovery: ${opts.goal}`, {
    goal: opts.goal,
    entryUrl,
    model: model.model,
    effort: model.effort,
  });

  const policy = new PolicyEngine({ ...DISCOVERY_POLICY, allowedOrigins: [entryOrigin] });

  const driver = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    headless: headless(opts.headless),
    recordVideoDir: `${logger.dir}/video`,
    onEvent: (type, message, data) => {
      if (type === 'policy_decision' && message.includes('allow')) return;
      logger.event(type as never, message, data);
    },
  });

  const recorder = new StepRecorder({
    goal: opts.goal,
    runId,
    model: model.model,
    vendor: opts.vendor ?? 'meridian',
    product: opts.product ?? 'servicing-console',
    versionRange: '1.x',
    entryUrl,
    baseUrl,
    injectedSecrets: [
      {
        name: 'operatorId',
        value: credentials.operatorId,
        description: 'Servicing console operator user ID. Injected by the runtime credential store.',
        sensitivity: 'pii',
      },
      {
        name: 'operatorPassword',
        value: credentials.operatorPassword,
        description: 'Servicing console operator password. Injected by the runtime credential store.',
        sensitivity: 'secret',
      },
    ],
  });

  try {
    await driver.navigate(entryUrl);
    logger.screenshot('discovery-start', await driver.screenshot());

    const result = await runDiscovery({
      goal: opts.goal,
      entryUrl,
      driver,
      logger,
      recorder,
      model: model.model,
      effort: model.effort,
      maxTurns: opts.maxSteps ?? model.maxSteps,
      apiKey: model.apiKey,
      credentials,
    });

    logger.screenshot('discovery-end', await driver.screenshot());

    if (result.status !== 'succeeded') {
      logger.event('run_finished', `discovery ${result.status}`, { ...result });
      process.stderr.write(`\nDiscovery ${result.status}.\n`);
      if (result.status === 'gave_up') process.stderr.write(`Reason: ${result.reason}\n`);
      if (result.status === 'refused') process.stderr.write(`The model declined (category: ${result.category}).\n`);
      process.stderr.write(`Evidence: ${logger.dir}\n\n`);
      return 1;
    }

    const draft = opts.capabilityId ? { ...result.artifact, id: opts.capabilityId } : result.artifact;

    // Check what is checkable before a human is asked to review it. See
    // discovery/validate.ts for why this pass exists.
    const validated = await validateAgainstEntryState(draft, driver, { baseUrl }, logger);
    const artifact = validated.artifact;
    const path = saveArtifact(artifact);
    // The artifact is written into the evidence bundle too, so the bundle is a
    // complete, self-contained record of what this run produced.
    logger.writeJson('artifact.json', artifact, { redact: false });
    logger.event('run_finished', `discovery succeeded in ${result.turns} turns → ${path}`);

    process.stdout.write(
      `\n${'─'.repeat(72)}\n` +
        `  Discovered capability: ${artifact.id} v${artifact.version}\n` +
        `${'─'.repeat(72)}\n` +
        `  ${artifact.title}\n\n` +
        `  steps        ${artifact.steps.length}\n` +
        `  inputs       ${artifact.inputs.filter((i) => !i.injected).map((i) => i.name).join(', ') || '(none)'}\n` +
        `  outputs      ${artifact.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}\n` +
        `  outcomes     ${artifact.outcomes.map((o) => o.code).join(', ') || '(none)'}\n` +
        `  max risk     ${artifact.maxRisk}\n` +
        `  approval     ${artifact.approval.state}\n\n` +
        (validated.rejected.length > 0
          ? `  validation removed ${validated.rejected.length} declared condition(s) that already held\n` +
            `  on the entry screen:\n` +
            validated.rejected.map((r) => `    · ${r.code}: ${r.reason}\n`).join('') +
            `\n`
          : '') +
        `  artifact     ${path}\n` +
        `  evidence     ${logger.dir}\n` +
        `${'─'.repeat(72)}\n\n` +
        `This capability is a DRAFT and will not replay unattended.\n` +
        `A single successful run cannot observe the paths it did not take, so its declared\n` +
        `outcomes are the model's hypotheses. Review them, then approve:\n\n` +
        validated.warnings.map((w) => `  ! ${w}\n\n`).join('') +
        `  npx tsx src/cli/index.ts catalog approve ${artifact.id}\n\n`,
    );
    return 0;
  } finally {
    await driver.close();
  }
}
