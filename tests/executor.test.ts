/**
 * The replay engine.
 *
 * This is the module the whole write-up is about, and until now it was covered
 * only incidentally by integration runs. Integration runs prove the happy path
 * works; they do not prove *why* it works, and every claim in REPORT §3 is a
 * claim about ordering and precedence:
 *
 *   - a business outcome must win over continuing to drive
 *   - a declared failure must win over the checkpoint
 *   - recovery must be budgeted per rule per run, not per step
 *   - `completed_manually` must not re-run the step
 *
 * Each of those is a decision that could silently reverse in a refactor and
 * still pass every integration test, because the happy path never exercises
 * them. So they get direct tests, against a scripted surface rather than a
 * browser.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ReplayEngine, type EscalationHandler, type InterventionOutcome } from '../src/replay/executor.js';
import { PolicyEngine, REPLAY_POLICY } from '../src/policy/engine.js';
import { RunLogger } from '../src/evidence/logger.js';
import { CapabilityArtifactSchema, type CapabilityArtifact, type Condition } from '../src/artifact/schema.js';
import type { SurfaceDriver, SurfaceElement } from '../src/surface/types.js';

const BASE = 'http://app.test';

/**
 * A surface whose screen advances on every click, driven by a script. Enough
 * to exercise ordering and precedence without a browser in the loop.
 */
function scriptedSurface(screens: string[], options: { unresolvable?: string[] } = {}) {
  let index = 0;
  const clicks: number[] = [];
  const element = { __brand: 'SurfaceElement' } as SurfaceElement;
  const unresolvable = new Set(options.unresolvable ?? []);

  const driver: SurfaceDriver = {
    kind: 'web',
    async navigate() {},
    async currentUrl() {
      return `${BASE}/screen/${index}`;
    },
    async title() {
      return '';
    },
    async visibleText() {
      return screens[Math.min(index, screens.length - 1)] ?? '';
    },
    async waitForSettled() {},
    pendingDialog: () => undefined,
    async snapshot() {
      return { url: '', title: '', viewport: { width: 0, height: 0 }, nodes: [], capturedAt: '' };
    },
    async resolve(target) {
      const report = {
        targetDescription: target.description,
        attempts: [],
        winningTier: 1,
        winningKind: 'role_name',
        degraded: false,
        elapsedMs: 0,
      };
      if (unresolvable.has(target.description)) {
        return { ok: false as const, reason: 'not_found' as const, report: { ...report, winningTier: null, winningKind: null } };
      }
      return { ok: true as const, element, report };
    },
    async click() {
      clicks.push(index);
      index += 1;
    },
    async type() {},
    async selectOption() {},
    async press() {},
    async read(_el, _source) {
      // Outputs read from the current screen: the value after "BALANCE=".
      const text = screens[Math.min(index, screens.length - 1)] ?? '';
      return text.match(/BALANCE=([^\s]+)/)?.[1] ?? '';
    },
    async isVisible() {
      return true;
    },
    async screenshot() {
      return Buffer.from('');
    },
    async sourceSnapshot() {
      return '';
    },
    async acceptDialog() {},
    async dismissDialog() {},
    async captureHumanActions() {
      return async () => {};
    },
    async humanClickAt() {},
    async humanType() {},
    async humanPress() {},
    async close() {},
  };

  return { driver, clicks, advance: () => (index += 1), at: () => index };
}

const textPresent = (text: string): Condition => ({ kind: 'text_present', text, framePath: [], caseSensitive: false });

const target = (description: string) => ({
  description,
  framePath: [],
  candidates: [{ kind: 'role_name' as const, role: 'button', name: description, exact: true }],
  evidence: {},
});

function artifact(overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup',
    version: 1,
    title: 't',
    description: 'd',
    approval: { state: 'approved' },
    target: { surface: 'web', app: { vendor: 'v', product: 'p' }, entryUrlTemplate: '{{baseUrl}}/' },
    inputs: [{ name: 'memberId', type: 'string', description: 'id', pattern: '^\\d{6}$' }],
    outputs: [
      {
        name: 'savingsBalance',
        type: 'money',
        description: 'balance',
        extract: { target: target('balance cell'), source: 'text', transforms: ['money'] },
      },
    ],
    steps: [
      { id: 'search', intent: 'run the search', risk: 'mutate_reversible', action: { kind: 'click', target: target('Search') } },
    ],
    checkpoint: { description: 'profile shown', condition: textPresent('MEMBER PROFILE') },
    provenance: { discoveredAt: '', runId: 'r', goal: 'g', model: 'm' },
    ...overrides,
  });
}

const logger = () => new RunLogger({ runId: 'exec-test', rootDir: mkdtempSync(`${tmpdir()}/cua-`), echo: false });

