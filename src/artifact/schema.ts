/**
 * The capability artifact: a typed, versioned, reviewable description of a flow
 * through an application UI.
 *
 * Three design commitments shape this file, and they are the ones worth arguing
 * about:
 *
 *  1. A target is a *ranked set of candidate descriptors*, never a selector
 *     string. Legacy enterprise UIs have no test IDs and unstable markup, so a
 *     single selector is a single point of failure. Replay tries candidates in
 *     tier order and reports which tier won; that report is our drift signal.
 *
 *  2. Business outcomes and recovery rules live *in the artifact*, not in the
 *     engine. "No such member" is a legitimate answer the caller needs, and
 *     which conditions count as which is a property of the flow, not of the
 *     executor. Putting them here is what lets a human review a capability's
 *     full contract in one file.
 *
 *  3. One condition language is reused for waits, checkpoints, outcome
 *     detection and recovery triggers. Four dialects would be four places for
 *     semantics to drift apart.
 */

import { z } from 'zod';

/** Bumped on any breaking change to the shapes below. Artifacts carry it so a
 *  future runtime can refuse, or migrate, an artifact it does not understand. */
export const SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * What a step can do to the world. This drives the safety model: discovery
 * never performs `mutate_irreversible`, and replay requires an approved
 * artifact plus an explicit opt-in before it will.
 */
