import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/policy/redaction.js';

describe('Redactor', () => {
  const r = new Redactor();

  it('redacts the identity data a member profile screen puts on display', () => {
    const screen = 'Tax ID 412-88-1097 · DOB 03/14/1968 · d.ashcroft@example.invalid · 503-555-0142';
    const out = r.text(screen);
    expect(out).not.toContain('412-88-1097');
    expect(out).not.toContain('03/14/1968');
    expect(out).not.toContain('d.ashcroft@example.invalid');
    expect(out).not.toContain('503-555-0142');
    // Placeholders keep the *type* so a redacted log is still debuggable.
    expect(out).toContain('[redacted:ssn]');
    expect(out).toContain('[redacted:dob]');
  });

  it('keeps the last four digits of long account numbers so records stay traceable', () => {
    expect(r.text('Account 000410028815')).toBe('Account [redacted:••8815]');
  });

  it('leaves six-digit member IDs alone', () => {
    // These are capability *inputs*. Redacting them would make every log
    // unreadable and buy nothing: the pattern is deliberately 9+ digits.
    expect(r.text('member 100001 balance enquiry')).toBe('member 100001 balance enquiry');
  });

  it('does not redact currency, because the balance is the thing being returned', () => {
    expect(r.text('Current Balance $4,182.55')).toBe('Current Balance $4,182.55');
  });

  it('scrubs runtime literals no pattern would recognise', () => {
    const withSecret = new Redactor();
    withSecret.addLiteral('demo-password');
    expect(withSecret.text('login failed for demo-password')).toBe('login failed for [redacted:literal]');
  });

  it('ignores literals too short to be worth scrubbing', () => {
    const short = new Redactor();
    short.addLiteral('ab');
    expect(short.text('ab cd ab')).toBe('ab cd ab');
  });

  it('always suppresses values declared secret, whatever they look like', () => {
    expect(r.value('anything at all', 'secret')).toBe('[redacted:secret]');
  });

  it('redacts nested structures, which is what evidence logging actually passes', () => {
    const out = r.deep({ steps: [{ observed: 'SSN 412-88-1097' }] }) as { steps: Array<{ observed: string }> };
    expect(out.steps[0]!.observed).toBe('SSN [redacted:ssn]');
  });

  it('is not order-dependent across calls', () => {
    // Guards a real bug class: a shared /g regex carries lastIndex between
    // calls and silently skips matches on alternating inputs.
    const first = r.text('412-88-1097');
    const second = r.text('412-88-1097');
    expect(second).toBe(first);
  });

  it('reports whether masking is needed, which drives screenshot masking', () => {
    expect(r.wouldRedact('Tax ID 412-88-1097')).toBe(true);
    expect(r.wouldRedact('Current Balance $4,182.55')).toBe(false);
  });
});
