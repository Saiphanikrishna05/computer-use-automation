/**
 * Capability cost accounting.
 *
 * The system's headline claim is a ratio: the model runs once, the recording
 * runs forever. A ratio is only worth the measurement under it, so the
 * measurement gets tests, including the boring arithmetic, because a cost
 * figure that is quietly wrong is worse than no cost figure at all. Nobody
 * audits a number that looks plausible.
 *
 * The cache fields are the ones most likely to break in practice: the Messages
 * API omits them when caching is not in play and can return them as null, and
 * a meter that treats either as NaN poisons every total downstream.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CostMeter, formatUsd, formatTokens, pricing } from '../src/discovery/cost.js';

const RATES = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };

afterEach(() => {
  for (const key of ['CUA_PRICE_INPUT', 'CUA_PRICE_OUTPUT', 'CUA_PRICE_CACHE_WRITE', 'CUA_PRICE_CACHE_READ']) {
    delete process.env[key];
  }
});

describe('CostMeter', () => {
  it('accumulates usage across turns', () => {
    const meter = new CostMeter();
    meter.record({ input_tokens: 100, output_tokens: 50 });
    meter.record({ input_tokens: 200, output_tokens: 25 });

    expect(meter.snapshot.turns).toBe(2);
    expect(meter.snapshot.inputTokens).toBe(300);
    expect(meter.snapshot.outputTokens).toBe(75);
    expect(meter.totalTokens).toBe(375);
  });

  it('counts a turn even when the response carried no usage at all', () => {
    // A refused turn still happened. Dropping it would make the run look
    // cheaper and shorter than it was.
    const meter = new CostMeter();
    meter.record(undefined);
    expect(meter.snapshot.turns).toBe(1);
    expect(meter.totalTokens).toBe(0);
  });

  it('treats absent and null cache fields as zero rather than NaN', () => {
    const meter = new CostMeter();
    meter.record({ input_tokens: 10, output_tokens: 5 });
    meter.record({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null });

    expect(Number.isFinite(meter.totalTokens)).toBe(true);
    expect(meter.snapshot.cacheReadTokens).toBe(0);
    expect(meter.snapshot.cacheWriteTokens).toBe(0);
    expect(Number.isFinite(meter.costUsd(RATES))).toBe(true);
  });

  it('prices each token class at its own rate', () => {
    const meter = new CostMeter();
    meter.record({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    // One million of each, so the total is just the sum of the four rates.
    expect(meter.costUsd(RATES)).toBeCloseTo(15 + 75 + 18.75 + 1.5, 6);
  });

  it('reports cache saving as the gap between the cached and uncached rate', () => {
    const meter = new CostMeter();
    meter.record({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 2_000_000 });
    // Two million tokens served from cache at 1.50 that would have cost 15.00.
    expect(meter.cacheSavingUsd(RATES)).toBeCloseTo(2 * (15 - 1.5), 6);
  });

  it('is zero before anything runs', () => {
    const meter = new CostMeter();
    expect(meter.totalTokens).toBe(0);
    expect(meter.costUsd(RATES)).toBe(0);
    expect(meter.cacheSavingUsd(RATES)).toBe(0);
  });
});

describe('pricing', () => {
  it('is overridable, because a hardcoded price goes stale silently', () => {
    process.env.CUA_PRICE_INPUT = '3';
    process.env.CUA_PRICE_OUTPUT = '15';
    expect(pricing().input).toBe(3);
    expect(pricing().output).toBe(15);
  });

  it('falls back to list price when an override is not a number', () => {
    process.env.CUA_PRICE_INPUT = 'free, surely';
    expect(pricing().input).toBe(15);
  });
});

describe('formatting', () => {
  it('does not round a sub-cent capability down to nothing', () => {
    // A capability that cost four tenths of a cent is the interesting case;
    // "$0.00" would erase exactly the point being made.
    expect(formatUsd(0.004)).toBe('$0.0040');
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(0)).toBe('$0');
  });

  it('groups large projected amounts so they read at a glance', () => {
    // The million-invocation figure is the one a reader has to take in
    // instantly; "$552693.00" does not read as half a million dollars.
    expect(formatUsd(552693)).toBe('$552,693.00');
  });

  it('groups token counts so a six-figure number is readable', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});
