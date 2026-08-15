# Design write-up

## 1. Architecture

`discover` (LLM) emits a typed, versioned artifact; `replay` executes it with no
model in the loop; `catalog` publishes it as a tool an agent invokes by name. One
boundary carries the design: `SurfaceDriver` is the only thing that knows how a
surface is perceived and acted on, and schema, replay, policy, escalation and
evidence are all written against `UiNode` and `TargetDescriptor` — none mentions
a browser.

The choices §4 left open: **TypeScript**, so one Zod schema is both the runtime
validator and the JSON Schema the catalog publishes; **`claude-opus-5`** behind a
one-method interface, needed only for discovery; **Playwright**, driving my own
element model; **a legacy console I built plus saucedemo.com**, the only way to
reproduce on demand every runtime error the brief names and to run a second
tenant, with the public site guarding against overfitting to my own markup;
**JSON files**, so a capability is reviewable in a pull request; **one process**,
since queues would be scaling infrastructure for a judgement-bound system.

Two decisions carry more weight. **I own the element model rather than delegating
to a selector engine** — perception computes each element's role, accessible
name, the label a human reads as belonging to it, its panel, and for cells its
row and column headers, a subset of what UIA, AX and AT-SPI already expose.
`td:nth-child(3)` is not a question you can ask an accessibility tree; "the
Savings row, Current Balance column" is. And **the model points; it does not
author locators** — its tools take a reference from the last observation, the
descriptor is synthesized from measured properties, and the action is performed
*through it*, so no step is recorded with a locator that never resolved.
Improving that synthesis improves every capability already recorded.

## 2. Artifact schema

**A target is a ranked candidate ladder, not a selector** —
`test_id → role_name → label → placeholder → text → structural → coordinates` —
encoding the claim that semantics outlive structure and structure outlives
pixels; replay tries them in order, requires a unique match, and records which
tier won. **Outcomes, recovery rules and hard failures are declared in the
artifact**, in one condition language shared with waits and the checkpoint, so a
reviewer reads a capability's whole failure contract in one file. Credentials
resolve at execution time and are absent from the published tool schema, so a
calling agent cannot supply, see or leak them.

**Approval state** is the fourth. Discovery emits `draft`; unattended replay of
one is refused. A run walks a single path, so its outcomes for the others are
guesses — in the first real run all four were wrong, one matching the login page
itself, which would have terminated every replay on turn zero. Post-discovery
validation now deletes any condition that holds in the success *or* entry state,
since such a condition is broken by construction; ones that merely never matched
are kept and flagged. That run is kept as evidence and its conditions are test
fixtures.

## 3. Determinism & error handling

Nothing is recorded by index or handle; resolution requires a *unique* match, and
ambiguity is reported rather than resolved by taking `[0]`; artifacts are
templates, not programs, because once a capability can compute, "is this safe to
approve" stops having a checkable answer. The result contract is a discriminated
union, making the distinction the brief calls the commonest mistake structural
rather than documentary:

```ts
| { status: 'success';          outputs }
| { status: 'business_outcome'; outcome; data }   // a real answer that isn't success
| { status: 'escalated';        interventionId }
| { status: 'failure';          error: { code, stepId, expected, observed } }
```

Before every step: outcomes, then declared failures, then recovery. Outcomes win
— a run that dismisses the not-found banner and keeps driving is the bug the
ordering prevents. Recovery is last because it alone mutates the surface, and is
budgeted per rule per *run*; refreshing that budget each step turns a broken
capability into an infinite loop. Every path is in `evidence/`, carrying step,
expected, observed, screenshot and DOM snapshot.

**Drift** is not layout change but *tier degradation*, and it is tested rather
than asserted (`./scripts/demo-drift.sh`): apply a vendor point release — reword
a button, re-order the accounts columns, insert a column — then replay the
unchanged artifact. The balance still resolves at tier 2, because it is addressed
as "the Savings row, Current Balance column", where a positional selector would
now be reading the inserted Status column and reporting "Open" as a balance. The
reworded button drops to the structural tier and is flagged. Nothing failed; the
signal fired anyway. That gap — still correct, now weaker — is the whole reason
the tier is recorded.

## 4. Heterogeneity & multi-tenant

