/**
 * Input binding and value transforms.
 *
 * Templates are `{{name}}` and nothing more. There is no expression syntax, no
 * conditionals, no arithmetic — deliberately. An artifact is a document a
 * reviewer has to be able to read and approve; the moment it can compute, it
 * stops being reviewable and becomes a program, and "is this capability safe"
 * stops having a checkable answer.
 */

import type { OutputSpec, ParamSpec, ValueType } from '../artifact/schema.js';

export class InputValidationError extends Error {
  constructor(
    message: string,
    readonly parameter: string,
  ) {
    super(message);
    this.name = 'InputValidationError';
  }
}

const TEMPLATE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function referencedParameters(template: string): string[] {
  return [...template.matchAll(TEMPLATE)].map((m) => m[1]!);
}

export function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(TEMPLATE, (_match, name: string) => {
    if (!(name in values)) {
      throw new InputValidationError(`Template references unknown parameter "${name}"`, name);
    }
    const value = values[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

function coerce(raw: unknown, type: ValueType, name: string): unknown {
  switch (type) {
    case 'string':
      return String(raw);
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new InputValidationError(`Parameter "${name}" must be a boolean`, name);
    case 'number':
    case 'money': {
      const cleaned = typeof raw === 'string' ? raw.replace(/[$,\s]/g, '') : raw;
      const n = Number(cleaned);
      if (!Number.isFinite(n)) throw new InputValidationError(`Parameter "${name}" must be numeric`, name);
      return n;
    }
  }
}

/**
 * Validates and coerces caller-supplied arguments against the artifact's
 * declared inputs. Rejecting unknown parameters is intentional: a typo'd
 * argument that is silently ignored produces a run that looks successful and
 * did the wrong thing.
 */
export function bindInputs(
  specs: ParamSpec[],
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};

  for (const spec of specs) {
    const present = spec.name in supplied && supplied[spec.name] !== undefined && supplied[spec.name] !== '';
    if (!present) {
      if (spec.required) {
        throw new InputValidationError(`Missing required parameter "${spec.name}"`, spec.name);
      }
      continue;
    }

    const value = coerce(supplied[spec.name], spec.type, spec.name);

    if (spec.pattern && !new RegExp(spec.pattern).test(String(supplied[spec.name]))) {
      throw new InputValidationError(
        `Parameter "${spec.name}" does not match required pattern ${spec.pattern}`,
        spec.name,
      );
    }

    bound[spec.name] = value;
  }

  const known = new Set(specs.map((s) => s.name));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) {
      throw new InputValidationError(`Unknown parameter "${key}" for this capability`, key);
    }
  }

  return bound;
}

export function applyTransforms(raw: string, transforms: OutputSpec['extract']['transforms']): string {
  let out = raw;
  for (const t of transforms) {
    switch (t) {
      case 'trim':
        out = out.trim();
        break;
      case 'collapse_whitespace':
        out = out.replace(/\s+/g, ' ').trim();
        break;
      case 'digits':
        out = out.replace(/\D/g, '');
        break;
      case 'money':
        out = out.replace(/[^0-9.\-]/g, '');
        break;
      case 'number':
        out = out.replace(/[^0-9.eE+\-]/g, '');
        break;
    }
  }
  return out;
}

/** Final coercion of an extracted string into the output's declared type. */
export function coerceOutput(raw: string, spec: OutputSpec): unknown {
  const transformed = applyTransforms(raw, spec.extract.transforms);
  switch (spec.type) {
    case 'string':
      return transformed;
    case 'boolean':
      return /^(true|yes|y|1)$/i.test(transformed.trim());
    case 'number':
    case 'money': {
      const cleaned = transformed.replace(/[$,\s]/g, '');
      // `Number('')` is 0, not NaN. Without this guard a field showing an
      // em-dash, or one the transforms stripped to nothing, would be reported
      // as a balance of zero — a wrong answer that looks entirely plausible
      // and is exactly the kind a caller would act on. An absent value must
      // read as absent.
      if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
  }
}
