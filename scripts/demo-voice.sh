#!/usr/bin/env bash
#
# The capability gap, closing.
#
# Three acts, in the order that makes the argument:
#
#   1. The assistant is asked for something no capability covers, and says so.
#      This is a real refusal: the capability is genuinely moved out of the
#      catalog first, and put back afterwards. Nothing is scripted to fail.
#
#   2. That capability is recorded. By default this replays a committed run at
#      the speed it actually happened, because discovery needs a network, a
#      model and about forty seconds, and a demo that depends on all three in
#      a conference room is a demo that fails in a conference room. Pass
#      --live to record it for real instead.
#
#   3. The same question is asked again, and answered.
#
# The number to watch in act three is the split, not the total. Understanding
# is a model and always will be; every voice product already pays it. The step
# this project replaced is "doing", and it is the one that would otherwise be
# the forty seconds from act two, on every single call.
#
# Usage:  ./scripts/demo-voice.sh [--live]
# Needs:  the target app       (npm run app)
#         the voice front door (npm run voice -- --route llm)

set -uo pipefail
cd "$(dirname "$0")/.."

VOICE="http://localhost:${CUA_VOICE_PORT:-7319}"
TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"
CAP=lookup_member_contact_details
ARTIFACT="artifacts/${CAP}.v1.json"
PARKED=".${CAP}.v1.json.parked"
RECORDING=evidence/discovery-capability-gap-closed
QUESTION="what is the phone number and email for member 100001"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
rule() { printf '\033[2m%s\033[0m\n' "────────────────────────────────────────────────────────────────────────"; }
pause() { printf '\033[2m  [enter]\033[0m'; read -r _; }

need() {
  curl -sf -o /dev/null "$1" || { printf '\nNot reachable: %s\n%s\n\n' "$1" "$2"; exit 1; }
}
need "$TARGET/" "Start the application first:  npm run app"
need "$VOICE/api/catalog" "Start the voice front door:   npm run voice -- --route llm"

# The capability is restored however this script exits, including Ctrl-C.
# Leaving a repository in a state the demo invented would be worse than the
# demo not running.
restore() { [[ -f "$PARKED" ]] && mv "$PARKED" "$ARTIFACT"; }
trap restore EXIT INT TERM

ask() {
  curl -s -X POST "$VOICE/api/ask" -H 'content-type: application/json' \
    --data "$(printf '{"utterance":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print()
    print("  error   " + str(d["error"]))
    sys.exit(0)
t = d["timing"]
print()
print("  asked   " + d["heard"])
print("  said    " + d["spoken"])
print()
if d["invocations"]:
    for i in d["invocations"]:
        print("  ran     " + i["capability"] + "(" + json.dumps(i["inputs"]) + ") -> " + i["status"])
        if i.get("outputs"):
            print("          " + json.dumps(i["outputs"]))
        print("          " + str(i["durationMs"]) + " ms, no model in this path, evidence " + i["evidencePath"])
else:
    print("  ran     nothing. No capability covered it.")
print()
print("  time    understanding " + str(t["understandingMs"]) + " ms  +  doing "
      + str(t["doingMs"]) + " ms  =  " + str(t["totalMs"]) + " ms")
'
}

# --- Act 1 -----------------------------------------------------------------
clear
rule; bold "  Act 1 — a question the assistant cannot answer"; rule
dim  "  Moving ${CAP} out of the catalog, so the refusal is real."
mv "$ARTIFACT" "$PARKED"
ask "$QUESTION"
echo
dim  "  It did not guess, and it did not pretend. There was no capability."
pause

# --- Act 2 -----------------------------------------------------------------
clear
rule; bold "  Act 2 — recording the capability"; rule
if [[ $LIVE -eq 1 ]]; then
  dim "  Live. A model drives the real screen. About forty seconds."
  echo
  restore_needed=1
  npm run discover -- --goal "Look up member 100001 and read their contact details: the email address and the phone number on the member record" \
    --capability-id "$CAP" --headless
  rm -f "$PARKED"
else
  dim "  Replaying the committed run of exactly this, at the speed it happened."
  echo
  npx tsx scripts/replay-recording.ts "$RECORDING"
  restore
fi
echo
dim  "  This happens once, in advance, by an operations person."
dim  "  No caller ever waits for it."
pause

# --- Act 3 -----------------------------------------------------------------
clear
rule; bold "  Act 3 — the same question"; rule
ask "$QUESTION"
echo
rule
dim  "  Understanding is a model, and every voice product already pays for it."
dim  "  Doing is a recorded capability: no model, no API call, ~1.5 s, every time."
dim  "  Put a model in that step instead and it is act two, on every call."
rule
echo
