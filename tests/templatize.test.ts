import { describe, it, expect } from 'vitest';
import { __templatizeForTest as templatize } from '../src/discovery/recorder.js';

const p = (name: string, value: string) => ({ name, value, type: 'string' as const, description: '' });

/**
 * Locator parameterisation is what lets one recording serve every member. It is
 * also the place where getting it wrong is silent: a locator that looks
 * parameterised but points at the wrong row returns a real number from the
 * wrong record, which is the only kind of bug that actually hurts.
 */
describe('templatising a recorded value into a parameter reference', () => {
  it('rewrites the member number where it is a whole token', () => {
    // The case this exists for: a share id carries the member number.
    expect(templatize('102777-S0001', [p('memberNumber', '102777')])).toBe('{{memberNumber}}-S0001');
  });

  it('will not rewrite the middle of a longer identifier', () => {
    // The defect. A bare substring replace turns this into
    // "Member {{memberNumber}}34", and the capability then looks for a row
    // that does not exist for any other member.
    expect(templatize('Member 100234', [p('memberNumber', '1002')])).toBe('Member 100234');
  });

  it('handles a short distinctive value once boundaries protect it', () => {
    // The example named as the known limitation: a value like "001" was
    // excluded outright, because nothing stopped it matching mid-number.
    expect(templatize('102777-001-X', [p('branch', '001')])).toBe('102777-{{branch}}-X');
    expect(templatize('100234', [p('branch', '001')])).toBe('100234');
  });

  it('replaces every whole-token occurrence, not just the first', () => {
    expect(templatize('102777 / 102777-S0001', [p('memberNumber', '102777')]))
      .toBe('{{memberNumber}} / {{memberNumber}}-S0001');
  });

  it('replaces the longer parameter first, so a shorter one cannot corrupt it', () => {
    const out = templatize('100001', [p('short', '100'), p('long', '100001')]);
    expect(out).toBe('{{long}}');
  });

  it('leaves text alone when a parameter appears inside a word', () => {
    expect(templatize('Rossiter', [p('lastName', 'Ross')])).toBe('Rossiter');
    expect(templatize('Ross, Katherine', [p('lastName', 'Ross')])).toBe('{{lastName}}, Katherine');
  });
});
