/**
 * Fault injection.
 *
 * The brief is explicit that the interesting failures in a stable enterprise UI
 * are not layout drift; they are the runtime conditions that legitimately
 * happen: validation errors, "record not found", permission denials, unexpected
 * dialogs, session expiry, transient slowness, outright app errors.
 *
 * A demo app that only ever works cannot show how any of those are handled. So
 * the app can be told to produce each of them on demand, one request at a time,
 * from outside the automation. That makes the error-handling evidence
 * reproducible by a reviewer rather than something they have to take on faith.
 */

export const FAULT_KINDS = [
  'slow', // transient: a content request takes several seconds
  'app_error', // hard: HTTP 500 with the vendor's error page
  'session_expired', // recoverable: session dropped, re-auth required
  'unexpected_dialog', // recoverable: a native confirm() fires on load
  'validation_error', // business: the form rejects the input
  'permission_denied', // business: staff not entitled to this record
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

/** Which request a fault attaches to. `any` matches the next content request. */
export type FaultScope = 'any' | 'search' | 'member_detail' | 'sub_account';

interface ArmedFault {
  kind: FaultKind;
  scope: FaultScope;
  remaining: number;
}

export class FaultStore {
  private armed: ArmedFault[] = [];

  arm(kind: FaultKind, count = 1, scope: FaultScope = 'any'): void {
    this.armed.push({ kind, scope, remaining: Math.max(1, count) });
  }

  /** Returns and consumes the first fault armed for this scope, if any. */
  consume(scope: Exclude<FaultScope, 'any'>): FaultKind | undefined {
    const idx = this.armed.findIndex((f) => f.scope === scope || f.scope === 'any');
    if (idx === -1) return undefined;
    const fault = this.armed[idx]!;
    fault.remaining -= 1;
    if (fault.remaining <= 0) this.armed.splice(idx, 1);
    return fault.kind;
  }

  list(): ReadonlyArray<Readonly<ArmedFault>> {
    return this.armed.map((f) => ({ ...f }));
  }

  reset(): void {
    this.armed = [];
  }
}
