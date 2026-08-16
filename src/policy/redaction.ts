/**
 * Redaction.
 *
 * The rule this module enforces:
 *
 *   Everything that is *persisted* or *sent to the model* is redacted.
 *   The typed return value handed back to the caller is not.
 *
 * That split is deliberate. A capability whose whole job is to return a
 * savings balance cannot redact the balance out of its own return value, but
 * it must never write that balance into a log line, a screenshot on disk, an
 * artifact, or a prompt. So redaction is applied at every egress boundary
 * (evidence, artifact, LLM) and nowhere else.
 *
 * Everything here is deny-by-pattern on top of deny-by-field: values typed
 * into a password field are suppressed structurally, regardless of whether
 * they happen to match a pattern.
 */

import type { Sensitivity } from '../artifact/schema.js';

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** What replaces a match. Keeps a shape hint so logs stay debuggable. */
  replace: (match: string) => string;
}

const keepLast = (n: number) => (match: string) => {
  const digits = match.replace(/\D/g, '');
  const tail = digits.slice(-n);
  return `[redacted:••${tail}]`;
};

/**
 * Ordered, earlier rules win, so the specific patterns (SSN, card) run before
 * the catch-all long-digit-run rule that would otherwise swallow them and lose
 * the type information in the placeholder.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => '[redacted:ssn]',
  },
  {
    name: 'card',
    pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
    replace: keepLast(4),
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => '[redacted:email]',
  },
  {
    name: 'phone',
    pattern: /\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g,
    replace: () => '[redacted:phone]',
  },
  {
    name: 'date_of_birth',
    pattern: /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g,
    replace: () => '[redacted:dob]',
  },
  {
    name: 'api_key',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_.\-]{20,})\b/g,
    replace: () => '[redacted:secret]',
  },
  {
    // Deliberately last, and deliberately 9+ digits: account and tax numbers
    // are long, while the 6-digit synthetic member IDs used as capability
    // inputs are not. Redacting the input parameter would make every log
    // unreadable for no privacy gain.
    name: 'long_account_number',
    pattern: /\b\d{9,}\b/g,
    replace: keepLast(4),
  },
];

export interface RedactorOptions {
  rules?: RedactionRule[];
  /** Literal strings to scrub wherever they appear, credentials supplied at
   *  runtime, which no pattern would recognise. */
  literals?: string[];
}

export class Redactor {
  private readonly rules: RedactionRule[];
  private literals: string[];

  constructor(options: RedactorOptions = {}) {
    this.rules = options.rules ?? DEFAULT_RULES;
    this.literals = (options.literals ?? []).filter((l) => l.length >= 4);
  }

  /** Register a runtime secret (a password from config, a session token) so it
   *  is scrubbed everywhere even though no pattern matches it. */
  addLiteral(value: string): void {
    if (value && value.length >= 4 && !this.literals.includes(value)) {
      this.literals.push(value);
    }
  }

  text(input: string | undefined | null): string {
    if (input == null) return '';
    let out = String(input);

    for (const literal of this.literals) {
      out = out.split(literal).join('[redacted:literal]');
    }
    for (const rule of this.rules) {
      // Fresh regex per call: the /g flag makes RegExp stateful via lastIndex,
      // and a shared instance would skip matches on alternating inputs.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      out = out.replace(re, (m) => rule.replace(m));
    }
    return out;
  }

  /**
   * Redact a value we already know the sensitivity of. `secret` never survives
   * in any form; `pii` and `financial` fall through to pattern redaction so a
   * shape hint is preserved for debugging.
   */
  value(input: unknown, sensitivity: Sensitivity = 'none'): unknown {
    if (sensitivity === 'secret') return '[redacted:secret]';
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v, sensitivity));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, this.value(v, sensitivity)]),
      );
    }
    return input;
  }

  /** Deep-redact an arbitrary structure destined for a log or the model. */
  deep<T>(input: T): T {
    return this.value(input, 'none') as T;
  }

  /** True when redaction would change the input, used to decide whether a
   *  screenshot region needs masking. */
  wouldRedact(input: string): boolean {
    return this.text(input) !== input;
  }
}

export const defaultRedactor = new Redactor();
