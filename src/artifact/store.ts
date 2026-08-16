/**
 * Artifact persistence and tenant specialization.
 *
 * Storage is files on disk. A database would buy versioned queries and
 * concurrent writers, neither of which this system needs to demonstrate
 * anything, and the brief is explicit that building scaling infrastructure is
 * not rewarded. Files also make an artifact reviewable in a pull request,
 * which is the workflow a bank actually wants around automation that touches
 * member accounts.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilityArtifactSchema,
  TenantOverlaySchema,
  type CapabilityArtifact,
  type FrameStep,
  type TenantOverlay,
} from './schema.js';

const ARTIFACT_DIR = process.env.CUA_ARTIFACT_DIR ?? 'artifacts';
const OVERLAY_DIR = join(ARTIFACT_DIR, 'tenants');

function ensureDirs(): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(OVERLAY_DIR, { recursive: true });
}

export function artifactPath(id: string, version: number): string {
  return join(ARTIFACT_DIR, `${id}.v${version}.json`);
}

export function saveArtifact(artifact: CapabilityArtifact): string {
  ensureDirs();
  const parsed = CapabilityArtifactSchema.parse(artifact);
  const path = artifactPath(parsed.id, parsed.version);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return path;
}

export function listArtifacts(): CapabilityArtifact[] {
  ensureDirs();
  const byId = new Map<string, CapabilityArtifact>();
  for (const file of readdirSync(ARTIFACT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = CapabilityArtifactSchema.parse(
        JSON.parse(readFileSync(join(ARTIFACT_DIR, file), 'utf8')),
      );
      // Latest version wins when several are on disk. Older versions stay
      // readable by explicit path so a pinned caller is never broken by a
      // newer recording landing beside it.
      const existing = byId.get(parsed.id);
      if (!existing || parsed.version > existing.version) byId.set(parsed.id, parsed);
    } catch {
      // A malformed file is skipped rather than fatal: one bad artifact should
      // not make the whole catalog unlistable.
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function loadArtifact(id: string, version?: number): CapabilityArtifact {
  ensureDirs();
  if (version !== undefined) {
    const path = artifactPath(id, version);
    if (!existsSync(path)) throw new Error(`No artifact ${id} v${version} at ${path}`);
    return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }
  const found = listArtifacts().find((a) => a.id === id);
  if (!found) {
    const available = listArtifacts().map((a) => a.id).join(', ') || '(none)';
    throw new Error(`No artifact with id "${id}". Available: ${available}`);
  }
  return found;
}

export function saveOverlay(overlay: TenantOverlay): string {
  ensureDirs();
  const parsed = TenantOverlaySchema.parse(overlay);
  const path = join(OVERLAY_DIR, `${parsed.tenantId}.json`);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return path;
}

/**
 * Loads a tenant's overlay, preferring one written for this specific
 * capability.
 *
 * `<tenant>.<capability>.json` wins over the tenant-wide `<tenant>.json`.
 * Step overrides are keyed by step id, and step ids belong to a *recording* -
 * so an overlay that patches specific steps is really scoped to one
 * capability, and pretending otherwise is what let a set of overrides sit in
 * the wrong file doing nothing.
 */
export function loadOverlay(tenantId: string, capabilityId?: string): TenantOverlay {
  const candidates = capabilityId
    ? [join(OVERLAY_DIR, `${tenantId}.${capabilityId}.json`), join(OVERLAY_DIR, `${tenantId}.json`)]
    : [join(OVERLAY_DIR, `${tenantId}.json`)];

  for (const path of candidates) {
    if (existsSync(path)) return TenantOverlaySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }
  throw new Error(`No tenant overlay for "${tenantId}" at ${candidates.join(' or ')}`);
}

