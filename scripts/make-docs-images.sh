#!/usr/bin/env bash
#
# Regenerates every image the README commits, `npm run docs:images`.
#
# These are screenshots of running software, so they go stale the moment the
# software changes, and a stale screenshot is a documented lie that nobody
# notices. Making them reproducible in one command means "did the UI change?"
# has a mechanical answer instead of a remembered one.
#
# Needs the target app running (npm run app). No API key required.

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="http://localhost:${CUA_TARGET_PORT:-4173}"
CONSOLE_PORT="${CUA_CATALOG_PORT:-7318}"

curl -s -o /dev/null "$TARGET/" || { echo "Target app not running. Start it with: npm run app"; exit 1; }
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null

echo "── the application being automated ──"
cat > .docs-shot.tmp.ts <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1180, height: 760 } });
await p.goto(process.env.TARGET!);
await p.fill('input[name=username]', 'teller01');
await p.fill('input[name=password]', 'demo-password');
await p.click('input[type=submit]');
await p.waitForLoadState('networkidle');
const cf = p.frames().find((f) => f.name() === 'contentFrame')!;
await cf.fill('input[name=memberId]', '100001');
await cf.click('input[name=go]');
await p.waitForTimeout(1200);
await p.screenshot({ path: 'docs/target-app-member-detail.png' });
await b.close();
EOF
TARGET="$TARGET" npx tsx .docs-shot.tmp.ts
echo "   → docs/target-app-member-detail.png"

echo "── the capability console ──"
npx tsx src/cli/index.ts console --port "$CONSOLE_PORT" >/tmp/cua-console.log 2>&1 &
CONSOLE_PID=$!
trap 'kill $CONSOLE_PID 2>/dev/null || true; rm -f .docs-shot.tmp.ts .docs-shot2.tmp.ts .docs-shot-mc.tmp.ts' EXIT
sleep 3
cat > .docs-shot2.tmp.ts <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1100, height: 1400 }, colorScheme: 'dark' });
await p.goto(`http://localhost:${process.env.PORT}/`, { waitUntil: 'networkidle' });
await p.screenshot({ path: 'docs/capability-console.png' });
await b.close();
EOF
PORT="$CONSOLE_PORT" npx tsx .docs-shot2.tmp.ts
kill $CONSOLE_PID 2>/dev/null || true
echo "   → docs/capability-console.png"

echo "── the operator console (captured mid-handoff by the escalation demo) ──"
curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
./scripts/demo-escalation.sh >/tmp/cua-esc.log 2>&1 || true
if [ -f /tmp/cua-operator-console.png ]; then
  cp /tmp/cua-operator-console.png docs/operator-console.png
  echo "   → docs/operator-console.png"
else
  echo "   ! the handoff capture did not run; see /tmp/cua-esc.log"
fi

echo "── MERIDIAN CORE: the dashboard and the chatbot refusing a transfer ──"
if curl -s -o /dev/null -m 4 "http://localhost:7400/api/capabilities"; then
  cat > .docs-shot-mc.tmp.ts <<'MCEOF'
import { chromium } from 'playwright';

async function main(): Promise<void> {
  const BASE = 'http://localhost:7400';
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();

  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: 'docs/meridian-dashboard.png', clip: { x: 0, y: 0, width: 1280, height: 780 } });

  await p.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
  await p.fill('#q', 'Transfer $1.00 from 102777-MMKT-4 to 102777-S0001 for member 102777, memo demo');
  await p.click('#send');
  await p.waitForFunction(
    () => {
      const last = [...document.querySelectorAll('.msg.bot .body')].pop();
      return last ? !last.textContent?.includes('working') : false;
    },
    undefined,
    { timeout: 180_000 },
  );
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'docs/meridian-chatbot-refusal.png', fullPage: true });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
MCEOF
  npx tsx .docs-shot-mc.tmp.ts
  echo "   → docs/meridian-dashboard.png"
  echo "   → docs/meridian-chatbot-refusal.png"
else
  echo "   ! skipped: nothing serving on :7400. Start it with:"
  echo "     npm run serve -- --tenant meridian-core"
fi
echo "   (docs/meridian-member-record.png is copied from a committed replay bundle,"
echo "    since it must be a screenshot the redaction layer actually produced)"

echo "── the demo GIF ──"
npx tsx scripts/make-gif.ts | tail -1

curl -s -X POST "$TARGET/_admin/reset" -o /dev/null
rm -f .docs-shot.tmp.ts .docs-shot2.tmp.ts .docs-shot-mc.tmp.ts

echo
echo "All README images regenerated:"
ls -la docs/ | tail -n +2 | awk '{printf "  %-34s %6.0f KB\n", $9, $5/1024}'
