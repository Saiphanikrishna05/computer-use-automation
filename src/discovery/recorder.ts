/**
 * The step recorder: turning a model transcript into a capability.
 *
 * The brief asks for an artifact "decoupled from the raw model transcript",
 * and this is where that decoupling happens. The transcript is a record of one
 * conversation, full of retries, dead ends, and reasoning that will never be
 * true again. The artifact is a contract. Only actions that actually succeeded
 * become steps; everything else stays in the evidence bundle where it belongs.
 *
 * Two jobs beyond bookkeeping:
 *
 *  - **Parameterization.** Concrete values the model typed are rewritten into
 *    `{{template}}` references. Credentials are parameterized automatically,
 *    by literal match, and marked `injected` so they can never be published in
 *    the agent-facing tool schema or written into the artifact.
 *
 *  - **Honest provenance.** The emitted artifact is a `draft`. A single
 *    successful run observes exactly one path; the outcomes and recovery rules
 *    it declares are the model's hypotheses about paths it never took. Marking
 *    it approved would be claiming evidence we do not have.
 */

import {
  SCHEMA_VERSION,
  type ActionClass,
  type BusinessOutcome,
  type CapabilityArtifact,
  type OutputSpec,
  type ParamSpec,
  type RecoveryRule,
  type Step,
  type TargetDescriptor,
  type ValueType,
} from '../artifact/schema.js';

export interface RecordedAction {
  kind: 'navigate' | 'click' | 'type' | 'select' | 'press';
  intent: string;
  risk: ActionClass;
  target?: TargetDescriptor;
  url?: string;
  value?: string;
  key?: string;
  secret?: boolean;
}

export interface DeclaredOutput {
  name: string;
  type: ValueType;
  description: string;
  sensitivity: OutputSpec['sensitivity'];
  target: TargetDescriptor;
  observedValue: string;
}

export interface DeclaredParameter {
  name: string;
  type: ValueType;
  description: string;
  /** The literal the model actually typed, used to rewrite steps into templates. */
  value: string;
  sensitivity?: ParamSpec['sensitivity'];
  injected?: boolean;
  pattern?: string;
}

export interface FinishDeclaration {
  capabilityId: string;
  title: string;
  description: string;
  parameters: DeclaredParameter[];
  checkpointDescription: string;
  checkpointText: string;
  checkpointFramePath?: { name?: string }[];
  expectedOutcomes: Array<{
    code: string;
    description: string;
    textWhenPresent: string;
    /** How to provoke this outcome, so probing can observe it rather than
     *  trusting the declaration. Optional: not every state is reachable by
     *  varying one input. */
    probeParameter?: string;
    probeValue?: string;
    probeRationale?: string;
  }>;
}

export interface RecorderOptions {
  goal: string;
  runId: string;
  model: string;
  vendor: string;
  product: string;
  versionRange: string;
  entryUrl: string;
  /** Substituted out of recorded URLs so the artifact is tenant-neutral. */
  baseUrl: string;
  /** Credentials to auto-parameterize. Never written to the artifact. */
  injectedSecrets: Array<{ name: string; value: string; description: string; sensitivity: ParamSpec['sensitivity'] }>;
}

export class StepRecorder {
  private readonly actions: RecordedAction[] = [];
  private readonly outputs: DeclaredOutput[] = [];

  constructor(private readonly options: RecorderOptions) {}

  record(action: RecordedAction): void {
    this.actions.push(action);
  }

  declareOutput(output: DeclaredOutput): void {
    // Re-declaring the same output name replaces it: a model that reads a
    // value, decides it read the wrong cell, and reads again should end up
    // with one output, not two.
    const existing = this.outputs.findIndex((o) => o.name === output.name);
    if (existing >= 0) this.outputs.splice(existing, 1, output);
    else this.outputs.push(output);
  }

  get declaredOutputs(): readonly DeclaredOutput[] {
    return this.outputs;
  }

  get actionCount(): number {
    return this.actions.length;
  }

  /** Replaces a concrete URL with the `{{baseUrl}}`-relative template form. */
  private canonicalizeUrl(url: string): string {
    return url.startsWith(this.options.baseUrl)
      ? `{{baseUrl}}${url.slice(this.options.baseUrl.length)}`
      : url;
  }