export function listOverlays(): TenantOverlay[] {
  ensureDirs();
  const out: TenantOverlay[] = [];
  for (const file of readdirSync(OVERLAY_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(TenantOverlaySchema.parse(JSON.parse(readFileSync(join(OVERLAY_DIR, file), 'utf8'))));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlay application
// ---------------------------------------------------------------------------

/**
 * Rewrites every `framePath` in the artifact through the tenant's alias map.
 *
 * This is done as a deep structural walk rather than at each known call site
 * because frame paths appear in five places, step targets, output extraction
 * targets, checkpoint conditions, outcome conditions and recovery targets -
 * and a per-site rewrite would silently miss whichever one gets added next.
 */
function rewriteFramePaths<T>(value: T, aliases: Record<string, string>): T {
  if (Array.isArray(value)) {
    return value.map((v) => rewriteFramePaths(v, aliases)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (key === 'framePath' && Array.isArray(child)) {
        out[key] = (child as FrameStep[]).map((step) =>
          step.name && aliases[step.name] ? { ...step, name: aliases[step.name] } : step,
        );
      } else {
        out[key] = rewriteFramePaths(child, aliases);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export interface SpecializedCapability {
  artifact: CapabilityArtifact;
  /** Template values contributed by the overlay, e.g. `baseUrl`. */
  bindings: Record<string, string>;
  /** Human-readable record of what the overlay changed, for the audit trail. */
  appliedChanges: string[];
}

export function applyOverlay(
  artifact: CapabilityArtifact,
  overlay: TenantOverlay | undefined,
): SpecializedCapability {
  if (!overlay) return { artifact, bindings: {}, appliedChanges: [] };

  if (overlay.appliesTo.vendor !== artifact.target.app.vendor || overlay.appliesTo.product !== artifact.target.app.product) {
    throw new Error(
      `Overlay ${overlay.tenantId} targets ${overlay.appliesTo.vendor}/${overlay.appliesTo.product}, ` +
        `but the capability was recorded against ${artifact.target.app.vendor}/${artifact.target.app.product}`,
    );
  }
  if (overlay.appliesTo.capabilityId && overlay.appliesTo.capabilityId !== artifact.id) {
    throw new Error(`Overlay ${overlay.tenantId} does not apply to capability ${artifact.id}`);
  }

  const changes: string[] = [];
  let next: CapabilityArtifact = artifact;

  if (Object.keys(overlay.frameAliases).length > 0) {
    next = rewriteFramePaths(next, overlay.frameAliases);
    for (const [from, to] of Object.entries(overlay.frameAliases)) {
      changes.push(`frame "${from}" → "${to}"`);
    }
  }

  if (Object.keys(overlay.stepOverrides).length > 0) {
    // An override that matches no step is a configuration error, and it has to
    // be a loud one.
    //
    // Overrides are keyed by step id, which couples an overlay to a particular
    // recording: re-record a capability and the generated ids change, orphaning
    // every override written against the old ones. That happened here. Nothing
    // failed, the overlay carried this tenant's reworded button and its
    // relabelled field, neither was applied, and two locators quietly resolved
    // three tiers lower than intended. The run still passed, only because both
    // tenants happen to share a form field name.
    //
    // A capability running without its tenant's corrections is precisely the
    // failure this system exists to prevent, so refusing to start is the
    // correct behaviour: a wrong screen acted on confidently is worse than a
    // replay that stops and says why.
    const stepIds = new Set(next.steps.map((s) => s.id));
    const orphaned = Object.keys(overlay.stepOverrides).filter((id) => !stepIds.has(id));
    if (orphaned.length > 0) {
      throw new Error(
        `Tenant overlay "${overlay.tenantId}" declares an override for step(s) ` +
          `${orphaned.map((id) => `"${id}"`).join(', ')}, which do not exist in capability ` +
          `"${artifact.id}" v${artifact.version} (its steps are ` +
          `${[...stepIds].map((id) => `"${id}"`).join(', ')}). ` +
          `This usually means the capability was re-recorded and the overlay was not updated.`,
      );
    }

    next = {
      ...next,
      steps: next.steps
        .map((step) => {
          const override = overlay.stepOverrides[step.id];
          if (!override) return step;
          if (override.skip) {
            changes.push(`step "${step.id}" skipped`);
            return undefined;
          }
          const patched = { ...step };
          if (override.target && 'target' in patched.action) {
            patched.action = { ...patched.action, target: override.target };
            changes.push(`step "${step.id}" target overridden`);
          }
          if (override.valueTemplate && 'valueTemplate' in patched.action) {
            patched.action = { ...patched.action, valueTemplate: override.valueTemplate };
            changes.push(`step "${step.id}" value overridden`);
          }
          return patched;
        })
        .filter((s): s is NonNullable<typeof s> => s !== undefined),
    };
  }

  if (overlay.extraRecovery.length > 0) {
    next = { ...next, recovery: [...next.recovery, ...overlay.extraRecovery] };
    for (const rule of overlay.extraRecovery) changes.push(`recovery rule "${rule.code}" added`);
  }

  return { artifact: next, bindings: overlay.bindings, appliedChanges: changes };
}
