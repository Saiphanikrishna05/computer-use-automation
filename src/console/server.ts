/**
 * The capability console — `npm run console`.
 *
 * The reviewer's view of what the system produced. REPORT §1 argues that a
 * capability should be reviewable the way a pull request is; this is that claim
 * made visible rather than asserted.
 *
 * It is deliberately read-only and deliberately thin. It renders what is
 * already on disk — the artifacts, and the evidence bundles from real runs —
 * and computes nothing of its own, so it cannot disagree with the system it
 * describes. Approving a capability is still a CLI action, because approval
 * should be a reviewed commit rather than a button someone clicks.
 */

import express from 'express';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listArtifacts, listOverlays } from '../artifact/store.js';
import type { CapabilityArtifact } from '../artifact/schema.js';
import type { ReplayResult } from '../replay/result.js';

interface RunSummary {
  bundle: string;
  status: string;
  outcome?: string;
  errorCode?: string;
  durationMs: number;
  degraded: number;
  tenant?: string;
  steps: number;
}

function loadRuns(): RunSummary[] {
  const dir = 'evidence';
  if (!existsSync(dir)) return [];
  const out: RunSummary[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name, 'result.json');
    if (!existsSync(path)) continue;
    try {
      const r = JSON.parse(readFileSync(path, 'utf8')) as ReplayResult & {
        capabilityId: string;
        tenantId?: string;
      };
      out.push({
        bundle: name,
        status: r.status,
        ...(r.status === 'business_outcome' ? { outcome: r.outcome } : {}),
        ...(r.status === 'failure' ? { errorCode: r.error.code } : {}),
        durationMs: r.durationMs,
        degraded: r.degradedResolutions ?? 0,
        ...(r.tenantId ? { tenant: r.tenantId } : {}),
        steps: r.steps?.length ?? 0,
      });
    } catch {
      /* a malformed bundle should not take the page down */
    }
  }
  return out;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Which locator tier each step's *primary* candidate would use. */
function primaryTier(step: CapabilityArtifact['steps'][number]): string {
  const target = 'target' in step.action ? step.action.target : undefined;
  const kind = target?.candidates?.[0]?.kind;
  return kind ?? '—';
}

const TIER_ORDER = ['test_id', 'role_name', 'label', 'placeholder', 'text', 'structural', 'coordinates'];

