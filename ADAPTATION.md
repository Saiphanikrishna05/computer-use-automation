# Adapting to MERIDIAN CORE

The take-home built a core: an LLM discovers how to do something on a UI-only
application, that run is captured as a typed capability artifact, and plain code
replays it with no model in the decision loop. This is what happened when I
pointed it at a target I had not seen and did not write.

---

## 1. What the adaptation actually took

**Sixty lines, all configuration.** A tenant entry carrying their base URL, a
per-tenant credential, and a `branch` field threaded through sign-on, because
Meridian Core asks for one and my own target does not.

```
src/config.ts               +46
src/cli/discover-command.ts +11
src/discovery/agent.ts       +5
```

Nothing above the surface driver changed to *reach* the application. The thing
that made that true was decided months earlier: the artifact describes a control
in terms an accessibility tree can answer — role, accessible name, the label a
human reads as belonging to it, the row and column a cell sits in — rather than
as a selector. `resolveCredentials` had also always taken a `tenantId` it never
used, because a real deployment resolves per-institution credentials from a
vault; a second target with different operators is the first time that mattered.

Then the target found four real things wrong with the core. Those were not
configuration, and they are the interesting half.

### The per-transaction hidden token was free

The brief flags `_token` as load-bearing: read it off the page before you
submit. For this system it required no code at all. **Replay drives a real
browser**, so clicking *Continue* submits every hidden field the form carries,
including one that rotates per session. I never read the token, never store it,
and never knew its value.

That is not luck. A system that reconstructed HTTP requests would have to solve
it; one that drives the UI gets it for nothing. It is the clearest argument for
this architecture in the whole exercise, and I only noticed because I went
looking for the hard part and could not find it.

### Identifiers that nest inside each other

Row and label matching is *containment* on purpose: it lets one recording
survive a tenant that says "Member No." where another says "Member ID". That
tolerance is correct right up until identifiers nest, and on a share ledger they
do — `102777-MMKT` is a prefix of `102777-MMKT-4`, and `100234-S0001` of twenty
others.

Asking for the first share's balance matched twenty-six rows and returned
whichever came back. **Member 100234's balance came back as $2,070.51 — a real
number, belonging to a different share of theirs.** Not a crash; a confident
wrong answer, which is the failure this system exists to prevent.

Exact now beats containing wherever an exact hit exists. Where nothing matches
exactly the tolerant path still applies, so cross-tenant wording is untouched —
and there is a test for that, because trading one bug for another would be easy
here.

The discovery model caught this itself, mid-run: *"the extracted balance belongs
to a different row, so the locator is matching ambiguously."*

### Locators could not be parameterised

On my target the balance cell is "the Savings row, Current Balance column", and
*Savings* is chrome — a product name, identical for every member. Meridian Core
heads each share row with an id containing the member number. That is record
data wearing a landmark's clothes, and recorded literally it reads the right
cell for exactly one member.

Locators may now carry `{{param}}` references the way typed values always could,
templatised by the recorder and filled at resolve time rather than baked in.
Credentials are excluded from that rewrite deliberately: a locator needing a
password in it is describing something no reviewer should be looking at, and
quietly templating it would hide that rather than surface it.

### Credential names were hardcoded in two places

Adding `branch` broke replay and probing, which both named `operatorId` and
`operatorPassword` directly. The recording declared three injected inputs and
replay supplied two, so it failed the contract before touching the application.
Now one function turns a credential set into typed inputs. **Probing caught this
within a minute of the first capability existing.**

---

## 2. Capabilities recorded

| | steps | outcomes observed | risk | cost to record |
|---|---|---|---|---|
| `mc_member_balance` | 9 | 1 of 1 | reversible | $1.83 |
| `mc_update_member` | 13 | 3 of 3 | reversible | $3.42 |
| `mc_funds_transfer` | 16 | 4 of 4 | **irreversible** | $4.29 |
| `mc_open_share` | 14 | 3 of 3 | **irreversible** | $3.81 |
| `mc_place_hold` | 14 | 1 of 2 | **irreversible** | $3.50 |

Five of the seven functions, $16.86 to record, and **twelve of thirteen declared
outcomes backed by a real screen** rather than asserted.

