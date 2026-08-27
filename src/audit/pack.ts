/**
 * The audit pack: what you hand someone who has to sign off on this.
 *
 * A capability artifact is complete and precise and almost useless to the
 * person whose approval actually gates production, who is a risk officer, an
 * internal auditor, or a regulator's examiner, and who is not going to read
 * JSON. The questions they ask are always the same six:
 *
 *   what does it do · what may it do · what data does it touch ·
 *   who approved it and on what basis · what proves any of that ·
 *   what do you still not know
 *
 * Every one of those is already answered somewhere in this repository. This
 * assembles them into one document, from the artifact and the committed
 * evidence, with nothing typed in by hand.
 *
 * **The last section is the point.** A pack that only lists strengths is
 * marketing, and an examiner has met marketing before. `Open questions` names
 * every outcome nobody has verified, every observation old enough to be
 * suspect, every locator seen degrading, and every claim the system makes on
 * the model's word rather than on evidence. Volunteering that is what makes the
 * rest of the document worth believing, and it is also simply true: a system
 * that acts on member accounts should be loudest about the parts of itself it
 * cannot vouch for.
 *
 * Generated, never authored. A pack written by hand is out of date the moment
 * the capability changes, and the gap between the document and the system is
 * exactly where an audit finding lives.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityArtifact } from '../artifact/schema.js';
import { freshnessOf, describeAge, maxObservationAgeDays, type Freshness } from '../artifact/staleness.js';
import { formatTokens, formatUsd } from '../discovery/cost.js';
import type { ReplayResult } from '../replay/result.js';

export interface ObservedRun {
  bundle: string;
  status: ReplayResult['status'];
  outcome?: string;
  failureCode?: string;
  tenantId?: string;
  startedAt?: string;
  durationMs: number;
  degradedResolutions: number;
  degradedSteps: string[];
}

/**
 * Every committed run of this capability.
 *
 * Read from `evidence/`, not from `runs/`. `runs/` is working output that is
 * gitignored and differs between machines; the committed bundles are what a
 * reader can actually go and check, which is the only kind of citation worth
 * putting in an audit document.
 */
export function observedRuns(capabilityId: string, evidenceDir = 'evidence'): ObservedRun[] {
  if (!existsSync(evidenceDir)) return [];
  const runs: ObservedRun[] = [];

  for (const entry of readdirSync(evidenceDir)) {
    const resultPath = join(evidenceDir, entry, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as ReplayResult;
      if (result.capabilityId !== capabilityId) continue;

      runs.push({
        bundle: join(evidenceDir, entry),
        status: result.status,
        ...(result.status === 'business_outcome' ? { outcome: result.outcome } : {}),
        ...(result.status === 'failure' ? { failureCode: result.error.code } : {}),
        ...(result.tenantId ? { tenantId: result.tenantId } : {}),
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        durationMs: result.durationMs,
        degradedResolutions: result.degradedResolutions,
        degradedSteps: result.steps.filter((s) => s.resolution?.degraded).map((s) => s.stepId),
      });
    } catch {
      // A malformed bundle is skipped rather than fatal. An audit pack that
      // refuses to generate because one artefact on disk is unreadable is an
      // audit pack nobody can produce on the day they need it.
    }
  }

  return runs.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}

export interface OpenQuestion {
  severity: 'material' | 'notable' | 'noted';
  subject: string;
  finding: string;
  soWhat: string;
}

/**
 * What this capability cannot currently vouch for.
 *
 * Ordered by how much it should change a reviewer's decision, not by how easy
 * it is to fix. `material` means do not approve without addressing it.
 */