  build(declaration: FinishDeclaration): CapabilityArtifact {
    const now = new Date().toISOString();

    // Credentials first: they are matched by literal value, so if a model
    // happened to type a password into a field we would otherwise persist the
    // password. Doing this before user-declared parameters guarantees the
    // secret is templated out even if the model declared nothing.
    const secretParams: DeclaredParameter[] = this.options.injectedSecrets.map((s) => ({
      name: s.name,
      type: 'string' as const,
      description: s.description,
      value: s.value,
      sensitivity: s.sensitivity,
      injected: true,
    }));

    const allParams = [...secretParams, ...declaration.parameters.filter((p) => !secretParams.some((s) => s.name === p.name))];

    const steps: Step[] = this.actions.map((action, index) => {
      const id = `${action.kind}_${index + 1}`;
      const base = { id, intent: action.intent, risk: action.risk, timeoutMs: 15_000, postconditions: [] };

      switch (action.kind) {
        case 'navigate':
          return { ...base, action: { kind: 'navigate' as const, urlTemplate: this.canonicalizeUrl(action.url ?? '') } };
        case 'click':
          return { ...base, action: { kind: 'click' as const, target: templatizeTarget(action.target!, allParams) } };
        case 'select':
          return {
            ...base,
            action: {
              kind: 'select' as const,
              target: templatizeTarget(action.target!, allParams),
              valueTemplate: templatize(action.value ?? '', allParams),
            },
          };
        case 'press':
          return {
            ...base,
            action: { kind: 'press' as const, key: action.key ?? 'Enter', ...(action.target ? { target: templatizeTarget(action.target, allParams) } : {}) },
          };
        case 'type': {
          const isSecret = secretParams.some((s) => s.value === action.value);
          return {
            ...base,
            action: {
              kind: 'type' as const,
              target: templatizeTarget(action.target!, allParams),
              valueTemplate: templatize(action.value ?? '', allParams),
              clearFirst: true,
              secret: action.secret || isSecret,
            },
          };
        }
      }
    });

    const inputs: ParamSpec[] = allParams.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: true,
      sensitivity: p.sensitivity ?? 'none',
      injected: p.injected ?? false,
      ...(p.pattern ? { pattern: p.pattern } : {}),
      ...(p.injected ? {} : { example: p.value }),
    }));

    const outputs: OutputSpec[] = this.outputs.map((o) => ({
      name: o.name,
      type: o.type,
      description: o.description,
      required: true,
      sensitivity: o.sensitivity,
      extract: {
        target: templatizeTarget(o.target, allParams),
        source: 'text' as const,
        transforms: o.type === 'money' || o.type === 'number' ? (['collapse_whitespace', 'money'] as const) : (['collapse_whitespace'] as const),
      },
    })) as OutputSpec[];

    const framePath = (declaration.checkpointFramePath ?? []).map((f) => ({ name: f.name }));

    // Every outcome is emitted as a hypothesis. Probing, which runs after this,
    // is what may upgrade one to an observation; nothing the model asserted is
    // treated as evidence on its own.
    const outcomes: BusinessOutcome[] = declaration.expectedOutcomes.map((o) => ({
      code: o.code,
      description: o.description,
      when: { kind: 'text_present' as const, text: o.textWhenPresent, framePath, caseSensitive: false },
      extract: [],
      ...(o.probeParameter && o.probeValue
        ? {
            probe: {
              parameter: o.probeParameter,
              value: o.probeValue,
              rationale: o.probeRationale ?? '',
            },
          }
        : {}),
      evidence: { state: 'hypothesised' as const },
    }));

    // A dialog-acknowledgement rule is added unconditionally because an
    // unhandled native modal blocks the surface entirely, every subsequent
    // step would fail with a misleading error. It is the one recovery that is
    // a property of the medium rather than of the application.
    const recovery: RecoveryRule[] = [
      {
        code: 'ACCEPT_SYSTEM_DIALOG',
        description:
          'A native dialog is blocking the page. Acknowledging it is required before any further step can run. Review whether acknowledging is safe for this flow before approving.',
        when: { kind: 'dialog_present' },
        then: [{ kind: 'accept_dialog' }],
        maxAttempts: 3,
      },
    ];

    const maxRisk = steps.reduce<ActionClass>((acc, step) => rank(step.risk) > rank(acc) ? step.risk : acc, 'read');

    return {
      schemaVersion: SCHEMA_VERSION,
      id: declaration.capabilityId,
      version: 1,
      title: declaration.title,
      description: declaration.description,
      target: {
        surface: 'web',
        app: {
          vendor: this.options.vendor,
          product: this.options.product,
          versionRange: this.options.versionRange,
        },
        entryUrlTemplate: this.canonicalizeUrl(this.options.entryUrl),
      },
      // Draft, always. See the note at the top of this file.
      approval: { state: 'draft' },
      maxRisk,
      inputs,
      outputs,
      steps,
      checkpoint: {
        description: declaration.checkpointDescription,
        condition: {
          kind: 'text_present',
          text: declaration.checkpointText,
          framePath,
          caseSensitive: false,
        },
      },
      outcomes,
      recovery,
      failures: [],
      provenance: {
        discoveredAt: now,
        runId: this.options.runId,
        goal: this.options.goal,
        model: this.options.model,
        evidencePath: `runs/${this.options.runId}`,
        humanEdits: [],
      },
    };
  }
}

