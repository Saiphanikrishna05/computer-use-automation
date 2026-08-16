/**
 * The control lease.
 *
 * The brief asks for "a way to know who is (or should be) in control". This is
 * that way, made explicit rather than implied.
 *
 * The problem it solves is concrete: when automation pauses and a human takes
 * over the *same live session*, the two can race. The automation's pending
 * `waitForSelector` fires while the human is mid-form; a retry loop clicks the
 * button the human just clicked. Treating "paused" as an absence of activity
 * is not enough, control has to be a single, explicit, checked value.
 *
 *   AUTOMATION ──requestHandoff──▶ HANDOFF_REQUESTED ──grant──▶ HUMAN
 *        ▲                                                        │
 *        └──────────── RESUMING ◀────────── returnControl ────────┘
 *
 * The driver asserts it holds the lease before *every* action, so an automation
 * path that forgets to check gets an exception rather than a race. HANDOFF_
 * REQUESTED exists as a distinct state because the automation may be mid-action
 * when the request is raised; it finishes the current action, then stops.
 */

import { EventEmitter } from 'node:events';

export type LeaseState = 'AUTOMATION' | 'HANDOFF_REQUESTED' | 'HUMAN' | 'RESUMING';
export type ControlHolder = 'automation' | 'human' | 'nobody';

export interface LeaseTransition {
  from: LeaseState;
  to: LeaseState;
  at: string;
  actor: string;
  reason?: string;
}

export class ControlLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlLeaseError';
  }
}

export class ControlLease extends EventEmitter {
  private _state: LeaseState = 'AUTOMATION';
  private readonly _history: LeaseTransition[] = [];
  private waiters: Array<() => void> = [];

  constructor(readonly sessionId: string) {
    super();
  }

  get state(): LeaseState {
    return this._state;
  }

  get holder(): ControlHolder {
    switch (this._state) {
      case 'AUTOMATION':
        return 'automation';
      case 'HUMAN':
        return 'human';
      // Mid-transfer, nobody may act. This is the state that prevents the race.
      case 'HANDOFF_REQUESTED':
      case 'RESUMING':
        return 'nobody';
    }
  }

  get history(): readonly LeaseTransition[] {
    return this._history;
  }

  /** True only when automation may safely touch the surface. */
  get automationMayAct(): boolean {
    return this._state === 'AUTOMATION';
  }

  private transition(to: LeaseState, actor: string, reason?: string): void {
    const t: LeaseTransition = { from: this._state, to, at: new Date().toISOString(), actor, reason };
    this._state = to;
    this._history.push(t);
    this.emit('transition', t);

    if (to === 'AUTOMATION') {
      const pending = this.waiters;
      this.waiters = [];
      for (const resolve of pending) resolve();
    }
  }

  /** Automation asks to hand off. It must stop acting after its current action. */
  requestHandoff(reason: string, actor = 'automation'): void {
    if (this._state !== 'AUTOMATION') {
      throw new ControlLeaseError(`Cannot request handoff from state ${this._state}`);
    }
    this.transition('HANDOFF_REQUESTED', actor, reason);
  }

  /** A human operator picks up the request and takes the session. */
  grantToHuman(operatorId: string): void {
    if (this._state !== 'HANDOFF_REQUESTED') {
      throw new ControlLeaseError(`Cannot grant control to a human from state ${this._state}`);
    }
    this.transition('HUMAN', operatorId, 'operator took control');
  }

  /** The human signals they are done; automation is not yet cleared to act. */
  beginReturn(operatorId: string, note?: string): void {
    if (this._state !== 'HUMAN') {
      throw new ControlLeaseError(`Cannot return control from state ${this._state}`);
    }
    this.transition('RESUMING', operatorId, note ?? 'operator returned control');
  }

  /** The run has re-observed the surface and is cleared to continue. */
  completeReturn(actor = 'automation'): void {
    if (this._state !== 'RESUMING') {
      throw new ControlLeaseError(`Cannot complete return from state ${this._state}`);
    }
    this.transition('AUTOMATION', actor, 'automation resumed');
  }

  /**
   * Called by the driver before every action. Cheap, and the reason the whole
   * mechanism is trustworthy: there is no way to act without passing it.
   */
  assertAutomationHolds(action: string): void {
    if (this._state !== 'AUTOMATION') {
      throw new ControlLeaseError(
        `Automation attempted "${action}" while control was ${this.holder} (lease state ${this._state})`,
      );
    }
  }

  /** Resolves when automation holds the lease again. */
  waitForAutomation(): Promise<void> {
    if (this._state === 'AUTOMATION') return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
