# Capability audit pack — `lookup_member_savings_balance` v1

**Look up a member's savings balance**

Generated 2026-08-25 from the capability artifact and the committed evidence in `evidence/`. Nothing in this document is written by hand; every claim below is read out of the artifact or a recorded run, and every citation is a path you can open.

## 1. What this automation does

Signs on to the Northpoint FCU Meridian Core Servicing Console, searches the Member Search panel by Member ID, and returns the member's name and the Current Balance of their Savings account from the Accounts table on the Member Detail screen. Read-only: it performs no transactions and changes no data.

It operates **meridian servicing-console** (1.x) through its user interface, the way a member services representative would. The application exposes no API for this task; driving the screen is the only route in.

| | |
|---|---|
| Steps | 5 |
| Highest risk class | `mutate_reversible` |
| Approval state | **approved** |
| Declared outcomes | 4 |
| Declared recovery rules | 1 |

## 2. What it is permitted to do

Every step carries a risk classification, and the axis is **reversibility, not danger**. "Risky" is a judgement; "can this be undone" is a fact.

| Step | Intent | Risk |
|---|---|---|
| `type_1` | Enter the operator ID in the Operator Sign-On panel | `mutate_reversible` |
| `type_2` | Enter the operator password in the Operator Sign-On panel | `mutate_reversible` |
| `click_3` | Submit the operator sign-on form to access the servicing console | `mutate_reversible` |
| `type_4` | Type the member number into the Member ID field of the Member Search panel | `mutate_reversible` |
| `click_5` | Run the member search for the entered member ID | `mutate_reversible` |

No step in this capability is irreversible. It reads and it fills in forms; it commits nothing.

## 3. Data it handles

| Field | Direction | Classification | Notes |
|---|---|---|---|
| `operatorId` | in | personal data | Supplied by the runtime credential store. Never published to a calling agent, never written to the artifact. |
| `operatorPassword` | in | credential | Supplied by the runtime credential store. Never published to a calling agent, never written to the artifact. |
| `memberId` | in | not sensitive | Supplied by the caller, validated against the declared contract before the application is touched. |
| `savingsBalance` | out | financial data | Returned to the caller. |
| `memberName` | out | personal data | Returned to the caller. |

**Redaction boundary.** Everything persisted or sent to a model is redacted: run logs, DOM snapshots, screenshots (masked at capture time, so an unmasked image never exists on disk), and any prompt. The typed return value handed to the caller is not, because a capability whose job is to return a balance cannot redact the balance out of its own answer. Those are different boundaries and the distinction is deliberate.

## 4. Who approved it, and on what basis

Approved by **sai** on 2026-08-15.

> Outcomes confirmed against the live console.

Every human change to this capability, in order:

- **2026-08-15**, sai — Draft review before approval. MEMBER_NOT_FOUND: detection text corrected from "No member found" to the exact on-screen wording. | PERMISSION_DENIED: added — the run never met a restricted member, the gap a single happy-path run always leaves. | Declared APP_ERROR and SESSION_EXPIRED hard-failure rules; a successful run cannot observe either. | Removed the "memberId" output: it echoes the caller-supplied input.
- **2026-08-25**, reviewer — Added probe declarations so the declared outcomes can be verified by provoking them rather than trusted on the model’s word.

## 5. What is claimed, and what backs it

A capability declares the non-success answers a caller must be able to distinguish. Those declarations start as the recording model's hypotheses about paths it never walked, and are only worth anything once something has gone and provoked them.

| Outcome | Detected by | Evidence | Last verified |
|---|---|---|---|
| `MEMBER_NOT_FOUND` | the text "No member record found" appearing on screen | **observed** (`probe-20260825T081132-01`) | today |
| `SIGN_ON_FAILED` | the text "Invalid credentials" appearing on screen | unverified hypothesis | never |
| `NO_SAVINGS_ACCOUNT` | the text "No accounts on file" appearing on screen | unverified hypothesis | never |
| `PERMISSION_DENIED` | the text "Entitlement check failed" appearing on screen | **observed** (`probe-20260825T081132-01`) | today |

Freshness threshold in force: **90 days**. An observation answers a question about the application on the day it was asked; it is not evidence forever.

## 6. Recorded operating history

10 committed run(s), each with a full log, the typed result, screenshots masked at capture, and DOM snapshots on failure.

| Run | Institution | Result | Duration | Degraded locators | Bundle |
|---|---|---|---|---|---|
| 2026-08-16 | northpoint-fcu | success | 1597 ms | 0 | `evidence/replay-success` |
| 2026-08-16 | northpoint-fcu | business outcome `MEMBER_NOT_FOUND` | 1357 ms | 0 | `evidence/replay-outcome-member-not-found` |
| 2026-08-16 | northpoint-fcu | business outcome `PERMISSION_DENIED` | 1342 ms | 0 | `evidence/replay-outcome-permission-denied` |
| 2026-08-16 | northpoint-fcu | failure `APP_ERROR` | 1330 ms | 0 | `evidence/replay-failure-app-error` |
| 2026-08-16 | northpoint-fcu | failure `SESSION_EXPIRED` | 1351 ms | 0 | `evidence/replay-failure-session-expired` |
| 2026-08-16 | northpoint-fcu | failure `INPUT_VALIDATION_FAILED` | 2 ms | 0 | `evidence/replay-failure-input-validation` |
| 2026-08-16 | cascade-cu | success | 2673 ms | 0 | `evidence/replay-tenant-b-cascade` |
| 2026-08-16 | northpoint-fcu | success | 1595 ms | 0 | `evidence/replay-before-ui-drift` |
| 2026-08-16 | northpoint-fcu | success | 1413 ms | 1 | `evidence/replay-after-ui-drift` |
| 2026-08-25 | northpoint-fcu | success | 1499 ms | 0 | `evidence/replay-recovery-unexpected-dialog` |

Of these, 5 succeeded, 2 returned a business outcome, and 3 failed. **A business outcome is not a failure**: "no such member" is a real answer the caller acts on, and the result type keeps the two apart structurally so no caller can confuse them.

## 7. Open questions

What this capability cannot currently vouch for, worst first. **`material` means it should not be approved, or relied on further, until addressed.**

| | Subject | Finding | Why it matters |
|---|---|---|---|
| `notable` | SIGN_ON_FAILED | Declared by the recording model from a run that never took this path, and never provoked since. | Accepted on the model's word. If the wording is wrong, this outcome silently never fires. |
| `notable` | NO_SAVINGS_ACCOUNT | Declared by the recording model from a run that never took this path, and never provoked since. No probe is declared, so it cannot currently be tested automatically. | Accepted on the model's word. If the wording is wrong, this outcome silently never fires. |
| `notable` | Locator degradation | click_5 resolved through a weaker locator than recorded in at least one run. | The step still worked. A rising count is the early warning that the application has moved and this capability is approaching the point where it will not. |

## 8. How this capability came to exist

Discovered 2026-08-15 by `claude-opus-5`, from the goal: *"Look up member 100001 and read their current savings balance"*.

A model worked out how to do this **once**, by driving the real application. That run was recorded as this typed, reviewable artifact. Everything since has been deterministic code executing that recording. The model is not consulted at run time, cannot be prompted at run time, and cannot change what this capability does.

Discovery evidence: `runs/discovery-20260815T011002-01`

