/**
 * Post-discovery validation.
 *
 * This is the mechanism that catches the model declaring outcomes it never
 * observed, so it has to be verifiable without needing a lucky model run. The
 * driver is stubbed to a two-state surface, the screen the flow ended on, and
 * the screen it started from, because those are the only two states the
 * validator inspects.
 *
 * The three fixtures below are the actual conditions the first real discovery
 * run produced (`evidence/discovery-first-run-unvalidated/`), not invented
 * ones.
 */

import { describe, expect, it } from 'vitest';
import { validateAgainstEntryState } from '../src/discovery/validate.js';
import { CapabilityArtifactSchema, type CapabilityArtifact, type Condition } from '../src/artifact/schema.js';
import type { SurfaceDriver } from '../src/surface/types.js';
import { RunLogger } from '../src/evidence/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** A surface that shows one thing at the end of a flow and another at entry. */
function fakeSurface(successText: string, entryText: string): SurfaceDriver {
  let state: 'success' | 'entry' = 'success';
  const unused = () => {
    throw new Error('not used by the validator');
  };
  return {
    kind: 'web',
    async navigate() {
      state = 'entry';
    },
    async currentUrl() {
      return state === 'entry' ? 'http://app.test/' : 'http://app.test/detail';
    },
    async title() {
      return '';
    },
    async visibleText() {
      return state === 'success' ? successText : entryText;
    },
    async waitForSettled() {},
    pendingDialog: () => undefined,
    async snapshot() {
      return { url: '', title: '', viewport: { width: 0, height: 0 }, nodes: [], capturedAt: '' };
    },
    async resolve() {
      return {
        ok: false as const,
        reason: 'not_found' as const,
        report: { targetDescription: '', attempts: [], winningTier: null, winningKind: null, degraded: false, elapsedMs: 0 },
      };
    },
    screenshot: unused as never,
    sourceSnapshot: unused as never,
    click: unused as never,
    type: unused as never,
    selectOption: unused as never,
    press: unused as never,
    read: unused as never,
    isVisible: unused as never,
    acceptDialog: unused as never,
    dismissDialog: unused as never,
    captureHumanActions: unused as never,
    humanClickAt: unused as never,
    humanType: unused as never,
    humanPress: unused as never,
    close: async () => {},
  };
}

const textPresent = (text: string): Condition => ({ kind: 'text_present', text, framePath: [], caseSensitive: false });

function artifactWith(outcomes: Array<{ code: string; text: string }>): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    id: 'lookup_member_savings_balance',
    version: 1,
    title: 't',
    description: 'd',
    target: {
      surface: 'web',
      app: { vendor: 'meridian', product: 'servicing-console' },
      entryUrlTemplate: '{{baseUrl}}/',
    },
    steps: [{ id: 's1', intent: 'i', action: { kind: 'assert', condition: textPresent('Member Profile') } }],
    checkpoint: { description: 'profile shown', condition: textPresent('Member Profile') },
    outcomes: outcomes.map((o) => ({ code: o.code, description: o.code, when: textPresent(o.text) })),
    provenance: { discoveredAt: '', runId: 'r', goal: 'g', model: 'm' },
  });
}

const logger = () => new RunLogger({ runId: 'validate-test', rootDir: mkdtempSync(`${tmpdir()}/cua-`), echo: false });

// The success screen and the entry (sign-on) screen of the stand-in console.
const SUCCESS = 'Member Profile Accounts Savings Checking Current Balance $4,182.55';
const ENTRY = 'Operator Sign-On User ID Password Sign On';