export const ActionClassSchema = z.enum([
  'read', // observing only: navigate, read, extract, assert
  'mutate_reversible', // typing into a field, opening a form, non-committal clicks
  'mutate_irreversible', // submitting a transaction, deleting, sending
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

/** Classification of data flowing through a parameter or output. Drives redaction. */
export const SensitivitySchema = z.enum(['none', 'pii', 'financial', 'secret']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const SurfaceKindSchema = z.enum(['web', 'desktop']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

// ---------------------------------------------------------------------------
// Frame path
// ---------------------------------------------------------------------------

/**
 * How to reach the frame a control lives in.
 *
 * Deliberately *not* an index. Frame order is the first thing that differs
 * between two tenants running the same vendor build, so index is recorded only
 * as a last-resort disambiguator and is never the primary signal.
 */
export const FrameStepSchema = z.object({
  name: z.string().optional().describe('frame name or id attribute'),
  urlPattern: z
    .string()
    .optional()
    .describe('canonicalized frame URL, e.g. "{{baseUrl}}/console/content"'),
  ordinal: z.number().int().nonnegative().optional().describe('last-resort positional fallback'),
});
export type FrameStep = z.infer<typeof FrameStepSchema>;

/** Empty array means the main frame. */
export const FramePathSchema = z.array(FrameStepSchema);
export type FramePath = z.infer<typeof FramePathSchema>;

// ---------------------------------------------------------------------------
// Locator candidates
// ---------------------------------------------------------------------------

/**
 * A single way to find a control. Replay tries these in tier order (low tier
 * number first) and takes the first that resolves to exactly one element.
 */
export const LocatorCandidateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('test_id'),
    attribute: z.string(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal('role_name'),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('label'),
    text: z.string(),
    /** True when the association is positional (adjacent table cell) rather than
     *  a real <label for>. Legacy consoles are almost entirely this case. */
    positional: z.boolean().default(false),
    /**
     * Whether the label identifies an input control or a table cell.
     *
     * These are genuinely different questions on a screen built from tables -
     * "the field labelled Member ID" and "the cell in the Member ID row" are
     * both reasonable readings, and on this markup they resolve to different
     * elements. Making the caller say which keeps every lookup unambiguous
     * instead of guessing from context.
     */
    expect: z.enum(['control', 'cell']).default('control'),
    /**
     * Column qualifier, only meaningful with `expect: "cell"`. "The Savings
     * row" plus "the Current Balance column" addresses one cell without a
     * positional selector, and survives column re-ordering.
     */
    column: z.string().optional(),
  }),
  z.object({
    kind: z.literal('placeholder'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    exact: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('structural'),
    /** CSS for a stable container to scope within (a landmark, a titled table). */
    containerCss: z.string().optional(),
    /** CSS relative to the container. Must not reference volatile ids. */
    css: z.string(),
    ordinal: z.number().int().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal('coordinates'),
    /** Viewport-relative fractions, so a different window size still lands. */
    xFraction: z.number().min(0).max(1),
    yFraction: z.number().min(0).max(1),
  }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

/**
 * Tier ordering. Lower is preferred.
 *
 * The ordering encodes a claim: semantics outlive structure, and structure
 * outlives pixels. Role+name survives a restyle; a CSS path survives a
 * relabel; coordinates survive neither but are the only thing left when a
 * surface exposes no tree at all (a Citrix-published app, a canvas widget).
 */
export const CANDIDATE_TIER: Record<LocatorCandidate['kind'], number> = {
  test_id: 0,
  role_name: 1,
  label: 2,
  placeholder: 3,
  text: 4,
  structural: 5,
  coordinates: 6,
};

/** Tier at or below which we consider a resolution healthy. Above it, replay
 *  still proceeds but flags drift, because succeeding via a *worse* signal than
 *  the one recorded is the early warning that the UI moved under us. */
export const HEALTHY_TIER_CEILING = 4;

// ---------------------------------------------------------------------------
// Target descriptor
// ---------------------------------------------------------------------------

/**
 * Everything we know about one control. `candidates` is how we find it;
 * `evidence` is what we saw when we recorded it, kept so a failure report can
 * say "expected a button named Search, found a disabled link" instead of
 * "selector did not match".
 */
export const TargetDescriptorSchema = z.object({
  description: z.string().describe('human-readable, e.g. "Member ID search field"'),
  framePath: FramePathSchema.default([]),
  candidates: z.array(LocatorCandidateSchema).min(1),
  /** Nearest semantic anchor, used to disambiguate duplicates across sections. */
  anchor: z
    .object({
      containerRole: z.string().optional(),
      containerName: z.string().optional(),
      nearestLabel: z.string().optional(),
    })
    .optional(),
  /** Which match to take when candidates legitimately resolve to several. */
  ordinal: z.number().int().nonnegative().optional(),
  evidence: z
    .object({
      role: z.string().optional(),
      accessibleName: z.string().optional(),
      tag: z.string().optional(),
      textSnippet: z.string().optional(),
      boundingBox: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    })
    .default({}),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

// ---------------------------------------------------------------------------
// Conditions, one language, four uses
// ---------------------------------------------------------------------------

const LeafConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('element_visible'), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal('element_absent'), target: TargetDescriptorSchema }),
  z.object({
    kind: z.literal('text_present'),
    text: z.string(),
    framePath: FramePathSchema.default([]),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('text_absent'),
    text: z.string(),
    framePath: FramePathSchema.default([]),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('url_matches'), pattern: z.string() }),
  /** A native modal is up. Not expressible as an element query, the page is
   *  blocked and cannot be inspected at all while one is open. */
  z.object({ kind: z.literal('dialog_present'), textContains: z.string().optional() }),
]);

export type Condition =
  | z.infer<typeof LeafConditionSchema>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

// Typed with an `unknown` input because the leaf schemas carry defaults, which
// makes the parsed output shape narrower than the accepted input shape. The
// two-parameter form of ZodType cannot express that for a recursive type.
export const ConditionSchema: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({ kind: z.literal('all'), of: z.array(ConditionSchema) }),
    z.object({ kind: z.literal('any'), of: z.array(ConditionSchema) }),
    z.object({ kind: z.literal('not'), of: ConditionSchema }),
  ]),
);

// ---------------------------------------------------------------------------
// Typed inputs and outputs, the agent-facing contract
// ---------------------------------------------------------------------------

export const ValueTypeSchema = z.enum(['string', 'number', 'boolean', 'money']);
export type ValueType = z.infer<typeof ValueTypeSchema>;

