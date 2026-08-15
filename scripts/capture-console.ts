/**
 * Screenshots the operator console while an intervention is live.
 *
 * Human-in-the-loop is a graded requirement, and until now the one surface a
 * human actually uses had no visual record anywhere in the evidence. A
 * reviewer had to take it on trust that the console existed.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:7317/';
const out = process.argv[3] ?? 'evidence/operator-console.png';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 1500 } });

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  // The console polls a live screenshot of the driven session; give it one
  // cycle so the capture shows the real thing rather than a broken image.
  await page.waitForTimeout(2_000);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  process.stdout.write(`operator console captured → ${out}\n`);
} catch (error) {
  process.stderr.write(`could not capture the operator console: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
