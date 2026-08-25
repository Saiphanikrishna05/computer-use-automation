/**
 * Fleet health: what to fix first, across every institution.
 *
 * One capability on one tenant is a demo. A hundred credit unions running the
 * same vendor product is the actual problem, and it has a specific shape: the
 * vendor ships a point release, it reaches institutions on their own schedules,
 * and some number of recorded capabilities quietly stop being able to find
 * things. Nobody finds out from the automation. They find out from a member.
 *
 * Every signal needed to see that coming is already recorded per run — which
 * locator tier won, whether it was weaker than the artifact expected, which
 * outcomes have evidence behind them, how old that evidence is. What was
 * missing is anywhere to look at all of them at once.
 *
 * **This is a work list, not a dashboard.** A dashboard is a thing somebody has
 * to remember to open, and it answers "how are things" with a colour. The
 * output here is ordered by what should be dealt with first, each line saying
 * what is wrong, what it will cost if ignored, and the command that addresses
 * it. Something a person can work down, or a pipeline can fail on.
 *
 * The ranking deliberately puts *silent* problems above loud ones. A capability
 * that has started failing is already generating support calls and will be
 * found today by someone. A capability still succeeding through a weaker
 * locator than it was recorded with is the one nobody is looking at, and it is
 * the one that turns into an outage on a Tuesday morning.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityArtifact } from '../artifact/schema.js';
import { loadOverlay } from '../artifact/store.js';
import { freshnessOf, describeAge, maxObservationAgeDays } from '../artifact/staleness.js';
import type { ReplayResult } from '../replay/result.js';

export type Severity = 'failing' | 'drifting' | 'unverified' | 'ungated' | 'healthy';

export interface FleetFinding {
  capabilityId: string;
  tenantId: string;
  severity: Severity;
  /** Lower sorts first. Silent problems outrank loud ones; see the note above. */
  rank: number;
  headline: string;
  detail: string;
  action: string;
}

export interface FleetRun {
  capabilityId: string;
  tenantId: string;
  status: ReplayResult['status'];
  startedAt?: string;
  degradedResolutions: number;
  degradedSteps: string[];
  failureCode?: string;
  /**
   * Whether a fault was deliberately injected into this run.
   *
   * The committed evidence includes runs that provoke an application error or
   * a session drop on purpose, to show the taxonomy classifying them. Counting
   * those as a fleet problem would mean the demonstration of correct error
   * handling permanently reads as a broken capability, and a health view that
   * is wrong on its own evidence is one nobody will trust about anything else.
   */
  faultInjected: boolean;
}

/** Every committed run, across all capabilities and all institutions. */
export function fleetRuns(evidenceDir = 'evidence'): FleetRun[] {
  if (!existsSync(evidenceDir)) return [];
  const runs: FleetRun[] = [];

  for (const entry of readdirSync(evidenceDir)) {
    const path = join(evidenceDir, entry, 'result.json');
    if (!existsSync(path)) continue;
    try {
      const r = JSON.parse(readFileSync(path, 'utf8')) as ReplayResult;
      runs.push({
        faultInjected: faultWasArmed(join(evidenceDir, entry)),
        capabilityId: r.capabilityId,
        tenantId: r.tenantId ?? '(unspecified)',
        status: r.status,
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        degradedResolutions: r.degradedResolutions,
        degradedSteps: r.steps.filter((s) => s.resolution?.degraded).map((s) => s.stepId),
        ...(r.status === 'failure' ? { failureCode: r.error.code } : {}),
      });
    } catch {
      // Skipped rather than fatal, for the same reason as the audit pack: a
      // fleet view that refuses to render because one file is unreadable is
      // useless precisely when something is wrong.
    }
  }
  return runs;
}

/**
 * Rank order. The numbers matter more than they look.
 *
 * `drifting` outranks `failing` on purpose, and it is the one judgement in this
 * file worth arguing about. A failing capability is loud: somebody is already
 * on it, because members are calling. A drifting one is silent, still returning
 * the right answer through a locator one rung weaker than it was recorded with,
 * and it is invisible until the day it is not. Ranking by noise would mean
 * always working on what is already known, which is how the silent problems
 * accumulate.
 */
