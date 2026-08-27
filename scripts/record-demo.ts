/**
 * Records the demo, so a bad network on the day costs a shrug rather than the
 * presentation.
 *
 * Driven by Playwright rather than captured off a screen, which makes it
 * reproducible: change the system, re-run this, and the backup matches what the
 * system now does. A screen capture taken once drifts from the thing it is
 * supposed to stand in for, and drifts silently.
 *
 * It walks the same path a person would on the day:
 *
 *   1. the dashboard — what has been recorded, and what backs it
 *   2. a question that succeeds
 *   3. a question whose honest answer is "no"        (business outcome)
 *   4. an instruction to move money                  (stops, and says so)
 *   5. back to the dashboard, into one run's evidence
 *
 * Deliberately paced. Every wait here is a beat someone watching needs to read
 * the screen, not a hack around a race.
 *
 * Usage:  npm run record            (needs `npm run serve` already running)
 */

import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CUA_DEMO_URL ?? 'http://localhost:7400';
const OUT = 'docs/demo-recording';
const VIEWPORT = { width: 1360, height: 900 };

/** A pause long enough to read what just appeared. */
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Types the way a person does.
 *
 * Not decoration: a value that appears instantly reads as a screenshot, and the
 * point of the recording is that someone believes it is really happening.
 */
async function typeLikeAHuman(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await page.fill(selector, '');
  await page.type(selector, text, { delay: 28 });
}

async function ask(page: Page, question: string, settleMs: number): Promise<void> {
  await typeLikeAHuman(page, '#q', question);
  await beat(500);
  await page.click('#send');
  // Wait for the answer to land rather than for a fixed time, then hold on it.
  await page
    .waitForFunction(
      () => {
        const last = [...document.querySelectorAll('.msg.bot .body')].pop();
        return last ? !last.textContent?.includes('working…') : false;
      },
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => undefined);
  await beat(settleMs);
}

async function main(): Promise<void> {
  const res = await fetch(`${BASE}/api/capabilities`).catch(() => undefined);
  if (!res?.ok) {
    process.stderr.write(
      `\nNothing answering at ${BASE}.\n` +
        `Start it first, in another terminal:\n\n  npm run serve -- --tenant meridian-core\n\n`,
    );
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT, size: VIEWPORT },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const say = (s: string) => process.stdout.write(`  ${s}\n`);

  // 1 — what exists, and what backs it -------------------------------------
  say('dashboard: the catalog');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await beat(2600);
  await page.mouse.wheel(0, 520);
  await beat(2200);
  await page.mouse.wheel(0, 620);
  await beat(2400);

  // 2 — a question that works ----------------------------------------------
  say('chatbot: a balance (success)');
  await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
  await beat(1600);
  await ask(page, "What's the balance on member 102777's regular shares?", 4200);

  // 3 — a question whose honest answer is "no" ------------------------------
  say('chatbot: an overdraw (business outcome)');
  await ask(page, 'Transfer $99999 from 102777-MMKT-4 to 102777-S0001 for member 102777, memo overdraw', 4200);

  // 4 — the one that matters ------------------------------------------------
  say('chatbot: moving money (stops, and says why)');
  await ask(page, 'Transfer $1.00 from 102777-MMKT-4 to 102777-S0001 for member 102777, memo demo', 6000);
  await page.mouse.wheel(0, 400);
  await beat(3000);

  // 5 — and the evidence underneath ----------------------------------------
  say('dashboard: the run, and its evidence');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await beat(1800);
  await page.mouse.wheel(0, 1400);
  await beat(1600);
  const firstRun = page.locator('#runs tr.click').first();
  if (await firstRun.count()) {
    await firstRun.click();
    await beat(4500);
    await page.mouse.wheel(0, 700);
    await beat(4000);
  }

  await context.close();
  await browser.close();

  // Playwright names the file after an internal id; give it one a person can
  // find under pressure.
  const produced = readdirSync(OUT).filter((f) => f.endsWith('.webm'));
  if (produced.length > 0) {
    const target = join(OUT, 'meridian-core-demo.webm');
    if (existsSync(target)) rmSync(target);
    renameSync(join(OUT, produced[0]!), target);
    process.stdout.write(`\n  → ${target}\n\n`);
  } else {
    process.stderr.write('\n  no video was produced\n\n');
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
