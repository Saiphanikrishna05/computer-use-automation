/**
 * Human-in-the-loop escalation and control transfer.
 *
 * The mechanism, end to end:
 *
 *   1. Replay hits something it cannot safely do (an irreversible action, an
 *      unresolvable target, a condition no recovery rule claims).
 *   2. It raises an `InterventionRequest` carrying the capability, the step,
 *      why it stopped, and a masked screenshot of what it was looking at.
 *   3. The control lease moves AUTOMATION → HANDOFF_REQUESTED. From this
 *      instant the driver refuses every automation action, so nothing can race
 *      the operator who is about to take over.
 *   4. An operator opens the console, takes control (→ HUMAN), and works the
 *      *same live page*, either directly in the headed browser window or
 *      through the console's forwarded input. Everything they do is captured.
 *   5. They hand back (→ RESUMING → AUTOMATION) and the run continues on the
 *      same session, with the human's actions recorded in the evidence bundle.
 *
 * The console UI is deliberately thin, because the brief puts a full co-browsing
 * operator surface out of scope. What is *not* thin is the control-transfer
 * model underneath it, because that is the part that would be identical in a
 * real product.
 */

import express from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { EscalationHandler, InterventionOutcome, InterventionRequest } from '../replay/executor.js';
import type { HumanAction, SurfaceDriver } from '../surface/types.js';
import type { RunLogger } from '../evidence/logger.js';
import { ControlLease } from './lease.js';
import { OPERATOR_PORT } from '../config.js';

interface PendingIntervention {
  id: string;
  request: InterventionRequest;
  raisedAt: string;
  state: 'waiting' | 'in_progress' | 'resolved';
  humanActions: HumanAction[];
  resolve: (outcome: InterventionOutcome) => void;
  stopCapture?: () => Promise<void>;
}

export class ConsoleEscalationHandler implements EscalationHandler {
  private server: Server | undefined;
  private readonly pending = new Map<string, PendingIntervention>();

  constructor(
    private readonly lease: ControlLease,
    private readonly logger: RunLogger,
    private readonly driver: SurfaceDriver,
    private readonly port = OPERATOR_PORT,
  ) {}

  async raise(request: InterventionRequest): Promise<InterventionOutcome> {
    const id = `int-${randomBytes(4).toString('hex')}`;

    // Order matters: stop automation *before* announcing the request, so an
    // operator who reacts instantly cannot collide with an in-flight action.
    this.lease.requestHandoff(`${request.code}: ${request.reason}`);

    await this.ensureServer();

    const stopCapture = await this.driver.captureHumanActions((action) => {
      const entry = this.pending.get(id);
      if (!entry) return;
      entry.humanActions.push(action);
      this.logger.event('human_action', `${action.kind}: ${action.detail}`, { interventionId: id, ...action });
    });

    const outcome = await new Promise<InterventionOutcome>((resolve) => {
      this.pending.set(id, {
        id,
        request,
        raisedAt: new Date().toISOString(),
        state: 'waiting',
        humanActions: [],
        resolve,
        stopCapture,
      });

      process.stderr.write(
        `\n${'!'.repeat(72)}\n` +
          `  HUMAN INTERVENTION REQUIRED, ${request.code}\n` +
          `  ${request.reason}\n` +
          `  capability: ${request.capabilityId} v${request.capabilityVersion}` +
          (request.stepId ? ` · step: ${request.stepId}` : '') +
          `\n\n  Operator console: http://localhost:${this.port}/\n` +
          `${'!'.repeat(72)}\n\n`,
      );

      this.logger.event('escalation_raised', `intervention ${id} awaiting an operator`, {
        interventionId: id,
        code: request.code,
        stepId: request.stepId,
        consoleUrl: `http://localhost:${this.port}/`,
      });
    });

    return outcome;
  }

