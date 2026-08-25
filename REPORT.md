# Design write-up

## 1. Architecture

`discover` (LLM) emits a typed, versioned artifact; `replay` executes it with no
model in the loop; `catalog` publishes it as a tool an agent invokes by name. One
boundary carries the design: `SurfaceDriver` is the only thing that knows how a
surface is perceived and acted on, and schema, replay, policy, escalation and
evidence are all written against `UiNode` and `TargetDescriptor`. None of them
mentions a browser.

The choices §4 left open: **TypeScript**, so one Zod schema is both the runtime
validator and the JSON Schema the catalog publishes; **`claude-opus-5`** behind a
one-method interface, needed only for discovery; **Playwright**, driving my own
element model; **a legacy console I built plus saucedemo.com**, the only way to
reproduce on demand every runtime error the brief names and to run a second
tenant, with the public site guarding against overfitting to my own markup;
**JSON files**, so a capability is reviewable in a pull request; **one process**,
since queues would be scaling infrastructure for a judgement-bound system.

Two decisions carry more weight. **I own the element model rather than delegating
to a selector engine.** Perception computes each element's role, accessible
name, the label a human reads as belonging to it, its panel, and for cells its
row and column headers, a subset of what UIA, AX and AT-SPI already expose.
`td:nth-child(3)` is not a question you can ask an accessibility tree; "the
Savings row, Current Balance column" is. And **the model points; it does not
author locators.** Its tools take a reference from the last observation, the
descriptor is synthesized from measured properties, and the action is performed
*through it*, so no step is recorded with a locator that never resolved.
Improving that synthesis improves every capability already recorded.

## 2. Artifact schema

**A target is a ranked candidate ladder, not a selector:**
`test_id → role_name → label → placeholder → text → structural → coordinates`.
It encodes the claim that semantics outlive structure and structure outlives
pixels; replay tries them in order, requires a unique match, and records which
tier won. **Outcomes, recovery rules and hard failures are declared in the
artifact**, in one condition language shared with waits and the checkpoint, so a
reviewer reads a capability's whole failure contract in one file. Credentials
resolve at execution time and are absent from the published tool schema, so a
calling agent cannot supply, see or leak them.

**Approval state** is the fourth. Discovery emits `draft`; unattended replay of
one is refused. A run walks a single path, so its outcomes for the others are
guesses. In the first real run all four were wrong, one matching the login page
itself, which would have terminated every replay on turn zero. Post-discovery
validation now deletes any condition that holds in the success *or* entry state,
since such a condition is broken by construction; ones that merely never matched
are kept and flagged. That run is kept as evidence and its conditions are test
fixtures.

**Outcome evidence** closes the gap validation cannot. Validation only asks
whether a declaration is provably wrong against the two screens a successful run
leaves behind; anything else survives as an unfalsified guess. So each outcome
now also carries how to *provoke* it, and probing goes and does so: it replays
the recorded steps with that input, from a cold browser, and marks the outcome
`observed` or `refuted` by what the application actually did. A probe is
ordinary replay rather than a bespoke driving path, which is what makes it
evidence, since the condition is confirmed by the same engine, in the same
precedence order, that will evaluate it in production. Run against this flow it
refuted all three declared outcomes: two on wording (`"No member found"` against
a console that says `"No member record found"`) and one as unreachable, because
`memberId`'s own `^\d{6}$` contract rejects the probe value before the
application ever sees it. That first refutation is the one worth noting: this
capability's own `humanEdits` already records me correcting `"No member found"`
to the real wording by hand, weeks earlier. Probing found the identical bug on a
fresh recording, unprompted, in about two seconds. Each refutation carries the text that was on screen,
so the correction is handed to the reviewer rather than left for them to hunt
for; applied, the survivors probe clean. `catalog approve` then refuses any
capability carrying a refuted outcome without `--force`, which is what makes
this a gate rather than a report. Capabilities whose `maxRisk` is
`mutate_irreversible` are never probed: provoking an outcome there would mean
committing the transaction with a deliberately invalid input.

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
A run that dismisses the not-found banner and keeps driving is the bug that
ordering prevents. Recovery is last because it alone mutates the surface, and is
budgeted per rule per *run*; refreshing that budget each step turns a broken
capability into an infinite loop. Every path is in `evidence/`, carrying step,
expected, observed, screenshot and DOM snapshot.

**Drift** is not layout change but *tier degradation*, and it is tested rather
than asserted (`./scripts/demo-drift.sh`): apply a vendor point release that
rewords a button, re-orders the accounts columns and inserts a column, then replay the
unchanged artifact. The balance still resolves at tier 2, because it is addressed
as "the Savings row, Current Balance column", where a positional selector would
now be reading the inserted Status column and reporting "Open" as a balance. The
reworded button drops to the structural tier and is flagged. Nothing failed; the
signal fired anyway. That gap, still correct but now weaker, is the whole reason
the tier is recorded.

