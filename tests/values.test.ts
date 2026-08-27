import { describe, expect, it } from 'vitest';
import { bindInputs, coerceOutput, interpolate, InputValidationError, interpolateTarget } from '../src/replay/values.js';
import type { OutputSpec, ParamSpec } from '../src/artifact/schema.js';

const memberId: ParamSpec = {
  name: 'memberId',
  type: 'string',
  description: 'six-digit member number',
  required: true,
  sensitivity: 'none',
  injected: false,
  pattern: '^\\d{6}$',
};

const optionalNote: ParamSpec = {
  name: 'note',
  type: 'string',
  description: 'optional note',
  required: false,
  sensitivity: 'none',
  injected: false,
};

describe('interpolate', () => {
  it('substitutes declared parameters', () => {
    expect(interpolate('{{baseUrl}}/member/{{memberId}}', { baseUrl: 'http://x', memberId: '100001' })).toBe(
      'http://x/member/100001',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(interpolate('{{ memberId }}', { memberId: '100001' })).toBe('100001');
  });

  it('throws on an unknown reference rather than silently emitting an empty string', () => {
    // A typo'd template that quietly renders "" produces a run that looks
    // successful and searched for nothing.
    expect(() => interpolate('{{typo}}', { memberId: '1' })).toThrow(InputValidationError);
  });

  it('leaves text with no templates untouched', () => {
    expect(interpolate('Member Profile', {})).toBe('Member Profile');
  });
});

describe('bindInputs', () => {
  it('accepts a valid value', () => {
    expect(bindInputs([memberId], { memberId: '100001' })).toEqual({ memberId: '100001' });
  });

  it('rejects a value that fails the declared pattern', () => {
    expect(() => bindInputs([memberId], { memberId: '12345' })).toThrow(/does not match required pattern/);
  });

  it('rejects a missing required parameter', () => {
    expect(() => bindInputs([memberId], {})).toThrow(/Missing required parameter/);
  });

  it('rejects unknown parameters instead of ignoring them', () => {
    // A silently-dropped typo is worse than an error: the run succeeds and
    // does the wrong thing.
    expect(() => bindInputs([memberId], { memberId: '100001', memberID: '999999' })).toThrow(/Unknown parameter/);
  });

  it('omits absent optional parameters', () => {
    expect(bindInputs([memberId, optionalNote], { memberId: '100001' })).toEqual({ memberId: '100001' });
  });

  it('coerces numeric types, stripping currency formatting', () => {
    const amount: ParamSpec = {
      name: 'amount',
      type: 'money',
      description: 'deposit',
      required: true,
      sensitivity: 'none',
      injected: false,
    };
    expect(bindInputs([amount], { amount: '$1,250.00' })).toEqual({ amount: 1250 });
  });

  it('rejects a non-numeric value for a numeric parameter', () => {
    const amount: ParamSpec = {
      name: 'amount',
      type: 'number',
      description: 'deposit',
      required: true,
      sensitivity: 'none',
      injected: false,
    };
    expect(() => bindInputs([amount], { amount: 'lots' })).toThrow(/must be numeric/);
  });
});

describe('coerceOutput', () => {
  const spec = (type: OutputSpec['type'], transforms: OutputSpec['extract']['transforms']): OutputSpec => ({
    name: 'v',
    type,
    description: '',
    required: true,
    sensitivity: 'none',
    extract: {
      source: 'text',
      transforms,
      target: { description: '', framePath: [], candidates: [{ kind: 'text', text: 'x', exact: false }], evidence: {} },
    },
  });

  it('turns a formatted currency string into a number', () => {
    expect(coerceOutput('$4,182.55', spec('money', ['collapse_whitespace', 'money']))).toBe(4182.55);
  });

  it('collapses whitespace in extracted text', () => {
    expect(coerceOutput('  Dolores   Ashcroft \n', spec('string', ['collapse_whitespace']))).toBe('Dolores Ashcroft');
  });

  it('returns null rather than NaN when a numeric field cannot be parsed', () => {
    // NaN propagates silently through JSON; null is an answer a caller can check.
    expect(coerceOutput('(none)', spec('money', ['money']))).toBeNull();
  });

  it('keeps leading zeros on account numbers by treating them as strings', () => {
    expect(coerceOutput('000410028815', spec('string', ['collapse_whitespace']))).toBe('000410028815');
  });
});

/**
 * Parameterised locators.
 *
 * A descriptor is mostly chrome and must be left alone. But MERIDIAN CORE
 * heads each share row with an id like "102777-S0001" — the member number is
 * inside the landmark. Recorded literally, that reads the right cell for one
 * member and a plausible wrong one for every other, which is the failure mode
 * worth naming: not a crash, a confident wrong number.
 */
describe('interpolateTarget', () => {
  const target = {
    description: 'cell in the Share ID panel',
    framePath: [],
    candidates: [
      { kind: 'label', text: '{{memberNumber}}-S0001', expect: 'cell', column: 'Balance' },
      { kind: 'coordinates', xFraction: 0.6, yFraction: 0.23 },
    ],
    evidence: {},
  };

  it('fills a reference nested inside a candidate', () => {
    const out = interpolateTarget(target, { memberNumber: '100234' });
    expect((out.candidates[0] as { text: string }).text).toBe('100234-S0001');
  });

  it('leaves chrome, numbers and structure untouched', () => {
    const out = interpolateTarget(target, { memberNumber: '100234' });
    expect((out.candidates[0] as { column: string }).column).toBe('Balance');
    expect((out.candidates[1] as { xFraction: number }).xFraction).toBe(0.6);
    expect(out.description).toBe('cell in the Share ID panel');
  });

  it('does not mutate the artifact it was given', () => {
    // The descriptor on disk stays a document describing *which* control; the
    // values are supplied per run. Mutating here would bake one run's member
    // number into every subsequent one in the same process.
    interpolateTarget(target, { memberNumber: '100234' });
    expect((target.candidates[0] as { text: string }).text).toBe('{{memberNumber}}-S0001');
  });

  it('passes through a target with no references at all', () => {
    const plain = { description: 'Search', candidates: [{ kind: 'role_name', role: 'button', name: 'Search' }] };
    expect(interpolateTarget(plain, {})).toEqual(plain);
  });
});
