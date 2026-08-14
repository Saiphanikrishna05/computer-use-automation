/**
 * The replay result contract.
 *
 * The brief names the most common design mistake in this problem directly:
 * conflating a legitimate business answer with a crash. So the distinction is
 * made *structurally* rather than documented — a caller cannot accidentally
 * treat "no such member" as a failure, because it does not arrive on the
 * failure branch of the union.
 *
 *   success           the flow completed and the checkpoint held
 *   business_outcome  the app gave a real, expected answer that isn't success
 *   escalated         a human was needed; the run is parked, not lost
 *   failure           something is wrong with the automation or the app
 *
 * Recoverable conditions do not appear here at all, and that is the point:
 * they are handled inside the run, recorded in the step reports, and are
 * invisible to the caller unless they exhaust their attempts — at which point
 * they become a failure with the recovery history attached.
 */

import type { ResolutionReport } from '../surface/types.js';

export type FailureCode =
  /** The descriptor matched nothing at any tier. */
  | 'TARGET_NOT_FOUND'
  /** Matched several elements and the artifact did not say which. */
  | 'TARGET_AMBIGUOUS'
  /** Flow ran to the end but the success condition did not hold. */
  | 'CHECKPOINT_FAILED'
  /** A step's own assertion failed — the click "worked" but did nothing. */
  | 'POSTCONDITION_FAILED'
  | 'STEP_TIMEOUT'
  /** Blocked by the allowlist or the action-class ceiling. */
  | 'POLICY_BLOCKED'
  /** The application itself errored (5xx page, vendor error screen). */
  | 'APP_ERROR'
  /** Session dropped and could not be recovered within the declared rules. */
  | 'SESSION_EXPIRED'
  /** A modal was up that no recovery rule claimed. */
  | 'UNHANDLED_DIALOG'
  | 'OUTPUT_EXTRACTION_FAILED'
  | 'INPUT_VALIDATION_FAILED'
  | 'ARTIFACT_NOT_APPROVED'
  /** A human was required but no operator channel was available. */
  | 'ESCALATION_UNAVAILABLE'
  | 'RECOVERY_EXHAUSTED'
  | 'INTERNAL_ERROR';

export interface RecoveryReport {
  code: string;
  attempt: number;
  succeeded: boolean;
  note?: string;
}

export interface StepReport {
  stepId: string;
  intent: string;
  action: string;
  status: 'ok' | 'recovered' | 'failed' | 'skipped';
  elapsedMs: number;
  resolution?: ResolutionReport;
  recoveries: RecoveryReport[];
  note?: string;
}

export interface RunEvidence {
  runId: string;
  /** Directory holding the log, screenshots and DOM snapshots for this run. */
  bundlePath: string;
  screenshots: string[];
  domSnapshots: string[];
}

export interface ReplayFailure {
  code: FailureCode;
  /** Step the run died on, when it died in a step. */
  stepId?: string;
  /** What the system was trying to achieve, in the artifact's own words. */
  expected: string;
  /** What it actually observed. */
  observed: string;
  detail?: string;
  resolution?: ResolutionReport;
}

interface ReplayBase {
  capabilityId: string;
  capabilityVersion: number;
  tenantId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepReport[];
  evidence: RunEvidence;
  /**
   * Aggregate drift signal: how many steps resolved through a weaker locator
   * than the artifact recorded. Zero on a healthy capability; a rising number
   * is the early warning that the UI has moved.
   */
  degradedResolutions: number;
}

export type ReplayResult =
  | (ReplayBase & { status: 'success'; outputs: Record<string, unknown> })
  | (ReplayBase & { status: 'business_outcome'; outcome: string; outcomeDescription: string; data: Record<string, unknown> })
  | (ReplayBase & { status: 'escalated'; interventionId: string; reason: string; resumable: boolean })
  | (ReplayBase & { status: 'failure'; error: ReplayFailure });

/** One-line summary for a CLI or a calling agent's log. */
export function summarize(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return `success · ${Object.keys(result.outputs).length} output(s) · ${result.durationMs}ms`;
    case 'business_outcome':
      return `business outcome ${result.outcome} · ${result.outcomeDescription}`;
    case 'escalated':
      return `escalated · intervention ${result.interventionId} · ${result.reason}`;
    case 'failure':
      return `failure ${result.error.code} at step ${result.error.stepId ?? '(none)'} · expected ${result.error.expected} · observed ${result.error.observed}`;
  }
}