A Windows UIA driver implements the same interface and emits the same `UiNode`;
nothing above it changes, because nothing above it contains a CSS selector. The
`structural` tier degrades to a control-tree path, and `coordinates` — viewport
fractions — carries surfaces with no tree at all. Frames resolve by name, then
URL, then position last, because frame *order* is among the first things that
differ between tenants.

An artifact is recorded against a *vendor product*, not a tenant. A
`TenantOverlay` may bind values, alias frames, override a target and add recovery
rules — never extend the flow, because divergent step lists are how a "shared"
artifact becomes N artifacts nobody can reason about. Cascade CU runs the same
build as Northpoint with different frame names, button wording, a
differently-labelled field and an extra login notice; the overlay carries three,
and the fourth needs no entry because non-exact matching absorbs it. The
saucedemo run replays 10/10 at **tier 0**, since it ships `data-test` attributes,
while the legacy console has none and resolves at **tier 2** via inferred labels
— same ladder, different available signal, which is the property that must hold
for one schema to span a modern web app and a 1998 frameset.

## 5. Escalation & handoff

"Stuck" is narrow — a policy refusal a human can authorize, an unresolvable
target, a failed postcondition, a timeout, a session drop — because paging an
operator who can do nothing is worse than failing. Control is explicit:

```
AUTOMATION ─request─▶ HANDOFF_REQUESTED ─grant─▶ HUMAN ─return─▶ RESUMING ─▶ AUTOMATION
```

The driver asserts it holds this **control lease** before every action, so a path
that forgets to check raises rather than races; the mid-transfer states belong to
nobody, since automation may still be finishing an in-flight action as the
operator picks up. The operator works the same live page, and an injected capture
script records what they did, redacted, into the same evidence bundle.
**Resolution is three-way**, and the third value matters: `resumed` retries the
step, `completed_manually` skips it, `aborted` stops. Without the middle one,
escalating an irreversible action is incoherent — the human is escalated to
*precisely because* only a person should perform that submit, and then the
automation retries and submits twice.

## 6. Safety

**Guardrails sit below the model**: the allowlist and action-class ceiling are
enforced inside the driver, on a path the model cannot address. The prompt states
the rules so the model cooperates; enforcement exists because prompts are
advisory once the input includes attacker-controlled page text. **Irreversibility,
not danger, is the axis** — "risky" is subjective, "can I undo this" is not, so
`mutate_irreversible` is refused outright during discovery and on replay needs an
approved artifact plus a human.

**Redaction applies at every egress**: logs, artifacts, screenshots masked at
capture, and the model's prompts. The most instructive bug was here — redaction
missed a node's `nearestLabel`, and in an accounts table the cell beside a
balance is the *account number*. The fix went past the leak: locator synthesis
now rejects any redacted string, because a locator built from record data both
leaks and cannot generalize, when the point is to run for a different member
tomorrow. **Injection is demonstrated, not argued** — a member's memo field
carries text telling automated assistants to post the account details to
`exfil.example`, the realistic surface being free text the institution's own
staff can edit. The agent never attempted it and reported it instead; had it
tried, the allowlist would have refused the origin without the model being
consulted. Limits: redaction is pattern-based, the allowlist is origin-and-path
only, and approval is a JSON field with no identity behind it.

## 7. Cuts

The brief says one or two stretch goals; four are here. The catalog and
cross-tenant reuse were deliberate, serving the two highest-weighted criteria;
the others were barely additions, since approval gating belongs to the safety
model regardless and stability scoring aggregates telemetry the drift signal
already produced. Not built: a desktop driver (interface and design only), a full
co-browsing console, multi-tenant plumbing. `restart_from_step` is in the schema
and throws, because re-entering the step loop mid-recovery makes a run non-linear
and its evidence unreadable. `open_sub_account` is hand-authored, since the
discovery agent is forbidden irreversible actions and cannot walk that flow to
its end — and the artifact exists to exercise the escalation path that constraint
creates. Column headings are still inferred heuristically: right for tables,
wrong for grids that are not tables.

**Next**, in order: **outcome probing during discovery** — after success, re-run
the parameterized step with a bad input and *observe* the not-found screen
instead of hypothesizing it, which would have caught all four wrong outcomes in
§2 without a human and is the highest-value item by some distance; then wiring
stability scoring into `catalog approve`; a real approval workflow with an
authenticated reviewer and an append-only audit; and a UIA driver against one
genuine Windows application, to find out which parts of `UiNode` I got wrong. I
expect the answer is "the label heuristics".