const RANK: Record<Severity, number> = {
  drifting: 0,
  failing: 1,
  ungated: 2,
  unverified: 3,
  healthy: 9,
};

export interface FleetOptions {
  evidenceDir?: string;
  maxObservationAge?: number;
  now?: Date;
}

export function fleetHealth(
  artifacts: CapabilityArtifact[],
  tenants: string[],
  options: FleetOptions = {},
): FleetFinding[] {
  const runs = fleetRuns(options.evidenceDir ?? 'evidence');
  const maxAge = options.maxObservationAge ?? maxObservationAgeDays();
  const now = options.now ?? new Date();
  const findings: FleetFinding[] = [];

  for (const artifact of artifacts) {
    const mine = runs.filter((r) => r.capabilityId === artifact.id);

    // --- per institution: what the recorded runs actually show --------------
    const seenTenants = [...new Set(mine.map((r) => r.tenantId))];
    for (const tenantId of seenTenants) {
      const here = mine.filter((r) => r.tenantId === tenantId);
      const degraded = [...new Set(here.flatMap((r) => r.degradedSteps))];
      // A rejected input is the contract working, not a fault; an injected
      // fault is a demonstration, not a fleet problem.
      const failing = here.filter(
        (r) => r.status === 'failure' && r.failureCode !== 'INPUT_VALIDATION_FAILED' && !r.faultInjected,
      );

      if (degraded.length > 0) {
        findings.push({
          capabilityId: artifact.id,
          tenantId,
          severity: 'drifting',
          rank: RANK.drifting,
          headline: `${degraded.length} locator(s) resolving below the recorded tier`,
          detail:
            `${degraded.join(', ')} resolved through a weaker signal than when recorded. This institution's ` +
            'build has moved. Nothing has failed yet, and nobody would notice until it does.',
          action: `npx tsx src/cli/index.ts stability ${artifact.id} -t ${tenantId} -n 20`,
        });
      }

      if (failing.length > 0) {
        const codes = [...new Set(failing.map((f) => f.failureCode))].join(', ');
        findings.push({
          capabilityId: artifact.id,
          tenantId,
          severity: 'failing',
          rank: RANK.failing,
          headline: `recorded run(s) ending in ${codes}`,
          detail:
            'Nothing was injected into these; the capability failed on its own. On a live fleet this is the ' +
            'shape of a capability that has stopped working at one institution and not the others.',
          action: `npx tsx src/cli/index.ts replay ${artifact.id} -t ${tenantId}`,
        });
      }
    }

    // --- capability-wide: what the artifact itself admits -------------------
    if (artifact.approval.state !== 'approved') {
      findings.push({
        capabilityId: artifact.id,
        tenantId: '(all)',
        severity: 'ungated',
        rank: RANK.ungated,
        headline: 'draft, so it will not run unattended anywhere',
        detail: 'A capability nobody approved is refused by policy at every institution.',
        action: `npx tsx src/cli/index.ts catalog approve ${artifact.id}`,
      });
    }

    const unbacked = artifact.outcomes.filter((o) => {
      const f = freshnessOf(o, maxAge, now).freshness;
      return f !== 'fresh';
    });
    if (unbacked.length > 0) {
      const refuted = unbacked.filter((o) => o.evidence.state === 'refuted');
      const stale = unbacked.filter((o) => freshnessOf(o, maxAge, now).freshness === 'stale');
      findings.push({
        capabilityId: artifact.id,
        tenantId: '(all)',
        severity: 'unverified',
        rank: RANK.unverified,
        headline:
          `${unbacked.length} of ${artifact.outcomes.length} declared outcome(s) not backed by a current observation`,
        detail:
          [
            refuted.length > 0 ? `${refuted.length} refuted` : '',
            stale.length > 0
              ? `${stale.length} stale (oldest ${describeAge(
                  Math.max(...stale.map((o) => freshnessOf(o, maxAge, now).ageDays ?? 0)),
                )})`
              : '',
            `${unbacked.length - refuted.length - stale.length} never verified`,
          ]
            .filter(Boolean)
            .join(', ') +
          '. These are the answers a caller is told to expect, on the recording model\'s word.',
        action: `npx tsx src/cli/index.ts probe ${artifact.id} --stale-only`,
      });
    }

    // --- institutions this capability has never been proven against ---------
    //
    // Only institutions that actually run this vendor product. A capability
    // recorded against a public web shop is not "untested at Northpoint FCU",
    // it is irrelevant there, and reporting it would be noise in the one view
    // that has to stay worth reading.
    const untested = tenants.filter(
      (t) => !seenTenants.includes(t) && runsThisProduct(t, artifact),
    );
    if (untested.length > 0 && artifact.approval.state === 'approved') {
      findings.push({
        capabilityId: artifact.id,
        tenantId: untested.join(', '),
        severity: 'unverified',
        rank: RANK.unverified,
        headline: `never replayed against ${untested.length} configured institution(s)`,
        detail:
          'The overlay may bind correctly and the capability may still not resolve against that build. Until ' +
          'it has run there, it is an assumption.',
        action: `npx tsx src/cli/index.ts replay ${artifact.id} -t ${untested[0]}`,
      });
    }
  }

  return findings.sort((a, b) => a.rank - b.rank || a.capabilityId.localeCompare(b.capabilityId));
}