function engineFor(art: CapabilityArtifact, driver: SurfaceDriver, extra: Record<string, unknown> = {}) {
  return new ReplayEngine({
    artifact: art,
    inputs: { memberId: '100001' },
    driver,
    policy: new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [BASE] }),
    logger: logger(),
    bindings: { baseUrl: BASE },
    ...extra,
  });
}

describe('ReplayEngine, the happy path', () => {
  it('runs the steps, verifies the checkpoint, and returns typed outputs', async () => {
    const { driver } = scriptedSurface(['SEARCH SCREEN', 'MEMBER PROFILE BALANCE=$4,182.55']);
    const result = await engineFor(artifact(), driver).run();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    // money coercion, not the raw string
    expect(result.outputs.savingsBalance).toBe(4182.55);
  });
});

describe('ReplayEngine, gates that run before anything is touched', () => {
  it('refuses a draft capability', async () => {
    const { driver, clicks } = scriptedSurface(['SEARCH SCREEN', 'MEMBER PROFILE']);
    const result = await engineFor(artifact({ approval: { state: 'draft' } }), driver).run();

    expect(result.status).toBe('failure');
    if (result.status === 'failure') expect(result.error.code).toBe('ARTIFACT_NOT_APPROVED');
    // Nothing was driven, the gate is before the surface, not after it.
    expect(clicks).toHaveLength(0);
  });

  it('rejects an input that fails its declared pattern, without touching the app', async () => {
    const { driver, clicks } = scriptedSurface(['SEARCH SCREEN', 'MEMBER PROFILE']);
    const engine = new ReplayEngine({
      artifact: artifact(),
      inputs: { memberId: 'not-an-id' },
      driver,
      policy: new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [BASE] }),
      logger: logger(),
      bindings: { baseUrl: BASE },
    });

    const result = await engine.run();
    expect(result.status).toBe('failure');
    if (result.status === 'failure') expect(result.error.code).toBe('INPUT_VALIDATION_FAILED');
    expect(clicks).toHaveLength(0);
  });
});

describe('ReplayEngine, precedence', () => {
  it('reports a business outcome instead of continuing to drive', async () => {
    // The single most important ordering rule in the engine: a run that
    // notices "no such member" and keeps clicking is the bug this prevents.
    const { driver, clicks } = scriptedSurface(['SEARCH SCREEN', 'NO MEMBER RECORD FOUND']);
    const art = artifact({
      steps: [
        { id: 'search', intent: 's', action: { kind: 'click', target: target('Search') } },
        { id: 'open', intent: 'o', action: { kind: 'click', target: target('Open') } },
      ],
      outcomes: [{ code: 'MEMBER_NOT_FOUND', description: 'no such member', when: textPresent('NO MEMBER RECORD FOUND') }],
    });

    const result = await engineFor(art, driver).run();
    expect(result.status).toBe('business_outcome');
    if (result.status === 'business_outcome') expect(result.outcome).toBe('MEMBER_NOT_FOUND');
    // The second step never ran.
    expect(clicks).toHaveLength(1);
  });

  it('a business outcome is not a failure, even though the checkpoint never held', async () => {
    const { driver } = scriptedSurface(['SEARCH SCREEN', 'NO MEMBER RECORD FOUND']);
    const art = artifact({
      outcomes: [{ code: 'MEMBER_NOT_FOUND', description: 'no such member', when: textPresent('NO MEMBER RECORD FOUND') }],
    });
    const result = await engineFor(art, driver).run();
    expect(result.status).not.toBe('failure');
  });

  it('a declared failure wins over the checkpoint', async () => {
    const { driver } = scriptedSurface(['SEARCH SCREEN', 'AN UNEXPECTED ERROR HAS OCCURRED']);
    const art = artifact({
      failures: [{ code: 'APP_ERROR', description: 'vendor error screen', when: textPresent('AN UNEXPECTED ERROR') }],
    });

    const result = await engineFor(art, driver).run();
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error.code).toBe('APP_ERROR');
      // Not CHECKPOINT_FAILED: naming the specific condition is the difference
      // between a debuggable report and "it didn't work".
      expect(result.error.observed).toMatch(/vendor error screen/);
    }
  });

  it('reports CHECKPOINT_FAILED when nothing else claims the state', async () => {
    const { driver } = scriptedSurface(['SEARCH SCREEN', 'SOME OTHER SCREEN']);
    const result = await engineFor(artifact(), driver).run();
    expect(result.status).toBe('failure');
    if (result.status === 'failure') expect(result.error.code).toBe('CHECKPOINT_FAILED');
  });

  it('reports an unresolvable target with the resolution report attached', async () => {
    const { driver } = scriptedSurface(['SEARCH SCREEN', 'MEMBER PROFILE'], { unresolvable: ['Search'] });
    const result = await engineFor(artifact(), driver).run();

    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error.code).toBe('TARGET_NOT_FOUND');
      expect(result.error.stepId).toBe('search');
      expect(result.error.resolution?.targetDescription).toBe('Search');
    }
  });
});

