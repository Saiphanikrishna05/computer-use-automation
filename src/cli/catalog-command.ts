/**
 * `catalog`, the agent-facing view of what capabilities exist.
 *
 * `schema` emits the exact JSON-Schema tool definition a calling agent would
 * receive. Generating it from the same Zod-validated artifact that replay
 * executes is the point: there is one description of a capability's contract,
 * not a hand-maintained tool schema that drifts from what the automation
 * actually does.
 */

import { listArtifacts, loadArtifact, saveArtifact } from '../artifact/store.js';
import { toolDefinitionFor, catalogToolDefinitions } from '../catalog/tools.js';

export async function runCatalogCommand(
  action: string,
  capability: string | undefined,
  opts: { by: string; note: string; force?: boolean },
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
        // How many of the declared outcomes are actually backed by an
        // observation, rather than by the recording model's word. A reviewer
        // scanning the catalog should be able to see that without opening the
        // artifact.
        const byState = (state: string) => a.outcomes.filter((o) => o.evidence.state === state).length;
        const evidence = a.outcomes.length === 0
          ? ''
          : ` (${[
              byState('observed') > 0 ? `${byState('observed')} observed` : '',
              byState('refuted') > 0 ? `${byState('refuted')} REFUTED` : '',
              byState('hypothesised') > 0 ? `${byState('hypothesised')} unverified` : '',
            ].filter(Boolean).join(', ')})`;
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
      process.stdout.write(`Approved ${approved.id} v${approved.version} → ${path}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown catalog action "${action}". Use list, show, schema or approve.\n`);
      return 1;
  }
}
