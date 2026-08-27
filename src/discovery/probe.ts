/**
 * Outcome probing: observing the paths a successful run never took.
 *
 * `validate.ts` can only ask whether a declared condition is *provably wrong*
 * against the two screens a successful run happens to leave behind. Everything
 * that survives that check is still a guess, and the warning it emits says so.
 * This module is the other half: instead of reasoning about screens we already
 * have, it goes and produces the screen the outcome describes, and looks.
 *
 * The mechanism is deliberately unexciting. Discovery emits an artifact whose
 * steps are already parameterised, so provoking "no such member" does not need
 * a new code path, a fixture, or a second conversation with a model. It needs
 * the same steps, run again, with one input changed. So a probe *is* a replay:
 *
 *     replay(artifact, { ...baseline, memberId: "999999" })
 *       → business_outcome MEMBER_NOT_FOUND   the condition held. Observed.
 *       → anything else                       it did not. Refuted.
 *
 * Three things follow from probing by replay rather than by driving the browser
 * directly, and they are the reason it is worth doing this way:
 *
 *  1. **The probe exercises the code the caller will exercise.** A condition
 *     confirmed here is confirmed in the engine that will evaluate it in
 *     production, in the same precedence order, against the same resolver. A
 *     bespoke probing path could only tell us about the bespoke probing path.
 *
 *  2. **It is evidence about the artifact, not just about the outcome.** A
 *     probe that reaches its outcome has also proved the recorded steps replay
 *     at all, from a cold navigation, without the model that recorded them.
 *
 *  3. **There is nothing new to make safe.** The ceiling that stopped discovery
 *     committing a transaction is the same ceiling here, enforced in the same
 *     driver. Probing adds no capability that policy has not already bounded.
 *
 * What it deliberately does not do: guess a probe value. If nobody can say what
 * input provokes an outcome, that outcome stays `hypothesised` and stays
 * flagged. An automated guess that failed would be indistinguishable from a
 * declaration that was wrong, and the two need different responses from a
 * reviewer.
 */

import type { BusinessOutcome, CapabilityArtifact } from '../artifact/schema.js';
import type { SurfaceDriver } from '../surface/types.js';
import type { RunLogger } from '../evidence/logger.js';
import { PolicyEngine } from '../policy/engine.js';
import { ReplayEngine } from '../replay/executor.js';
import { describeCondition } from '../replay/conditions.js';
import { freshnessOf, describeAge } from '../artifact/staleness.js';
import { credentialInputs, type OperatorCredentials } from '../config.js';
import type { ReplayResult } from '../replay/result.js';

export interface ProbeOptions {
  artifact: CapabilityArtifact;
  /**
   * Opens a *fresh* surface for one probe run, which the probe then closes.
   *
   * A factory rather than a driver, and this is not a detail. The first real
   * run of this module reused the session discovery had been exploring in, so
   * every probe started already signed on, every recorded sign-on step
   * resolved against nothing, and three outcomes came back refuted with a
   * screenshot of the search page and an authoritative-sounding explanation
   * that was entirely wrong. A probe is a claim about what replay will do; the
   * only way it can support that claim is by starting where replay starts.
   * Handing it a factory makes that structural instead of remembered.
   */
  newDriver: () => Promise<SurfaceDriver>;
  /** The inputs discovery itself used, including injected credentials. */
  baselineInputs: Record<string, unknown>;
  bindings: Record<string, string>;
  policy: PolicyEngine;
  logger: RunLogger;
  /**
   * Ceiling on how many probe runs one discovery may spend. Each is a full
   * replay against a live application; a capability declaring nine outcomes
   * should not silently turn one discovery into ten runs.
   */
  maxProbes?: number;
  /**
   * Re-verify only what is not currently backed by a fresh observation.
   *
   * Re-probing is the answer to observations ageing out, and it has to be
   * cheap enough to run on a schedule or nobody will. A capability with nine
   * outcomes of which one has aged past the threshold should cost one run, not
   * nine, or the honest maintenance habit becomes the expensive one.
   */
  staleOnly?: boolean;
}

export interface ProbeReport {
  code: string;
  /** Outcome of the probe for this specific declared outcome. */
  state: 'observed' | 'refuted' | 'skipped';
  reason: string;
  /** What the probe run produced, when it did not produce the target outcome. */
  observedInstead?: string;
  probe?: { parameter: string; value: string };
}

export interface ProbeResult {
  artifact: CapabilityArtifact;
  reports: ProbeReport[];
  warnings: string[];
  /** True when the capability was not eligible for probing at all. */
  skippedEntirely: boolean;
  /**
   * Whether any outcome was actually settled. False means the pass produced no
   * observation, and a caller should leave the artifact alone rather than
   * rewrite it with nothing new in it, which is a real thing this command did
   * to a hand-authored file before the flag existed.
   */
  learnedSomething: boolean;
}

