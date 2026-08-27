/**
 * Outcome probing.
 *
 * The claim under test is narrow and worth stating plainly: an outcome marked
 * `observed` must have been *seen*, and an outcome the application does not
 * actually produce must not survive as though it had been.
 *
 * The surface here is input-sensitive rather than a fixed script, because that
 * is the whole mechanism: a probe changes one input and the application is
 * supposed to react differently. A scripted surface that ignored its input
 * could not tell a working probe from a broken one.
 *
 * The wording fixtures are the real ones. `MEMBER_NOT_FOUND` declared as "No
 * member found" against an application that says "No member record found" is
 * the exact miss from the first real discovery run, and it is the case that
 * motivated this module: `validate.ts` cannot catch it, because the wrong
 * wording is absent from the success and entry screens too.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { probeOutcomes } from '../src/discovery/probe.js';
import { PolicyEngine, PROBE_POLICY } from '../src/policy/engine.js';
import { RunLogger } from '../src/evidence/logger.js';
import { CapabilityArtifactSchema, type CapabilityArtifact, type Condition } from '../src/artifact/schema.js';
import type { SurfaceDriver, SurfaceElement } from '../src/surface/types.js';

const BASE = 'http://app.test';

const SEARCH_SCREEN = 'MEMBER SEARCH Member Number Submit Inquiry';

/** What the stand-in console actually renders, per member id. */
const SCREENS: Record<string, string> = {
  '100001': 'MEMBER PROFILE Dolores Ashcroft Accounts Savings Current Balance BALANCE=$4,182.55',
  '999999': 'Inquiry Result No member record found for ID 999999. Verify the member number and re-submit.',
  '100002': 'Authorisation Required Entitlement check failed for member 100002. Contact a branch supervisor.',
};

/**
 * A surface that answers according to what was typed into it, then clicked.
 * Every probe run starts with a navigate, which resets it, so runs are
 * independent in the same way real ones are.
 */
function consoleSurface() {
  const typed: string[] = [];
  let submitted = false;
  let lastValue = '';
  const element = { __brand: 'SurfaceElement' } as SurfaceElement;

  const screen = () => (submitted ? (SCREENS[lastValue] ?? `No member record found for ID ${lastValue}.`) : SEARCH_SCREEN);

  const driver: SurfaceDriver = {
    kind: 'web',
    async navigate() {
      submitted = false;
      lastValue = '';
    },
    async currentUrl() {
      return `${BASE}/console/content`;
    },
    async title() {
      return 'Meridian';
    },
    async visibleText() {
      return screen();
    },
    async waitForSettled() {},
    pendingDialog: () => undefined,
    async snapshot() {
      return { url: '', title: '', viewport: { width: 0, height: 0 }, nodes: [], capturedAt: '' };
    },
    async resolve(t) {
      return {
        ok: true as const,
        element,
        report: {
          targetDescription: t.description,
          attempts: [],
          winningTier: 1,
          winningKind: 'role_name',
          degraded: false,
          elapsedMs: 0,
        },
      };
    },
    async click() {
      submitted = true;
    },
    async type(_el, text) {
      typed.push(text);
      lastValue = text;
    },
    async selectOption() {},
    async press() {},
    async read() {
      return screen().match(/BALANCE=([^\s]+)/)?.[1] ?? '';
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

  return { driver, typed };
}

const textPresent = (text: string): Condition => ({ kind: 'text_present', text, framePath: [], caseSensitive: false });

const target = (description: string) => ({
  description,
  framePath: [],
  candidates: [{ kind: 'role_name' as const, role: 'textbox', name: description, exact: true }],
  evidence: {},
});

interface OutcomeSpec {
  code: string;
  text: string;
  probe?: { parameter: string; value: string };
}

function artifact(outcomes: OutcomeSpec[], overrides: Record<string, unknown> = {}): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup_member_savings_balance',
    version: 1,
    title: 'Look up a savings balance',
    description: 'd',
    // Draft on purpose: probing a draft is the point, and the probe policy is
    // the only place the approval gate is allowed to be open.
    approval: { state: 'draft' },
    target: { surface: 'web', app: { vendor: 'meridian', product: 'servicing-console' }, entryUrlTemplate: '{{baseUrl}}/' },
    inputs: [
      { name: 'memberId', type: 'string', description: 'member number', example: '100001' },
      { name: 'operatorPassword', type: 'string', description: 'operator password', sensitivity: 'secret', injected: true },
    ],
    outputs: [],
    steps: [
      {
        id: 'type_1',
        intent: 'Type the member number into the search panel',
        risk: 'mutate_reversible',
        action: { kind: 'type', target: target('Member Number'), valueTemplate: '{{memberId}}' },
      },
      {
        id: 'click_2',
        intent: 'Submit the inquiry',
        risk: 'mutate_reversible',
        action: { kind: 'click', target: target('Submit Inquiry') },
      },
    ],
    checkpoint: { description: 'member profile shown', condition: textPresent('MEMBER PROFILE') },
    outcomes: outcomes.map((o) => ({
      code: o.code,
      description: o.code,
      when: textPresent(o.text),
      ...(o.probe ? { probe: { parameter: o.probe.parameter, value: o.probe.value, rationale: '' } } : {}),
    })),
    provenance: { discoveredAt: '', runId: 'r', goal: 'g', model: 'm' },
    ...overrides,
  });
}

