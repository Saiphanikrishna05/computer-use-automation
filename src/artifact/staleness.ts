/**
 * The shelf life of an observation.
 *
 * Probing answers "does this declared outcome actually fire?" by going and
 * provoking it. That answer is true about the application *on the day it was
 * asked*. It is not true forever, and the gap between those two things is where
 * a whole class of quiet failure lives: the vendor reworded the not-found
 * banner in a July point release, the capability was verified in March, and the
 * artifact still says `observed` in September with complete confidence.
 *
 * This is the same argument the locator ladder already makes about drift, moved
 * one level up. There, a step that resolves through a weaker tier than recorded
 * is the early warning that the UI moved. Here, an outcome nobody has re-tested
 * since the last release is the early warning that it *might* have, and nothing
 * would say so.
 *
 * **Staleness is derived, never stored.** There is deliberately no fourth
 * evidence state and no job that flips `observed` to `stale`, because that job
 * would be wrong from the moment it stopped running, and an artifact that
 * disagrees with the clock is worse than one that never claimed freshness. The
 * artifact records *when* it was observed; how old that makes it is arithmetic,
 * done at the moment someone asks. The same reason a record holds a date of
 * birth rather than an age.
 */

import type { BusinessOutcome, CapabilityArtifact } from './schema.js';

/**
 * How long an observation is treated as current.
 *
 * Ninety days is a guess dressed as a default, and it is the kind of number
 * that should belong to whoever operates the system rather than to whoever
 * wrote it: an institution on a quarterly vendor release cadence wants
 * something different from one taking continuous updates. Overridable, and the
 * value in force is printed wherever the verdict is.
 */
export function maxObservationAgeDays(): number {
  const raw = Number(process.env.CUA_OBSERVATION_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

export type Freshness = 'fresh' | 'stale' | 'unverified' | 'refuted' | 'undated';

export interface OutcomeFreshness {
  code: string;
  freshness: Freshness;
  ageDays?: number;
  probedAt?: string;
}

const DAY_MS = 86_400_000;

/** Exact age in days, fractional. Used for comparisons. */
export function exactAgeInDays(iso: string, now: Date = new Date()): number | undefined {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  return (now.getTime() - then) / DAY_MS;
}

/**
 * Whole days, for display.
 *
 * Kept separate from the comparison deliberately. Rounding first and comparing
 * second would let an observation 89.6 days old floor to 89 and pass a 90-day
 * threshold, which is a boundary bug of exactly the kind nobody notices,
 * because it only misfires on the day it matters.
 */
export function ageInDays(iso: string, now: Date = new Date()): number | undefined {
  const exact = exactAgeInDays(iso, now);
  return exact === undefined ? undefined : Math.floor(exact);
}

/**
 * What we currently know about one outcome, clock included.
 *
 * `undated` is its own answer rather than being folded into `stale`. An
 * observation with no timestamp is a record-keeping fault in this system; an
 * observation that has simply aged is a fact about the application. Telling a
 * reviewer to go and re-probe would be right in both cases, but only one of
 * them is a bug here.
 */
export function freshnessOf(
  outcome: BusinessOutcome,
  maxAgeDays: number = maxObservationAgeDays(),
  now: Date = new Date(),
): OutcomeFreshness {
  const { state, probedAt } = outcome.evidence;

  if (state === 'refuted') return { code: outcome.code, freshness: 'refuted', ...(probedAt ? { probedAt } : {}) };
  if (state === 'hypothesised') return { code: outcome.code, freshness: 'unverified' };
  if (!probedAt) return { code: outcome.code, freshness: 'undated' };

  const exact = exactAgeInDays(probedAt, now);
  if (exact === undefined) return { code: outcome.code, freshness: 'undated', probedAt };

  return {
    code: outcome.code,
    // Compared exactly, reported rounded.
    freshness: exact > maxAgeDays ? 'stale' : 'fresh',
    ageDays: Math.floor(exact),
    probedAt,
  };
}

export function freshnessReport(
  artifact: CapabilityArtifact,
  maxAgeDays: number = maxObservationAgeDays(),
  now: Date = new Date(),
): OutcomeFreshness[] {
  return artifact.outcomes.map((o) => freshnessOf(o, maxAgeDays, now));
}

/** Outcomes whose evidence has aged out, oldest first, because that is the
 *  order somebody re-verifying them would want to work in. */
export function staleOutcomes(
  artifact: CapabilityArtifact,
  maxAgeDays: number = maxObservationAgeDays(),
  now: Date = new Date(),
): OutcomeFreshness[] {
  return freshnessReport(artifact, maxAgeDays, now)
    .filter((f) => f.freshness === 'stale' || f.freshness === 'undated')
    .sort((a, b) => (b.ageDays ?? Infinity) - (a.ageDays ?? Infinity));
}

/** One-line summary for a catalog listing. Empty when there are no outcomes to
 *  describe, so a caller can concatenate it without a special case. */
export function summariseFreshness(report: OutcomeFreshness[]): string {
  if (report.length === 0) return '';
  const count = (f: Freshness) => report.filter((r) => r.freshness === f).length;
  const parts = [
    count('fresh') > 0 ? `${count('fresh')} observed` : '',
    count('stale') > 0 ? `${count('stale')} STALE` : '',
    count('undated') > 0 ? `${count('undated')} undated` : '',
    count('refuted') > 0 ? `${count('refuted')} REFUTED` : '',
    count('unverified') > 0 ? `${count('unverified')} unverified` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/** How an age reads in a report line. Days up to a point, then months, because
 *  "observed 402 days ago" is a number a reader has to convert themselves. */
export function describeAge(ageDays: number | undefined): string {
  if (ageDays === undefined) return 'never';
  if (ageDays <= 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  if (ageDays < 60) return `${ageDays} days ago`;
  const months = Math.floor(ageDays / 30);
  return months < 24 ? `${months} months ago` : `${Math.floor(ageDays / 365)} years ago`;
}
