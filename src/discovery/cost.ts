/**
 * What a capability cost to record.
 *
 * This exists because the central claim of the system is an economic one, not
 * only an architectural one: **the model is used once, and the result is used
 * forever.** That claim is worth exactly as much as the measurement behind it,
 * and until now the loop received a token count from every API response and
 * threw it away.
 *
 * So discovery now accounts for itself. Every turn's usage is accumulated, the
 * total is written into the artifact's provenance, and a reviewer deciding
 * whether a capability is worth keeping can see what producing it consumed.
 * Across a fleet of institutions that is an operational number, not a curiosity:
 * it is the difference between "recording capabilities is cheap" as an opinion
 * and as a line item.
 *
 * The ratio is the part that needs no pricing at all. Discovery spends tokens
 * once; replay spends **none**, because there is no model in that path. Every
 * invocation after the first is free in the only sense that matters here, and
 * that is a property of the architecture rather than of anyone's price list.
 *
 * Prices below are list prices per million tokens, and are overridable, because
 * they are the one number in this file that will be wrong eventually. Token
 * counts are measured; dollars are that measurement times a rate the operator
 * sets. Both are reported, so a reader who disagrees with the rate can still
 * use the arithmetic.
 */

/** Usage as the Messages API reports it, with the cache fields it may omit. */
export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface TokenTotals {
  turns: number;
  /** Uncached input tokens, billed at the standard input rate. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache, billed at a premium once. */
  cacheWriteTokens: number;
  /** Tokens served from the prompt cache, billed at a large discount. */
  cacheReadTokens: number;
}

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * List price per million tokens. Overridable per field, because a price is the
 * kind of fact that goes stale silently and should never be the reason a
 * reported number is wrong without anyone noticing.
 */
export function pricing(): Pricing {
  const num = (name: string, fallback: number) => {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    input: num('CUA_PRICE_INPUT', 15),
    output: num('CUA_PRICE_OUTPUT', 75),
    // Cache writes are charged at a premium over standard input, cache reads at
    // a fraction of it. The 1.25x / 0.1x shape is what makes caching the
    // system prompt worth doing on a multi-turn loop.
    cacheWrite: num('CUA_PRICE_CACHE_WRITE', 18.75),
    cacheRead: num('CUA_PRICE_CACHE_READ', 1.5),
  };
}

export class CostMeter {
  private totals: TokenTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };

  record(usage: TurnUsage | undefined): void {
    this.totals.turns += 1;
    if (!usage) return;
    this.totals.inputTokens += usage.input_tokens ?? 0;
    this.totals.outputTokens += usage.output_tokens ?? 0;
    this.totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  get snapshot(): TokenTotals {
    return { ...this.totals };
  }

  /** Every token the run consumed, however it was billed. */
  get totalTokens(): number {
    const t = this.totals;
    return t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
  }

  costUsd(rates: Pricing = pricing()): number {
    const t = this.totals;
    return (
      (t.inputTokens * rates.input +
        t.outputTokens * rates.output +
        t.cacheWriteTokens * rates.cacheWrite +
        t.cacheReadTokens * rates.cacheRead) /
      1_000_000
    );
  }

  /**
   * What caching actually saved on this run.
   *
   * Cached tokens would otherwise have been billed at the full input rate, so
   * the saving is the gap between the two. On a twenty-turn loop with a fixed
   * system prompt and tool list this is most of the input bill, which is why
   * the prefix is marked cacheable in the first place.
   */
  cacheSavingUsd(rates: Pricing = pricing()): number {
    return (this.totals.cacheReadTokens * (rates.input - rates.cacheRead)) / 1_000_000;
  }
}

/**
 * Rounded to cents-and-then-some: a capability can legitimately cost less than
 * a cent, and reporting that as "$0.00" would lose the point. Grouped above a
 * thousand, because the projected figures are exactly the ones a reader needs
 * to take in at a glance and "$552693.00" does not read as half a million.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}
