/**
 * `catalog`, the agent-facing view of what capabilities exist.
 *
 * `schema` emits the exact JSON-Schema tool definition a calling agent would
 * receive. Generating it from the same Zod-validated artifact that replay
 * executes is the point: there is one description of a capability's contract,
 * not a hand-maintained tool schema that drifts from what the automation
 * actually does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listArtifacts, loadArtifact, saveArtifact } from '../artifact/store.js';
import { CapabilityArtifactSchema } from '../artifact/schema.js';
import { formatTokens, formatUsd, pricing } from '../discovery/cost.js';
import { appendAudit, verifyAuditLog, historyOf } from '../artifact/audit-log.js';
import {
  freshnessReport,
  staleOutcomes,
  summariseFreshness,
  describeAge,
  maxObservationAgeDays,
} from '../artifact/staleness.js';
import { toolDefinitionFor, catalogToolDefinitions } from '../catalog/tools.js';

export async function runCatalogCommand(
  action: string,
  capability: string | undefined,
  opts: { by: string; note: string; force?: boolean; invocations?: number; from?: string },
): Promise<number> {
  switch (action) {
    case 'list': {
      const artifacts = listArtifacts();
      if (artifacts.length === 0) {
        process.stdout.write('No capabilities recorded yet. Run `npm run discover` first.\n');
        return 0;
      }
      process.stdout.write(`\n${artifacts.length} capabilit${artifacts.length === 1 ? 'y' : 'ies'}:\n\n`);
      for (const a of artifacts) {
        const gate = a.approval.state === 'approved' ? 'approved' : 'DRAFT, will not replay unattended';
        process.stdout.write(`  ${a.id}  v${a.version}\n`);
        process.stdout.write(`    ${a.title}\n`);
        process.stdout.write(`    risk: ${a.maxRisk} · ${gate}\n`);
        process.stdout.write(
          `    inputs: ${a.inputs.filter((i) => !i.injected).map((i) => i.name).join(', ') || '(none)'}` +
            ` → outputs: ${a.outputs.map((o) => o.name).join(', ') || '(none)'}\n`,
        );
        // How many declared outcomes are backed by an observation, and how
        // many of those observations are old enough that nobody should still be
        // relying on them. A reviewer scanning the catalog should see both
        // without opening the artifact.
        const summary = summariseFreshness(freshnessReport(a));
        const evidence = summary ? ` (${summary})` : '';
        process.stdout.write(
          `    ${a.steps.length} steps · ${a.outcomes.length} declared outcomes${evidence} · ${a.recovery.length} recovery rules\n\n`,
        );
      }
      return 0;
    }

    case 'show': {
      if (!capability) {
        process.stderr.write('catalog show requires a capability id\n');
        return 1;
      }
      process.stdout.write(`${JSON.stringify(loadArtifact(capability), null, 2)}\n`);
      return 0;
    }

    case 'schema': {
      const defs = capability ? [toolDefinitionFor(loadArtifact(capability))] : catalogToolDefinitions();
      process.stdout.write(`${JSON.stringify(defs, null, 2)}\n`);
      return 0;
    }

    case 'approve': {
      if (!capability) {
        process.stderr.write('catalog approve requires a capability id\n');
        return 1;
      }
      const artifact = loadArtifact(capability);

      // A refuted outcome is one the system went and tested, and which did not
      // do what it claimed. Approving over that is exactly the "plausible list
      // waved through by a skimming reviewer" this whole pass exists to
      // prevent, so it takes an explicit override and is recorded as one.
      const refuted = artifact.outcomes.filter((o) => o.evidence.state === 'refuted');
      if (refuted.length > 0 && !opts.force) {
        process.stderr.write(
          `\nRefusing to approve ${artifact.id}: ${refuted.length} declared outcome(s) were probed and did ` +
            `not fire.\n\n` +
            refuted
              .map((o) => `  ✗ ${o.code}\n    ${o.evidence.note ?? 'no detail recorded'}\n`)
              .join('') +
            `\nFix the condition wording and re-record, or approve deliberately with --force.\n\n`,
        );
        return 1;
      }

      const hypothesised = artifact.outcomes.filter((o) => o.evidence.state === 'hypothesised');
      if (hypothesised.length > 0) {
        process.stderr.write(
          `\nNote: ${hypothesised.length} outcome(s) remain unverified hypotheses ` +
            `(${hypothesised.map((o) => o.code).join(', ')}).\n` +
            `They were never observed. Approving accepts them on the model's word.\n\n`,
        );
      }

      // An observation is true about the application on the day it was made.
      // Approving on the strength of one taken a year ago trusts a check nobody
      // has repeated across however many vendor releases have shipped since.
      // This warns rather than blocks: unlike a refutation, a stale observation
      // is not known to be wrong, and refusing on it would expire every
      // capability on a date nobody chose.
      const stale = staleOutcomes(artifact);
      if (stale.length > 0) {
        process.stderr.write(
          `\nNote: ${stale.length} outcome(s) were verified, but not recently ` +
            `(threshold ${maxObservationAgeDays()} days):\n` +
            stale.map((f) => `  · ${f.code} — last observed ${describeAge(f.ageDays)}\n`).join('') +
            `\nRe-verify before relying on them:\n` +
            `  npx tsx src/cli/index.ts probe ${artifact.id} --stale-only\n\n`,
        );
      }

      const approved = {
        ...artifact,
        approval: {
          state: 'approved' as const,
          approvedBy: opts.by,
          approvedAt: new Date().toISOString(),
          note: opts.note,
        },
        provenance: {
          ...artifact.provenance,
          humanEdits: [
            ...artifact.provenance.humanEdits,
            {
              at: new Date().toISOString(),
              by: opts.by,
              note:
                `approved for unattended replay: ${opts.note}` +
                (refuted.length > 0 ? ` [--force over ${refuted.length} refuted outcome(s)]` : '') +
                (hypothesised.length > 0 ? ` [${hypothesised.length} outcome(s) unverified]` : ''),
            },
          ],
        },
      };
      const path = saveArtifact(approved);

      // The artifact records who approved it; the log records it somewhere the
      // artifact cannot quietly disagree with later.
      const entry = appendAudit({
        action: 'approved',
        capabilityId: approved.id,
        capabilityVersion: approved.version,
        actor: opts.by,
        summary:
          opts.note +
          (refuted.length > 0 ? ` [--force over ${refuted.length} refuted]` : '') +
          (hypothesised.length > 0 ? ` [${hypothesised.length} unverified]` : ''),
      });

      process.stdout.write(
        `Approved ${approved.id} v${approved.version} → ${path}\n` +
          `Audit entry #${entry.seq} recorded (${entry.hash.slice(0, 12)}…)\n`,
      );
      return 0;
    }

    case 'economics': {
      // The system's central claim, stated in the units a reviewer or an
      // operator actually budgets in, and computed from what the runs measured
      // rather than from an estimate typed into a slide.
      // A run bundle is a legitimate source here, not a convenience. The
      // capabilities committed to this repo were recorded before cost was
      // measured, and re-recording one to backfill a number would orphan the
      // tenant overrides keyed to its step ids, which is a documented bug in
      // this system rather than a hypothetical. So the measurement is read from
      // where it was taken.
      const artifacts = opts.from
        ? [CapabilityArtifactSchema.parse(JSON.parse(readFileSync(join(opts.from, 'artifact.json'), 'utf8')))]
        : capability
          ? [loadArtifact(capability)]
          : listArtifacts();
      const priced = artifacts.filter((a) => a.provenance.cost);
      const invocations = opts.invocations ?? 1_000_000;

      process.stdout.write(`\n${'─'.repeat(72)}\n  Capability economics\n${'─'.repeat(72)}\n\n`);

      if (priced.length === 0) {
        process.stdout.write(
          '  No capability in the catalog carries a recorded cost.\n\n' +
            '  Cost is measured during discovery, and the capabilities committed here\n' +
            '  predate that measurement. They are deliberately not backfilled:\n' +
            '  re-recording one to obtain a number would orphan the tenant overrides\n' +
            '  keyed to its step ids, and inventing the number would be worse.\n\n' +
            '  A real measured run is committed. Read it with:\n\n' +
            '    npx tsx src/cli/index.ts catalog economics --from evidence/discovery-cost-measured\n\n' +
            '  Every new `npm run discover` records its own cost from here on.\n\n',
        );
        return 0;
      }

      let totalRecording = 0;
      for (const a of priced) {
        const c = a.provenance.cost!;
        totalRecording += c.costUsd;
        process.stdout.write(
          `  ${a.id}\n` +
            `    recorded once    ${formatUsd(c.costUsd).padEnd(10)}${formatTokens(c.totalTokens)} tokens · ${c.turns} model turns\n` +
            `    prompt caching   saved ${formatUsd(c.cacheSavingUsd)} of that (${formatTokens(c.cacheReadTokens)} tokens served from cache)\n` +
            `    every replay     $0         0 tokens · no model in the path\n\n`,
        );
      }

      // The comparison is against the honest alternative: an agent that drives
      // the same UI with a model in the loop on every invocation. Its per-run
      // cost is unknown, so recording cost stands in for it, which is if
      // anything generous to the alternative, since a recording run is one
      // exploration whereas that agent re-derives the flow every single time.
      const perRun = totalRecording / priced.length;
      process.stdout.write(
        `${'─'.repeat(72)}\n` +
          `  At ${formatTokens(invocations)} invocations of one capability\n` +
          `${'─'.repeat(72)}\n\n` +
          `    model in the loop every time   ${formatUsd(perRun * invocations)}\n` +
          `    recorded once, replayed        ${formatUsd(perRun)}\n\n` +
          `    Break-even is the second invocation. Everything after the first is\n` +
          `    free, and not "cheap": replay makes no API call at all, which is why\n` +
          `    it runs with no API key configured.\n\n` +
          `  Assumes an always-on agent costs per run what recording cost here\n` +
          `  (${formatUsd(perRun)}). That favours the alternative: recording explores once,\n` +
          `  an always-on agent re-derives the flow on every call.\n\n` +
          `  Rates: $${pricing().input}/$${pricing().output} per Mtok in/out. Override with\n` +
          `  CUA_PRICE_INPUT / CUA_PRICE_OUTPUT. Token counts above are measured.\n\n`,
      );
      return 0;
    }

    case 'history': {
      const entries = capability ? historyOf(capability) : [];
      const check = verifyAuditLog();

      process.stdout.write(`\n${'─'.repeat(72)}\n  Governance log${capability ? ` — ${capability}` : ''}\n${'─'.repeat(72)}\n\n`);
      if (entries.length === 0 && capability) {
        process.stdout.write(`  Nothing recorded for ${capability}.\n\n`);
      }
      for (const e of entries) {
        process.stdout.write(
          `  #${e.seq}  ${e.at.slice(0, 19).replace('T', ' ')}  ${e.action}\n` +
            `      by ${e.actor}${e.runId ? ` · ${e.runId}` : ''}\n` +
            `      ${e.summary}\n\n`,
        );
      }
      process.stdout.write(
        check.ok
          ? `  Chain verified: ${check.entries} entr${check.entries === 1 ? 'y' : 'ies'}, unbroken.\n\n`
          : `  CHAIN BROKEN at entry ${check.brokenAt}: ${check.reason}\n\n`,
      );
      return check.ok ? 0 : 1;
    }

    default:
      process.stderr.write(
        `Unknown catalog action "${action}". Use list, show, schema, economics, history or approve.\n`,
      );
      return 1;
  }
}
