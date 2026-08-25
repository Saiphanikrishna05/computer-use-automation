# Capability audit pack — `open_sub_account` v1

**Open a sub-account for an existing member**

Generated 2026-08-25 from the capability artifact and the committed evidence in `evidence/`. Nothing in this document is written by hand; every claim below is read out of the artifact or a recorded run, and every citation is a path you can open.

## 1. What this automation does

Signs on to the servicing console, opens a member's record, completes the new sub-account request form and submits it to the host. This CHANGES STATE: submitting the request opens a live account and cannot be reversed from the terminal. The final step is classified irreversible and will not run unattended.

It operates **meridian servicing-console** (1.x) through its user interface, the way a member services representative would. The application exposes no API for this task; driving the screen is the only route in.

| | |
|---|---|
| Steps | 10 |
| Highest risk class | `mutate_irreversible` |
| Approval state | **approved** |
| Declared outcomes | 3 |
| Declared recovery rules | 1 |

## 2. What it is permitted to do

Every step carries a risk classification, and the axis is **reversibility, not danger**. "Risky" is a judgement; "can this be undone" is a fact.

| Step | Intent | Risk |
|---|---|---|
| `enter_operator_id` | Type the operator user ID into the sign-on form | `mutate_reversible` |
| `enter_operator_password` | Type the operator password into the sign-on form | `mutate_reversible` |
| `submit_signon` | Submit the sign-on form | `mutate_reversible` |
| `await_search_screen` | Wait for the member search screen | `read` |
| `enter_member_id` | Type the member number into the Member Search panel | `mutate_reversible` |
| `submit_search` | Run the member search | `mutate_reversible` |
| `open_form` | Open the new sub-account request form for this member | `mutate_reversible` |
| `choose_product` | Choose the product type for the new sub-account | `mutate_reversible` |
| `enter_deposit` | Enter the opening deposit amount | `mutate_reversible` |
| `submit_request` | Submit the sub-account request to the host. This opens a live account and cannot be undone. | `mutate_irreversible` |

**1 step(s) are irreversible** (`submit_request`). These are refused under unattended replay and raise an intervention for a named human instead. The refusal is enforced in the surface driver, on a code path no prompt and no page content can address.

## 3. Data it handles

| Field | Direction | Classification | Notes |
|---|---|---|---|
| `memberId` | in | not sensitive | Supplied by the caller, validated against the declared contract before the application is touched. |
| `productType` | in | not sensitive | Supplied by the caller, validated against the declared contract before the application is touched. |
| `initialDeposit` | in | financial data | Supplied by the caller, validated against the declared contract before the application is touched. |
| `operatorId` | in | personal data | Supplied by the runtime credential store. Never published to a calling agent, never written to the artifact. |
| `operatorPassword` | in | credential | Supplied by the runtime credential store. Never published to a calling agent, never written to the artifact. |
| `reference` | out | not sensitive | Returned to the caller. |

**Redaction boundary.** Everything persisted or sent to a model is redacted: run logs, DOM snapshots, screenshots (masked at capture time, so an unmasked image never exists on disk), and any prompt. The typed return value handed to the caller is not, because a capability whose job is to return a balance cannot redact the balance out of its own answer. Those are different boundaries and the distinction is deliberate.

## 4. Who approved it, and on what basis

Approved by **seed** on 2026-08-13.

> Approved so the escalation path can be demonstrated. Note that approval does NOT authorise the irreversible step — that still requires a human at run time.

Every human change to this capability, in order:

- **2026-08-13**, engineer — Hand-authored rather than discovered, because the discovery agent is forbidden from performing irreversible actions and therefore cannot walk this flow to its end. That constraint is deliberate; this artifact exists to exercise the escalation path it creates.

## 5. What is claimed, and what backs it

A capability declares the non-success answers a caller must be able to distinguish. Those declarations start as the recording model's hypotheses about paths it never walked, and are only worth anything once something has gone and provoked them.

| Outcome | Detected by | Evidence | Last verified |
|---|---|---|---|
| `MEMBER_NOT_FOUND` | the text "No member record found" appearing on screen | unverified hypothesis | never |
| `PERMISSION_DENIED` | the text "Entitlement check failed" appearing on screen | unverified hypothesis | never |
| `REQUEST_REJECTED` | the text "Product type is required" appearing on screen | unverified hypothesis | never |

Freshness threshold in force: **90 days**. An observation answers a question about the application on the day it was asked; it is not evidence forever.

## 6. Recorded operating history

1 committed run(s), each with a full log, the typed result, screenshots masked at capture, and DOM snapshots on failure.

| Run | Institution | Result | Duration | Degraded locators | Bundle |
|---|---|---|---|---|---|
| 2026-08-16 | northpoint-fcu | success | 12029 ms | 0 | `evidence/replay-escalation-irreversible` |

Of these, 1 succeeded, 0 returned a business outcome, and 0 failed. **A business outcome is not a failure**: "no such member" is a real answer the caller acts on, and the result type keeps the two apart structurally so no caller can confuse them.

## 7. Open questions

What this capability cannot currently vouch for, worst first. **`material` means it should not be approved, or relied on further, until addressed.**

| | Subject | Finding | Why it matters |
|---|---|---|---|
| `material` | Irreversible action | This capability contains a step classified as irreversible. | It will not run unattended: policy refuses the step and raises an intervention for a named human, who either performs it themselves or authorises it. That refusal is enforced in the driver, not requested in a prompt. |
| `notable` | MEMBER_NOT_FOUND | Declared by the recording model from a run that never took this path, and never provoked since. No probe is declared, so it cannot currently be tested automatically. | Accepted on the model's word. If the wording is wrong, this outcome silently never fires. |
| `notable` | PERMISSION_DENIED | Declared by the recording model from a run that never took this path, and never provoked since. No probe is declared, so it cannot currently be tested automatically. | Accepted on the model's word. If the wording is wrong, this outcome silently never fires. |
| `notable` | REQUEST_REJECTED | Declared by the recording model from a run that never took this path, and never provoked since. No probe is declared, so it cannot currently be tested automatically. | Accepted on the model's word. If the wording is wrong, this outcome silently never fires. |

## 8. How this capability came to exist

Discovered 2026-08-13 by `hand-authored reference`, from the goal: *"Open a new sub-account for a member and reach the confirmation screen"*.

A model worked out how to do this **once**, by driving the real application. That run was recorded as this typed, reviewable artifact. Everything since has been deterministic code executing that recording. The model is not consulted at run time, cannot be prompted at run time, and cannot change what this capability does.