const logger = () => new RunLogger({ runId: 'probe-test', rootDir: mkdtempSync(`${tmpdir()}/cua-`), echo: false });

function run(art: CapabilityArtifact, driver: SurfaceDriver, maxProbes?: number) {
  return probeOutcomes({
    artifact: art,
    newDriver: async () => driver,
    baselineInputs: { memberId: '100001', operatorPassword: 'hunter2' },
    bindings: { baseUrl: BASE },
    policy: new PolicyEngine({ ...PROBE_POLICY, allowedOrigins: [BASE] }),
    logger: logger(),
    ...(maxProbes === undefined ? {} : { maxProbes }),
  });
}

const stateOf = (art: CapabilityArtifact, code: string) =>
  art.outcomes.find((o) => o.code === code)?.evidence.state;

describe('probeOutcomes, turning a hypothesis into an observation', () => {
  it('marks an outcome observed when provoking it actually produces it', async () => {
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
      ]),
      driver,
    );

    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('observed');
    expect(result.reports[0]!.state).toBe('observed');
    // The evidence has to be traceable to a run, not just asserted.
    expect(result.artifact.outcomes[0]!.evidence.probedAt).toMatch(/^\d{4}-/);
    expect(result.warnings).toHaveLength(0);
  });

  it('actually drives the flow with the probe value, not the recorded one', async () => {
    const { driver, typed } = consoleSurface();
    await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
      ]),
      driver,
    );
    // If this were still typing 100001 the outcome would never fire and the
    // "observed" verdict above would be meaningless.
    expect(typed).toContain('999999');
    expect(typed).not.toContain('100001');
  });

  it('probes a draft, which is the only state a freshly discovered artifact is in', async () => {
    const { driver } = consoleSurface();
    const art = artifact([
      { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
    ]);
    expect(art.approval.state).toBe('draft');
    const result = await run(art, driver);
    // A probe that inherited REPLAY_POLICY would fail ARTIFACT_NOT_APPROVED
    // here and report every outcome refuted for the wrong reason.
    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('observed');
  });
});

