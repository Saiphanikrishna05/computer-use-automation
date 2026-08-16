/**
 * Two institutions running the same vendor product.
 *
 * This is the multi-tenant story made concrete. Both tenants run "Meridian
 * Core, Servicing Console 1.x". The flow is identical. What differs is
 * exactly what differs in the real world:
 *
 *   - branding and page titles,
 *   - the *names of the frames* (a per-tenant deployment setting),
 *   - button wording ("Search" vs "Find Member"),
 *   - and one tenant has an extra login-time system notice the other doesn't.
 *
 * None of those are flow changes, so none of them justify re-recording the
 * capability. They are exactly the class of difference a tenant overlay is
 * supposed to absorb, which is the point the second tenant exists to prove.
 */

export interface TenantConfig {
  id: string;
  name: string;
  shortName: string;
  productVersion: string;
  accentColor: string;
  frames: { nav: string; content: string };
  /** Wording differences that force the locator ladder to earn its keep. */
  labels: {
    searchButton: string;
    memberIdField: string;
    savingsRowLabel: string;
  };
  /** Tenant B interrupts the first console load with a notice modal. */
  showsLoginNotice: boolean;
  port: number;
}

export const MERIDIAN_TENANT: TenantConfig = {
  id: 'northpoint-fcu',
  name: 'Northpoint Federal Credit Union',
  shortName: 'Northpoint FCU',
  productVersion: '1.4.2',
  accentColor: '#1c3f60',
  frames: { nav: 'navFrame', content: 'contentFrame' },
  labels: {
    searchButton: 'Search',
    memberIdField: 'Member ID',
    savingsRowLabel: 'Savings',
  },
  showsLoginNotice: false,
  port: Number(process.env.CUA_TARGET_PORT ?? 4173),
};

export const CASCADE_TENANT: TenantConfig = {
  id: 'cascade-cu',
  name: 'Cascade Community Credit Union',
  shortName: 'Cascade CU',
  productVersion: '1.4.7',
  accentColor: '#2f5d3a',
  // Same product, different deployment-time frame names. This single line is
  // what a naive index- or name-hardcoded automation would break on.
  frames: { nav: 'menuFrame', content: 'mainFrame' },
  labels: {
    searchButton: 'Find Member',
    memberIdField: 'Member Number',
    savingsRowLabel: 'Regular Savings',
  },
  showsLoginNotice: true,
  port: Number(process.env.CUA_TENANT_B_PORT ?? 4174),
};

export const TENANTS: Record<string, TenantConfig> = {
  [MERIDIAN_TENANT.id]: MERIDIAN_TENANT,
  [CASCADE_TENANT.id]: CASCADE_TENANT,
};
