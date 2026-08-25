/**
 * The governance log.
 *
 * The property being tested is narrow and worth stating exactly, because it is
 * easy to overclaim: this is **tamper-evident, not tamper-proof**. Someone with
 * write access can rewrite the whole file consistently and the chain will
 * verify. What they cannot do is alter, remove or insert *one* entry quietly,
 * and that is the realistic failure mode — not a determined attacker, but an
 * approval back-dated or an inconvenient probe result removed the week before
 * an audit.
 *
 * So the tests below are mostly attacks: edit an entry, drop one, insert one,
 * and check the log says where.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, readAuditLog, verifyAuditLog, historyOf, type AuditEntry } from '../src/artifact/audit-log.js';

let logPath = '';
const fresh = () => {
  logPath = join(mkdtempSync(join(tmpdir(), 'cua-audit-')), 'audit-log.jsonl');
  return logPath;
};

const entry = (over: Partial<Parameters<typeof appendAudit>[0]> = {}) => ({
  action: 'approved' as const,
  capabilityId: 'lookup',
  capabilityVersion: 1,
  actor: 'a.reviewer',
  summary: 'reviewed and approved',
  ...over,
});

const rewrite = (path: string, mutate: (entries: AuditEntry[]) => AuditEntry[]) => {
  const entries = mutate(readAuditLog(path));
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
};

afterEach(() => {
  logPath = '';
});

describe('appendAudit', () => {
  it('chains each entry to the one before it', () => {
    const path = fresh();
    const first = appendAudit(entry(), path);
    const second = appendAudit(entry({ action: 'probed' }), path);

    expect(first.prev).toBe('');
    expect(second.prev).toBe(first.hash);
    expect(second.seq).toBe(2);
  });

  it('verifies a log nobody has touched', () => {
    const path = fresh();
    appendAudit(entry(), path);
    appendAudit(entry({ action: 'probed', actor: 'probe' }), path);
    appendAudit(entry({ action: 'repair_proposed', actor: 'replay' }), path);

    expect(verifyAuditLog(path)).toEqual({ ok: true, entries: 3 });
  });

  it('verifies an empty log rather than treating absence as tampering', () => {
    expect(verifyAuditLog(join(tmpdir(), 'no-such-audit.jsonl'))).toEqual({ ok: true, entries: 0 });
  });
});

describe('verifyAuditLog, under tampering', () => {
  it('catches an entry altered after the fact, and says which', () => {
    // The realistic one: an approval quietly reattributed or its note softened.
    const path = fresh();
    appendAudit(entry(), path);
    appendAudit(entry({ action: 'probed' }), path);
    rewrite(path, (es) => es.map((e, i) => (i === 0 ? { ...e, actor: 'someone.else' } : e)));

    const result = verifyAuditLog(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/altered/);
  });

  it('catches a removed entry', () => {
    // Deleting an inconvenient probe result is the version of this that would
    // actually happen.
    const path = fresh();
    appendAudit(entry(), path);
    appendAudit(entry({ action: 'probed', summary: '0 observed · 3 refuted' }), path);
    appendAudit(entry({ action: 'approved' }), path);
    rewrite(path, (es) => [es[0]!, es[2]!]);

    const result = verifyAuditLog(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenAt).toBe(2);
  });

  it('catches an entry spliced into the middle', () => {
    const path = fresh();
    appendAudit(entry(), path);
    appendAudit(entry({ action: 'probed' }), path);
    rewrite(path, (es) => [es[0]!, { ...es[1]!, seq: 2, summary: 'forged' }, { ...es[1]!, seq: 3 }]);

    expect(verifyAuditLog(path).ok).toBe(false);
  });

  it('still verifies after a legitimate append, so appending is not tampering', () => {
    const path = fresh();
    appendAudit(entry(), path);
    appendAudit(entry({ action: 'probed' }), path);
    expect(verifyAuditLog(path).ok).toBe(true);
    appendAudit(entry({ action: 'assisted' }), path);
    expect(verifyAuditLog(path)).toEqual({ ok: true, entries: 3 });
  });

  it('detects a wholesale consistent rewrite only by seq, which is the honest limit', () => {
    // Stated as a test rather than a caveat in prose: someone who can write the
    // file can forge a consistent history. This is tamper-EVIDENT, and the
    // claim should not be larger than that.
    const path = fresh();
    appendAudit(entry(), path);
    const forged = appendAudit(entry({ action: 'probed' }), path);
    rewrite(path, () => []);
    // A rewritten-from-scratch log verifies. Nothing here can prevent that.
    expect(verifyAuditLog(path)).toEqual({ ok: true, entries: 0 });
    expect(forged.hash).toBeTruthy();
  });
});

describe('historyOf', () => {
  it('returns only the entries for one capability, in order', () => {
    const path = fresh();
    appendAudit(entry({ capabilityId: 'lookup' }), path);
    appendAudit(entry({ capabilityId: 'open_sub_account' }), path);
    appendAudit(entry({ capabilityId: 'lookup', action: 'probed' }), path);

    const history = historyOf('lookup', path);
    expect(history.map((e) => e.action)).toEqual(['approved', 'probed']);
  });
});

describe('the log on disk', () => {
  it('is append-only in practice: earlier bytes are never rewritten', () => {
    const path = fresh();
    appendAudit(entry(), path);
    const afterFirst = readFileSync(path, 'utf8');
    appendAudit(entry({ action: 'probed' }), path);
    expect(readFileSync(path, 'utf8').startsWith(afterFirst)).toBe(true);
  });
});