describe('probeOutcomes, catching a wrong declaration', () => {
  it('refutes wording the application does not use, and reports what it does use', async () => {
    // The real miss: the model declared "No member found"; the console says
    // "No member record found". Absent from the success screen and absent from
    // the entry screen, so entry-state validation passes it through.
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member found', probe: { parameter: 'memberId', value: '999999' } },
      ]),
      driver,
    );

    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('refuted');
    // The wording that would fix it is handed to the reviewer, not left for
    // them to go and find.
    expect(result.artifact.outcomes[0]!.evidence.note).toMatch(/No member record found/);
    expect(result.warnings.join(' ')).toMatch(/MEMBER_NOT_FOUND was probed and did not fire/);
  });

  it('refutes an outcome whose probe value does not change the outcome at all', async () => {
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        // 100001 is the happy path; probing with it proves nothing.
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '100001' } },
      ]),
      driver,
    );

    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('refuted');
    expect(result.reports[0]!.observedInstead).toBe('success');
    expect(result.reports[0]!.reason).toMatch(/still succeeded/);
  });

  it('credits the outcome that did fire, while refuting the one it was aiming at', async () => {
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        // Aimed at NOT_FOUND, but 100002 is the restricted member, so the
        // console answers with the entitlement screen instead.
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '100002' } },
        { code: 'PERMISSION_DENIED', text: 'Entitlement check failed' },
      ]),
      driver,
    );

    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('refuted');
    // Seen on a real screen this flow produced, so it counts, even though no
    // probe was aimed at it.
    expect(stateOf(result.artifact, 'PERMISSION_DENIED')).toBe('observed');
    expect(result.reports.find((r) => r.code === 'MEMBER_NOT_FOUND')!.observedInstead).toMatch(/PERMISSION_DENIED/);
  });

  it('does not spend a second run re-confirming an outcome another probe already produced', async () => {
    const { driver, typed } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '100002' } },
        { code: 'PERMISSION_DENIED', text: 'Entitlement check failed', probe: { parameter: 'memberId', value: '100002' } },
      ]),
      driver,
    );

    expect(stateOf(result.artifact, 'PERMISSION_DENIED')).toBe('observed');
    // One run, not two: the second outcome was settled by the first probe.
    expect(typed.filter((t) => t === '100002')).toHaveLength(1);
    expect(result.reports.find((r) => r.code === 'PERMISSION_DENIED')!.reason).toMatch(/another outcome's probe/i);
  });
});

describe('probeOutcomes, what it refuses to do', () => {
  it('probes a capability that commits, because the ceiling is what stops the commit', async () => {
    // This deliberately reverses an earlier rule. Refusing irreversible
    // capabilities wholesale left every outcome on a funds transfer
    // permanently unverified — and all of them are validations that fire at
    // the review step, long before anything posts. What protects the money is
    // the action ceiling in the driver, not this function declining to look.
    const { driver } = consoleSurface();
    const result = await run(
      artifact(
        [{ code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } }],
        { maxRisk: 'mutate_irreversible' },
      ),
      driver,
    );

    expect(result.skippedEntirely).toBe(false);
    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('observed');
  });

  it('refuses to vary an injected credential to provoke an outcome', async () => {
    const { driver, typed } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'SIGN_ON_FAILED', text: 'Invalid credentials', probe: { parameter: 'operatorPassword', value: 'wrong' } },
      ]),
      driver,
    );

    expect(result.reports[0]!.state).toBe('skipped');
    expect(result.reports[0]!.reason).toMatch(/injected credential/);
    expect(typed).toHaveLength(0);
    expect(stateOf(result.artifact, 'SIGN_ON_FAILED')).toBe('hypothesised');
  });

  it('reports learning nothing, so a caller does not rewrite an artifact it did not change', async () => {
    // `probe open_sub_account` correctly declined to probe anything, and then
    // wrote the artifact back anyway, reserialising a hand-authored reviewed
    // file for no reason. A read-only operation modified its input. The flag
    // exists so the command can tell the difference.
    const { driver } = consoleSurface();

    const nothingDeclared = await run(artifact([{ code: 'Y', text: 'y' }]), driver);
    expect(nothingDeclared.learnedSomething).toBe(false);

    const real = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
      ]),
      driver,
    );
    expect(real.learnedSomething).toBe(true);
  });

  it('leaves an outcome with no declared probe as an unverified hypothesis', async () => {
    const { driver, typed } = consoleSurface();
    const result = await run(artifact([{ code: 'NO_SAVINGS_ACCOUNT', text: 'No accounts on file' }]), driver);

    expect(result.reports[0]!.state).toBe('skipped');
    expect(stateOf(result.artifact, 'NO_SAVINGS_ACCOUNT')).toBe('hypothesised');
    expect(typed).toHaveLength(0);
  });

  it('skips a probe naming a parameter the capability does not declare', async () => {
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'accountNumber', value: 'x' } },
      ]),
      driver,
    );

    expect(result.reports[0]!.state).toBe('skipped');
    expect(result.reports[0]!.reason).toMatch(/does not declare/);
    expect(result.warnings.join(' ')).toMatch(/accountNumber/);
  });

  it('stops at the probe budget rather than turning one discovery into many runs', async () => {
    const { driver, typed } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
        { code: 'PERMISSION_DENIED', text: 'Entitlement check failed', probe: { parameter: 'memberId', value: '100002' } },
      ]),
      driver,
      1,
    );

    expect(typed).toHaveLength(1);
    expect(result.reports[1]!.state).toBe('skipped');
    expect(result.reports[1]!.reason).toMatch(/budget/);
    expect(stateOf(result.artifact, 'PERMISSION_DENIED')).toBe('hypothesised');
  });
});

