# Adapting to MERIDIAN CORE

The take-home built a core: a model discovers how to do something on a UI-only
application, that run is captured as a typed capability, and plain code replays
it with no model in the decision loop. This is what happened pointing it at a
target I had not seen and did not write.

## What it took

**Sixty lines, all configuration:** a tenant entry with their base URL, a
per-tenant credential, and a `branch` field threaded through sign-on:

```
src/config.ts +46   src/cli/discover-command.ts +11   src/discovery/agent.ts +5
```

Nothing above the surface driver changed to *reach* it. That was decided months
earlier: the artifact describes a control in terms an accessibility tree can
answer (role, accessible name, the label a human reads as belonging to it, the
row and column a cell sits in) rather than as a selector.

**The hidden token cost nothing.** The brief flags `_token` as load-bearing.
Replay drives a real browser, so clicking *Continue* submits every hidden field
the form carries, including one that rotates per session. I never read it. A
system reconstructing HTTP requests would have to solve that; one driving the UI
gets it free. I only noticed because I went looking for the hard part and could
not find it.

Then their target found four real things wrong with the core.

**Identifiers that nest.** Row matching is *containment* on purpose, so one
recording survives a tenant saying "Member No." where another says "Member ID".
That holds until identifiers nest, and on a share ledger they do:
`100234-S0001` is a prefix of twenty others. Asking for one share's balance
matched twenty-six rows and returned **$2,070.51, a real number from a
different share.** Not a crash; a confident wrong answer. Exact now beats
containing where an exact hit exists, and a test pins that the tolerant path
still applies where nothing matches exactly.

**Locators could not be parameterised.** On my target the balance row is headed
"Savings": chrome, identical for every member. Meridian Core heads each row
with a share id containing the member number: record data wearing a landmark's
clothes, correct for exactly one member. Locators now carry `{{param}}`
references, templatised by the recorder and filled at resolve time. Credentials
are excluded from that rewrite, because a locator needing a password in it is
describing something no reviewer should be looking at.

**Credential names were hardcoded** in two places. Adding `branch` broke replay
and probing, and probing caught it within a minute of the first capability
existing.

**Recovery reported that it ran, not that it worked.** `tryRecovery` answered
"did a rule fire?", and the declared-failure check treats that as reason not to
call a condition fatal, so a recovery that failed suppressed the failure it had
failed to fix. A host stuck in maintenance reported `TARGET_NOT_FOUND` several
steps later, pointing at a missing button rather than a closed host.

## What was recorded

| | steps | outcomes observed | risk | to record |
|---|---|---|---|---|
| `mc_member_balance` | 9 | 1 of 1 | reversible | $1.83 |
| `mc_update_member` | 13 | 3 of 3 | reversible | $3.42 |
| `mc_funds_transfer` | 16 | 4 of 4 | **irreversible** | $4.29 |
| `mc_open_share` | 14 | 3 of 3 | **irreversible** | $3.81 |
| `mc_place_hold` | 14 | 2 of 2 | **irreversible** | $3.50 |

Five of seven functions, **$16.86 to record, $0 per replay**, verified by
running with the API key removed from the environment.

`mc_update_member` is worth noticing: it writes, and it is still
`mutate_reversible`, because a contact detail can be written back. The axis is
reversibility, not whether anything changed. The three irreversible ones could
not be recorded end to end, and that is the system working: the discovery agent
is forbidden irreversible actions, so it walks each flow only to the
confirmation screen. Their final steps are authored by hand and marked. The
agent records what it may do; a human decides what commits.

## The API contract

```
GET  /api/capabilities              the callable catalog, typed
POST /api/capabilities/:id/invoke   invoke by name, structured result
GET  /api/runs, /api/runs/:runId    what happened, with the evidence
```

```
src/api/server.ts          410 lines   the API
src/api/public/index.html  154 lines   the dashboard
src/api/public/chat.html   146 lines   the chatbot
```

Eight hundred lines for all three, and that is the point: they are **clients of
the capability API, not the system**. The chatbot uses a model to understand a
sentence and then invokes a recorded capability; the dashboard reads the same
run bundles the CLI writes. Neither can do anything the API cannot.

Generated from the same artifact replay executes. A result is one of four
shapes, and the fourth is the point:

```
success · business_outcome · needs_human · failure
```

`needs_human` covers both an escalation and a policy refusal, because to a
caller they are the same fact, and separating them invites treating one as
retryable.

