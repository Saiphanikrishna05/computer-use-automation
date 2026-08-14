/**
 * `catalog` — the agent-facing view of what capabilities exist.
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
  opts: { by: string; note: string },
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
        const gate = a.approval.state === 'approved' ? 'approved' : 'DRAFT — will not replay unattended';
        process.stdout.write(`  ${a.id}  v${a.version}\n`);
        process.stdout.write(`    ${a.title}\n`);
        process.stdout.write(`    risk: ${a.maxRisk} · ${gate}\n`);
        process.stdout.write(
          `    inputs: ${a.inputs.filter((i) => !i.injected).map((i) => i.name).join(', ') || '(none)'}` +
            ` → outputs: ${a.outputs.map((o) => o.name).join(', ') || '(none)'}\n`,
        );
        process.stdout.write(`    ${a.steps.length} steps · ${a.outcomes.length} declared outcomes · ${a.recovery.length} recovery rules\n\n`);
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
            { at: new Date().toISOString(), by: opts.by, note: `approved for unattended replay: ${opts.note}` },
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