export function openQuestions(artifact: CapabilityArtifact, runs: ObservedRun[]): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  const maxAge = maxObservationAgeDays();

  for (const outcome of artifact.outcomes) {
    const freshness = freshnessOf(outcome, maxAge);
    const detail = ((f: Freshness): OpenQuestion | undefined => {
      switch (f) {
        case 'refuted':
          return {
            severity: 'material',
            subject: outcome.code,
            finding: `Probed, and the declared condition did not fire. ${outcome.evidence.note ?? ''}`.trim(),
            soWhat:
              'This state would not be recognised at run time. The caller would receive a failure, or a ' +
              'different outcome, instead of this answer.',
          };
        case 'unverified':
          return {
            severity: 'notable',
            subject: outcome.code,
            finding:
              'Declared by the recording model from a run that never took this path, and never provoked ' +
              `since. ${outcome.probe ? '' : 'No probe is declared, so it cannot currently be tested automatically.'}`.trim(),
            soWhat: 'Accepted on the model\'s word. If the wording is wrong, this outcome silently never fires.',
          };
        case 'stale':
          return {
            severity: 'notable',
            subject: outcome.code,
            finding: `Verified, but ${describeAge(freshness.ageDays)}, past the ${maxAge}-day threshold.`,
            soWhat:
              'The application may have been through vendor releases since. The observation is not wrong, ' +
              'it is simply no longer current.',
          };
        case 'undated':
          return {
            severity: 'notable',
            subject: outcome.code,
            finding: 'Marked observed, but carries no timestamp.',
            soWhat: 'Age cannot be established, so freshness cannot be argued either way.',
          };
        case 'fresh':
          return undefined;
      }
    })(freshness.freshness);
    if (detail) questions.push(detail);
  }

  if (artifact.maxRisk === 'mutate_irreversible') {
    questions.push({
      severity: 'material',
      subject: 'Irreversible action',
      finding: 'This capability contains a step classified as irreversible.',
      soWhat:
        'It will not run unattended: policy refuses the step and raises an intervention for a named human, ' +
        'who either performs it themselves or authorises it. That refusal is enforced in the driver, not ' +
        'requested in a prompt.',
    });
  }

  const degraded = new Set(runs.flatMap((r) => r.degradedSteps));
  if (degraded.size > 0) {
    questions.push({
      severity: 'notable',
      subject: 'Locator degradation',
      finding: `${[...degraded].join(', ')} resolved through a weaker locator than recorded in at least one run.`,
      soWhat:
        'The step still worked. A rising count is the early warning that the application has moved and this ' +
        'capability is approaching the point where it will not.',
    });
  }

  if (artifact.approval.state !== 'approved') {
    questions.push({
      severity: 'material',
      subject: 'Approval',
      finding: 'This capability is a draft.',
      soWhat: 'Unattended replay is refused outright until a named reviewer approves it.',
    });
  }

  if (runs.length === 0) {
    questions.push({
      severity: 'notable',
      subject: 'Operating history',
      finding: 'No committed run of this capability was found in evidence/.',
      soWhat: 'Nothing here can be independently checked against a recorded execution.',
    });
  }

  const order = { material: 0, notable: 1, noted: 2 };
  return questions.sort((a, b) => order[a.severity] - order[b.severity]);
}

const SENSITIVITY_NOTE: Record<string, string> = {
  none: 'not sensitive',
  pii: 'personal data',
  financial: 'financial data',
  secret: 'credential',
};

