/**
 * Builds the README's demo GIF from a live run, `npm run demo:gif`.
 *
 * It films the claim the whole design rests on: a capability recorded once
 * against an application that then changes. Frames are captured from the real
 * browser while the real replay engine drives it, so this is a recording of the
 * system working, not an animation of it.
 *
 * No API key is needed, which is the point, a reviewer can regenerate this
 * themselves. Pure JS end to end (pngjs + gifenc), so there is no ffmpeg or
 * ImageMagick to install.
 */

import { chromium, type Browser, type Page } from 'playwright';
// gifenc ships a CJS default export rather than named ESM exports.
import gifencModule from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifencModule as unknown as {
  GIFEncoder: () => { writeFrame: (i: Uint8Array, w: number, h: number, o: Record<string, unknown>) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (d: Uint8Array, n: number) => number[][];
  applyPalette: (d: Uint8Array, p: number[][]) => Uint8Array;
};
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

import { PlaywrightWebSurface } from '../src/surface/playwright-web.js';
import { ReplayEngine } from '../src/replay/executor.js';
import { PolicyEngine, REPLAY_POLICY } from '../src/policy/engine.js';
import { Redactor } from '../src/policy/redaction.js';
import { RunLogger } from '../src/evidence/logger.js';
import { loadArtifact } from '../src/artifact/store.js';
import { resolveCredentials, DEFAULT_TENANT } from '../src/config.js';

const TARGET = `http://localhost:${process.env['CUA_TARGET_PORT'] ?? 4173}`;
const OUT = 'docs/demo.gif';

/** Frame width. Wider looks better and costs bytes; 900 is the balance. */
const WIDTH = 900;
const FRAME_MS = 140;

interface Frame {
  png: Buffer;
  caption: string;
  sub: string;
  /** Frames to hold this one for, how a still becomes a beat. */
  hold: number;
}

const frames: Frame[] = [];

async function drive(caption: string, sub: string, resultCaption: string, holdLast: number) {
  const artifact = loadArtifact('lookup_member_savings_balance');
  const credentials = resolveCredentials(DEFAULT_TENANT);
  const logger = new RunLogger({ runId: `gif-${Date.now()}`, rootDir: 'runs', echo: false });
  const policy = new PolicyEngine({ ...REPLAY_POLICY, allowedOrigins: [TARGET] });
  const driver = await PlaywrightWebSurface.launch({
    policy,
    redactor: new Redactor(),
    headless: true,
    viewport: { width: 1180, height: 450 },
  });

  // Poll the live page while the engine drives it. Screenshotting is far
  // cheaper than a step, so this reads as motion rather than a slideshow.
  let capturing = true;
  const pump = (async () => {
    while (capturing) {
      try {
        frames.push({ png: await driver.screenshot(), caption, sub, hold: 1 });
      } catch {
        /* page mid-navigation; skip this frame */
      }
      await new Promise((r) => setTimeout(r, 65));
    }
  })();

  try {
    const result = await new ReplayEngine({
      artifact,
      inputs: {
        memberId: '100001',
        operatorId: credentials.operatorId,
        operatorPassword: credentials.operatorPassword,
      },
      driver,
      policy,
      logger,
      bindings: { baseUrl: TARGET },
    }).run();

    capturing = false;
    await pump;

    // Take the closing frame explicitly, once the page has settled.
    //
    // The poll loop races the engine: masking mutates the DOM, screenshots,
    // then restores it, and a navigation mid-flight can make that silently
    // no-op, which would put an unmasked tax ID in a file destined for a
    // public repo. A settled capture is guaranteed to be masked, so the frames
    // that linger on screen are the ones taken deliberately.
    const settled = await driver.screenshot();
    const last = frames[frames.length - 1];
    if (last) {
      last.png = settled;
      last.hold = 4;
      const outputs =
        result.status === 'success'
          ? `savingsBalance ${result.outputs['savingsBalance']}  ·  ${result.durationMs} ms  ·  ` +
            `${result.degradedResolutions} degraded locator${result.degradedResolutions === 1 ? '' : 's'}`
          : result.status;
      frames.push({ png: settled, caption: resultCaption, sub: outputs, hold: holdLast });
    }
    return result;
  } finally {
    capturing = false;
    await driver.close();
  }
}

/**
 * Uses a browser page as the compositor: the screenshot is placed in an HTML
 * frame with its caption and re-shot. Cheaper than pulling in a canvas
 * dependency, and the typography is better than anything I would draw by hand.
 */
async function composite(page: Page, frame: Frame): Promise<Buffer> {
  const b64 = frame.png.toString('base64');
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    * { margin:0; box-sizing:border-box; }
    body { width:${WIDTH}px; background:#0e1116; font:14px/1.4 -apple-system,"Segoe UI",Helvetica,sans-serif; }
    .bar { padding:14px 18px 12px; }
    .cap { color:#e6e8ec; font-size:16px; font-weight:600; letter-spacing:-0.01em; }
    .sub { color:#7f8b9c; font-size:13px; margin-top:3px; font-variant-numeric:tabular-nums; }
    img { display:block; width:100%; border-top:1px solid #262c36; }
  </style>
  <div class="bar"><div class="cap">${frame.caption}</div><div class="sub">${frame.sub}</div></div>
  <img src="data:image/png;base64,${b64}">`);
  const el = await page.$('body');
  return (await el!.screenshot({ type: 'png' })) as Buffer;
}

// ---------------------------------------------------------------------------

const res = await fetch(`${TARGET}/`).catch(() => null);
if (!res) {
  console.error('The target app is not running. Start it with: npm run app');
  process.exit(1);
}

await fetch(`${TARGET}/_admin/reset`, { method: 'POST' });

console.log('filming the capability as recorded…');
const before = await drive(
  'A capability recorded once by an LLM.',
  'Replaying it, no model in the loop.',
  'It works.',
  14,
);

console.log('applying a vendor point release…');
await fetch(`${TARGET}/_admin/drift`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
});

console.log('filming the same artifact against the changed application…');
const after = await drive(
  'The application is upgraded. The artifact is not.',
  'Button reworded · accounts columns re-ordered · a column inserted',
  'Same answer. And it told us which locator weakened.',
  22,
);

await fetch(`${TARGET}/_admin/reset`, { method: 'POST' });

console.log(
  `  before: ${before.status}, ${before.degradedResolutions} degraded  ·  ` +
    `after: ${after.status}, ${after.degradedResolutions} degraded`,
);

// ---------------------------------------------------------------------------

console.log(`compositing ${frames.length} frames…`);
const browser: Browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } });

const gif = GIFEncoder();
let width = 0;
let height = 0;

for (const frame of frames) {
  const composed = await composite(page, frame);
  const png = PNG.sync.read(composed);
  width = png.width;
  height = png.height;
  const data = new Uint8Array(png.data);
  // 128 colours is plenty for flat UI screenshots and roughly halves the file
  // against a full palette.
  const palette = quantize(data, 128);
  const index = applyPalette(data, palette);
  for (let i = 0; i < frame.hold; i += 1) {
    gif.writeFrame(index, width, height, { palette, delay: FRAME_MS });
  }
}

gif.finish();
await browser.close();

mkdirSync('docs', { recursive: true });
writeFileSync(OUT, Buffer.from(gif.bytes()));

const kb = Buffer.from(gif.bytes()).length / 1024;
console.log(`\n${OUT}  ${width}×${height}  ${(kb / 1024).toFixed(2)} MB`);
if (kb > 4096) console.log('  ⚠ over 4 MB, reduce WIDTH or raise FRAME_MS');
