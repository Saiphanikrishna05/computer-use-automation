/**
 * The governance log: append-only, and tamper-evident.
 *
 * An artifact records who approved it. That is a claim the artifact makes about
 * itself, in a file anyone who can edit the file can change, and it is exactly
 * the kind of claim an examiner is paid not to take at face value. `humanEdits`
 * is a good record and a poor control: rewrite history and it agrees with you.
 *
 * So every governance act — an approval, a probe result, a repair proposal —
 * also appends a line here, and each line carries the hash of the one before
 * it. That makes the log **tamper-evident** rather than tamper-proof, which is
 * the honest and achievable property for a file on disk:
 *
 *   - append a line and the chain still verifies
 *   - change an old line and every hash after it stops matching
 *   - delete a line and the chain breaks at that point
 *   - rewrite the whole file consistently and the chain verifies again
 *
 * That last one matters and is why this is not a blockchain and does not
 * pretend to be. Someone with write access to the file can forge a consistent
 * history. What they cannot do is edit *one entry* quietly, which is the
 * realistic failure mode: not a determined attacker, but an approval quietly
 * back-dated, or an inconvenient probe result removed before an audit. The
 * chain turns that from undetectable into obvious.
 *
 * Deliberately **no authentication**. A real deployment resolves the actor from
 * whatever identity system the institution already runs, and inventing a user
 * store here would be building the least interesting half of the problem while
 * claiming to have solved the interesting one. `actor` is recorded as asserted,
 * and the schema says so.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export type GovernanceAction = 'approved' | 'probed' | 'repair_proposed' | 'assisted' | 'discovered';

export interface AuditEntry {
  /** Position in the chain, from 1. */
  seq: number;
  at: string;
  action: GovernanceAction;
  capabilityId: string;
  capabilityVersion: number;
  /** Who did this, **as asserted by the caller**. Not authenticated here; a
   *  deployment binds it to the institution's own identity system. */
  actor: string;
  summary: string;
  /** Evidence bundle backing this entry, where one exists. */
  runId?: string;
  /** Hash of the previous entry, or the empty string for the first. */
  prev: string;
  /** Hash of this entry's content plus `prev`. */
  hash: string;
}

const DEFAULT_PATH = process.env.CUA_AUDIT_LOG ?? 'audit-log.jsonl';

/** Everything except the hash itself, so verification recomputes exactly what
 *  was signed and a field added later cannot be silently excluded. */
function digest(entry: Omit<AuditEntry, 'hash'>): string {
  const canonical = JSON.stringify([
    entry.seq,
    entry.at,
    entry.action,
    entry.capabilityId,
    entry.capabilityVersion,
    entry.actor,
    entry.summary,
    entry.runId ?? '',
    entry.prev,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function readAuditLog(path = DEFAULT_PATH): AuditEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

export interface AppendInput {
  action: GovernanceAction;
  capabilityId: string;
  capabilityVersion: number;
  actor: string;
  summary: string;
  runId?: string;
}

/** Appends one entry, chained to the current tail. */
export function appendAudit(input: AppendInput, path = DEFAULT_PATH): AuditEntry {
  const existing = readAuditLog(path);
  const prev = existing.length > 0 ? existing[existing.length - 1]!.hash : '';

  const unsigned: Omit<AuditEntry, 'hash'> = {
    seq: existing.length + 1,
    at: new Date().toISOString(),
    action: input.action,
    capabilityId: input.capabilityId,
    capabilityVersion: input.capabilityVersion,
    actor: input.actor,
    summary: input.summary,
    ...(input.runId ? { runId: input.runId } : {}),
    prev,
  };

  const entry: AuditEntry = { ...unsigned, hash: digest(unsigned) };
  mkdirSync(dirname(path) === '' ? '.' : dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

export type VerifyResult =
  | { ok: true; entries: number }
  | { ok: false; entries: number; brokenAt: number; reason: string };

/**
 * Walks the chain and reports the first entry that does not agree with it.
 *
 * Reports the *first* break rather than a count, because that is the entry
 * someone has to go and explain, and everything after it is a consequence
 * rather than a separate finding.
 */
export function verifyAuditLog(path = DEFAULT_PATH): VerifyResult {
  const entries = readAuditLog(path);
  let prev = '';

  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return { ok: false, entries: entries.length, brokenAt: index + 1, reason: `entry ${index + 1} is numbered ${entry.seq}; a line was inserted or removed` };
    }
    if (entry.prev !== prev) {
      return { ok: false, entries: entries.length, brokenAt: entry.seq, reason: `entry ${entry.seq} does not follow the entry before it` };
    }
    const { hash, ...unsigned } = entry;
    if (digest(unsigned) !== hash) {
      return { ok: false, entries: entries.length, brokenAt: entry.seq, reason: `entry ${entry.seq} has been altered since it was written` };
    }
    prev = hash;
  }

  return { ok: true, entries: entries.length };
}

/** Every entry concerning one capability, in order. */
export function historyOf(capabilityId: string, path = DEFAULT_PATH): AuditEntry[] {
  return readAuditLog(path).filter((e) => e.capabilityId === capabilityId);
}