describe('probeOutcomes, starting where a replay starts', () => {
  it('opens a fresh surface for every probe and closes it afterwards', async () => {
    // The bug this pins is not hypothetical. The first real run reused the
    // session discovery had explored in, so every probe began already signed
    // on, the recorded sign-on steps resolved against nothing, and three
    // outcomes were reported refuted with confident, wrong explanations.
    const opened: Array<{ closed: boolean }> = [];
    const art = artifact([
      { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
      { code: 'PERMISSION_DENIED', text: 'Entitlement check failed', probe: { parameter: 'memberId', value: '100002' } },
    ]);

    const result = await probeOutcomes({
      artifact: art,
      newDriver: async () => {
        const { driver } = consoleSurface();
        const handle = { closed: false };
        opened.push(handle);
        return { ...driver, close: async () => void (handle.closed = true) };
      },
      baselineInputs: { memberId: '100001', operatorPassword: 'hunter2' },
      bindings: { baseUrl: BASE },
      policy: new PolicyEngine({ ...PROBE_POLICY, allowedOrigins: [BASE] }),
      logger: logger(),
    });

    expect(opened).toHaveLength(2);
    expect(opened.every((d) => d.closed)).toBe(true);
    expect(stateOf(result.artifact, 'MEMBER_NOT_FOUND')).toBe('observed');
    expect(stateOf(result.artifact, 'PERMISSION_DENIED')).toBe('observed');
  });

  it('reports an outcome unreachable through the capability\'s own input contract as exactly that', async () => {
    // memberId is constrained to six digits, so "ABC" never reaches the
    // application: the engine rejects it first. Calling that a wording problem
    // would send a reviewer to correct the one thing that is not wrong.
    const { driver, typed } = consoleSurface();
    const art = artifact(
      [{ code: 'INVALID_MEMBER_ID', text: 'Invalid member ID', probe: { parameter: 'memberId', value: 'ABC' } }],
      {
        inputs: [
          { name: 'memberId', type: 'string', description: 'member number', example: '100001', pattern: '^\\d{6}$' },
          { name: 'operatorPassword', type: 'string', description: 'pw', sensitivity: 'secret', injected: true },
        ],
      },
    );

    const result = await run(art, driver);

    expect(stateOf(result.artifact, 'INVALID_MEMBER_ID')).toBe('refuted');
    expect(result.reports[0]!.reason).toMatch(/unreachable through this capability/);
    expect(result.reports[0]!.reason).not.toMatch(/wording/);
    // The application was never touched, which is the point being reported.
    expect(typed).toHaveLength(0);
  });
});

describe('the outcome evidence field', () => {
  it('defaults to hypothesised, so artifacts recorded before probing read honestly', () => {
    // Backward compatibility is the point: an older artifact has no evidence
    // field, and must not parse as though its outcomes had been verified.
    const parsed = artifact([{ code: 'MEMBER_NOT_FOUND', text: 'No member record found' }]);
    expect(parsed.outcomes[0]!.evidence.state).toBe('hypothesised');
    expect(parsed.outcomes[0]!.probe).toBeUndefined();
  });

  it('survives a round trip through the schema once probed', async () => {
    const { driver } = consoleSurface();
    const result = await run(
      artifact([
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found', probe: { parameter: 'memberId', value: '999999' } },
      ]),
      driver,
    );
    const reparsed = CapabilityArtifactSchema.parse(JSON.parse(JSON.stringify(result.artifact)));
    expect(reparsed.outcomes[0]!.evidence.state).toBe('observed');
    expect(reparsed.outcomes[0]!.probe?.value).toBe('999999');
  });
});