`mc_update_member` is the one worth noticing. It writes — a member's contact
details change on the host — and it is still `mutate_reversible`, because a
contact detail can be written back. The axis is reversibility, not whether
anything changed; a system that gated every write would gate the ones that do
not need it and teach everyone to wave the gate through. Replay costs nothing and calls no model — verified by
running it with the API key removed from the environment.

`mc_funds_transfer` could not be recorded end to end, and that is the system
working. **The discovery agent is forbidden irreversible actions**, so it walks
the flow only as far as the confirmation screen. The final `post_transfer` step
is authored by hand and marked `mutate_irreversible`. The agent records what it
is permitted to do; a human decides what commits.

---

## 3. The API contract

```
GET  /api/capabilities              the callable catalog, typed
GET  /api/capabilities/:id          one tool schema plus its artifact
POST /api/capabilities/:id/invoke   invoke by name, structured result back
GET  /api/runs, /api/runs/:runId    what happened, with the evidence
```

The catalog is generated from the same artifact replay executes — a
hand-maintained tool schema beside an automation is a second source of truth,
and the two drift the moment either changes.

A result arrives as one of four shapes, and the fourth is the point:

```
success         outputs, typed
business_outcome a real answer that isn't success — MEMBER_NOT_FOUND
needs_human     the work stopped on purpose; a person must authorise it
failure         something is actually broken
```

`needs_human` covers both an explicit escalation and a policy refusal, because
to a caller they are the same fact and separating them would invite treating one
as retryable.

**The API is a front door, not a second path.** An invocation runs the same
replay under the same policy writing the same evidence. It does not accept
credentials — injected parameters are absent from the published schema, so a
caller cannot supply an operator password, see that one exists, or be talked
into revealing one. And it cannot authorise irreversible work: asking it to move
money returns `needs_human`, because the refusal happens in the driver.

The chatbot is a demo driver over that API rather than a second product. Asked
to move a dollar it answers *"it stopped at the confirmation screen because
posting is irreversible — you'll need to authorise it"*. Asked to move ninety-nine
thousand it answers that the balance is insufficient. Neither claims success.

---

## 4. Driving the UI, and its exceptional states

Every step keeps a **ranked ladder** of ways to find a control, and every run
records which rung it used. On Meridian Core one step consistently resolves
below where it was recorded, and the dashboard flags it: nothing has failed, but
that step is closer to failing than it was, and I would rather know now.

The declared outcomes were the model's guesses, and **probing proved every one
of them wrong.** It provokes each state against the live target and reads back
what the host actually says:

| the model declared | Meridian Core actually says |
|---|---|
| `"No members found"` | "No member records matched your search." |
| `"Insufficient funds"` | "Insufficient available balance in the source share." |
| `"account is on hold"` | "Source share is HOLD and cannot be debited." |
| `"Share not found"` | "Source and destination shares must differ." |

Corrected from what probing read, all four are now observed on real screens
rather than asserted. A fifth, `INVALID_AMOUNT`, was deleted: the host does
validate it, but `amount` is typed `money`, so the input contract rejects a
non-numeric value before the host sees it. Unreachable on any path this
capability can take, and worth removing rather than carrying as a claim nobody
can test.

Probing an irreversible capability at all is a rule this target reversed. It
used to refuse them outright, reasoning that provoking an outcome would commit
the transaction. A real transfer flow showed that to be over-cautious and
expensive — every outcome it declares fires at the *review* step, long before
anything posts — and refusing wholesale left five real conditions unverified on
the one capability where being sure matters most. What protects the money is the
action ceiling in the driver, not this function declining to look.

---

## 5. How the guarantees survive the new surface

- **Allowlist** follows the tenant's base URL, enforced in the driver on a path
  no prompt and no page content can address.
- **Irreversible work** is refused wherever it is invoked from. Unattended
  replay of the transfer runs fifteen of sixteen steps and stops:
  `POLICY_BLOCKED at post_transfer · IRREVERSIBLE_REQUIRES_HUMAN`. The money
  does not move, from the CLI, the API or the chatbot.
