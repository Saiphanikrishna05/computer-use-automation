/**
 * `stability` — replay a capability N times and report how reliably it runs.
 *
 * The useful output is not the pass rate. A capability that passes ten times
 * out of ten while three of its steps resolve through the structural tier is
 * *currently* fine and *structurally* fragile, and those are different facts a
 * pass/fail number cannot express.
 *
 * So the report is per-step: which locator tier won, how consistently, and
 * whether any run had to fall back further than the artifact recorded. That is
 * the number worth gating an approval on.
 */

import { runReplayCommand } from './replay-command.js';
import { loadArtifact } from '../artifact/store.js';
import type { ReplayResult } from '../replay/result.js';

export interface StabilityOptions {
  capability: string;
  inputs: Record<string, string>;
  tenant: string;
  runs: number;
  headless?: boolean;
}

interface StepStats {
  stepId: string;
  intent: string;
  tiers: Map<number, number>;
  degraded: number;
  failed: number;
}

export async function runStabilityCommand(opts: StabilityOptions): Promise<number> {
  const artifact = loadArtifact(opts.capability);
  const results: ReplayResult[] = [];
  const steps = new Map<string, StepStats>();

  process.stdout.write(
    `\nReplaying ${artifact.id} v${artifact.version} ${opts.runs} times against ${opts.tenant}…\n\n`,
  );

  for (let i = 1; i <= opts.runs; i += 1) {
    const result = await runReplayCommand({
      capability: opts.capability,
      inputs: opts.inputs,
      tenant: opts.tenant,
      headless: opts.headless ?? true,
      operator: false,
      json: true,
    });
    results.push(result);

    for (const step of result.steps) {
      const stats =
        steps.get(step.stepId) ??
        ({ stepId: step.stepId, intent: step.intent, tiers: new Map(), degraded: 0, failed: 0 } as StepStats);
      if (step.resolution?.winningTier != null) {
        stats.tiers.set(step.resolution.winningTier, (stats.tiers.get(step.resolution.winningTier) ?? 0) + 1);
      }
      if (step.resolution?.degraded) stats.degraded += 1;
      if (step.status === 'failed') stats.failed += 1;
      steps.set(step.stepId, stats);
    }

    const mark = result.status === 'success' ? '·' : result.status === 'failure' ? '✗' : '○';
    process.stdout.write(
      `  run ${String(i).padStart(2)}  ${mark}  ${result.status.padEnd(17)} ${String(result.durationMs).padStart(5)}ms  ` +
        `${result.degradedResolutions} degraded\n`,
    );
  }

  const successes = results.filter((r) => r.status === 'success').length;
  const outcomes = results.filter((r) => r.status === 'business_outcome').length;
  const failures = results.filter((r) => r.status === 'failure').length;
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);

  process.stdout.write(`\n${'─'.repeat(72)}\n  Stability report\n${'─'.repeat(72)}\n`);
  process.stdout.write(`  runs                ${opts.runs}\n`);
  process.stdout.write(`  success             ${successes}   business outcome ${outcomes}   failure ${failures}\n`);
  process.stdout.write(
    `  duration            median ${durations[Math.floor(durations.length / 2)]}ms   ` +
      `min ${durations[0]}ms   max ${durations[durations.length - 1]}ms\n\n`,
  );

  process.stdout.write('  per-step locator stability:\n');
  let unstable = 0;
  let weak = 0;
  for (const stats of steps.values()) {
    const tiers = [...stats.tiers.entries()].sort((a, b) => a[0] - b[0]);
    const spread = tiers.map(([tier, n]) => `tier ${tier}×${n}`).join(', ') || 'no locator';
    // A step that resolves through a *different* tier on different runs is the
    // real warning sign: the same page is answering the same question two ways.
    const inconsistent = tiers.length > 1;
    if (inconsistent) unstable += 1;
    if (stats.degraded > 0) weak += 1;
    const flag = inconsistent ? '  ⚠ inconsistent' : stats.degraded > 0 ? '  ⚠ degraded' : '';
    process.stdout.write(`    ${stats.stepId.padEnd(16)} ${spread}${flag}\n`);
  }

  const verdict =
    failures > 0
      ? 'NOT STABLE — at least one run failed outright.'
      : unstable > 0
        ? 'UNSTABLE LOCATORS — a step resolved through different tiers across runs; the page is answering the same question two ways.'
        : weak > 0
          ? 'STABLE BUT DEGRADED — every run passed, but a locator is resolving below the tier it was recorded at. Re-record before it breaks.'
          : 'STABLE — every run passed at the recorded locator tier.';

  process.stdout.write(`\n  ${verdict}\n${'─'.repeat(72)}\n\n`);

  // Three exit codes, matching the rest of the CLI: 0 healthy, 1 a gate that
  // should block, 2 something a person needs to know about.
  //
  // Degradation deliberately does not block. A capability resolving through a
  // weaker tier still works, and failing it would stop a working automation on
  // a warning — which is the opposite of what an early-warning signal is for.
  // It exits 2 so CI can surface it without gating on it.
  if (failures > 0 || unstable > 0) return 1;
  return weak > 0 ? 2 : 0;
}