describe('ReplayEngine, a modal blocking the page', () => {
  /**
   * A surface behaving the way a real browser does with an unanswered dialog:
   * the page cannot be read at all until someone answers it.
   *
   * This is the shape of a bug that survived to a committed evidence bundle.
   * The executor checks declared outcomes immediately after each action and
   * before recovery, which is the correct order for business logic, but every
   * one of those checks reads the page. With a modal up, each read blocked,
   * once per declared outcome, and the run never reached the recovery rule
   * written to dismiss it. It hung rather than failing, which is the worst
   * available outcome for something running unattended.
   */
  function surfaceWithModal() {
    let dialog: { kind: 'confirm'; message: string } | undefined;
    let accepted = false;
    const element = { __brand: 'SurfaceElement' } as SurfaceElement;
    const base = scriptedSurface(['SEARCH', 'MEMBER PROFILE']).driver;

    const driver: SurfaceDriver = {
      ...base,
      async click() {
        // The click lands, and the page it loads raises a confirm().
        dialog = { kind: 'confirm', message: 'System notice: continue?' };
      },
      pendingDialog: () => dialog,
      async acceptDialog() {
        dialog = undefined;
        accepted = true;
      },
      async visibleText() {
        // The property under test: nothing is readable behind a modal.
        if (dialog) return '';
        return accepted ? 'MEMBER PROFILE' : 'SEARCH';
      },
      async resolve() {
        return {
          ok: true as const,
          element,
          report: { targetDescription: '', attempts: [], winningTier: 1, winningKind: 'role_name', degraded: false, elapsedMs: 0 },
        };
      },
    };
    return { driver, wasAccepted: () => accepted };
  }

  const withDialogRecovery = () =>
    artifact({
      steps: [{ id: 'search', intent: 'run the search', action: { kind: 'click', target: target('Search') } }],
      outcomes: [
        // Declared outcomes are checked before recovery, and each one reads the
        // page. Several, because one would not reproduce the pile-up.
        { code: 'MEMBER_NOT_FOUND', description: 'no such member', when: textPresent('NO MEMBER RECORD FOUND') },
        { code: 'PERMISSION_DENIED', description: 'not entitled', when: textPresent('ENTITLEMENT CHECK FAILED') },
      ],
      recovery: [
        {
          code: 'ACCEPT_SYSTEM_DIALOG',
          description: 'a native dialog is blocking the page',
          when: { kind: 'dialog_present' },
          then: [{ kind: 'accept_dialog' }],
          maxAttempts: 3,
        },
      ],
    });

  it('clears the dialog and completes, rather than reading a page it cannot see', async () => {
    const { driver, wasAccepted } = surfaceWithModal();
    const result = await engineFor(withDialogRecovery(), driver).run();

    expect(wasAccepted()).toBe(true);
    expect(result.status).toBe('success');
  });

  it('records the recovery on the step, so it is visible rather than absorbed', async () => {
    // A run that silently survives a blocking modal looks identical to one that
    // never met a modal at all, which is how a fixture that stopped firing went
    // unnoticed. The recovery has to show up in the result.
    const { driver } = surfaceWithModal();
    const result = await engineFor(withDialogRecovery(), driver).run();

    const recoveries = result.steps.flatMap((s) => s.recoveries);
    expect(recoveries.map((r) => r.code)).toContain('ACCEPT_SYSTEM_DIALOG');
    expect(recoveries.every((r) => r.succeeded)).toBe(true);
    expect(result.steps.some((s) => s.status === 'recovered')).toBe(true);
  });

  it('does not mistake an unreadable page for a business outcome', async () => {
    // "" contains no declared outcome text, so a blank read must not resolve as
    // one. Reporting MEMBER_NOT_FOUND because a modal was in the way would be a
    // wrong answer delivered confidently.
    const { driver } = surfaceWithModal();
    const result = await engineFor(withDialogRecovery(), driver).run();
    expect(result.status).not.toBe('business_outcome');
  });
});

