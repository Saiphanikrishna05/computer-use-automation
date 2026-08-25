/**
 * `fleet`, the estate-wide view.
 *
 * Exits non-zero when anything is drifting or failing, so this can run on a
 * schedule and be the thing that notices, rather than a page someone has to
 * remember to open.
 */

import { listArtifacts } from '../artifact/store.js';
import { fleetHealth, renderFleet } from '../fleet/health.js';
import { TENANT_RUNTIMES } from '../config.js';

export interface FleetCommandOptions {
  json?: boolean;
}

export async function runFleetCommand(opts: FleetCommandOptions): Promise<number> {
  const artifacts = listArtifacts();
  const tenants = Object.keys(TENANT_RUNTIMES);
  const findings = fleetHealth(artifacts, tenants);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderFleet(findings, artifacts, tenants)}\n`);
  }

  return findings.some((f) => f.severity === 'drifting' || f.severity === 'failing') ? 2 : 0;
}