/**
 * Whether a tenant runs the product a capability was recorded against.
 *
 * Positive evidence only: an overlay declaring itself applicable to this
 * vendor and product. Absence of an overlay is not evidence either way, so the
 * only other way a tenant counts as applicable is that the capability has
 * already been observed running there.
 */
function runsThisProduct(tenantId: string, artifact: CapabilityArtifact): boolean {
  try {
    const overlay = loadOverlay(tenantId, artifact.id);
    return (
      overlay.appliesTo.vendor === artifact.target.app.vendor &&
      overlay.appliesTo.product === artifact.target.app.product
    );
  } catch {
    // No overlay is not evidence either way, and guessing would put a public
    // web shop on a credit union's work list.
    return false;
  }
}

/** Reads the run log for the marker `replay` writes when a fault is armed. */
function faultWasArmed(bundle: string): boolean {
  const log = join(bundle, 'log.jsonl');
  if (!existsSync(log)) return false;
  try {
    return readFileSync(log, 'utf8').includes('armed fault');
  } catch {
    return false;
  }
}

const MARK: Record<Severity, string> = {
  drifting: '◆',
  failing: '✗',
  ungated: '○',
  unverified: '·',
  healthy: '✓',
};

export function renderFleet(
  findings: FleetFinding[],
  artifacts: CapabilityArtifact[],
  tenants: string[],
): string {
  const out: string[] = [];
  const w = (l = '') => out.push(l);
  const rule = '─'.repeat(72);

  w();
  w(rule);
  w(`  Fleet health · ${artifacts.length} capabilities × ${tenants.length} institutions`);
  w(rule);
  w();

  if (findings.length === 0) {
    w('  Nothing needs attention. Every capability is approved, every declared');
    w('  outcome is backed by a current observation, and no locator has been seen');
    w('  resolving below the tier it was recorded at.');
    w();
    return out.join('\n');
  }

  const bySeverity = (s: Severity) => findings.filter((f) => f.severity === s).length;
  w(
    `  ${bySeverity('drifting')} drifting · ${bySeverity('failing')} failing · ` +
      `${bySeverity('ungated')} ungated · ${bySeverity('unverified')} unverified`,
  );
  w();
  w('  Ordered by what to do first. Drift outranks failure deliberately: a');
  w('  failing capability is already generating support calls, and a drifting one');
  w('  is the one nobody is looking at.');
  w();

  for (const f of findings) {
    w(`  ${MARK[f.severity]} ${f.capabilityId}  ·  ${f.tenantId}`);
    w(`    ${f.headline}`);
    w(`    ${f.detail}`);
    w(`    → ${f.action}`);
    w();
  }

  w(rule);
  return out.join('\n');
}
