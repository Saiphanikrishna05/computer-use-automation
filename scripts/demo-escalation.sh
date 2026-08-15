#!/usr/bin/env bash
#
# Human-in-the-loop handoff, end to end and unattended.
#
# Replaying `open_sub_account` reaches a step the artifact declares
# irreversible. Policy refuses to perform it, replay raises an intervention and
# releases the control lease, and this script then plays the operator: it takes
# control of the *same live session*, performs the submit itself, and hands
# control back marked "I performed this step myself" — so the automation
# continues from the next step rather than submitting a second time.
#
# Scripted rather than clicked so the whole thing is reproducible by a reviewer
# with no browser interaction. A person would do exactly this through the
# console UI at http://localhost:7317/.
#
# Usage:  ./scripts/demo-escalation.sh
# Needs:  the target app running (npm run app)

set -uo pipefail
cd "$(dirname "$0")/.."

CONSOLE="http://localhost:${CUA_OPERATOR_PORT:-7317}"
TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"

echo "── resetting the target application ──"
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null || {
  echo "The target app is not running. Start it with: npm run app"; exit 1;
}

echo "── starting replay (it will stop at the irreversible step) ──"
npx tsx src/cli/index.ts replay open_sub_account \
  -i memberId=100001 -i productType=Savings -i initialDeposit=25.00 \
  --headless > /tmp/cua-escalation-run.log 2>&1 &
REPLAY_PID=$!

echo "── waiting for an intervention to appear on the operator console ──"
INTERVENTION=""
for _ in $(seq 1 90); do
  INTERVENTION=$(curl -s "$CONSOLE/" 2>/dev/null \
    | grep -o 'intervention/int-[0-9a-f]*/take' | head -1 | cut -d/ -f2)
  [ -n "$INTERVENTION" ] && break
  kill -0 "$REPLAY_PID" 2>/dev/null || { echo "replay exited early:"; tail -20 /tmp/cua-escalation-run.log; exit 1; }
  sleep 1
done

if [ -z "$INTERVENTION" ]; then
  echo "No intervention was raised within 90s."; tail -30 /tmp/cua-escalation-run.log; exit 1
fi
echo "   intervention: $INTERVENTION"

echo "── operator takes control of the live session ──"
curl -s -X POST "$CONSOLE/intervention/$INTERVENTION/take" \
  -H 'content-type: application/json' -d '{"operatorId":"supervisor-04"}' -o /dev/null

echo "── capturing the operator console for the evidence bundle ──"
npx tsx scripts/capture-console.ts "$CONSOLE/" /tmp/cua-operator-console.png || true

echo "── operator performs the irreversible submit themselves ──"
# Focus is still in the deposit field where the automation left it, so Enter
# submits the form. This lands on the same page, in the same session.
curl -s -X POST "$CONSOLE/intervention/$INTERVENTION/type" \
  -H 'content-type: application/json' -d '{"text":"","thenPress":"Enter"}'
echo

echo "── operator hands control back, marking the step as done by hand ──"
curl -s -X POST "$CONSOLE/intervention/$INTERVENTION/resume" \
  -H 'content-type: application/json' \
  -d '{"operatorId":"supervisor-04","mode":"performed","note":"Authorised and submitted manually under branch supervisor approval."}' \
  -o /dev/null

wait "$REPLAY_PID"
STATUS=$?

echo
echo "════════════════════════ replay output ════════════════════════"
tail -32 /tmp/cua-escalation-run.log
echo "═══════════════════════════════════════════════════════════════"
exit "$STATUS"
