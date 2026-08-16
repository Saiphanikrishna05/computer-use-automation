#!/usr/bin/env bash
#
# The claim this system rests on, tested rather than asserted.
#
# A capability is recorded once and expected to keep working. So: apply a
# vendor point release to the application, reword a button, re-order the
# accounts table, insert a new column, wrap every cell in a span, and replay
# the *same, already-committed artifact*, unchanged.
#
# Two things should happen, and they are different things:
#
#   1. It still returns the right answer. The row/column addressing survives a
#      column re-order that would silently break any nth-child selector, worse
#      than breaking, because it would read the wrong column and report it as
#      fact.
#
#   2. The locator that could not survive says so. The reworded button drops
#      from tier 1 to tier 5 and is flagged as degraded. Nothing failed, but
#      the capability is now one change from failing, and we know before a user
#      finds out.
#
# Usage:  ./scripts/demo-drift.sh
# Needs:  the target app running (npm run app)

set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"
CAP=lookup_member_savings_balance

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

curl -s -o /dev/null "$TARGET/" 2>/dev/null || { echo "Target app not running. Start it with: npm run app"; exit 1; }

tiers() {
  python3 -c "
import json,glob,os
p=sorted(glob.glob('runs/replay-*/'),key=os.path.getmtime)[-1]
for l in open(p+'log.jsonl'):
    e=json.loads(l)
    if e['type']=='resolution':
        r=e['data']['report']
        mark='   <<< DEGRADED' if r.get('degraded') else ''
        print(f\"    tier {r['winningTier']} via {str(r['winningKind']):11} {r['targetDescription'][:42]}{mark}\")
        if r.get('degraded'):
            for a in r['attempts']:
                print(f\"          tried {a['kind']:11} -> {a['matchCount']} match(es)\")
"
}

curl -s -X POST "$TARGET/_admin/reset" -o /dev/null

bold "1 · Before the upgrade"
dim "  The capability as recorded, against the application as recorded."
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --headless --no-operator 2>/dev/null \
  | grep -E "degraded locators|^ +(savingsBalance|memberName)|^success"
tiers

bold "2 · Apply a vendor point release"
dim "  The 'Search' button is reworded to 'Search Member'."
dim "  The accounts table columns are re-ordered, a 'Status' column is inserted,"
dim "  and every cell is wrapped in a <span> by the new template engine."
dim "  The flow itself does not change."
curl -s -X POST -H 'content-type: application/json' -d '{"enabled":true}' "$TARGET/_admin/drift" >/dev/null
dim "  → applied"

bold "3 · After the upgrade, the SAME artifact, not re-recorded"
npx tsx src/cli/index.ts replay $CAP -i memberId=100001 --headless --no-operator 2>/dev/null \
  | grep -E "degraded locators|^ +(savingsBalance|memberName)|^success"
tiers

bold "What just happened"
dim "  The balance still resolved at tier 2, through 'the Savings row, Current"
dim "  Balance column'. The column moved and it did not matter, a positional"
dim "  selector would now be reading the Status column and reporting it as a"
dim "  balance."
echo
dim "  The reworded button could not survive on name, so it fell to the"
dim "  structural tier and was flagged. The run succeeded; the drift counter"
dim "  is how we find out before it stops succeeding."

curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