export const DEFAULT_MAX_PROBES = 4;

/**
 * Runs one probe per declared outcome that carries a probe declaration, and
 * rewrites each outcome's evidence with what was actually seen.
 */
export async function probeOutcomes(options: ProbeOptions): Promise<ProbeResult> {
  const { artifact, logger } = options;
  const warnings: string[] = [];
  const reports: ProbeReport[] = [];

  // An earlier version refused to probe an irreversible capability at all, on
  // the grounds that provoking an outcome would mean committing the
  // transaction. Pointing this at a real transfer flow showed that to be both
  // over-cautious and expensive: every outcome a funds transfer declares —
  // insufficient balance, source on hold, same source and destination — is a
  // validation that fires at the *review* step, long before anything posts.
  // Refusing wholesale left five real conditions permanently unverified on the
  // one capability where being sure matters most.
  //
  // What actually protects the money is the action ceiling, enforced in the
  // driver: a probe runs under a policy that caps at mutate_reversible, so an
  // irreversible step is refused there whatever this function decides. So the
  // rule is now precise rather than blanket — probe it, and if a run reaches
  // the irreversible step, report that the ceiling stopped it rather than
  // pretending the outcome was tested.

  const budget = options.maxProbes ?? DEFAULT_MAX_PROBES;
  const evidence = new Map<string, BusinessOutcome['evidence']>();
  let spent = 0;

  for (const outcome of artifact.outcomes) {
    // Already settled by an earlier probe that happened to produce this outcome
    // instead of its own target. Real evidence, obtained for free; spending a
    // second run to re-confirm it would be waste.
    if (evidence.get(outcome.code)?.state === 'observed') {
      reports.push({
        code: outcome.code,
        state: 'observed',
        reason: 'Observed during another outcome\'s probe run.',
      });
      continue;
    }

    if (options.staleOnly) {
      const freshness = freshnessOf(outcome);
      if (freshness.freshness === 'fresh') {
        reports.push({
          code: outcome.code,
          state: 'skipped',
          reason: `Still current: observed ${describeAge(freshness.ageDays)}. Not re-probed.`,
        });
        continue;
      }
    }

    if (!outcome.probe) {
      const reason =
        'No probe declared: nothing was recorded about which input would provoke this state, so it could ' +
        'not be tested. Remains a hypothesis.';
      reports.push({ code: outcome.code, state: 'skipped', reason });
      continue;
    }

    const inputSpec = artifact.inputs.find((i) => i.name === outcome.probe!.parameter);
    if (!inputSpec) {
      const reason =
        `Probe names parameter "${outcome.probe.parameter}", which this capability does not declare. ` +
        'Nothing was run.';
      reports.push({ code: outcome.code, state: 'skipped', reason, probe: probeOf(outcome) });
      warnings.push(`${outcome.code}: ${reason}`);
      continue;
    }

    // An injected parameter is a credential the runtime supplies. Varying one
    // is not probing a business outcome, it is an authentication test against
    // whatever the operator account happens to be, and repeated failures lock
    // real accounts out. Business outcomes are provoked with business data.
    if (inputSpec.injected) {
      const reason =
        `Probe would vary the injected credential "${inputSpec.name}". Credentials are supplied by the ` +
        'runtime and are never varied to provoke an outcome. Nothing was run.';
      reports.push({ code: outcome.code, state: 'skipped', reason, probe: probeOf(outcome) });
      warnings.push(`${outcome.code}: ${reason}`);
      continue;
    }

    if (spent >= budget) {
      const reason = `Probe budget of ${budget} run(s) for this discovery was already spent. Remains a hypothesis.`;
      reports.push({ code: outcome.code, state: 'skipped', reason, probe: probeOf(outcome) });
      warnings.push(`${outcome.code}: ${reason}`);
      continue;
    }

    spent += 1;
    const report = await runOneProbe(options, outcome, evidence);
    reports.push(report);
    if (report.state === 'refuted') {
      warnings.push(
        `${outcome.code} was probed and did not fire: ${report.reason} Confirm the real on-screen wording ` +
          'before approving.',
      );
    }
  }

  const probed = artifact.outcomes.map((outcome) => {
    const found = evidence.get(outcome.code);
    return found ? { ...outcome, evidence: found } : outcome;
  });

  for (const warning of warnings) logger.event('note', `probe: ${warning}`);

  return {
    artifact: { ...artifact, outcomes: probed },
    reports,
    warnings,
    skippedEntirely: false,
    learnedSomething: reports.some((r) => r.state !== 'skipped'),
  };
}

/**
 * One probe: replay the recorded steps with the provoking input, then classify
 * what came back.
 */