describe('ReplayEngine, recovery', () => {
  const recoveringArtifact = (maxAttempts: number) =>
    artifact({
      steps: [
        { id: 'a', intent: 'a', action: { kind: 'click', target: target('A') } },
        { id: 'b', intent: 'b', action: { kind: 'click', target: target('B') } },
        { id: 'c', intent: 'c', action: { kind: 'click', target: target('C') } },
      ],
      recovery: [
        {
          code: 'DISMISS_NOTICE',
          description: 'an interstitial notice',
          when: textPresent('SYSTEM NOTICE'),
          then: [{ kind: 'click', target: target('Acknowledge') }],
          maxAttempts,
        },
      ],
    });

  it('budgets recovery attempts per rule per run, not per step', async () => {
    // A rule that keeps firing is a rule that is not working. Refreshing its
    // budget at every step turns a broken capability into an infinite loop.
    const { driver } = scriptedSurface([
      'SYSTEM NOTICE',
      'SYSTEM NOTICE',
      'SYSTEM NOTICE',
      'SYSTEM NOTICE',
      'SYSTEM NOTICE',
      'SYSTEM NOTICE',
    ]);

    const result = await engineFor(recoveringArtifact(2), driver).run();

    // It gave up rather than looping: the run ends, and it is not a success.
    expect(result.status).toBe('failure');
    const recoveries = result.steps.flatMap((s) => s.recoveries).filter((r) => r.code === 'DISMISS_NOTICE');
    expect(recoveries.length).toBeLessThanOrEqual(2);
  });

  it('records each recovery attempt against the step it happened during', async () => {
    const { driver } = scriptedSurface(['SYSTEM NOTICE', 'CLEARED', 'CLEARED', 'MEMBER PROFILE']);
    const result = await engineFor(recoveringArtifact(3), driver).run();
    const all = result.steps.flatMap((s) => s.recoveries);
    expect(all.some((r) => r.code === 'DISMISS_NOTICE')).toBe(true);
  });
});

describe('ReplayEngine, escalation', () => {
  const handler = (resolution: InterventionOutcome['resolution']): EscalationHandler => ({
    raise: vi.fn(async () => ({
      interventionId: 'int-test',
      resolution,
      operatorId: 'supervisor-04',
      note: 'handled',
      humanActions: [{ at: '2026-01-01T00:00:00Z', kind: 'click', detail: 'input "submit"' }],
    })),
  });

  const failingArtifact = artifact({ steps: [{ id: 'search', intent: 's', action: { kind: 'click', target: target('Search') } }] });

  it('does not re-run the step when the operator performed it themselves', async () => {
    // The reason `completed_manually` exists. Retrying an irreversible step
    // the human just performed submits the transaction twice.
    const { driver, clicks } = scriptedSurface(['SEARCH', 'MEMBER PROFILE'], { unresolvable: ['Search'] });
    const result = await engineFor(failingArtifact, driver, { escalation: handler('completed_manually') }).run();

    expect(clicks).toHaveLength(0);
    const step = result.steps.find((s) => s.stepId === 'search');
    expect(step?.note).toMatch(/performed manually by supervisor-04/);
  });

  it('retries the step when the operator says they cleared the blocker', async () => {
    const { driver } = scriptedSurface(['SEARCH', 'MEMBER PROFILE'], { unresolvable: ['Search'] });
    const raise = handler('resumed');
    await engineFor(failingArtifact, driver, { escalation: raise }).run();
    // Raised once; the retry resolves the same (still unresolvable) target, so
    // the run ends in failure rather than looping.
    expect(raise.raise).toHaveBeenCalledTimes(1);
  });

  it('folds the operator\'s actions into the step report, so a handoff is not a gap', async () => {
    const { driver } = scriptedSurface(['SEARCH', 'MEMBER PROFILE'], { unresolvable: ['Search'] });
    const result = await engineFor(failingArtifact, driver, { escalation: handler('completed_manually') }).run();

    const recorded = result.steps.flatMap((s) => s.recoveries);
    expect(recorded.some((r) => r.code === 'HUMAN_CLICK' && r.note?.includes('supervisor-04'))).toBe(true);
  });

  it('ends the run when the operator aborts', async () => {
    const { driver } = scriptedSurface(['SEARCH', 'MEMBER PROFILE'], { unresolvable: ['Search'] });
    const result = await engineFor(failingArtifact, driver, { escalation: handler('aborted') }).run();
    expect(result.status).toBe('escalated');
    if (result.status === 'escalated') expect(result.interventionId).toBe('int-test');
  });

  it('does not escalate a condition a human could not fix', async () => {
    // A checkpoint that never held is a capability problem, not something an
    // operator can resolve at their terminal. Paging them would be noise.
    const { driver } = scriptedSurface(['SEARCH', 'SOMETHING ELSE']);
    const raise = handler('resumed');
    const result = await engineFor(artifact(), driver, { escalation: raise }).run();

    expect(raise.raise).not.toHaveBeenCalled();
    expect(result.status).toBe('failure');
  });
});