export const ParamSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ValueTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema.default('none'),
  pattern: z.string().optional().describe('regex the value must satisfy'),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /**
   * Supplied by the runtime from a credential store, never by the calling
   * agent. Operator credentials are the motivating case: the AI agent that
   * invokes this capability has no business knowing them, so they are excluded
   * from the tool schema the catalog publishes and injected at execution time.
   */
  injected: z.boolean().default(false),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const ExtractionSchema = z.object({
  target: TargetDescriptorSchema,
  source: z.enum(['text', 'value', 'attribute']).default('text'),
  attribute: z.string().optional(),
  /** Applied in order. Keeps "strip the dollar sign" out of the executor. */
  transforms: z.array(z.enum(['trim', 'collapse_whitespace', 'digits', 'money', 'number'])).default([]),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const OutputSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ValueTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema.default('none'),
  extract: ExtractionSchema,
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const StepActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), urlTemplate: z.string() }),
  z.object({ kind: z.literal('click'), target: TargetDescriptorSchema }),
  z.object({
    kind: z.literal('type'),
    target: TargetDescriptorSchema,
    valueTemplate: z.string().describe('may reference inputs, e.g. "{{memberId}}"'),
    clearFirst: z.boolean().default(true),
    /** Suppresses the value from logs and evidence regardless of parameter
     *  sensitivity. Set for anything typed into a password field. */
    secret: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('select'),
    target: TargetDescriptorSchema,
    valueTemplate: z.string(),
  }),
  z.object({ kind: z.literal('press'), key: z.string(), target: TargetDescriptorSchema.optional() }),
  z.object({ kind: z.literal('wait_for'), condition: ConditionSchema, timeoutMs: z.number().int().positive().default(10_000) }),
  z.object({ kind: z.literal('extract'), outputName: z.string() }),
  z.object({ kind: z.literal('assert'), condition: ConditionSchema }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Why this step exists, in the discovering model's own words. Carried into
   *  failure reports and the operator console so a human gets intent, not just
   *  a selector. */
  intent: z.string(),
  action: StepActionSchema,
  risk: ActionClassSchema.default('read'),
  timeoutMs: z.number().int().positive().default(10_000),
  /** Cheap assertions run immediately after the action. A failed postcondition
   *  is what turns "the click silently did nothing" into a real error. */
  postconditions: z.array(ConditionSchema).default([]),
});
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Outcomes and recovery
// ---------------------------------------------------------------------------

/**
 * How to deliberately provoke an outcome, so it can be observed instead of
 * guessed.
 *
 * Deliberately just "set one input to this value". Anything richer, a branch, a
 * fixture, a second flow, would be a second capability wearing a probe's
 * clothes, and the point of a probe is that it walks the *same* recorded steps
 * a caller will walk. If an outcome cannot be reached by varying one input,
 * this system cannot honestly claim to have observed it, and says so.
 */
export const OutcomeProbeSchema = z.object({
  /** Name of a declared, non-injected input. */
  parameter: z.string(),
  /** Value to supply instead of the one discovery used. */
  value: z.string(),
  /** Why this value should provoke the outcome, in the declarer's own words. */
  rationale: z.string().default(''),
});
export type OutcomeProbe = z.infer<typeof OutcomeProbeSchema>;

/**
 * What we actually know about a declared outcome, as opposed to what was
 * asserted about it.
 *
 *   hypothesised  declared from a run that never took this path. A guess, and
 *                 the state every outcome starts in.
 *   observed      a probe drove the recorded steps with a provoking input and
 *                 this condition held on the screen that produced. Evidence.
 *   refuted       a probe ran and this condition did *not* hold. The wording is
 *                 probably wrong; a human needs to look before approval.
 *
 * `refuted` is a weaker claim than "wrong", and it is kept in the artifact
 * rather than deleted, because the distinction between "we tried and it did not
 * fire" and "we never tried" is exactly the information a reviewer needs and
 * exactly the information a deletion destroys.
 */
export const OutcomeEvidenceSchema = z.object({
  state: z.enum(['hypothesised', 'observed', 'refuted']).default('hypothesised'),
  probedAt: z.string().optional(),
  /** Evidence bundle of the probe run, relative to the repo root. */
  runId: z.string().optional(),
  /** What the probe run actually produced, when it did not produce this. */
  observedInstead: z.string().optional(),
  note: z.string().optional(),
});
export type OutcomeEvidence = z.infer<typeof OutcomeEvidenceSchema>;

