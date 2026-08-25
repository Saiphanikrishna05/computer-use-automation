/**
 * The error taxonomy, checked exhaustively rather than by example.
 *
 * The brief names conflating a business answer with a failure as the commonest
 * mistake in this problem, and the README claims the distinction is structural.
 * A claim like that is worth one table: every condition this application can
 * produce, driven on purpose, next to what the engine actually called it.
 *
 * Two things make the table worth reading rather than decorative:
 *
 *   - The expectation is written down *before* the run, per case, including the
 *     specific failure code. A harness that reports whatever happened and calls
 *     it correct is a harness that cannot fail.
 *
 *   - "Recovered" is a distinct expected result from "succeeded". A run that
 *     hits a blocking dialog, clears it via a declared rule and completes is
 *     not the same event as a run that never met one, even though both end in
 *     `success`. Collapsing them would hide whether recovery fired at all.
 *
 * Usage:  npx tsx scripts/fault-taxonomy.ts [--json]
 * Needs:  the target app running (npm run app)
 */

import { runReplayCommand } from '../src/cli/replay-command.js';
import type { ReplayResult } from '../src/replay/result.js';
import { DEFAULT_TENANT, TENANT_RUNTIMES } from '../src/config.js';

type Expectation =
  | { kind: 'success' }
  | { kind: 'success_after_recovery'; rule: string }
  | { kind: 'business_outcome'; code: string }
  | { kind: 'failure'; code: string };

interface Case {
  /** What is being provoked, in the words a reviewer would use. */
  condition: string;
  memberId: string;
  fault?: string;
  faultScope?: string;
  expect: Expectation;
  /** Why this classification is the right one, not merely the observed one. */
  because: string;
}

const CASES: Case[] = [
  {
    condition: 'nothing wrong',
    memberId: '100001',
    expect: { kind: 'success' },
    because: 'The baseline. Without it a table of failures proves only that everything fails.',
  },
  {
    condition: 'member does not exist',
    memberId: '999999',
    expect: { kind: 'business_outcome', code: 'MEMBER_NOT_FOUND' },
    because: 'A real answer the caller needs to act on, not a fault. This is the distinction the brief calls the commonest mistake.',
  },
  {
    condition: 'operator not entitled to the record',
    memberId: '100002',
    expect: { kind: 'business_outcome', code: 'PERMISSION_DENIED' },
    because: 'The application worked correctly and said no. Reporting it as a failure would send an operator to debug a system that is fine.',
  },
  {
    condition: 'member id fails the declared input contract',
    memberId: '12345',
    expect: { kind: 'failure', code: 'INPUT_VALIDATION_FAILED' },
    because: 'Caught against the artifact contract before the application is touched at all, so a malformed call costs nothing and reaches nothing.',
  },
  {
    condition: 'native dialog blocks the page mid-run',
    memberId: '100003',
    expect: { kind: 'success_after_recovery', rule: 'ACCEPT_SYSTEM_DIALOG' },
    because: 'Declared recovery, bounded. The run should complete and the recovery should be visible in the step reports rather than silently absorbed.',
  },
  {
    condition: 'application returns its error page',
    memberId: '100001',
    fault: 'app_error',
    faultScope: 'search',
    expect: { kind: 'failure', code: 'APP_ERROR' },
    because: 'Nothing the automation can fix. It stops, and carries the step, the expectation, what it saw, a screenshot and a DOM snapshot.',
  },
  {
    condition: 'session drops mid-run',
    memberId: '100001',
    fault: 'session_expired',
    faultScope: 'search',
    expect: { kind: 'failure', code: 'SESSION_EXPIRED' },
    because: 'Recoverable in principle, fatal once the declared re-auth budget is spent. Reported as the specific cause rather than a generic timeout.',
  },
];

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const baseUrl = (TENANT_RUNTIMES[DEFAULT_TENANT] ?? Object.values(TENANT_RUNTIMES)[0]!).baseUrl;
  const rows: Array<{ condition: string; expected: string; actual: string; ok: boolean; because: string }> = [];

  for (const testCase of CASES) {
    // Faults are single-shot, but a previous case that failed early could leave
    // one armed. Clearing first keeps each row independent of the one above it.
    await resetFaults(baseUrl);

    const result = await runReplayCommand({
      capability: 'lookup_member_savings_balance',
      inputs: { memberId: testCase.memberId },
      tenant: DEFAULT_TENANT,
      headless: true,
      operator: false,
      json: true,
      ...(testCase.fault ? { fault: testCase.fault, faultScope: testCase.faultScope ?? 'any' } : {}),
    });

    const actual = describe(result);
    const ok = matches(testCase.expect, result);
    rows.push({ condition: testCase.condition, expected: describeExpectation(testCase.expect), actual, ok, because: testCase.because });

    if (!json) {
      process.stdout.write(`  ${ok ? '✓' : '✗'} ${testCase.condition.padEnd(46)} ${actual}\n`);
    }
  }

  await resetFaults(baseUrl);

  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const failed = rows.filter((r) => !r.ok);
    process.stdout.write(
      `\n  ${rows.length - failed.length}/${rows.length} conditions classified as declared\n\n` +
        (failed.length > 0
          ? failed.map((r) => `  MISMATCH ${r.condition}: expected ${r.expected}, got ${r.actual}\n`).join('')
          : ''),
    );
    process.stdout.write(markdownTable(rows));
  }

  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

function describeExpectation(e: Expectation): string {
  switch (e.kind) {
    case 'success': return 'success';
    case 'success_after_recovery': return `success via ${e.rule}`;
    case 'business_outcome': return `business_outcome ${e.code}`;
    case 'failure': return `failure ${e.code}`;
  }
}

function describe(result: ReplayResult): string {
  const recovered = result.steps.flatMap((s) => s.recoveries).filter((r) => r.succeeded);
  switch (result.status) {
    case 'success':
      return recovered.length > 0 ? `success via ${recovered.map((r) => r.code).join(', ')}` : 'success';
    case 'business_outcome':
      return `business_outcome ${result.outcome}`;
    case 'escalated':
      return 'escalated';
    case 'failure':
      return `failure ${result.error.code}`;
  }
}

function matches(expect: Expectation, result: ReplayResult): boolean {
  switch (expect.kind) {
    case 'success':
      return result.status === 'success';
    case 'success_after_recovery':
      return (
        result.status === 'success' &&
        result.steps.flatMap((s) => s.recoveries).some((r) => r.code === expect.rule && r.succeeded)
      );
    case 'business_outcome':
      return result.status === 'business_outcome' && result.outcome === expect.code;
    case 'failure':
      return result.status === 'failure' && result.error.code === expect.code;
  }
}

function markdownTable(rows: Array<{ condition: string; expected: string; actual: string; ok: boolean; because: string }>): string {
  const lines = [
    '',
    '| Condition provoked | Classified as | As declared | Why that is the right call |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.condition} | \`${r.actual}\` | ${r.ok ? '✓' : '✗'} | ${r.because} |`),
    '',
  ];
  return lines.join('\n');
}

async function resetFaults(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/_admin/reset`, { method: 'POST' });
  } catch {
    // The app not being up is reported by the first replay, with a better
    // message than anything this could produce.
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
