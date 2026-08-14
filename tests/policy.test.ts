import { describe, expect, it } from 'vitest';
import { PolicyEngine, DISCOVERY_POLICY, REPLAY_POLICY } from '../src/policy/engine.js';

const allowed = 'http://localhost:4173';

describe('PolicyEngine — navigation allowlist', () => {
  const policy = new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [allowed] });

  it('permits the allowlisted origin', () => {
    expect(policy.checkNavigation(`${allowed}/console`).allowed).toBe(true);
  });

  it('refuses any other origin', () => {
    const decision = policy.checkNavigation('https://evil.example/steal');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses a different port on the same host', () => {
    // Tenant isolation depends on this: two institutions are two origins.
    expect(policy.checkNavigation('http://localhost:4174/console').allowed).toBe(false);
  });

  it('refuses a malformed URL rather than coercing it', () => {
    const decision = policy.checkNavigation('/console');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('MALFORMED_URL');
  });

  it('enforces route patterns when configured', () => {
    const scoped = new PolicyEngine({
      ...REPLAY_POLICY,
      allowedOrigins: [allowed],
      allowedPathPatterns: ['^/console'],
    });
    expect(scoped.checkNavigation(`${allowed}/console/content`).allowed).toBe(true);
    const denied = scoped.checkNavigation(`${allowed}/_admin/faults`);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.code).toBe('PATH_NOT_ALLOWED');
  });
});

describe('PolicyEngine — action risk', () => {
  it('will not let discovery commit an irreversible action at all', () => {
    // There is nothing to escalate to during exploration, so this is a flat
    // refusal rather than a request for authorisation.
    const policy = new PolicyEngine({ ...DISCOVERY_POLICY, allowedOrigins: [allowed] });
    const decision = policy.checkAction('click', 'mutate_irreversible');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('ACTION_CLASS_EXCEEDS_CEILING');
      expect(decision.escalatable).toBe(false);
    }
  });

  it('routes an irreversible replay action to a human instead of blocking it outright', () => {
    const policy = new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [allowed] });
    const decision = policy.checkAction('click', 'mutate_irreversible');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('IRREVERSIBLE_REQUIRES_HUMAN');
      // Escalatable is the whole distinction: a person can authorise this one.
      expect(decision.escalatable).toBe(true);
    }
  });

  it('permits an irreversible action once explicitly authorised', () => {
    const policy = new PolicyEngine({
      ...REPLAY_POLICY,
      allowedOrigins: [allowed],
      allowUnattendedIrreversible: true,
    });
    expect(policy.checkAction('click', 'mutate_irreversible').allowed).toBe(true);
  });

  it('allows reads and reversible mutations on both paths', () => {
    for (const base of [DISCOVERY_POLICY, REPLAY_POLICY]) {
      const policy = new PolicyEngine({ ...base, allowedOrigins: [allowed] });
      expect(policy.checkAction('read', 'read').allowed).toBe(true);
      expect(policy.checkAction('type', 'mutate_reversible').allowed).toBe(true);
    }
  });

  it('refuses action kinds outside the permitted set', () => {
    const policy = new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [allowed], allowedActions: ['read'] });
    const decision = policy.checkAction('click', 'read');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('ACTION_KIND_NOT_ALLOWED');
  });
});

describe('PolicyEngine — approval gate', () => {
  it('refuses unattended replay of a draft capability', () => {
    const policy = new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [allowed] });
    const decision = policy.checkArtifactApproval('draft');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('ARTIFACT_NOT_APPROVED');
    expect(policy.checkArtifactApproval('approved').allowed).toBe(true);
  });

  it('does not gate on approval during discovery, where nothing is saved yet', () => {
    const policy = new PolicyEngine({ ...DISCOVERY_POLICY, allowedOrigins: [allowed] });
    expect(policy.checkArtifactApproval('draft').allowed).toBe(true);
  });
});
