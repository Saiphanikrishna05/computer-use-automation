/**
 * Post-discovery validation.
 *
 * The problem this solves showed up the first time a real model finished a run.
 * Asked to declare the business outcomes a caller would need to distinguish,
 * it produced four — and all four were wrong in ways that are obvious once
 * stated and invisible in a JSON diff:
 *
 *   SIGN_ON_FAILED     → "Operator Sign-On", which is the title of the login
 *                         panel itself. This condition holds before the
 *                         capability does anything, so every replay would
 *                         terminate on turn zero reporting a sign-on failure.
 *   NO_SAVINGS_ACCOUNT → 'Accounts table present without a "Savings" row',
 *                         a description of a state rather than text on screen.
 *   MEMBER_NOT_FOUND   → "No member found", where the application says
 *                         "No member record found".
 *
 * None of this is a criticism of the model. It walked exactly one path and was
 * asked about three it never saw; being wrong is the *expected* outcome, which
 * is why the artifact is emitted as a draft. But shipping wrong conditions to a
 * human reviewer is worse than shipping none: they look like findings, and a
 * reviewer skimming a plausible-looking list will approve them.
 *
 * So we check what is mechanically checkable. Every declared condition is
 * evaluated against the entry state. A condition that already holds before the
 * flow has run cannot be evidence that the flow produced it — that one is
 * provably broken, and it is removed rather than flagged. Conditions that
 * merely never matched anything are kept and flagged, because we genuinely do
 * not know whether they are wrong or simply describe a state we did not visit.
 */

import type { CapabilityArtifact } from '../artifact/schema.js';
import type { SurfaceDriver } from '../surface/types.js';
import { evaluateCondition, describeCondition } from '../replay/conditions.js';
import { interpolate } from '../replay/values.js';
import type { RunLogger } from '../evidence/logger.js';

export interface ValidationResult {
  artifact: CapabilityArtifact;
  warnings: string[];
  rejected: Array<{ code: string; reason: string }>;
}

/**
 * A declared non-success condition has two states it must not hold in, and
 * both are sitting right in front of us when discovery finishes:
 *
 *   the SUCCESS state — we are standing on it. A condition that holds here
 *     fires on every successful replay. (The first model run declared
 *     NO_SAVINGS_ACCOUNT as the text "Savings", which appears in the accounts
 *     table of every member who *has* one.)
 *
 *   the ENTRY state — one navigation away. A condition that holds here fires
 *     before the capability has done anything at all.
 *
 * Checking success first matters, because getting back to the entry screen
 * destroys the success state and there is no way to re-reach it without
 * re-running the flow.
 */
export async function validateAgainstEntryState(
  artifact: CapabilityArtifact,
  driver: SurfaceDriver,
  bindings: Record<string, unknown>,
  logger: RunLogger,
): Promise<ValidationResult> {
  const warnings: string[] = [];
  const rejected: Array<{ code: string; reason: string }> = [];
  const ctx = { driver, values: bindings as Record<string, unknown> };

  const holdsInSuccessState = new Map<string, boolean>();
  for (const outcome of artifact.outcomes) {
    holdsInSuccessState.set(outcome.code, await evaluateCondition(ctx, outcome.when));
  }
  for (const rule of artifact.failures) {
    holdsInSuccessState.set(rule.code, await evaluateCondition(ctx, rule.when));
  }
  const checkpointHoldsAtSuccess = await evaluateCondition(ctx, artifact.checkpoint.condition);
  if (!checkpointHoldsAtSuccess) {
    warnings.push(
      `Checkpoint "${describeCondition(artifact.checkpoint.condition)}" does not hold on the screen the run ` +
        'ended on, so it would never confirm success. Replace it with text visible in the end state.',
    );
  }

  // The artifact's own entry point, not an assumed base URL. Getting this
  // wrong sent the validator at a different origin than the one being
  // explored, where the allowlist correctly refused it — the guardrail
  // catching my own bug rather than an attack, which is the cheapest possible
  // way to find out.
  const entryUrl = interpolate(artifact.target.entryUrlTemplate, bindings);
  await driver.navigate(entryUrl);
  await driver.waitForSettled();

  // A checkpoint that holds at entry proves nothing about success.
  if (await evaluateCondition(ctx, artifact.checkpoint.condition)) {
    warnings.push(
      `Checkpoint "${describeCondition(artifact.checkpoint.condition)}" already holds on the entry screen, ` +
        'so it cannot distinguish success from having done nothing. Replace it with something specific to the end state.',
    );
  }

  const keptOutcomes: typeof artifact.outcomes = [];
  for (const outcome of artifact.outcomes) {
    if (holdsInSuccessState.get(outcome.code)) {
      rejected.push({
        code: outcome.code,
        reason:
          `Condition (${describeCondition(outcome.when)}) holds on the SUCCESS screen, so it would fire on ` +
          'every successful replay and mask the real result. Removed.',
      });
      continue;
    }
    if (await evaluateCondition(ctx, outcome.when)) {
      rejected.push({
        code: outcome.code,
        reason:
          `Condition (${describeCondition(outcome.when)}) already holds on the ENTRY screen. ` +
          'Every replay would terminate immediately reporting this outcome. Removed.',
      });
      continue;
    }
    keptOutcomes.push(outcome);
  }

  const keptFailures: typeof artifact.failures = [];
  for (const rule of artifact.failures) {
    if (holdsInSuccessState.get(rule.code) || (await evaluateCondition(ctx, rule.when))) {
      rejected.push({
        code: rule.code,
        reason: `Condition (${describeCondition(rule.when)}) holds in the success or entry state; removed.`,
      });
      continue;
    }
    keptFailures.push(rule);
  }

  if (keptOutcomes.length > 0) {
    warnings.push(
      `${keptOutcomes.length} declared outcome(s) were hypothesised from a single successful run and have not ` +
        'been observed. Confirm the exact on-screen wording of each before approving: ' +
        keptOutcomes.map((o) => `${o.code} ("${textOf(o.when)}")`).join(', '),
    );
  }

  for (const warning of warnings) logger.event('note', `validation: ${warning}`);
  for (const item of rejected) logger.event('note', `validation rejected ${item.code}: ${item.reason}`);

  return {
    artifact: {
      ...artifact,
      outcomes: keptOutcomes,
      failures: keptFailures,
      provenance: {
        ...artifact.provenance,
        validation: { checkedAt: new Date().toISOString(), warnings, rejected },
      },
    },
    warnings,
    rejected,
  };
}

function textOf(condition: { kind: string } & Record<string, unknown>): string {
  return typeof condition.text === 'string' ? condition.text : describeCondition(condition as never);
}
