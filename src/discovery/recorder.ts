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
  expectedOutcomes: Array<{ code: string; description: string; textWhenPresent: string }>;
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
          return { ...base, action: { kind: 'click' as const, target: action.target! } };
        case 'select':
          return {
            ...base,
            action: {
              kind: 'select' as const,
              target: action.target!,
              valueTemplate: templatize(action.value ?? '', allParams),
            },
          };
        case 'press':
          return {
            ...base,
            action: { kind: 'press' as const, key: action.key ?? 'Enter', ...(action.target ? { target: action.target } : {}) },
          };
        case 'type': {
          const isSecret = secretParams.some((s) => s.value === action.value);
          return {
            ...base,
            action: {
              kind: 'type' as const,
              target: action.target!,
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
        target: o.target,
        source: 'text' as const,
        transforms: o.type === 'money' || o.type === 'number' ? (['collapse_whitespace', 'money'] as const) : (['collapse_whitespace'] as const),
      },
    })) as OutputSpec[];

    const framePath = (declaration.checkpointFramePath ?? []).map((f) => ({ name: f.name }));

    const outcomes: BusinessOutcome[] = declaration.expectedOutcomes.map((o) => ({
      code: o.code,
      description: o.description,
      when: { kind: 'text_present' as const, text: o.textWhenPresent, framePath, caseSensitive: false },
      extract: [],
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
 * Rewrites concrete values into template references.
 *
 * Longest-first so a parameter whose value is a substring of another cannot
 * corrupt the longer one, replacing "100" before "100001" would leave
 * "{{shortParam}}001" behind.
 */
function templatize(value: string, params: DeclaredParameter[]): string {
  let out = value;
  for (const param of [...params].sort((a, b) => b.value.length - a.value.length)) {
    if (param.value && out.includes(param.value)) {
      out = out.split(param.value).join(`{{${param.name}}}`);
    }
  }
  return out;
}