describe('validateAgainstEntryState', () => {
  it('removes an outcome whose condition already holds on the entry screen', async () => {
    // The real failure: the model keyed SIGN_ON_FAILED on "Operator Sign-On",
    // the title of the sign-on panel itself. Every replay would terminate on
    // turn zero reporting a sign-on failure.
    const result = await validateAgainstEntryState(
      artifactWith([{ code: 'SIGN_ON_FAILED', text: 'Operator Sign-On' }]),
      fakeSurface(SUCCESS, ENTRY),
      { baseUrl: 'http://app.test' },
      logger(),
    );

    expect(result.artifact.outcomes).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.code).toBe('SIGN_ON_FAILED');
    expect(result.rejected[0]!.reason).toMatch(/ENTRY screen/);
  });

  it('removes an outcome whose condition holds on the success screen', async () => {
    // NO_SAVINGS_ACCOUNT keyed on "Savings", which appears in the accounts
    // table of every member who has one, so it would fire on every success.
    const result = await validateAgainstEntryState(
      artifactWith([{ code: 'NO_SAVINGS_ACCOUNT', text: 'Savings' }]),
      fakeSurface(SUCCESS, ENTRY),
      { baseUrl: 'http://app.test' },
      logger(),
    );

    expect(result.artifact.outcomes).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/SUCCESS screen/);
  });

  it('keeps an outcome that holds in neither state, and flags it as unverified', async () => {
    // "No member record found" is genuinely absent from both screens. We have
    // no evidence it is right, only that it is not provably wrong, so it
    // survives with a warning rather than silently becoming fact.
    const result = await validateAgainstEntryState(
      artifactWith([{ code: 'MEMBER_NOT_FOUND', text: 'No member record found' }]),
      fakeSurface(SUCCESS, ENTRY),
      { baseUrl: 'http://app.test' },
      logger(),
    );

    expect(result.artifact.outcomes.map((o) => o.code)).toEqual(['MEMBER_NOT_FOUND']);
    expect(result.rejected).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/hypothesised|have not been observed/);
  });

  it('separates the three real first-run outcomes correctly in one pass', async () => {
    const result = await validateAgainstEntryState(
      artifactWith([
        { code: 'SIGN_ON_FAILED', text: 'Operator Sign-On' },
        { code: 'NO_SAVINGS_ACCOUNT', text: 'Savings' },
        { code: 'MEMBER_NOT_FOUND', text: 'No member record found' },
      ]),
      fakeSurface(SUCCESS, ENTRY),
      { baseUrl: 'http://app.test' },
      logger(),
    );

    expect(result.rejected.map((r) => r.code).sort()).toEqual(['NO_SAVINGS_ACCOUNT', 'SIGN_ON_FAILED']);
    expect(result.artifact.outcomes.map((o) => o.code)).toEqual(['MEMBER_NOT_FOUND']);
  });

  it('warns when the checkpoint does not hold on the screen the run ended on', async () => {
    const artifact = artifactWith([]);
    const broken = { ...artifact, checkpoint: { description: 'x', condition: textPresent('Nowhere To Be Seen') } };
    const result = await validateAgainstEntryState(broken, fakeSurface(SUCCESS, ENTRY), { baseUrl: 'http://app.test' }, logger());
    expect(result.warnings.join(' ')).toMatch(/does not hold on the screen the run ended on/);
  });

  it('warns when the checkpoint already holds at entry, so it proves nothing', async () => {
    const artifact = artifactWith([]);
    const weak = { ...artifact, checkpoint: { description: 'x', condition: textPresent('Sign On') } };
    const result = await validateAgainstEntryState(weak, fakeSurface(SUCCESS, ENTRY), { baseUrl: 'http://app.test' }, logger());
    expect(result.warnings.join(' ')).toMatch(/already holds on the entry screen/);
  });

  it('records the outcome of the pass in the artifact provenance', async () => {
    const result = await validateAgainstEntryState(
      artifactWith([{ code: 'SIGN_ON_FAILED', text: 'Operator Sign-On' }]),
      fakeSurface(SUCCESS, ENTRY),
      { baseUrl: 'http://app.test' },
      logger(),
    );
    // A reviewer opening the artifact should see what was checked and removed,
    // without having to go and read the run log.
    expect(result.artifact.provenance.validation?.rejected).toHaveLength(1);
    expect(result.artifact.provenance.validation?.checkedAt).toMatch(/^\d{4}-/);
  });
});
