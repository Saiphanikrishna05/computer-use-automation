import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CapabilityArtifactSchema, TenantOverlaySchema } from '../src/artifact/schema.js';
import { applyOverlay } from '../src/artifact/store.js';
import { toolDefinitionFor } from '../src/catalog/tools.js';

const artifact = CapabilityArtifactSchema.parse(
  JSON.parse(readFileSync('artifacts/lookup_member_savings_balance.v1.json', 'utf8')),
);
// The capability-scoped overlay, which is where step overrides live: they are
// keyed by step id, and step ids belong to a recording.
const overlay = TenantOverlaySchema.parse(
  JSON.parse(readFileSync('artifacts/tenants/cascade-cu.lookup_member_savings_balance.json', 'utf8')),
);

describe('artifact schema', () => {
  it('parses the committed capability', () => {
    expect(artifact.id).toBe('lookup_member_savings_balance');
    expect(artifact.steps.length).toBeGreaterThan(0);
  });

  it('round-trips through JSON without loss', () => {
    expect(CapabilityArtifactSchema.parse(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it('rejects a capability with no steps', () => {
    expect(() => CapabilityArtifactSchema.parse({ ...artifact, steps: [] })).toThrow();
  });

  it('rejects a target with no locator candidates', () => {
    // A descriptor that can find nothing is not a weaker descriptor, it is a
    // broken one, and it should never reach disk.
    const broken = JSON.parse(JSON.stringify(artifact));
    broken.steps[0].action.target.candidates = [];
    expect(() => CapabilityArtifactSchema.parse(broken)).toThrow();
  });

  it('rejects an id that is not a valid tool name', () => {
    expect(() => CapabilityArtifactSchema.parse({ ...artifact, id: 'Not A Tool Name' })).toThrow();
  });
});

describe('tenant overlay', () => {
  it('refuses to run when an override matches no step, instead of silently doing nothing', () => {
    // The bug this pins. Overrides are keyed by step id, and step ids belong to
    // a recording, so re-recording a capability orphans every override written
    // against the old ids. It happened: this tenant's reworded button and
    // relabelled field went un-applied, two locators quietly resolved three
    // tiers lower, and the run still passed because both tenants happen to
    // share a form field name.
    //
    // A capability running without its tenant's corrections is the exact
    // failure this system exists to prevent, so it has to be loud.
    const stale = {
      ...overlay,
      stepOverrides: { ...overlay.stepOverrides, a_step_that_was_renamed: { skip: true } },
    };

    expect(() => applyOverlay(artifact, stale)).toThrowError(/a_step_that_was_renamed/);
    // And it must say what the capability's steps actually are, so the fix is
    // obvious from the message alone.
    expect(() => applyOverlay(artifact, stale)).toThrowError(new RegExp(artifact.steps[0]!.id));
  });

  it('rewrites frame names everywhere they appear, not just in steps', () => {
    const { artifact: specialized, appliedChanges } = applyOverlay(artifact, overlay);

    const framesIn = (value: unknown): string[] => {
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
            if (key === 'framePath' && Array.isArray(child)) {
              for (const step of child as Array<{ name?: string }>) if (step.name) found.push(step.name);
            } else walk(child);
          }
        }
      };
      walk(value);
      return found;
    };

    const names = new Set(framesIn(specialized));
    // Frame paths live in steps, checkpoint conditions, outcome conditions,
    // output extraction targets and recovery targets. Missing any one of them
    // would produce a capability that half-works on the second tenant.
    expect(names.has('contentFrame')).toBe(false);
    expect(names.has('mainFrame')).toBe(true);
    expect(appliedChanges.some((c) => c.includes('contentFrame'))).toBe(true);
  });

  it('applies per-step target overrides for wording the base cannot absorb', () => {
    const { artifact: specialized } = applyOverlay(artifact, overlay);
    const submit = specialized.steps.find((s) => s.id === 'click_5')!;
    const action = submit.action as { target: { candidates: Array<{ name?: string }> } };
    expect(action.target.candidates.some((c) => c.name === 'Find Member')).toBe(true);
  });

  it('appends the tenant\'s own recovery rules without dropping the base ones', () => {
    const { artifact: specialized } = applyOverlay(artifact, overlay);
    const codes = specialized.recovery.map((r) => r.code);
    expect(codes).toContain('ACCEPT_SYSTEM_DIALOG');
    expect(codes).toContain('ACKNOWLEDGE_SYSTEM_NOTICE');
  });

  it('supplies the tenant base URL as a binding rather than editing the artifact', () => {
    const { bindings, artifact: specialized } = applyOverlay(artifact, overlay);
    expect(bindings.baseUrl).toBe('http://localhost:4174');
    // The artifact itself stays tenant-neutral and reusable.
    expect(specialized.target.entryUrlTemplate).toContain('{{baseUrl}}');
  });

  it('refuses an overlay written for a different vendor product', () => {
    const wrong = { ...overlay, appliesTo: { ...overlay.appliesTo, product: 'some-other-console' } };
    expect(() => applyOverlay(artifact, wrong)).toThrow(/recorded against/);
  });

  it('is a no-op when no overlay applies', () => {
    const { artifact: same, appliedChanges } = applyOverlay(artifact, undefined);
    expect(same).toBe(artifact);
    expect(appliedChanges).toHaveLength(0);
  });
});

describe('agent-facing tool definition', () => {
  const tool = toolDefinitionFor(artifact);

  it('publishes the capability under its invocable name', () => {
    expect(tool.name).toBe('lookup_member_savings_balance');
  });

  it('never exposes injected credentials to the calling agent', () => {
    // The agent should not be able to supply, see, or leak operator
    // credentials, so they are not in the schema at all.
    expect(Object.keys(tool.input_schema.properties)).toEqual(['memberId']);
    expect(tool.input_schema.required).toEqual(['memberId']);
    expect(JSON.stringify(tool)).not.toContain('operatorPassword');
  });

  it('carries the input validation pattern through to the agent', () => {
    expect(tool.input_schema.properties.memberId?.pattern).toBe('^\\d{6}$');
  });

  it('tells the agent which outcomes are answers rather than errors', () => {
    // Without this an agent retries a lookup for a member that does not exist.
    expect(tool.description).toContain('MEMBER_NOT_FOUND');
    expect(tool.description).toContain('legitimate answers rather than errors');
  });

  it('refuses unexpected arguments', () => {
    expect(tool.input_schema.additionalProperties).toBe(false);
  });
});