function rank(actionClass: ActionClass): number {
  return { read: 0, mutate_reversible: 1, mutate_irreversible: 2 }[actionClass];
}

/**
 * The same rewrite, applied through a locator.
 *
 * A descriptor is mostly chrome — roles, column headings, panel names — which
 * must be left alone. But where a landmark happens to *contain* a value the
 * caller supplies, it is not a landmark at all: MERIDIAN CORE heads each share
 * row with an id like "102777-S0001", and the member number is right there
 * inside it. Recorded literally, that reads the correct cell for one member and
 * a plausible wrong one for everybody else.
 *
 * Credentials are excluded deliberately. A locator that needed a password in it
 * would be describing something no reviewer should be looking at, and quietly
 * templating it would hide that rather than surface it.
 */
function templatizeTarget<T>(target: T, params: DeclaredParameter[]): T {
  // Three characters, not four. The old floor was a blunt guard around a bare
  // substring replace; boundary matching below does that work properly now, so
  // the floor only has to exclude values too short to be distinctive at all.
  const usable = params.filter((p) => !p.injected && p.value && p.value.length >= 3);
  if (usable.length === 0) return target;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return templatize(node, usable);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) =>
          // `evidence` records what was on screen when this step was recorded.
          // Resolution never reads it; a human reviewing the artifact does.
          // Rewriting a value inside a snapshot makes the snapshot less true
          // rather than more portable, so it is left exactly as observed.
          [k, k === 'evidence' ? v : walk(v)],
        ),
      );
    }
    return node;
  };
  return walk(target) as T;
}

/**
 * Rewrites concrete values into template references.
 *
 * Longest-first so a parameter whose value is a substring of another cannot
 * corrupt the longer one: replacing "100" before "100001" would leave
 * "{{shortParam}}001" behind.
 *
 * Only whole tokens are replaced. A bare substring match rewrites the middle of
 * an unrelated identifier, and the result is a locator that looks
 * parameterised and is quietly wrong for every member but the recorded one:
 *
 *     memberNumber="1002"  ·  "Member 100234"  ->  "Member {{memberNumber}}34"
 *
 * A token here is bounded by a non-alphanumeric character or the end of the
 * string, which keeps the case this exists for. In "102777-S0001" the member
 * number is bounded by a hyphen and is rewritten; in "100234" a shorter number
 * sitting inside it is not.
 *
 * The failure this trades into is under-templatising: a locator stays literal
 * and the capability then fails to find its row for a different member. That is
 * a loud failure at a named step, and it is the better half of the trade,
 * because over-templatising produces a confident wrong answer instead.
 */
function templatize(value: string, params: DeclaredParameter[]): string {
  let out = value;
  for (const param of [...params].sort((a, b) => b.value.length - a.value.length)) {
    if (!param.value) continue;
    out = replaceWholeTokens(out, param.value, `{{${param.name}}}`);
  }
  return out;
}

/** True when `text[index]` sits outside a run of alphanumeric characters. */
function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !/[A-Za-z0-9]/.test(text[index]!);
}

function replaceWholeTokens(text: string, needle: string, replacement: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(needle, cursor);
    if (at === -1) {
      out += text.slice(cursor);
      return out;
    }
    const whole = isBoundary(text, at - 1) && isBoundary(text, at + needle.length);
    out += text.slice(cursor, at) + (whole ? replacement : needle);
    cursor = at + needle.length;
  }
}

/** Exposed for tests: the boundary rule is the load-bearing part. */
export const __templatizeForTest = templatize;
export const __templatizeTargetForTest = templatizeTarget;