- **Two guards, answering different questions.** `mc_place_hold` run as
  `teller1` returns `business_outcome SUPERVISOR_REQUIRED` — the host's own
  entitlement model, reported as the real answer it is. Run as `super1` the host
  allows it, and thirteen of fourteen steps in *my* policy refuses the last one.
  Satisfying one guard does not satisfy the other.
- **The catalog is scoped to the institution being served.** An agent is offered
  only capabilities recorded against this vendor product. Without that it
  reached for one belonging to a different console entirely, failed, and
  recovered by trying another — it got there, but it spent a call learning
  something the catalog already knew.
- **Redaction** applies at every egress — logs, DOM snapshots, screenshots
  masked at capture, and any prompt. What is returned to the caller is not
  redacted, because a capability whose job is to return a balance cannot redact
  its own answer.
- **Evidence** is unchanged: every run keeps a log, its typed result, masked
  screenshots and DOM snapshots, and the dashboard reads exactly those.
- **Approval** still gates unattended replay, and `catalog approve` refuses a
  capability carrying an outcome that was probed and did not fire.

---

## 6. What I left out, and what is next

**Two of seven functions are unrecorded** — sign-off, and member inquiry by
surname. Sign-off is a single link and carries no contract worth recording;
inquiry by surname is the same flow as inquiry by number with one field
changed, and would be a sixth capability proving nothing the fifth did not.

**`mc_place_hold` has one outcome I could not verify.** `SUPERVISOR_REQUIRED`
turns on which operator the runtime signs on as, not on any argument a caller
supplies, and provoking it would mean varying an injected credential — which
probing refuses by design, because repeatedly failing sign-on against a real
operator account is an authentication test rather than a business one. So it is
declared, demonstrated by running the same capability under each operator, and
left honestly unprobed.

**Place Account Hold is the one I most regret cutting**, because it is the
supervisor-gated action and would have exercised the second half of the
escalation model: not just refusing, but handing control to a *different*
operator. The credential resolver already distinguishes a supervisor
(`resolveSupervisorCredentials`); nothing consumes it yet.

Also not done:

- **A capability's contract can be coarser than the task.** Asked to change only
  a phone number, the assistant stops and asks for the email and address too,
  because `mc_update_member` declares all three as required — the recorded flow
  types all three, since the host's form arrives pre-filled. It is right to ask
  rather than guess, and the contract is still blunter than it should be.
- **Injected faults are unexercised.** `?inject=maintenance` and friends are
  exactly the recoverable-versus-fatal distinction the core already reasons
  about, and I did not get to declaring recovery rules for them.
- **Re-probing on a schedule.** Observations carry an age and the system reports
  it, but nothing runs the re-check; that needs somewhere to run from and
  somewhere for the result to go, neither of which this repository should
  invent.

**What I would do first with more time** is not another capability. It is to
make locator parameterisation something the recorder gets right without review
— it currently templatises on exact value matches, which worked here because a
member number is distinctive, and would not on a value like `001`.

---

## The recording

`npm run record` drives the whole demo with Playwright and writes
`docs/demo-recording/meridian-core-demo.webm` — about seventy seconds: the
catalog, a balance that succeeds, an overdraw that comes back as a business
outcome, a transfer that stops at the irreversible step and says so, and the
evidence behind one of those runs.

Driven rather than screen-captured on purpose. Change the system, re-run it, and
the backup matches what the system now does; a capture taken once drifts from
the thing it stands in for, and drifts silently.

## Running it

```bash
npm install && npx playwright install chromium
cp .env.example .env          # ANTHROPIC_API_KEY, needed only to record

npm run serve -- --tenant meridian-core
#   dashboard  http://localhost:7400/
#   chatbot    http://localhost:7400/chat
```

Replaying needs no key:

```bash
npm run replay -- mc_member_balance --tenant meridian-core -i memberNumber=102777
npm run replay -- mc_funds_transfer --tenant meridian-core \
  -i memberNumber=102777 -i fromShare=102777-MMKT-4 -i toShare=102777-S0001 \
  -i amount=1.00 -i memo="demo"        # → stops at post_transfer
```

Recording one does:

```bash
npm run discover -- --tenant meridian-core --capability-id mc_open_share \
  --max-steps 22 --goal "…"
```