/**
 * A legitimate, expected, non-error result the caller needs to know about.
 * Checked before every step and after the run; the first match ends the run
 * with `status: "business_outcome"`.
 */
export const BusinessOutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  when: ConditionSchema,
  /** Data worth returning alongside the outcome, e.g. the validation message. */
  extract: z.array(OutputSpecSchema).default([]),
  /** How to provoke this outcome on demand. Absent means it cannot be probed,
   *  which is itself worth a reviewer knowing. */
  probe: OutcomeProbeSchema.optional(),
  /**
   * Defaulted, so every artifact recorded before probing existed parses
   * unchanged and reads as what it is: a set of untested hypotheses.
   */
  evidence: OutcomeEvidenceSchema.default({ state: 'hypothesised' }),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>;

export const RecoveryActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal('accept_dialog') }),
  z.object({ kind: z.literal('dismiss_dialog') }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('restart_from_step'), stepId: z.string() }),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

/**
 * A condition replay is allowed to handle by itself, with a bounded number of
 * attempts. Everything not declared here that goes wrong is a hard failure -
 * the engine never improvises.
 */
export const RecoveryRuleSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  when: ConditionSchema,
  then: z.array(RecoveryActionSchema).min(1),
  maxAttempts: z.number().int().positive().max(5).default(2),
});
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

/**
 * A condition that is neither a business answer nor something replay may fix
 * on its own, an application error page, an unrecoverable session drop.
 *
 * Declaring these alongside outcomes and recovery rules is what completes the
 * taxonomy: all three classes the brief asks us to separate are stated in the
 * artifact, in the same condition language, and a reviewer can read a
 * capability's entire failure contract in one place instead of inferring it
 * from engine source.
 */
export const FailureRuleSchema = z.object({
  code: z.enum(['APP_ERROR', 'SESSION_EXPIRED', 'UNHANDLED_DIALOG', 'HOST_UNAVAILABLE']),
  description: z.string(),
  when: ConditionSchema,
});
export type FailureRule = z.infer<typeof FailureRuleSchema>;

// ---------------------------------------------------------------------------
// Approval, provenance, target identity
// ---------------------------------------------------------------------------

