import { describe, it, expect } from 'vitest';
import { TENANT_RUNTIMES } from '../src/config.js';

/**
 * A capability is scoped to the application it was recorded against, and the
 * catalog filters on that scope. So an artifact stamped with the wrong product
 * does not fail loudly: it is simply absent from the tenant it was recorded
 * for, which is the worst way for a mistake like this to present.
 *
 * `mc_member_lookup_by_surname` was recorded against the meridian-core tenant
 * and stamped `meridian/servicing-console`, because the discover command
 * defaulted vendor and product to a literal instead of to the tenant. It
 * vanished from the catalog and nothing reported it.
 *
 * These pin the two halves of the fix: every tenant declares its application,
 * and no two tenants for different applications share a product name.
 */
describe('tenant application scoping', () => {
  it('gives every tenant an application to stamp its recordings with', () => {
    for (const [id, runtime] of Object.entries(TENANT_RUNTIMES)) {
      expect(runtime.app, `tenant "${id}" declares no application`).toBeDefined();
      expect(runtime.app?.vendor, `tenant "${id}" has no vendor`).toBeTruthy();
      expect(runtime.app?.product, `tenant "${id}" has no product`).toBeTruthy();
    }
  });

  it('keeps meridian-core distinct from the stand-in console', () => {
    // The specific collision that hid a capability: these must not be equal,
    // or the catalog cannot tell the two applications apart.
    const hosted = TENANT_RUNTIMES['meridian-core']?.app;
    const standIn = TENANT_RUNTIMES['northpoint-fcu']?.app;
    expect(hosted).toBeDefined();
    expect(standIn).toBeDefined();
    expect(hosted?.product).not.toBe(standIn?.product);
  });

  it('lets tenants on the same product share it, which is the point of the field', () => {
    // Two institutions running the same vendor product should match, so one
    // recording can serve both. That is the reuse the scope exists to permit.
    const a = TENANT_RUNTIMES['northpoint-fcu']?.app;
    const b = TENANT_RUNTIMES['cascade-cu']?.app;
    expect(a?.product).toBe(b?.product);
    expect(a?.vendor).toBe(b?.vendor);
  });
});