function page(artifacts: CapabilityArtifact[], runs: RunSummary[], tenants: string[]): string {
  const cards = artifacts
    .map((a) => {
      const mine = runs.filter((r) => r.bundle.includes(a.id.replace(/_/g, '-')) || true);
      const approved = a.approval.state === 'approved';

      // Injected parameters are shown apart from caller inputs, because that
      // distinction is a safety claim: credentials are resolved at execution
      // time and never appear in the tool schema an agent sees. A console that
      // lists them beside memberId would read as "the agent supplies the
      // password", which is the opposite of what happens.
      const callerInputs = a.inputs.filter((i) => !i.injected);
      const injected = a.inputs.filter((i) => i.injected);

      const io = (list: Array<{ name: string; type: string; description: string }>, kind: string) =>
        list.length === 0
          ? `<p class="none">no ${kind}</p>`
          : `<ul class="io">${list
              .map(
                (p) =>
                  `<li><code>${esc(p.name)}</code><span class="type">${esc(p.type)}</span>` +
                  `<span class="desc">${esc(p.description)}</span></li>`,
              )
              .join('')}</ul>`;

      const steps = a.steps
        .map((s) => {
          const tier = primaryTier(s);
          const rank = TIER_ORDER.indexOf(tier);
          const strength = rank < 0 ? 'unknown' : rank <= 1 ? 'strong' : rank <= 4 ? 'ok' : 'weak';
          return `<tr>
            <td class="mono">${esc(s.id)}</td>
            <td>${esc(s.intent)}</td>
            <td><span class="risk ${esc(s.risk)}">${esc(s.risk.replace(/_/g, ' '))}</span></td>
            <td><span class="tier ${strength}">${esc(tier)}</span></td>
          </tr>`;
        })
        .join('');

      const contract = [
        ['outcomes', a.outcomes.map((o) => o.code)],
        ['declared failures', a.failures.map((f) => f.code)],
        ['recovery rules', a.recovery.map((r) => r.code)],
      ]
        .map(
          ([label, codes]) =>
            `<div class="contract-group"><h4>${esc(label)}</h4>${
              (codes as string[]).length === 0
                ? '<p class="none">none declared</p>'
                : (codes as string[]).map((c) => `<span class="code">${esc(c)}</span>`).join('')
            }</div>`,
        )
        .join('');

      return `<article>
        <header>
          <div>
            <h2>${esc(a.id)} <span class="ver">v${a.version}</span></h2>
            <p class="sub">${esc(a.title)}</p>
          </div>
          <span class="badge ${approved ? 'approved' : 'draft'}">${esc(a.approval.state)}</span>
        </header>

        <p class="desc-long">${esc(a.description)}</p>

        <div class="grid">
          <section><h3>Inputs <span class="hint">— what a calling agent supplies</span></h3>
            ${io(callerInputs, 'inputs')}</section>
          <section><h3>Outputs <span class="hint">— what it gets back</span></h3>
            ${io(a.outputs, 'outputs')}</section>
        </div>

        ${
          injected.length === 0
            ? ''
            : `<h3>Injected at runtime <span class="hint">— resolved by the credential store; never in the published tool schema</span></h3>
               <ul class="io injected">${injected
                 .map(
                   (p) =>
                     `<li><code>${esc(p.name)}</code><span class="type secret">${esc(
                       p.sensitivity ?? 'secret',
                     )}</span><span class="desc">${esc(p.description)}</span></li>`,
                 )
                 .join('')}</ul>`
        }

        <h3>Steps <span class="hint">— the locator tier each one leads with</span></h3>
        <table><thead><tr><th>id</th><th>intent</th><th>risk</th><th>primary locator</th></tr></thead>
        <tbody>${steps}</tbody></table>

        <h3>Failure contract</h3>
        <div class="contract">${contract}</div>

        <footer>
          recorded ${esc(a.provenance.discoveredAt?.slice(0, 10) ?? '—')}
          by <code>${esc(a.provenance.model)}</code>
          ${a.provenance.humanEdits?.length ? `· ${a.provenance.humanEdits.length} reviewed edit(s)` : ''}
          ${mine.length ? '' : ''}
        </footer>
      </article>`;
    })
    .join('');

  const runRows = runs
    .map((r) => {
      const cls =
        r.status === 'success' ? 'ok' : r.status === 'business_outcome' ? 'outcome' : r.status === 'escalated' ? 'esc' : 'fail';
      const detail = r.outcome ?? r.errorCode ?? '';
      return `<tr>
        <td class="mono">${esc(r.bundle)}</td>
        <td><span class="status ${cls}">${esc(r.status.replace(/_/g, ' '))}</span></td>
        <td class="mono dim">${esc(detail)}</td>
        <td class="num">${r.steps}</td>
        <td class="num">${r.durationMs} ms</td>
        <td class="num ${r.degraded > 0 ? 'warn' : ''}">${r.degraded}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Capability console</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --bg:#f5f6f8; --panel:#fff; --line:#e2e6ec; --ink:#14171c; --muted:#5d6672;
    --accent:#1c3f60; --ok:#166534; --ok-bg:#dcfce7; --warn:#92400e; --warn-bg:#fef3c7;
    --fail:#991b1b; --fail-bg:#fee2e2; --info:#1e40af; --info-bg:#dbeafe;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1015; --panel:#151920; --line:#242a34; --ink:#e7e9ed; --muted:#8d96a4;
      --accent:#7fb2e5; --ok:#86efac; --ok-bg:#12331f; --warn:#fcd34d; --warn-bg:#3a2f10;
      --fail:#fca5a5; --fail-bg:#3b1717; --info:#93c5fd; --info-bg:#16244a;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;padding:2.5rem 1.5rem 5rem;background:var(--bg);color:var(--ink);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:70rem;margin:0 auto}
  h1{font-size:1.3rem;margin:0 0 .25rem;letter-spacing:-.02em}
  .lede{color:var(--muted);margin:0 0 2.5rem;max-width:44rem}
  article{background:var(--panel);border:1px solid var(--line);border-radius:14px;
          padding:1.5rem 1.75rem;margin-bottom:1.5rem}
  article>header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;
                 border-bottom:1px solid var(--line);padding-bottom:1rem;margin-bottom:1rem}
  h2{font-size:1.05rem;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .ver{color:var(--muted);font-weight:400;font-size:.85rem}
  .sub{margin:.2rem 0 0;color:var(--muted);font-size:.9rem}
  .desc-long{margin:0 0 1.25rem;color:var(--ink);max-width:52rem}
  h3{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
     margin:1.5rem 0 .6rem;font-weight:600}
  h3:first-of-type{margin-top:0}
  .hint{text-transform:none;letter-spacing:0;font-weight:400}
  h4{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .4rem}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
  @media (max-width:44rem){.grid{grid-template-columns:1fr}}
  ul.io{list-style:none;padding:0;margin:0;font-size:.88rem}
  ul.io li{padding:.35rem 0;border-bottom:1px dashed var(--line);display:flex;gap:.5rem;flex-wrap:wrap;align-items:baseline}
  ul.io li:last-child{border-bottom:0}
  .type{font-size:.7rem;padding:.05rem .4rem;border-radius:4px;background:var(--info-bg);color:var(--info)}
  .type.secret{background:var(--warn-bg);color:var(--warn)}
  ul.io.injected li{opacity:.85}
  .desc{color:var(--muted);font-size:.82rem;flex:1 1 12rem}
  .none{color:var(--muted);font-size:.85rem;margin:.2rem 0}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;font-weight:600;color:var(--muted);font-size:.72rem;text-transform:uppercase;
     letter-spacing:.06em;padding:.35rem .5rem .35rem 0;border-bottom:1px solid var(--line)}
  td{padding:.4rem .5rem .4rem 0;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
  .dim{color:var(--muted)}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .badge,.status,.risk,.tier,.code{font-size:.7rem;padding:.15rem .5rem;border-radius:999px;
        font-weight:600;letter-spacing:.02em;white-space:nowrap;display:inline-block}
  .badge.approved,.status.ok,.tier.strong{background:var(--ok-bg);color:var(--ok)}
  .badge.draft,.status.outcome,.tier.ok{background:var(--info-bg);color:var(--info)}
  .status.fail,.tier.weak{background:var(--fail-bg);color:var(--fail)}
  .status.esc,.warn{background:var(--warn-bg);color:var(--warn)}
  .risk{background:transparent;border:1px solid var(--line);color:var(--muted);font-weight:500}
  .risk.mutate_irreversible{border-color:var(--fail);color:var(--fail)}
  .code{background:transparent;border:1px solid var(--line);color:var(--ink);font-weight:500;
        font-family:ui-monospace,Menlo,monospace;margin:0 .3rem .3rem 0}
  .contract{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem}
  article>footer{margin-top:1.25rem;padding-top:.9rem;border-top:1px solid var(--line);
                 color:var(--muted);font-size:.8rem}
  code{font-family:ui-monospace,Menlo,monospace;font-size:.85em}
  .runs{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.5rem 1.75rem}
  .foot{color:var(--muted);font-size:.82rem;margin-top:2rem;text-align:center}
</style>
<div class="wrap">
  <h1>Capability console</h1>
  <p class="lede">Everything an LLM discovered, as it will be executed: the typed contract an
  agent calls, the locator each step leads with, and the failure conditions the capability
  declares. Read-only — approval is a reviewed commit, not a button.</p>

  ${cards || '<article><p class="none">No capabilities recorded yet. Run <code>npm run discover</code>.</p></article>'}

  <div class="runs">
    <h1 style="font-size:1.05rem">Committed evidence</h1>
    <p class="lede" style="margin-bottom:1.25rem">Every run in <code>evidence/</code>, from a real
    execution. The last column is the drift signal: a locator resolving below the tier it was
    recorded at has not failed, but is one change from failing.</p>
    <table><thead><tr><th>bundle</th><th>result</th><th>detail</th><th class="num">steps</th>
    <th class="num">duration</th><th class="num">degraded</th></tr></thead>
    <tbody>${runRows || '<tr><td colspan="6" class="none">No evidence bundles.</td></tr>'}</tbody></table>
  </div>

  <p class="foot">${artifacts.length} capabilit${artifacts.length === 1 ? 'y' : 'ies'} ·
  ${tenants.length} tenant overlay file(s) · ${runs.length} replay bundle(s) with a typed result</p>
</div>`;
}

export function startConsole(port: number): Promise<void> {
  const app = express();

  app.get('/', (_req, res) => {
    // Re-read on every request so the page always reflects disk, not a cache
    // taken at boot — a console that can disagree with the artifacts is worse
    // than no console.
    res.type('html').send(page(listArtifacts(), loadRuns(), listOverlays().map((o) => o.tenantId)));
  });

  app.get('/api/capabilities', (_req, res) => res.json(listArtifacts()));

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      process.stdout.write(`\n  Capability console → http://localhost:${port}/\n  Ctrl-C to stop.\n\n`);
    });
    process.on('SIGINT', () => {
      server.close();
      resolve();
    });
  });
}