  /** Called by the console when an operator resolves an intervention. */
  private async settle(
    id: string,
    resolution: 'resumed' | 'completed_manually' | 'aborted',
    operatorId: string,
    note?: string,
  ): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry || entry.state === 'resolved') return;

    await entry.stopCapture?.().catch(() => undefined);
    entry.state = 'resolved';

    if (this.lease.state === 'HUMAN') this.lease.beginReturn(operatorId, note);
    if (this.lease.state === 'RESUMING') this.lease.completeReturn();

    this.logger.event('control_transfer', `intervention ${id} ${resolution} by ${operatorId}`, {
      interventionId: id,
      resolution,
      note,
      humanActionCount: entry.humanActions.length,
    });

    entry.resolve({
      interventionId: id,
      resolution,
      operatorId,
      note,
      humanActions: entry.humanActions.map((a) => ({ at: a.at, kind: a.kind, detail: a.detail })),
    });
  }

  async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  // -------------------------------------------------------------------------
  // The console
  // -------------------------------------------------------------------------

  private async ensureServer(): Promise<void> {
    if (this.server) return;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    app.get('/', (_req, res) => {
      const items = [...this.pending.values()].filter((p) => p.state !== 'resolved');
      res.send(renderConsole(items, this.lease));
    });

    app.get('/intervention/:id/screen.png', async (_req, res) => {
      try {
        const png = await this.driver.screenshot({ maskSensitive: true });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.send(png);
      } catch (error) {
        res.status(503).send(String(error));
      }
    });

    app.post('/intervention/:id/take', (req, res) => {
      const entry = this.pending.get(req.params.id);
      if (!entry) return res.status(404).send('no such intervention');
      if (this.lease.state === 'HANDOFF_REQUESTED') {
        this.lease.grantToHuman(String(req.body?.operatorId || 'operator'));
        entry.state = 'in_progress';
      }
      return res.redirect(`/?focus=${entry.id}`);
    });

    // Input forwarding. The point is that these land on the *same* page the
    // automation was driving, same session, same cookies, same frame state -
    // so a headless reviewer gets the identical control-transfer semantics a
    // headed operator gets by clicking in the browser window directly.
    app.post('/intervention/:id/click', async (req, res) => {
      try {
        await this.driver.humanClickAt(Number(req.body?.x ?? 0), Number(req.body?.y ?? 0));
        res.json({ ok: true });
      } catch (error) {
        res.status(409).json({ ok: false, error: String(error) });
      }
    });

    app.post('/intervention/:id/type', async (req, res) => {
      try {
        const text = String(req.body?.text ?? '');
        if (text) await this.driver.humanType(text);
        if (req.body?.thenPress) await this.driver.humanPress(String(req.body.thenPress));
        res.json({ ok: true });
      } catch (error) {
        res.status(409).json({ ok: false, error: String(error) });
      }
    });

    app.post('/intervention/:id/resume', async (req, res) => {
      // Two distinct meanings of "done", because they lead to different
      // executor behaviour. See InterventionOutcome.resolution.
      const resolution = req.body?.mode === 'performed' ? 'completed_manually' : 'resumed';
      await this.settle(req.params.id, resolution, String(req.body?.operatorId || 'operator'), String(req.body?.note || ''));
      res.redirect('/');
    });

    app.post('/intervention/:id/abort', async (req, res) => {
      await this.settle(req.params.id, 'aborted', String(req.body?.operatorId || 'operator'), String(req.body?.note || 'operator aborted the run'));
      res.redirect('/');
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(this.port, () => resolve());
    });
  }
}

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function renderConsole(items: PendingIntervention[], lease: ControlLease): string {
  const body =
    items.length === 0
      ? '<p class="muted">No interventions are waiting. This page refreshes automatically.</p>'
      : items
          .map(
            (entry) => `
    <article>
      <h2>${esc(entry.request.code)}<span class="pill ${entry.state}">${entry.state.replace('_', ' ')}</span></h2>
      <dl>
        <dt>capability</dt><dd>${esc(entry.request.capabilityId)} v${entry.request.capabilityVersion}</dd>
        <dt>step</dt><dd>${esc(entry.request.stepId ?? '(none)')}${entry.request.stepIntent ? ` · ${esc(entry.request.stepIntent)}` : ''}</dd>
        <dt>why it stopped</dt><dd>${esc(entry.request.reason)}</dd>
        <dt>raised</dt><dd>${esc(entry.raisedAt)}</dd>
      </dl>

      <h3>Live session</h3>
      <img id="screen-${entry.id}" class="screen" src="/intervention/${entry.id}/screen.png" alt="live session">
      <p class="hint">The same browser session the automation was driving, same cookies, same frame state. Click the image to click the page. Sensitive regions are masked before capture.</p>

      ${
        entry.state === 'waiting'
          ? `<form method="post" action="/intervention/${entry.id}/take">
               <input name="operatorId" placeholder="your operator id" value="operator">
               <button class="primary" type="submit">Take control of this session</button>
             </form>`
          : `<div class="controls">
               <input id="text-${entry.id}" placeholder="text to type into the focused field">
               <button onclick="sendType('${entry.id}')">Type</button>
               <button onclick="sendType('${entry.id}', 'Enter')">Type + Enter</button>
             </div>
             <form method="post" action="/intervention/${entry.id}/resume">
               <input name="operatorId" value="operator">
               <input name="note" placeholder="what you did" size="34">
               <button class="primary" name="mode" value="retry" type="submit">I cleared the blocker, retry the step</button>
               <button class="primary" name="mode" value="performed" type="submit">I performed this step myself, continue</button>
             </form>
             <form method="post" action="/intervention/${entry.id}/abort">
               <input type="hidden" name="operatorId" value="operator">
               <button class="danger" type="submit">Abort the run</button>
             </form>`
      }

      <h3>Actions recorded during this handoff</h3>
      <ul class="actions">${
        entry.humanActions.length === 0
          ? '<li class="muted">none yet</li>'
          : entry.humanActions.map((a) => `<li><code>${esc(a.kind)}</code> ${esc(a.detail)}</li>`).join('')
      }</ul>
    </article>`,
          )
          .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Operator console</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6f8; --panel: #ffffff; --line: #dde3ea; --ink: #16181d; --muted: #5b6472;
    --accent: #1c3f60; --warn-bg: #fff4d6; --warn-ink: #7a5209;
    --live-bg: #dcfce7; --live-ink: #14532d; --danger: #8b1a1a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --panel: #161a21; --line: #262c36; --ink: #e6e8ec; --muted: #9099a8;
      --accent: #7fb2e5; --warn-bg: #3a2f10; --warn-ink: #f0d089;
      --live-bg: #12331f; --live-ink: #86efac;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.5rem 4rem;
    background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 68rem; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.75rem; }
  h1 { font-size: 1.05rem; margin: 0; letter-spacing: -0.01em; }
  .lease {
    font-size: .78rem; font-variant-numeric: tabular-nums;
    padding: .2rem .6rem; border-radius: 999px; border: 1px solid var(--line);
    background: var(--panel); color: var(--muted);
  }
  .lease strong { color: var(--ink); font-weight: 600; }
  article {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 1.4rem 1.6rem; margin-bottom: 1.5rem;
    box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  h2 { font-size: .95rem; margin: 0 0 1rem; display: flex; align-items: center; gap: .6rem; }
  h3 {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
    color: var(--muted); margin: 1.5rem 0 .6rem; font-weight: 600;
  }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: .45rem 1rem; margin: 0; font-size: .88rem; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  .pill {
    font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; font-weight: 600;
    padding: .2rem .55rem; border-radius: 999px; background: var(--warn-bg); color: var(--warn-ink);
  }
  .pill.in_progress { background: var(--live-bg); color: var(--live-ink); }
  .screen {
    width: 100%; border: 1px solid var(--line); border-radius: 8px;
    cursor: crosshair; display: block; background: #fff;
  }
  .hint { font-size: .8rem; color: var(--muted); margin: .5rem 0 0; }
  form, .controls { margin-top: 1rem; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  input {
    padding: .45rem .7rem; border: 1px solid var(--line); border-radius: 7px;
    font: inherit; background: var(--bg); color: var(--ink); min-width: 9rem;
  }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    padding: .45rem 1rem; border-radius: 7px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink); font: inherit; font-weight: 500; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
  .actions { font-size: .85rem; padding-left: 0; list-style: none; margin: 0; }
  .actions li { padding: .3rem 0; border-bottom: 1px dashed var(--line); }
  .actions li:last-child { border-bottom: 0; }
  .muted { color: var(--muted); }
  code {
    background: color-mix(in srgb, var(--muted) 16%, transparent);
    padding: .1rem .35rem; border-radius: 4px; font-size: .85em;
  }
</style></head>
<body>
  <div class="wrap">
    <header>
      <h1>Operator console</h1>
      <span class="lease">control lease <strong>${lease.state}</strong> · held by <strong>${lease.holder}</strong></span>
    </header>
    ${body}
  </div>
<script>
  // Forward a click on the screenshot to the same coordinate on the live page.
  document.querySelectorAll('.screen').forEach((img) => {
    img.addEventListener('click', async (event) => {
      const rect = img.getBoundingClientRect();
      const scale = img.naturalWidth / rect.width;
      const x = Math.round((event.clientX - rect.left) * scale);
      const y = Math.round((event.clientY - rect.top) * scale);
      const id = img.id.replace('screen-', '');
      const res = await fetch('/intervention/' + id + '/click', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x, y }),
      });
      if (!res.ok) alert((await res.json()).error);
      setTimeout(() => refresh(), 400);
    });
  });

  async function sendType(id, thenPress) {
    const text = document.getElementById('text-' + id).value;
    const res = await fetch('/intervention/' + id + '/type', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, thenPress }),
    });
    if (!res.ok) alert((await res.json()).error);
    setTimeout(() => refresh(), 400);
  }

  function refresh() {
    document.querySelectorAll('.screen').forEach((img) => {
      img.src = img.src.split('?')[0] + '?t=' + Date.now();
    });
  }
  setInterval(refresh, 1500);
</script>
</body></html>`;
}
