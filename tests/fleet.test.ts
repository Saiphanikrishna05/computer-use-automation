/**
 * Fleet health.
 *
 * Two properties matter more than the rest, and both are judgements rather than
 * mechanics, which is exactly why they need pinning:
 *
 *   - **Drift ranks above failure.** A failing capability is already generating
 *     support calls; somebody is on it. A drifting one still returns the right
 *     answer through a weaker locator, and is invisible until it is not. A work
 *     list ordered by noise would mean only ever working on what is already
 *     known.
 *
 *   - **It must not cry wolf.** A health view is worth reading exactly as long
 *     as its findings are all real. The committed evidence contains runs that
 *     fail on purpose, and capabilities recorded against an application no
 *     credit union runs. Either one reported as a fleet problem would train a
 *     reader to skim past the ones that are.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetHealth, fleetRuns, renderFleet } from '../src/fleet/health.js';
import { CapabilityArtifactSchema, type BusinessOutcome, type CapabilityArtifact } from '../src/artifact/schema.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function outcome(code: string, evidence: Partial<BusinessOutcome['evidence']> = {}): BusinessOutcome {
  return {
    code,
    description: code,
    when: { kind: 'text_present', text: code, framePath: [], caseSensitive: false },
    extract: [],
    evidence: { state: 'hypothesised', ...evidence } as BusinessOutcome['evidence'],
  };
}

function artifact(overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup',
    version: 1,
    title: 't',
    description: 'd',
    approval: { state: 'approved' },
    target: { surface: 'web', app: { vendor: 'meridian', product: 'servicing-console' }, entryUrlTemplate: '{{baseUrl}}/' },
    inputs: [],
    outputs: [],
    steps: [{ id: 'search', intent: 'i', action: { kind: 'assert', condition: { kind: 'text_present', text: 'x', framePath: [], caseSensitive: false } } }],
    checkpoint: { description: 'c', condition: { kind: 'text_present', text: 'x', framePath: [], caseSensitive: false } },
    outcomes: [outcome('A', { state: 'observed', probedAt: daysAgo(1) })],
    provenance: { discoveredAt: '', runId: 'r', goal: 'g', model: 'm' },
    ...overrides,
  });
}

interface RunSpec {
  status?: string;
  tenantId?: string;
  degradedSteps?: string[];
  failureCode?: string;
  faultArmed?: boolean;
}

function evidenceWith(specs: RunSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cua-fleet-'));
  specs.forEach((spec, i) => {
    const dir = join(root, `run-${i}`);
    mkdirSync(dir, { recursive: true });
    const degraded = spec.degradedSteps ?? [];
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({
        capabilityId: 'lookup',
        capabilityVersion: 1,
        tenantId: spec.tenantId ?? 'northpoint-fcu',
        startedAt: daysAgo(1),
        finishedAt: daysAgo(1),
        durationMs: 1400,
        status: spec.status ?? 'success',
        ...(spec.status === 'failure' ? { error: { code: spec.failureCode ?? 'APP_ERROR', expected: '', observed: '' } } : {}),
        ...(spec.status === 'success' ? { outputs: {} } : {}),
        steps: degraded.map((id) => ({
          stepId: id, intent: '', action: 'click', status: 'ok', elapsedMs: 1, recoveries: [],
          resolution: { targetDescription: '', attempts: [], winningTier: 5, winningKind: 'structural', degraded: true, elapsedMs: 1 },
        })),
        degradedResolutions: degraded.length,
        evidence: { runId: `r${i}`, bundlePath: dir, screenshots: [], domSnapshots: [] },
      }),
    );
    writeFileSync(
      join(dir, 'log.jsonl'),
      spec.faultArmed
        ? `${JSON.stringify({ ts: '', seq: 1, runId: 'r', type: 'note', message: 'armed fault "app_error" on scope "search"' })}\n`
        : `${JSON.stringify({ ts: '', seq: 1, runId: 'r', type: 'run_started', message: 'replay lookup v1' })}\n`,
    );
  });
  return root;
}

describe('fleetHealth, the ordering', () => {
  it('puts a silently drifting capability above a loudly failing one', () => {
    const dir = evidenceWith([
      { status: 'failure', failureCode: 'APP_ERROR', tenantId: 'cascade-cu' },
      { degradedSteps: ['search'], tenantId: 'northpoint-fcu' },
    ]);
    const findings = fleetHealth([artifact()], ['northpoint-fcu', 'cascade-cu'], { evidenceDir: dir });
    expect(findings[0]!.severity).toBe('drifting');
    expect(findings.find((f) => f.severity === 'failing')).toBeDefined();
  });

  it('names the degraded steps and gives the command that investigates them', () => {
    const dir = evidenceWith([{ degradedSteps: ['type_4', 'click_5'] }]);
    const [finding] = fleetHealth([artifact()], ['northpoint-fcu'], { evidenceDir: dir });
    expect(finding!.detail).toContain('type_4, click_5');
    expect(finding!.action).toContain('stability lookup');
  });
});

describe('fleetHealth, not crying wolf', () => {
  it('does not report a deliberately injected fault as a fleet problem', () => {
    // The committed evidence demonstrates the taxonomy by breaking things on
    // purpose. Counting those would make correct error handling read forever
    // as a broken capability.
    const dir = evidenceWith([{ status: 'failure', failureCode: 'APP_ERROR', faultArmed: true }]);
    const findings = fleetHealth([artifact()], ['northpoint-fcu'], { evidenceDir: dir });
    expect(findings.find((f) => f.severity === 'failing')).toBeUndefined();
  });

  it('does not report a rejected input as a failure, because the contract worked', () => {
    const dir = evidenceWith([{ status: 'failure', failureCode: 'INPUT_VALIDATION_FAILED' }]);
    const findings = fleetHealth([artifact()], ['northpoint-fcu'], { evidenceDir: dir });
    expect(findings.find((f) => f.severity === 'failing')).toBeUndefined();
  });

  it('does not claim a capability is untested at an institution that runs a different product', () => {
    // A capability recorded against a public web shop is not "untested at
    // Northpoint FCU", it is irrelevant there. No overlay exists for these
    // tenants in the test fixture, which is exactly the absence-of-evidence
    // case, and absence must not be read as applicability.
    const dir = evidenceWith([{ tenantId: 'www.saucedemo.com' }]);
    const findings = fleetHealth(
      [artifact({ target: { surface: 'web', app: { vendor: 'sauce', product: 'swag-labs' }, entryUrlTemplate: 'x' } })],
      ['northpoint-fcu', 'cascade-cu'],
      { evidenceDir: dir },
    );
    expect(findings.find((f) => f.headline.includes('never replayed'))).toBeUndefined();
  });

  it('reports nothing at all when everything is healthy', () => {
    const dir = evidenceWith([{ tenantId: 'northpoint-fcu' }]);
    const findings = fleetHealth([artifact()], ['northpoint-fcu'], { evidenceDir: dir });
    expect(findings).toEqual([]);
  });
});

describe('fleetHealth, what the artifact admits about itself', () => {
  it('raises a draft, because policy refuses it at every institution', () => {
    const dir = evidenceWith([{}]);
    const findings = fleetHealth([artifact({ approval: { state: 'draft' } })], ['northpoint-fcu'], { evidenceDir: dir });
    const ungated = findings.find((f) => f.severity === 'ungated');
    expect(ungated?.tenantId).toBe('(all)');
  });

  it('counts outcomes with no current observation behind them', () => {
    const dir = evidenceWith([{}]);
    const findings = fleetHealth(
      [artifact({ outcomes: [outcome('A'), outcome('B', { state: 'observed', probedAt: daysAgo(400) }), outcome('C', { state: 'observed', probedAt: daysAgo(1) })] })],
      ['northpoint-fcu'],
      { evidenceDir: dir },
    );
    const unverified = findings.find((f) => f.severity === 'unverified');
    expect(unverified?.headline).toContain('2 of 3');
    expect(unverified?.detail).toContain('stale');
  });
});

describe('fleetRuns', () => {
  it('reads every capability across every institution', () => {
    const dir = evidenceWith([{ tenantId: 'northpoint-fcu' }, { tenantId: 'cascade-cu' }]);
    expect(fleetRuns(dir).map((r) => r.tenantId).sort()).toEqual(['cascade-cu', 'northpoint-fcu']);
  });

  it('returns nothing rather than throwing when there is no evidence directory', () => {
    expect(fleetRuns(join(tmpdir(), 'nope-not-here'))).toEqual([]);
  });
});

describe('renderFleet', () => {
  it('says so plainly when there is nothing to do', () => {
    expect(renderFleet([], [artifact()], ['northpoint-fcu'])).toContain('Nothing needs attention');
  });

  it('leads with the counts, then the work, each with its command', () => {
    const dir = evidenceWith([{ degradedSteps: ['search'] }]);
    const findings = fleetHealth([artifact()], ['northpoint-fcu'], { evidenceDir: dir });
    const rendered = renderFleet(findings, [artifact()], ['northpoint-fcu']);
    expect(rendered).toContain('1 drifting');
    expect(rendered).toContain('→ npx tsx src/cli/index.ts stability');
  });
});