async function runOneProbe(
  options: ProbeOptions,
  target: BusinessOutcome,
  evidence: Map<string, BusinessOutcome['evidence']>,
): Promise<ProbeReport> {
  const { artifact, logger, policy } = options;
  const probe = target.probe!;
  const probedAt = new Date().toISOString();

  logger.event(
    'note',
    `probing ${target.code}: replaying with ${probe.parameter}="${probe.value}"` +
      (probe.rationale ? ` (${probe.rationale})` : ''),
  );

  let result: ReplayResult;
  let screen: string | undefined;
  let driver: SurfaceDriver;
  try {
    driver = await options.newDriver();
  } catch (error) {
    const reason = `Could not open a surface for the probe: ${error instanceof Error ? error.message : String(error)}`;
    evidence.set(target.code, { state: 'refuted', probedAt, note: reason });
    return { code: target.code, state: 'refuted', reason, probe: probeOf(target) };
  }

  try {
    result = await new ReplayEngine({
      artifact,
      inputs: { ...options.baselineInputs, [probe.parameter]: probe.value },
      driver,
      policy,
      logger,
      bindings: options.bindings,
      // No escalation handler, deliberately. A probe is an automated
      // verification pass; parking it to wait for an operator would block a
      // discovery run on a human who never asked to be involved. Whatever
      // would have escalated becomes the probe's answer instead.
    }).run();
    // Read the screen while the probe's own surface is still open. Doing this
    // after the driver closes is how a refutation loses the one piece of
    // information that makes it actionable.
    screen = await safeVisibleText(driver);
  } catch (error) {
    const reason = `Probe run threw: ${error instanceof Error ? error.message : String(error)}`;
    evidence.set(target.code, { state: 'refuted', probedAt, note: reason });
    return { code: target.code, state: 'refuted', reason, probe: probeOf(target) };
  } finally {
    await driver.close().catch(() => {});
  }

  const runId = result.evidence.runId;

  if (result.status === 'business_outcome' && result.outcome === target.code) {
    const note =
      `Provoked with ${probe.parameter}="${probe.value}"; condition (${describeCondition(target.when)}) held ` +
      'on the resulting screen.';
    evidence.set(target.code, { state: 'observed', probedAt, runId, note });
    return { code: target.code, state: 'observed', reason: note, probe: probeOf(target) };
  }

  // Everything below this line is a refutation of the target. What differs is
  // how useful the refutation is, so each branch says what was actually seen.
  const observedInstead = describeResult(result);

  if (result.status === 'business_outcome') {
    // A different declared outcome fired. That is a real observation of *that*
    // outcome on a screen this flow genuinely produced, so it is credited,
    // while the outcome we were aiming at is refuted.
    const other = result.outcome;
    if (!evidence.has(other) || evidence.get(other)!.state !== 'observed') {
      evidence.set(other, {
        state: 'observed',
        probedAt,
        runId,
        note: `Observed while probing ${target.code} with ${probe.parameter}="${probe.value}".`,
      });
    }
    const reason =
      `Replaying with ${probe.parameter}="${probe.value}" produced ${other}, not ${target.code}. ` +
      'Either the probe value does not provoke this state, or the two conditions overlap and ' +
      `${other} is matching first.`;
    evidence.set(target.code, { state: 'refuted', probedAt, runId, observedInstead, note: reason });
    return { code: target.code, state: 'refuted', reason, observedInstead, probe: probeOf(target) };
  }

  // A probe value the capability's own input contract refuses is a finding in
  // its own right, and a sharper one than a wording mismatch: the engine
  // rejected the value before the application ever saw it, so this outcome
  // cannot be reached through this capability at all. Reporting that as
  // "the wording is probably wrong" would send a reviewer to fix the one thing
  // that is not broken.
  if (result.status === 'failure' && result.error.code === 'POLICY_BLOCKED') {
    // The probe walked the flow and arrived at the step that commits. Policy
    // stopped it, which is the system working — but it means this outcome was
    // never reached, and saying "refuted" would be a lie about a condition
    // nobody tested.
    const reason =
      `Provoking ${target.code} with ${probe.parameter}="${probe.value}" walked the flow as far as an ` +
      'irreversible step, where the action ceiling refused it. The outcome was never reached, so it ' +
      'remains untested rather than disproven. Confirm it against a test environment.';
    evidence.set(target.code, { state: 'hypothesised', probedAt, runId, note: reason });
    return { code: target.code, state: 'skipped', reason, probe: probeOf(target) };
  }

  if (result.status === 'failure' && result.error.code === 'INPUT_VALIDATION_FAILED') {
    const reason =
      `${probe.parameter}="${probe.value}" is rejected by this capability's own input contract ` +
      `(${result.error.observed}), so the application never saw it. ${target.code} is unreachable through ` +
      'this capability: either the outcome does not belong here, or the parameter is over-constrained.';
    evidence.set(target.code, { state: 'refuted', probedAt, runId, observedInstead, note: reason });
    return { code: target.code, state: 'refuted', reason, observedInstead, probe: probeOf(target) };
  }

  // The most valuable case, and the one this whole feature exists for: the
  // application did show a different screen, and no declared condition
  // recognised it. The screen text is captured verbatim, because the wording
  // the model guessed wrong is right there in it.
  const reason =
    result.status === 'success'
      ? `Replaying with ${probe.parameter}="${probe.value}" still succeeded, so this input does not provoke ` +
        `${target.code} and the condition was never tested.`
      : `Replaying with ${probe.parameter}="${probe.value}" ended in ${observedInstead}, and no declared ` +
        `condition matched the screen it ended on. The wording in (${describeCondition(target.when)}) is ` +
        `probably not what this application shows.`;

  evidence.set(target.code, {
    state: 'refuted',
    probedAt,
    runId,
    observedInstead,
    note: screen ? `${reason} Screen read: "${screen}"` : reason,
  });

  return {
    code: target.code,
    state: 'refuted',
    reason: screen ? `${reason} Screen read: "${screen}"` : reason,
    observedInstead,
    probe: probeOf(target),
  };
}