**The API is a front door, not a second path.** It runs the same replay under
the same policy writing the same evidence. It does not accept credentials:
injected parameters are absent from the published schema, so a caller cannot
supply an operator password or see that one exists. And it cannot authorise
irreversible work: asking it to move money returns `needs_human`, because the
refusal happens in the driver.

The chatbot is a demo driver over that API. It chains calls, and its catalog is
scoped to the institution being served. Without that it reached for a
capability belonging to a different console, failed, and recovered by trying
another.

## Exceptional states

Every step keeps a ranked ladder of ways to find a control and records which
rung it used, so a step resolving below where it was recorded is flagged before
it fails.

The declared outcomes were the model's guesses, and **probing proved every one
wrong** by provoking each against the live host and reading back what it says:

| the model declared | Meridian Core says |
|---|---|
| `"No members found"` | "No member records matched your search." |
| `"Insufficient funds"` | "Insufficient available balance in the source share." |
| `"account is on hold"` | "Source share is HOLD and cannot be debited." |
| `"Invalid e-mail"` | "E-mail address is not in a valid format." |

Corrected, **all thirteen outcomes across five capabilities are backed by a real
screen.** One was deleted rather than carried: `INVALID_AMOUNT` is unreachable,
because `amount` is typed `money` and the contract rejects a non-numeric value
before the host sees it.

The last one to fall was `SUPERVISOR_REQUIRED`, and getting to it meant fixing a
rule that was too blunt. Probing refused to touch credentials at all, so an
entitlement check, which turns on *who is signed on* rather than on any caller
argument, could never be provoked. But those are two different hazards wearing
one name. Guessing a password fails sign-on and locks real accounts out.
Choosing a different identity the deployment has already provisioned signs on
fine; what is then under test is the check after it. So the rule is now sharper:

> A probe may change **who you are**. It may never guess **what you know**.

`mc_place_hold` is baselined as a supervisor, and its probe declares
`as: "operator"`. The teller signs on, reaches the review step, and is refused
there, which is the outcome, observed. An identity the deployment has not
configured is still skipped rather than improvised, and both halves of that are
pinned by tests.

The three states their host can be forced into are declared identically on every
capability, since they are properties of the host: `server` → `APP_ERROR`,
`timeout` → `SESSION_EXPIRED`, `maintenance` → recoverable, bounded to two
attempts, then `HOST_UNAVAILABLE`.

## How the guarantees survive

- **Irreversible work is refused wherever it is invoked from.** The transfer
  runs fifteen of sixteen steps and stops at `post_transfer`. The money does not
  move, from the CLI, the API or the chatbot.
- **Two guards, different questions.** `mc_place_hold` as `teller1` returns
  `business_outcome SUPERVISOR_REQUIRED`, which is their entitlement model. As
  `super1` the host allows it and *my* policy refuses the last step. Satisfying
  one does not satisfy the other.
- **Redaction** applies at every egress: logs, DOM snapshots, screenshots
  masked at capture, prompts. What is returned to the caller is not, because a
  capability whose job is to return a balance cannot redact its own answer.
- **Approval** still gates unattended replay, and refuses a capability carrying
  an outcome that was probed and did not fire.

## What I left out

**Two functions.** Sign-off is a single link with no contract worth recording;
inquiry by surname is the same flow as inquiry by number with one field changed.
Neither would prove anything the five do not.

**Which identity a capability needs is configuration, not contract.**
`mc_place_hold` has to be probed with `--as supervisor` because a teller never
gets past the entitlement check, but the artifact does not say so. A human
knows to pass the flag. The artifact should declare the role it was recorded
under and let the runtime pick, and today it does not.

**A contract blunter than the task.** Asked to change only a phone number, the
assistant stops and asks for the email and address too, because
`mc_update_member` requires all three: the recorded flow types all three, since
the host's form arrives pre-filled. Asking beats guessing, and it is still
blunt.

**Re-probing on a schedule** is supported but not run; that needs somewhere to
run from and somewhere for the result to go.

**What I would do first with more time** is not another capability. It is making
locator parameterisation reliable without review. It matches on exact values
today, which worked because a member number is distinctive, and would not on a
value like `001`.

---

Setup, the demo path and the exact commands are in [README.md](README.md).
Every run referenced above is committed under `evidence/mc-*`.