export function buildAuditPack(artifact: CapabilityArtifact, evidenceDir = 'evidence'): string {
  const runs = observedRuns(artifact.id, evidenceDir);
  const questions = openQuestions(artifact, runs);
  const maxAge = maxObservationAgeDays();
  const out: string[] = [];
  const w = (line = '') => out.push(line);

  w(`# Capability audit pack — \`${artifact.id}\` v${artifact.version}`);
  w();
  w(`**${artifact.title}**`);
  w();
  w(
    `Generated ${new Date().toISOString().slice(0, 10)} from the capability artifact and the committed ` +
      `evidence in \`${evidenceDir}/\`. Nothing in this document is written by hand; every claim below is ` +
      `read out of the artifact or a recorded run, and every citation is a path you can open.`,
  );
  w();

  // --- 1. what it does -----------------------------------------------------
  w('## 1. What this automation does');
  w();
  w(artifact.description);
  w();
  w(`It operates **${artifact.target.app.vendor} ${artifact.target.app.product}** (${artifact.target.app.versionRange}) `
    + `through its user interface, the way a member services representative would. The application exposes no `
    + `API for this task; driving the screen is the only route in.`);
  w();
  w(`| | |`);
  w(`|---|---|`);
  w(`| Steps | ${artifact.steps.length} |`);
  w(`| Highest risk class | \`${artifact.maxRisk}\` |`);
  w(`| Approval state | ${artifact.approval.state === 'approved' ? '**approved**' : '**DRAFT — will not replay unattended**'} |`);
  w(`| Declared outcomes | ${artifact.outcomes.length} |`);
  w(`| Declared recovery rules | ${artifact.recovery.length} |`);
  w();

  // --- 2. authority --------------------------------------------------------
  w('## 2. What it is permitted to do');
  w();
  w('Every step carries a risk classification, and the axis is **reversibility, not danger**. "Risky" is a '
    + 'judgement; "can this be undone" is a fact.');
  w();
  w('| Step | Intent | Risk |');
  w('|---|---|---|');
  for (const step of artifact.steps) {
    w(`| \`${step.id}\` | ${step.intent} | \`${step.risk}\` |`);
  }
  w();
  const irreversible = artifact.steps.filter((s) => s.risk === 'mutate_irreversible');
  w(
    irreversible.length === 0
      ? 'No step in this capability is irreversible. It reads and it fills in forms; it commits nothing.'
      : `**${irreversible.length} step(s) are irreversible** (${irreversible.map((s) => `\`${s.id}\``).join(', ')}). ` +
        'These are refused under unattended replay and raise an intervention for a named human instead. The ' +
        'refusal is enforced in the surface driver, on a code path no prompt and no page content can address.',
  );
  w();

  // --- 3. data -------------------------------------------------------------
  w('## 3. Data it handles');
  w();
  w('| Field | Direction | Classification | Notes |');
  w('|---|---|---|---|');
  for (const input of artifact.inputs) {
    const notes = input.injected
      ? 'Supplied by the runtime credential store. Never published to a calling agent, never written to the artifact.'
      : 'Supplied by the caller, validated against the declared contract before the application is touched.';
    w(`| \`${input.name}\` | in | ${SENSITIVITY_NOTE[input.sensitivity] ?? input.sensitivity} | ${notes} |`);
  }
  for (const output of artifact.outputs) {
    w(`| \`${output.name}\` | out | ${SENSITIVITY_NOTE[output.sensitivity] ?? output.sensitivity} | Returned to the caller. |`);
  }
  w();
  w('**Redaction boundary.** Everything persisted or sent to a model is redacted: run logs, DOM snapshots, '
    + 'screenshots (masked at capture time, so an unmasked image never exists on disk), and any prompt. The typed '
    + 'return value handed to the caller is not, because a capability whose job is to return a balance cannot '
    + 'redact the balance out of its own answer. Those are different boundaries and the distinction is deliberate.');
  w();

  // --- 4. approval ---------------------------------------------------------
  w('## 4. Who approved it, and on what basis');
  w();
  if (artifact.approval.state === 'approved') {
    w(`Approved by **${artifact.approval.approvedBy ?? 'unnamed'}**`
      + `${artifact.approval.approvedAt ? ` on ${artifact.approval.approvedAt.slice(0, 10)}` : ''}.`);
    if (artifact.approval.note) w(`\n> ${artifact.approval.note}`);
  } else {
    w('**Not approved.** Unattended replay is refused while this capability is in draft.');
  }
  w();
  if (artifact.provenance.humanEdits.length > 0) {
    w('Every human change to this capability, in order:');
    w();
    for (const edit of artifact.provenance.humanEdits) {
      w(`- **${edit.at.slice(0, 10)}**, ${edit.by} — ${edit.note}`);
    }
    w();
  }

  // --- 5. evidence ---------------------------------------------------------
  w('## 5. What is claimed, and what backs it');
  w();
  w('A capability declares the non-success answers a caller must be able to distinguish. Those declarations '
    + 'start as the recording model\'s hypotheses about paths it never walked, and are only worth anything once '
    + 'something has gone and provoked them.');
  w();
  w('| Outcome | Detected by | Evidence | Last verified |');
  w('|---|---|---|---|');
  for (const outcome of artifact.outcomes) {
    const f = freshnessOf(outcome, maxAge);
    const state = {
      fresh: '**observed**',
      stale: '**observed, now stale**',
      undated: 'observed, undated',
      unverified: 'unverified hypothesis',
      refuted: '**REFUTED**',
    }[f.freshness];
    const cite = outcome.evidence.runId ? ` (\`${outcome.evidence.runId}\`)` : '';
    w(`| \`${outcome.code}\` | ${describeDetection(outcome.when)} | ${state}${cite} | ${describeAge(f.ageDays)} |`);
  }
  w();
  w(`Freshness threshold in force: **${maxAge} days**. An observation answers a question about the application `
    + 'on the day it was asked; it is not evidence forever.');
  w();

  // --- 6. history ----------------------------------------------------------
  w('## 6. Recorded operating history');
  w();
  if (runs.length === 0) {
    w('No committed run of this capability was found.');
  } else {
    w(`${runs.length} committed run(s), each with a full log, the typed result, screenshots masked at capture, `
      + 'and DOM snapshots on failure.');
    w();
    w('| Run | Institution | Result | Duration | Degraded locators | Bundle |');
    w('|---|---|---|---|---|---|');
    for (const run of runs) {
      const result =
        run.status === 'business_outcome' ? `business outcome \`${run.outcome}\`` :
        run.status === 'failure' ? `failure \`${run.failureCode}\`` :
        run.status;
      w(`| ${run.startedAt?.slice(0, 10) ?? '—'} | ${run.tenantId ?? '—'} | ${result} | ${run.durationMs} ms | `
        + `${run.degradedResolutions} | \`${run.bundle}\` |`);
    }
    w();
    const outcomes = runs.filter((r) => r.status === 'business_outcome').length;
    const failures = runs.filter((r) => r.status === 'failure').length;
    w(`Of these, ${runs.filter((r) => r.status === 'success').length} succeeded, ${outcomes} returned a business `
      + `outcome, and ${failures} failed. **A business outcome is not a failure**: "no such member" is a real `
      + 'answer the caller acts on, and the result type keeps the two apart structurally so no caller can '
      + 'confuse them.');
  }
  w();

  // --- 7. the honest bit ---------------------------------------------------
  w('## 7. Open questions');
  w();
  if (questions.length === 0) {
    w('None outstanding. Every declared outcome is backed by a current observation, no locator has been seen '
      + 'degrading, and the capability commits nothing irreversible.');
  } else {
    w('What this capability cannot currently vouch for, worst first. **`material` means it should not be '
      + 'approved, or relied on further, until addressed.**');
    w();
    w('| | Subject | Finding | Why it matters |');
    w('|---|---|---|---|');
    for (const q of questions) {
      w(`| \`${q.severity}\` | ${q.subject} | ${q.finding} | ${q.soWhat} |`);
    }
  }
  w();

  // --- 8. provenance -------------------------------------------------------
  w('## 8. How this capability came to exist');
  w();
  w(`Discovered ${artifact.provenance.discoveredAt.slice(0, 10) || '(undated)'} by \`${artifact.provenance.model}\`, `
    + `from the goal: *"${artifact.provenance.goal}"*.`);
  w();
  const cost = artifact.provenance.cost;
  if (cost) {
    w(`Recording it consumed **${formatTokens(cost.totalTokens)} tokens over ${cost.turns} model turns, `
      + `${formatUsd(cost.costUsd)}**. Replaying it consumes none: there is no model in that path, which is why `
      + 'replay runs with no API key configured.');
    w();
  }
  w('A model worked out how to do this **once**, by driving the real application. That run was recorded as this '
    + 'typed, reviewable artifact. Everything since has been deterministic code executing that recording. The '
    + 'model is not consulted at run time, cannot be prompted at run time, and cannot change what this '
    + 'capability does.');
  w();
  if (artifact.provenance.evidencePath) {
    w(`Discovery evidence: \`${artifact.provenance.evidencePath}\``);
    w();
  }

  return out.join('\n');
}

function describeDetection(condition: { kind: string } & Record<string, unknown>): string {
  if (condition.kind === 'text_present' && typeof condition.text === 'string') {
    return `the text "${condition.text}" appearing on screen`;
  }
  if (condition.kind === 'dialog_present') return 'a native dialog being raised';
  return condition.kind;
}
