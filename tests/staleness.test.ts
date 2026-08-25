/**
 * The shelf life of an observation.
 *
 * Everything here is tested against an injected clock rather than the real one,
 * because a test that has to wait ninety days is not a test. That is also the
 * reason the production code takes `now` as a parameter at all.
 *
 * The case worth reading is the boundary one. An observation 89.6 days old
 * under a 90-day threshold is fresh, and it stays fresh whether or not the
 * display rounds it to 89. Comparing the rounded number would be right on every
 * day except the one where it matters.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  freshnessOf,
  freshnessReport,
  staleOutcomes,
  summariseFreshness,
  describeAge,
  ageInDays,
  maxObservationAgeDays,
} from '../src/artifact/staleness.js';
import { CapabilityArtifactSchema, type BusinessOutcome, type CapabilityArtifact } from '../src/artifact/schema.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

afterEach(() => {
  delete process.env.CUA_OBSERVATION_MAX_AGE_DAYS;
});

function outcome(
  code: string,
  evidence: Partial<BusinessOutcome['evidence']> = {},
): BusinessOutcome {
  return {
    code,
    description: code,
    when: { kind: 'text_present', text: code, framePath: [], caseSensitive: false },
    extract: [],
    evidence: { state: 'hypothesised', ...evidence } as BusinessOutcome['evidence'],
  };
}

function artifactWith(outcomes: BusinessOutcome[]): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup',
    version: 1,
    title: 't',
    description: 'd',
    target: { surface: 'web', app: { vendor: 'v', product: 'p' }, entryUrlTemplate: '{{baseUrl}}/' },
    steps: [{ id: 's', intent: 'i', action: { kind: 'assert', condition: { kind: 'text_present', text: 'x', framePath: [], caseSensitive: false } } }],
    checkpoint: { description: 'c', condition: { kind: 'text_present', text: 'x', framePath: [], caseSensitive: false } },
    outcomes,
    provenance: { discoveredAt: '', runId: 'r', goal: 'g', model: 'm' },
  });
}

describe('freshnessOf', () => {
  it('calls a recent observation fresh', () => {
    const f = freshnessOf(outcome('A', { state: 'observed', probedAt: daysBefore(3) }), 90, NOW);
    expect(f.freshness).toBe('fresh');
    expect(f.ageDays).toBe(3);
  });

  it('calls an observation past the threshold stale', () => {
    const f = freshnessOf(outcome('A', { state: 'observed', probedAt: daysBefore(200) }), 90, NOW);
    expect(f.freshness).toBe('stale');
    expect(f.ageDays).toBe(200);
  });

  it('compares exactly rather than on the rounded age', () => {
    // 89.6 days floors to 89. Comparing the floor would agree here by luck;
    // the case that matters is the other side of the same bug.
    expect(freshnessOf(outcome('A', { state: 'observed', probedAt: daysBefore(89.6) }), 90, NOW).freshness).toBe('fresh');
    // 90.4 days floors to 90, which is *not* greater than 90. Rounding first
    // would call this fresh a full day after it stopped being so.
    const late = freshnessOf(outcome('A', { state: 'observed', probedAt: daysBefore(90.4) }), 90, NOW);
    expect(late.ageDays).toBe(90);
    expect(late.freshness).toBe('stale');
  });

  it('never treats an unverified hypothesis as fresh, whatever the clock says', () => {
    expect(freshnessOf(outcome('A'), 90, NOW).freshness).toBe('unverified');
  });

  it('keeps a refutation distinct from an ageing observation', () => {
    // A refuted outcome is known wrong. Re-probing it is not the fix, and
    // folding it into "stale" would suggest that it is.
    const f = freshnessOf(outcome('A', { state: 'refuted', probedAt: daysBefore(400) }), 90, NOW);
    expect(f.freshness).toBe('refuted');
  });

  it('separates an undated observation from an old one', () => {
    // No timestamp is a record-keeping fault in this system; an old timestamp
    // is a fact about the application. Both need re-probing, only one is a bug
    // here, and a reviewer should be able to tell which they are looking at.
    expect(freshnessOf(outcome('A', { state: 'observed' }), 90, NOW).freshness).toBe('undated');
    expect(freshnessOf(outcome('A', { state: 'observed', probedAt: 'not a date' }), 90, NOW).freshness).toBe('undated');
  });
});

describe('staleOutcomes', () => {
  it('returns what needs re-verifying, oldest first', () => {
    const artifact = artifactWith([
      outcome('RECENT', { state: 'observed', probedAt: daysBefore(1) }),
      outcome('OLD', { state: 'observed', probedAt: daysBefore(150) }),
      outcome('OLDEST', { state: 'observed', probedAt: daysBefore(400) }),
      outcome('UNDATED', { state: 'observed' }),
    ]);
    const stale = staleOutcomes(artifact, 90, NOW);
    // Undated sorts first: an unknown age is not a small one.
    expect(stale.map((s) => s.code)).toEqual(['UNDATED', 'OLDEST', 'OLD']);
  });

  it('is empty when everything has been verified recently', () => {
    const artifact = artifactWith([outcome('A', { state: 'observed', probedAt: daysBefore(2) })]);
    expect(staleOutcomes(artifact, 90, NOW)).toHaveLength(0);
  });
});

describe('summariseFreshness', () => {
  it('reports each category a reviewer would act on differently', () => {
    const artifact = artifactWith([
      outcome('A', { state: 'observed', probedAt: daysBefore(2) }),
      outcome('B', { state: 'observed', probedAt: daysBefore(300) }),
      outcome('C', { state: 'refuted', probedAt: daysBefore(2) }),
      outcome('D'),
    ]);
    const summary = summariseFreshness(freshnessReport(artifact, 90, NOW));
    expect(summary).toContain('1 observed');
    expect(summary).toContain('1 STALE');
    expect(summary).toContain('1 REFUTED');
    expect(summary).toContain('1 unverified');
  });

  it('is empty for a capability declaring no outcomes, so callers need no special case', () => {
    expect(summariseFreshness(freshnessReport(artifactWith([]), 90, NOW))).toBe('');
  });
});

describe('the threshold', () => {
  it('defaults to 90 days and is overridable by whoever operates the system', () => {
    expect(maxObservationAgeDays()).toBe(90);
    process.env.CUA_OBSERVATION_MAX_AGE_DAYS = '30';
    expect(maxObservationAgeDays()).toBe(30);
  });

  it('ignores a nonsensical override rather than treating everything as stale', () => {
    process.env.CUA_OBSERVATION_MAX_AGE_DAYS = 'soon';
    expect(maxObservationAgeDays()).toBe(90);
    process.env.CUA_OBSERVATION_MAX_AGE_DAYS = '-5';
    expect(maxObservationAgeDays()).toBe(90);
  });
});

describe('describeAge', () => {
  it('reads the way a person would say it', () => {
    expect(describeAge(0)).toBe('today');
    expect(describeAge(1)).toBe('yesterday');
    expect(describeAge(14)).toBe('14 days ago');
    // Past a couple of months, a raw day count is a number the reader has to
    // convert themselves.
    expect(describeAge(150)).toBe('5 months ago');
    expect(describeAge(800)).toBe('2 years ago');
    expect(describeAge(undefined)).toBe('never');
  });

  it('measures age from the timestamp, not from the calendar date', () => {
    expect(ageInDays(daysBefore(5), NOW)).toBe(5);
    expect(ageInDays('nonsense', NOW)).toBeUndefined();
  });
});
