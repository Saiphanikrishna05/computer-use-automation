#!/usr/bin/env bash
#
# A guided walkthrough of the whole system, in the order that tells the story.
#
# Pauses between sections so you can read the output and watch the browser.
# Run with SKIP_LLM=1 to skip the two sections that need an API key.
#
#   ./scripts/demo.sh
#
# Needs the target app running in another terminal:  npm run app

set -uo pipefail
cd "$(dirname "$0")/.."

CAP=lookup_member_savings_balance
TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"
SKIP_LLM="${SKIP_LLM:-0}"

bold()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }
rule()  { printf '\033[2m%s\033[0m\n' "────────────────────────────────────────────────────────────────────"; }
# Pauses only when someone is actually watching. Piped or redirected, the
# script runs straight through instead of blocking on a read that will never
# be answered.
pause() {
  [ -t 0 ] || return 0
  printf '\n\033[2m   [Enter] to continue\033[0m'
  read -r _
}

curl -s -o /dev/null "$TARGET/" 2>/dev/null || {
  bold "The target application is not running."
  dim  "Open another terminal and run:  npm run app"
  exit 1
}

clear
rule
bold "  Computer-use automation, guided demo"
rule
dim "  An LLM works out how to do something inside a UI with no API."
dim "  The run becomes a typed capability. That capability then replays"
dim "  deterministically, and an AI agent calls it by name."
echo
dim "  A browser window will open during the live sections. Watch it."
pause

# ---------------------------------------------------------------------------
bold "1 · The application we have to automate"
rule
dim "  Open this in your browser:   $TARGET"
dim "  Sign on with                 teller01 / demo-password"
echo
dim "  Then View Source. It is a real <frameset>. Table-based layout, <font>"
dim "  tags, no test ids, no ARIA, and every element id is regenerated on each"
dim "  render, so id selectors are worthless. The field labels are just the"
dim "  adjacent table cell, with no markup association at all."
echo
dim "  This is the shape of the software the brief is about."
pause

# ---------------------------------------------------------------------------
if [ "$SKIP_LLM" != "1" ] && grep -q "ANTHROPIC_API_KEY=sk-ant-a" .env 2>/dev/null; then
  bold "2 · Discovery, an LLM drives it for the first time"
  rule
  dim "  A browser opens. Watch it sign on, search, and read the balance."
  dim "  Note the model is never shown a selector; it points at elements it can"
  dim "  see, and the durable locator is built from what perception measured."
  pause
  npx tsx src/cli/index.ts discover \
    --goal "Look up member 100004 and read their current savings balance" \
    --capability-id demo_lookup_balance 2>&1 | tail -28
  pause

  bold "3 · What it recorded"
  rule
  dim "  Note: it is a DRAFT. A single run walks one path, so the outcomes it"
  dim "  declares for paths it never took are hypotheses. Validation already"
  dim "  deleted any that were checkably wrong."
  echo
  npx tsx src/cli/index.ts catalog show demo_lookup_balance 2>/dev/null \
    | python3 -c "
import json,sys
a=json.load(sys.stdin)
print('  steps:')
for s in a['steps']: print(f\"    {s['id']:16} {s['intent'][:60]}\")
print('\n  the savings-balance locator it recorded:')
for o in a['outputs']:
    if 'alance' in o['name']:
        for c in o['extract']['target']['candidates']: print('   ', json.dumps(c))
"
  pause
fi

# ---------------------------------------------------------------------------
bold "4 · Deterministic replay, no model in the loop"
rule
dim "  Same flow, no API key involved. Watch how much faster it is."
pause
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --no-operator 2>/dev/null | tail -14
pause

bold "   ...and it generalises to a different member"
rule
npx tsx src/cli/index.ts replay $CAP -i memberId=100004 --headless --no-operator 2>/dev/null | grep -E "^ +(memberName|savingsBalance)|^success"
dim "  Same artifact, different record. The locators are durable, not"
dim "  value-derived; that took two bugs to get right (REPORT §6)."
pause

# ---------------------------------------------------------------------------
bold "5 · A real answer that is not success"
rule
dim "  This is the distinction the brief calls the commonest design mistake."
echo
npx tsx src/cli/index.ts replay $CAP -i memberId=999999 --headless --no-operator 2>/dev/null | tail -9
dim "  business_outcome, not failure. The caller can act on it. Exit code 2."
pause

# ---------------------------------------------------------------------------
bold "6 · Things genuinely going wrong"
rule
dim "  The application can be told to fail on demand, so this is reproducible."
echo
dim "  → an application error page:"
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --fault app_error --fault-scope search --headless --no-operator 2>/dev/null | grep -E "error:|expected|observed" | cut -c1-100
echo
dim "  → the host dropping the session:"
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --fault session_expired --fault-scope search --headless --no-operator 2>/dev/null | grep -E "error:" | cut -c1-100
echo
dim "  → a bad input, rejected before the application is touched at all:"
npx tsx src/cli/index.ts replay $CAP -i memberId=12345 --headless --no-operator 2>/dev/null | grep -E "error:|observed" | cut -c1-100
pause

bold "7 · Something it is allowed to fix by itself"
rule
dim "  Member 100003 raises a native confirm() dialog mid-run. The artifact"
dim "  declares a recovery rule for it, so the run continues."
echo
npx tsx src/cli/index.ts replay $CAP -i memberId=100003 --headless --no-operator 2>/dev/null | grep -E "recovery_attempt|^success"
pause

# ---------------------------------------------------------------------------
bold "8 · Handing control to a human"
rule
dim "  open_sub_account ends in a step the artifact declares irreversible."
dim "  Policy refuses to perform it and escalates. This script plays the"
dim "  operator: it takes the same live session, submits by hand, and hands"
dim "  control back marked 'I did this myself', so it is not submitted twice."
pause
./scripts/demo-escalation.sh 2>&1 | grep -E "control_transfer|human_action|^success" | cut -c1-96
dim "  Every operator action is in the evidence bundle. A handoff is not"
dim "  allowed to be a hole in the audit trail."
pause

# ---------------------------------------------------------------------------
bold "9 · A second institution running the same vendor product"
rule
dim "  Different frame names, different button wording, an extra login notice."
dim "  Same base artifact plus a small overlay, not a re-recording."
echo
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --tenant cascade-cu --headless --no-operator 2>/dev/null \
  | grep -E "^success"
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --tenant cascade-cu --headless --no-operator 2>&1 \
  | grep -E "overlay|recovery_attempt" | cut -c1-96
pause

# ---------------------------------------------------------------------------
if [ "$SKIP_LLM" != "1" ] && grep -q "ANTHROPIC_API_KEY=sk-ant-a" .env 2>/dev/null; then
  bold "10 · The loop closed, an AI agent invoking the capability"
  rule
  dim "  The agent gets the catalog as tools. It decides what to do; this"
  dim "  system does how. Note how the not-found case comes back."
  pause
  npx tsx src/cli/index.ts agent-demo \
    "I'm a teller at the branch. Please look up the savings balance for member 100001, and also check member 999999." \
    --headless 2>&1 | grep -v "^  \[" | tail -22
  pause
fi

# ---------------------------------------------------------------------------
bold "Where the evidence lives"
rule
ls -1 evidence | sed 's/^/  /'
echo
dim "  Every bundle: structured log, screenshots with sensitive regions masked,"
dim "  DOM snapshots on failure, and the typed result."
echo
rule
bold "  Done."
dim "  Design write-up: REPORT.md    ·    How to run it: README.md"
rule
