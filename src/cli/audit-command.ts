/**
 * `audit`, the capability explained to the person who has to sign it off.
 *
 * Written to a file by default rather than to stdout, because the artefact this
 * produces is meant to be attached to a change record or handed to an examiner,
 * and a document that only ever existed in a terminal scrollback is not
 * evidence of anything.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadArtifact, listArtifacts } from '../artifact/store.js';
import { buildAuditPack, openQuestions, observedRuns } from '../audit/pack.js';

export interface AuditCommandOptions {
  capability?: string;
  version?: number;
  out?: string;
  stdout?: boolean;
}

export async function runAuditCommand(opts: AuditCommandOptions): Promise<number> {
  const artifacts = opts.capability ? [loadArtifact(opts.capability, opts.version)] : listArtifacts();

  for (const artifact of artifacts) {
    const pack = buildAuditPack(artifact);

    if (opts.stdout) {
      process.stdout.write(`${pack}\n`);
      continue;
    }

    const path = opts.out ?? `audit/${artifact.id}.v${artifact.version}.md`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${pack}\n`);

    const questions = openQuestions(artifact, observedRuns(artifact.id));
    const material = questions.filter((q) => q.severity === 'material').length;
    process.stdout.write(
      `  ${artifact.id} v${artifact.version} → ${path}\n` +
        `    ${questions.length} open question(s)` +
        (material > 0 ? `, ${material} material\n` : '\n'),
    );
  }

  // Material findings exit non-zero so this can gate a pipeline: a capability
  // that cannot vouch for itself should be able to fail a build, not merely
  // mention it in a document nobody opened.
  const anyMaterial = artifacts.some((a) =>
    openQuestions(a, observedRuns(a.id)).some((q) => q.severity === 'material'),
  );
  return anyMaterial ? 2 : 0;
}