/**
 * The inputs the recording run used, reconstructed from the artifact itself.
 *
 * Non-injected parameters carry the literal the model typed as `example`;
 * injected ones are credentials the runtime supplies and are deliberately never
 * written into an artifact, so they come from the credential store instead. A
 * probe varies exactly one of these and leaves the rest as recorded, which is
 * what makes any difference in behaviour attributable to the probe.
 */
export function baselineInputsFor(
  artifact: CapabilityArtifact,
  credentials: OperatorCredentials,
  overrides: Record<string, string> = {},
): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ...credentialInputs(credentials) };
  for (const spec of artifact.inputs) {
    if (spec.injected) continue;
    if (spec.example !== undefined) inputs[spec.name] = spec.example;
  }
  return { ...inputs, ...overrides };
}

/** Folds a probe pass into provenance, so the artifact records what was tested
 *  without a reviewer having to open the run log. */
export function withProbingProvenance(probed: ProbeResult): CapabilityArtifact {
  const { artifact, reports } = probed;
  return {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      probing: {
        probedAt: new Date().toISOString(),
        runs: reports.filter((r) => r.state !== 'skipped').length,
        observed: reports.filter((r) => r.state === 'observed').map((r) => r.code),
        refuted: reports.filter((r) => r.state === 'refuted').map((r) => r.code),
        unprobed: reports.filter((r) => r.state === 'skipped').map((r) => r.code),
        warnings: probed.warnings,
      },
    },
  };
}

/** One block of terminal output summarising a probe pass. Shared by `discover`
 *  and `probe` so the two commands cannot drift in how they report it. */
export function renderProbeSummary(probed: ProbeResult): string {
  if (probed.reports.length === 0) return '  probing      no outcomes declared\n\n';

  const lines = probed.reports.map((r) => {
    const mark = r.state === 'observed' ? '✓' : r.state === 'refuted' ? '✗' : '·';
    const probe = r.probe ? ` (${r.probe.parameter}="${r.probe.value}")` : '';
    return `    ${mark} ${r.code}${probe}\n      ${r.reason}\n`;
  });

  // Counted from the artifact rather than from this pass. A re-verification
  // run that correctly re-probed nothing, because every observation was still
  // current, would otherwise report "0 observed" and read as a total failure
  // to verify anything.
  const backed = probed.artifact.outcomes.filter((o) => o.evidence.state === 'observed').length;
  const spent = probed.reports.filter((r) => r.state !== 'skipped').length;
  return (
    `  probing      ${backed}/${probed.artifact.outcomes.length} outcome(s) backed by an observation` +
    ` · ${spent} probe run(s) this pass\n` +
    lines.join('') +
    '\n'
  );
}

function probeOf(outcome: BusinessOutcome): ProbeReport['probe'] {
  return outcome.probe ? { parameter: outcome.probe.parameter, value: outcome.probe.value } : undefined;
}

function describeResult(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return 'success';
    case 'business_outcome':
      return `business outcome ${result.outcome}`;
    case 'escalated':
      return `escalation (${result.reason})`;
    case 'failure':
      return `failure ${result.error.code}`;
  }
}

/** Reading the screen is best-effort: a probe that cannot report the text it
 *  saw is still a probe whose verdict stands. */
async function safeVisibleText(driver: SurfaceDriver): Promise<string | undefined> {
  try {
    const text = (await driver.visibleText()).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}