export const ApprovalSchema = z.object({
  state: z.enum(['draft', 'approved']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  note: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ProvenanceSchema = z.object({
  discoveredAt: z.string(),
  runId: z.string(),
  goal: z.string(),
  model: z.string(),
  /** Path, relative to the repo root, of the discovery evidence bundle. */
  evidencePath: z.string().optional(),
  humanEdits: z
    .array(z.object({ at: z.string(), by: z.string(), note: z.string() }))
    .default([]),
  /**
   * Result of the post-discovery validation pass. A single successful run
   * cannot observe the paths it did not take, so the model's declared outcomes
   * are hypotheses, and hypotheses that are checkably wrong should not reach a
   * human reviewer disguised as findings.
   */
  validation: z
    .object({
      checkedAt: z.string(),
      warnings: z.array(z.string()).default([]),
      /** Conditions removed because they already held before the flow ran. */
      rejected: z.array(z.object({ code: z.string(), reason: z.string() })).default([]),
    })
    .optional(),
  /**
   * What producing this capability consumed.
   *
   * Recorded because the system's central claim is economic as well as
   * architectural: the model runs once, the recording runs forever. A reviewer
   * deciding whether a capability earns its keep, or an operator sizing what it
   * costs to onboard an institution, should not have to reconstruct that from a
   * billing dashboard. Token counts are measured; `costUsd` is those counts at
   * the rate configured when the run happened, so a reader who prices
   * differently can still use the counts.
   */
  cost: z
    .object({
      turns: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      cacheReadTokens: z.number().int().nonnegative().default(0),
      cacheWriteTokens: z.number().int().nonnegative().default(0),
      costUsd: z.number().nonnegative(),
      /** What prompt-caching saved, versus billing the same tokens as input. */
      cacheSavingUsd: z.number().nonnegative().default(0),
    })
    .optional(),
  /**
   * Result of the probing pass, which goes further than validation: rather than
   * checking declarations against screens we happen to have, it provokes the
   * state each outcome describes and looks at what the application does.
   *
   * Absent means probing never ran, which is not the same as it finding
   * nothing, and a reviewer should be able to tell those apart from the
   * artifact alone.
   */
  probing: z
    .object({
      probedAt: z.string(),
      /** Probe runs actually spent. Zero with a reason is a real result. */
      runs: z.number().int().nonnegative().default(0),
      observed: z.array(z.string()).default([]),
      refuted: z.array(z.string()).default([]),
      unprobed: z.array(z.string()).default([]),
      warnings: z.array(z.string()).default([]),
    })
    .optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Identity of the *vendor product*, not the tenant. This is the hinge of the
 * multi-tenant story: one artifact is recorded against a product, and each
 * institution running that product supplies an overlay rather than a
 * re-recording.
 */
export const AppIdentitySchema = z.object({
  vendor: z.string(),
  product: z.string(),
  versionRange: z.string().default('*'),
});
export type AppIdentity = z.infer<typeof AppIdentitySchema>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Agent-facing tool name. Stable across versions; this is what a caller invokes. */
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Monotonic. A new recording of the same flow bumps this; it does not replace. */
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string().describe('what a calling agent needs to decide whether to invoke this'),

  target: z.object({
    surface: SurfaceKindSchema,
    app: AppIdentitySchema,
    entryUrlTemplate: z.string(),
  }),

  approval: ApprovalSchema.default({ state: 'draft' }),

  inputs: z.array(ParamSpecSchema).default([]),
  outputs: z.array(OutputSpecSchema).default([]),
  steps: z.array(StepSchema).min(1),

  /** The success condition. Replay does not report success without it holding. */
  checkpoint: z.object({
    description: z.string(),
    condition: ConditionSchema,
  }),

  outcomes: z.array(BusinessOutcomeSchema).default([]),
  recovery: z.array(RecoveryRuleSchema).default([]),
  failures: z.array(FailureRuleSchema).default([]),

  /** Highest risk class any step in this capability carries. Denormalized so a
   *  policy decision can be made from the header without walking the steps. */
  maxRisk: ActionClassSchema.default('read'),

  provenance: ProvenanceSchema,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

// ---------------------------------------------------------------------------
// Tenant overlay
// ---------------------------------------------------------------------------

/**
 * Per-institution specialization of a base artifact.
 *
 * The rule is that an overlay may *bind* and *override*, never *extend the
 * flow*. If a tenant needs different steps, that is a different capability and
 * should be recorded as one, silently divergent step lists are how a
 * "shared" artifact becomes N artifacts nobody can reason about.
 */
export const TenantOverlaySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  tenantId: z.string(),
  tenantName: z.string(),
  appliesTo: z.object({
    vendor: z.string(),
    product: z.string(),
    /** Omit to apply to every capability recorded against this product. */
    capabilityId: z.string().optional(),
  }),
  /** Values substituted into url templates, e.g. { baseUrl: "https://cu.example" }. */
  bindings: z.record(z.string()).default({}),
  /** Rename frames whose name attribute differs in this tenant's build. */
  frameAliases: z.record(z.string()).default({}),
  /** Per-step target replacement or skip. Keyed by step id. */
  stepOverrides: z
    .record(
      z.object({
        skip: z.boolean().optional(),
        target: TargetDescriptorSchema.optional(),
        valueTemplate: z.string().optional(),
      }),
    )
    .default({}),
  /** Tenant-local interstitials, the classic "one CU has an extra MOTD modal". */
  extraRecovery: z.array(RecoveryRuleSchema).default([]),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseArtifact(raw: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(raw);
}

export function parseOverlay(raw: unknown): TenantOverlay {
  return TenantOverlaySchema.parse(raw);
}
