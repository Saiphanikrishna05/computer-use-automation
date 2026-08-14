import { describe, expect, it } from 'vitest';
import { ControlLease, ControlLeaseError } from '../src/escalation/lease.js';

describe('ControlLease', () => {
  it('starts with automation in control', () => {
    const lease = new ControlLease('run-1');
    expect(lease.state).toBe('AUTOMATION');
    expect(lease.holder).toBe('automation');
    expect(lease.automationMayAct).toBe(true);
  });

  it('walks the full handoff cycle back to automation', () => {
    const lease = new ControlLease('run-1');
    lease.requestHandoff('irreversible step needs authorisation');
    expect(lease.state).toBe('HANDOFF_REQUESTED');

    lease.grantToHuman('operator-7');
    expect(lease.holder).toBe('human');

    lease.beginReturn('operator-7', 'authorised and submitted manually');
    expect(lease.state).toBe('RESUMING');

    lease.completeReturn();
    expect(lease.state).toBe('AUTOMATION');
    expect(lease.history).toHaveLength(4);
  });

  it('gives control to nobody mid-transfer, which is what prevents the race', () => {
    const lease = new ControlLease('run-1');
    lease.requestHandoff('stuck');
    // The automation may still be finishing an in-flight action here, and the
    // operator has not picked up yet. Neither party may start something new.
    expect(lease.holder).toBe('nobody');
    expect(lease.automationMayAct).toBe(false);

    lease.grantToHuman('operator-7');
    lease.beginReturn('operator-7');
    expect(lease.holder).toBe('nobody');
  });

  it('refuses automation actions unless automation holds the lease', () => {
    const lease = new ControlLease('run-1');
    expect(() => lease.assertAutomationHolds('click')).not.toThrow();

    lease.requestHandoff('stuck');
    expect(() => lease.assertAutomationHolds('click')).toThrow(ControlLeaseError);

    lease.grantToHuman('operator-7');
    expect(() => lease.assertAutomationHolds('click')).toThrow(/control was human/);
  });

  it('rejects transitions that are not legal from the current state', () => {
    const lease = new ControlLease('run-1');
    expect(() => lease.grantToHuman('operator-7')).toThrow(ControlLeaseError);
    expect(() => lease.completeReturn()).toThrow(ControlLeaseError);

    lease.requestHandoff('stuck');
    expect(() => lease.requestHandoff('again')).toThrow(ControlLeaseError);
  });

  it('resolves waiters when control returns to automation', async () => {
    const lease = new ControlLease('run-1');
    lease.requestHandoff('stuck');
    lease.grantToHuman('operator-7');

    let resumed = false;
    const waiting = lease.waitForAutomation().then(() => {
      resumed = true;
    });

    expect(resumed).toBe(false);
    lease.beginReturn('operator-7');
    lease.completeReturn();
    await waiting;
    expect(resumed).toBe(true);
  });

  it('records who did what, for the audit trail', () => {
    const lease = new ControlLease('run-1');
    lease.requestHandoff('permission denied');
    lease.grantToHuman('operator-7');
    const [request, grant] = lease.history;
    expect(request?.actor).toBe('automation');
    expect(request?.reason).toBe('permission denied');
    expect(grant?.actor).toBe('operator-7');
    expect(grant?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