## 4. Heterogeneity & multi-tenant

A Windows UIA driver implements the same interface and emits the same `UiNode`;
nothing above it changes, because nothing above it contains a CSS selector. The
`structural` tier degrades to a control-tree path, and `coordinates`, expressed
as viewport fractions, carries surfaces with no tree at all. Frames resolve by name, then
URL, then position last, because frame *order* is among the first things that
differ between tenants.

An artifact is recorded against a *vendor product*, not a tenant. A
`TenantOverlay` may bind values, alias frames, override a target and add recovery
rules, but never extend the flow, because divergent step lists are how a "shared"
artifact becomes N artifacts nobody can reason about. Cascade CU runs the same
build as Northpoint with different frame names, button wording, a
differently-labelled field and an extra login notice; the overlay carries three,
and the fourth needs no entry because non-exact matching absorbs it. The
saucedemo run replays 10/10 at **tier 0**, since it ships `data-test` attributes,
while the legacy console has none and resolves at **tier 2** via inferred labels
Same ladder, different available signal, which is the property that must hold
for one schema to span a modern web app and a 1998 frameset.

## 5. Escalation & handoff

"Stuck" is narrow: a policy refusal a human can authorize, an unresolvable
target, a failed postcondition, a timeout, a session drop. Paging an operator
who can do nothing is worse than failing. Control is explicit:

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
escalating an irreversible action is incoherent. The human is escalated to
*precisely because* only a person should perform that submit, and then the
automation retries and submits twice.

## 6. Safety

**Guardrails sit below the model**: the allowlist and action-class ceiling are
enforced inside the driver, on a path the model cannot address. The prompt states
the rules so the model cooperates; enforcement exists because prompts are
advisory once the input includes attacker-controlled page text. **Irreversibility,
not danger, is the axis.** "Risky" is subjective, "can I undo this" is not, so
`mutate_irreversible` is refused outright during discovery and on replay needs an
approved artifact plus a human.

**Redaction applies at every egress**: logs, artifacts, screenshots masked at
capture, and the model's prompts. Masking is scoped to the deepest matching
element, because an element's text contains its descendants'; masking every
match blacked out the whole screen and turned the evidence into an absence of
it. It also fails *closed*: a frame that cannot be inspected before capture is covered
whole and logged, because "we could not check" and "there was nothing to hide"
must not produce the same image. The most instructive bug was here. Redaction
missed a node's `nearestLabel`, and in an accounts table the cell beside a
balance is the *account number*. The fix went past the leak: locator synthesis
now rejects any redacted string, because a locator built from record data both
leaks and cannot generalize, when the point is to run for a different member
tomorrow. **Injection is demonstrated, not argued.** A member's memo field
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
and its evidence unreadable. `open_sub_account` is the one hand-authored capability, since
the discovery agent is forbidden irreversible actions and cannot walk that flow
to its end, and the artifact exists to exercise the escalation path that
constraint creates. Column headings are still inferred heuristically: right for tables,
wrong for grids that are not tables. Overlay overrides are keyed by step id, which couples them to a
particular recording: re-recording a capability orphans every override written
against the old ids. That happened here, and the run's own drift counter caught
it: two locators on the second tenant resolving three tiers below where the
overlay intended, while the run still passed. Overrides are now scoped to one
capability per file, and an override matching no step aborts the run rather than
doing nothing, because a capability running without its tenant's corrections is
the failure this system exists to prevent.

**Outcome probing** was the top item on this list and is now built (§2). Two
things about it were only obvious once it ran. The first: the probe originally
reused discovery's browser, so every probe began already signed on, the recorded
sign-on steps resolved against nothing, and three outcomes came back refuted
with confident, entirely wrong explanations. A probe is a claim about what
replay will do, and it can only support that claim by starting where replay
starts, so it now takes a driver *factory* and opens a cold surface per run.
That is the kind of error that passes every unit test and is caught only by
running the thing. The second: `INVALID_MEMBER_ID` was refuted not on wording
but because the capability's own input pattern rejected the probe value before
the application saw it. Reporting that as a wording problem would have sent a
reviewer to fix the one thing that was correct, so it is classified and worded
separately. What probing still cannot do is invent a probe value; an outcome
nobody can say how to provoke stays a flagged hypothesis, which is honest but
not satisfying.

**Next**, in order. Wiring stability scoring into `catalog approve`; a real
approval workflow with an authenticated reviewer and an append-only audit;
re-probing on a schedule, so an outcome observed in March is not still trusted
in September after the vendor reworded the banner, which is the same drift
argument the locator ladder already makes and the natural extension of the
`observed` state; and a UIA driver against one genuine Windows application, to
find out which parts of `UiNode` I got wrong. I expect the answer is "the label
heuristics".
