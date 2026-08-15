#!/usr/bin/env bash
#
# Regenerates every bundle under evidence/.
#
# Each scenario is one run of the real system against the real application, so
# the committed evidence is reproducible rather than curated by hand. The only
# bundle this does not regenerate is the discovery run, which costs money and
# is deliberately preserved exactly as it happened.
#
# Usage:  ./scripts/make-evidence.sh
# Needs:  the target app running (npm run app)

set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"
TENANT_B="http://localhost:${CUA_TENANT_B_PORT:-4174}"
CAP="lookup_member_savings_balance"

curl -s -o /dev/null "$TARGET/" || { echo "Target app not running. Start it with: npm run app"; exit 1; }

run() {
  local label="$1"; shift
  echo "── $label ──"
  curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
  curl -s -X POST "$TENANT_B/_admin/reset" -o /dev/null

  local before after bundle
  before=$(ls -1 runs 2>/dev/null | wc -l)
  npx tsx src/cli/index.ts replay "$@" --headless --no-operator >/dev/null 2>&1
  after=$(ls -1 runs | wc -l)
  [ "$after" -le "$before" ] && { echo "   no new run bundle produced"; return 1; }

  bundle=$(ls -1dt runs/*/ | head -1)
  rm -rf "evidence/$label"
  cp -R "$bundle" "evidence/$label"
  echo "   → evidence/$label  ($(grep -c . "evidence/$label/log.jsonl") log events)"
}

mkdir -p evidence

run replay-success                            "$CAP" -i memberId=100001
run replay-outcome-member-not-found           "$CAP" -i memberId=999999
run replay-outcome-permission-denied          "$CAP" -i memberId=100002
run replay-failure-app-error                  "$CAP" -i memberId=100001 --fault app_error --fault-scope search
run replay-failure-session-expired            "$CAP" -i memberId=100001 --fault session_expired --fault-scope search
run replay-recovery-unexpected-dialog         "$CAP" -i memberId=100003
run replay-failure-input-validation           "$CAP" -i memberId=12345
run replay-tenant-b-cascade                   "$CAP" -i memberId=100001 --tenant cascade-cu

echo "── escalation (human-in-the-loop handoff) ──"
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
./scripts/demo-escalation.sh >/dev/null 2>&1
ESC=$(ls -1dt runs/*/ | head -1)
rm -rf evidence/replay-escalation-irreversible
cp -R "$ESC" evidence/replay-escalation-irreversible
# The console screenshot is captured mid-handoff by demo-escalation.sh; it is
# the only visual record that the human-facing surface exists.
[ -f /tmp/cua-operator-console.png ] && cp /tmp/cua-operator-console.png evidence/replay-escalation-irreversible/screenshots/operator-console.png
echo "   → evidence/replay-escalation-irreversible"

echo "── ui drift resilience ──"
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
npx tsx src/cli/index.ts replay "$CAP" -i memberId=100001 --headless --no-operator >/dev/null 2>&1
BEFORE=$(ls -1dt runs/*/ | head -1)
rm -rf evidence/replay-before-ui-drift && cp -R "$BEFORE" evidence/replay-before-ui-drift
curl -s -X POST -H 'content-type: application/json' -d '{"enabled":true}' "$TARGET/_admin/drift" -o /dev/null
npx tsx src/cli/index.ts replay "$CAP" -i memberId=100001 --headless --no-operator >/dev/null 2>&1
AFTER=$(ls -1dt runs/*/ | head -1)
rm -rf evidence/replay-after-ui-drift && cp -R "$AFTER" evidence/replay-after-ui-drift
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
echo "   → evidence/replay-before-ui-drift and evidence/replay-after-ui-drift"

# Playwright videos are large and add nothing a screenshot does not.
find evidence -type d -name video -exec rm -rf {} + 2>/dev/null

echo
echo "Evidence bundles:"
du -sh evidence/* 2>/dev/null | sort -k2
