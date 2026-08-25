/**
 * The audit pack.
 *
 * The section under test is section 7. A pack that lists only strengths is
 * marketing, and the whole reason to generate this document rather than write
 * it is that a generated one cannot quietly omit the inconvenient half.
 *
 * So these tests are mostly about what the pack refuses to leave out: an
 * outcome nobody verified, an observation that has aged past the threshold, a
 * capability that can commit something irreversible, a draft presented as
 * though it were approved. Each of those is a thing a reviewer would want
 * volunteered, and each is a thing a hand-written summary would drop.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuditPack, openQuestions, observedRuns } from '../src/audit/pack.js';
import { CapabilityArtifactSchema, type BusinessOutcome, type CapabilityArtifact } from '../src/artifact/schema.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function outcome(code: string, evidence: Partial<BusinessOutcome['evidence']> = {}, probe = true): BusinessOutcome {
  return {
    code,
    description: `${code} happened`,
    when: { kind: 'text_present', text: `${code} TEXT`, framePath: [], caseSensitive: false },
    extract: [],
    ...(probe ? { probe: { parameter: 'memberId', value: '999999', rationale: '' } } : {}),
    evidence: { state: 'hypothesised', ...evidence } as BusinessOutcome['evidence'],
  };
}

function artifact(overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup_member_savings_balance',
    version: 1,
    title: 'Look up a savings balance',
    description: 'Reads a member savings balance from the servicing console.',
    approval: { state: 'approved', approvedBy: 'a.reviewer', approvedAt: '2026-08-01T00:00:00.000Z' },
    target: { surface: 'web', app: { vendor: 'meridian', product: 'servicing-console' }, entryUrlTemplate: '{{baseUrl}}/' },
    inputs: [
      { name: 'memberId', type: 'string', description: 'member number' },
      { name: 'operatorPassword', type: 'string', description: 'pw', sensitivity: 'secret', injected: true },
    ],
    outputs: [],
    steps: [{ id: 'search', intent: 'run the search', risk: 'mutate_reversible', action: { kind: 'click', target: { description: 'Search', framePath: [], candidates: [{ kind: 'role_name', role: 'button', name: 'Search', exact: true }], evidence: {} } } }],
    checkpoint: { description: 'shown', condition: { kind: 'text_present', text: 'PROFILE', framePath: [], caseSensitive: false } },
    outcomes: [],
    provenance: { discoveredAt: '2026-08-01T00:00:00.000Z', runId: 'r', goal: 'read a balance', model: 'claude-opus-5' },
    ...overrides,
  });
}

/** An evidence directory holding one committed run, as the real one does. */
function evidenceDirWith(runs: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'cua-audit-'));
  runs.forEach((run, i) => {
    const dir = join(root, `replay-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify(run));
  });
  return root;
}

const RUN = {
  capabilityId: 'lookup_member_savings_balance',
  capabilityVersion: 1,
  tenantId: 'northpoint-fcu',
  startedAt: '2026-08-16T05:33:17.755Z',
  finishedAt: '2026-08-16T05:33:19.352Z',
  durationMs: 1597,
  status: 'success',
  outputs: {},
  steps: [],
  degradedResolutions: 0,
  evidence: { runId: 'r', bundlePath: 'runs/r', screenshots: [], domSnapshots: [] },
};

describe('openQuestions', () => {
  it('flags a refuted outcome as material, because it would not fire at run time', () => {
    const q = openQuestions(
      artifact({ outcomes: [outcome('MEMBER_NOT_FOUND', { state: 'refuted', probedAt: daysAgo(1), note: 'did not fire' })] }),
      [],
    );
    const refuted = q.find((x) => x.subject === 'MEMBER_NOT_FOUND');
    expect(refuted?.severity).toBe('material');
  });

  it('flags an outcome nobody has ever verified', () => {
    const q = openQuestions(artifact({ outcomes: [outcome('SIGN_ON_FAILED')] }), []);
    const found = q.find((x) => x.subject === 'SIGN_ON_FAILED');
    expect(found?.severity).toBe('notable');
    expect(found?.finding).toMatch(/never took this path/);
  });

  it('says so when an outcome cannot be tested automatically at all', () => {
    // No probe declared means nobody recorded how to provoke it, which is a
    // different problem from having tried and failed, and needs a person.
    const q = openQuestions(artifact({ outcomes: [outcome('NO_ACCOUNTS', {}, false)] }), []);
    expect(q.find((x) => x.subject === 'NO_ACCOUNTS')?.finding).toMatch(/No probe is declared/);
  });

  it('flags an observation that has aged past the threshold', () => {
    const q = openQuestions(
      artifact({ outcomes: [outcome('MEMBER_NOT_FOUND', { state: 'observed', probedAt: daysAgo(400) })] }),
      [],
    );
    expect(q.find((x) => x.subject === 'MEMBER_NOT_FOUND')?.finding).toMatch(/past the .* threshold/);
  });

  it('says nothing about an outcome that is currently verified', () => {
    const q = openQuestions(
      artifact({ outcomes: [outcome('MEMBER_NOT_FOUND', { state: 'observed', probedAt: daysAgo(2) })] }),
      [RUN as never],
    );
    expect(q.find((x) => x.subject === 'MEMBER_NOT_FOUND')).toBeUndefined();
  });

  it('raises an irreversible capability as material even when everything else is clean', () => {
    const q = openQuestions(artifact({ maxRisk: 'mutate_irreversible' }), [RUN as never]);
    const found = q.find((x) => x.subject === 'Irreversible action');
    expect(found?.severity).toBe('material');
    // The mitigation is stated alongside it: a reviewer needs to know it is
    // gated, not only that it exists.
    expect(found?.soWhat).toMatch(/will not run unattended/);
  });

  it('raises a draft as material, since it cannot be relied on at all', () => {
    const q = openQuestions(artifact({ approval: { state: 'draft' } }), [RUN as never]);
    expect(q.find((x) => x.subject === 'Approval')?.severity).toBe('material');
  });

  it('reports a locator seen degrading in any recorded run', () => {
    const q = openQuestions(artifact(), [{ ...RUN, degradedResolutions: 1, degradedSteps: ['search'] } as never]);
    const found = q.find((x) => x.subject === 'Locator degradation');
    expect(found?.finding).toMatch(/search/);
    // Not material: the run still worked. Overstating it would train a reader
    // to ignore the severity column.
    expect(found?.severity).toBe('notable');
  });

  it('says when there is no recorded history to check anything against', () => {
    const q = openQuestions(artifact(), []);
    expect(q.find((x) => x.subject === 'Operating history')).toBeDefined();
  });

  it('orders material findings above notable ones', () => {
    const q = openQuestions(
      artifact({ maxRisk: 'mutate_irreversible', outcomes: [outcome('A')] }),
      [RUN as never],
    );
    expect(q[0]!.severity).toBe('material');
  });
});

describe('observedRuns', () => {
  it('reads committed runs of this capability and ignores other capabilities', () => {
    const dir = evidenceDirWith([RUN, { ...RUN, capabilityId: 'something_else' }]);
    const runs = observedRuns('lookup_member_savings_balance', dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.tenantId).toBe('northpoint-fcu');
  });

  it('survives a malformed bundle rather than refusing to produce a pack', () => {
    // An audit pack that cannot be generated because one file on disk is
    // unreadable is one nobody can produce on the day they need it.
    const dir = evidenceDirWith([RUN]);
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'result.json'), '{not json');
    expect(observedRuns('lookup_member_savings_balance', dir)).toHaveLength(1);
  });

  it('returns nothing when the evidence directory does not exist', () => {
    expect(observedRuns('anything', join(tmpdir(), 'definitely-not-here'))).toEqual([]);
  });
});

describe('buildAuditPack', () => {
  it('answers the six questions a reviewer actually asks', () => {
    const pack = buildAuditPack(artifact({ outcomes: [outcome('A', { state: 'observed', probedAt: daysAgo(1) })] }), evidenceDirWith([RUN]));
    for (const heading of [
      'What this automation does',
      'What it is permitted to do',
      'Data it handles',
      'Who approved it',
      'What is claimed, and what backs it',
      'Recorded operating history',
      'Open questions',
    ]) {
      expect(pack).toContain(heading);
    }
  });

  it('names the credential as injected rather than listing it as an input a caller supplies', () => {
    const pack = buildAuditPack(artifact(), evidenceDirWith([RUN]));
    expect(pack).toMatch(/operatorPassword.*credential.*runtime credential store/s);
  });

  it('marks a draft prominently rather than burying it', () => {
    const pack = buildAuditPack(artifact({ approval: { state: 'draft' } }), evidenceDirWith([RUN]));
    expect(pack).toContain('DRAFT — will not replay unattended');
  });

  it('records what recording cost when the artifact carries it', () => {
    const withCost = artifact({
      provenance: {
        discoveredAt: '2026-08-01T00:00:00.000Z',
        runId: 'r',
        goal: 'g',
        model: 'm',
        cost: { turns: 9, totalTokens: 60336, costUsd: 0.552693 },
      },
    });
    expect(buildAuditPack(withCost, evidenceDirWith([RUN]))).toMatch(/60,336 tokens over 9 model turns/);
  });

  it('states plainly that nothing is verified when nothing is', () => {
    const pack = buildAuditPack(artifact({ outcomes: [outcome('A'), outcome('B')] }), evidenceDirWith([RUN]));
    expect(pack).toContain('unverified hypothesis');
    expect(pack).toContain('## 7. Open questions');
    expect(pack).not.toContain('None outstanding');
  });
});
