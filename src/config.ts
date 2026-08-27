/**
 * Runtime configuration.
 *
 * The credential section is the part worth reading. Operator credentials are
 * *not* in the artifact, not in the catalog's published tool schema, and not
 * supplied by the calling agent. They are resolved here, at execution time,
 * from the environment, which stands in for the secrets manager a real
 * deployment would use.
 *
 * That boundary is the point: an AI agent should be able to invoke
 * "look up member 100001's balance" without ever being in a position to leak,
 * log, or be tricked into revealing the credentials used to do it.
 */

import { config as loadDotenv } from 'dotenv';

loadDotenv();

export interface TenantRuntime {
  id: string;
  name: string;
  baseUrl: string;
  /** Overlay to apply, when this tenant is not the one the artifact was recorded on. */
  overlayId?: string;
}

export const TENANT_RUNTIMES: Record<string, TenantRuntime> = {
  /**
   * MERIDIAN CORE, hosted by interface.ai. The first target this system was
   * pointed at that I did not write, which is the whole point of it being
   * here: everything below is a base URL and a credential, and no code above
   * the driver changed to reach it.
   */
  'meridian-core': {
    id: 'meridian-core',
    name: 'Meridian Core · Cornerstone Financial Systems',
    baseUrl: process.env.CUA_MERIDIAN_URL ?? 'https://web-sample.interface-hiring.com',
  },
  'northpoint-fcu': {
    id: 'northpoint-fcu',
    name: 'Northpoint Federal Credit Union',
    baseUrl: `http://localhost:${process.env.CUA_TARGET_PORT ?? 4173}`,
  },
  'cascade-cu': {
    id: 'cascade-cu',
    name: 'Cascade Community Credit Union',
    baseUrl: `http://localhost:${process.env.CUA_TENANT_B_PORT ?? 4174}`,
    overlayId: 'cascade-cu',
  },
};

export const DEFAULT_TENANT = 'northpoint-fcu';

export interface OperatorCredentials {
  operatorId: string;
  operatorPassword: string;
  /**
   * Some targets sign on against a specific branch or terminal. Absent where
   * the application has no such concept, rather than defaulted to a value that
   * would silently be wrong somewhere.
   */
  branch?: string;
}

/**
 * A supervisor sign-on, where the application distinguishes one.
 *
 * Kept separate from the operator rather than being "the operator with more
 * rights", because they are different people: the whole point of a
 * supervisor-gated action is that the person performing it is not the person
 * who started it.
 */
export function resolveSupervisorCredentials(tenantId: string): OperatorCredentials | undefined {
  if (tenantId !== 'meridian-core') return undefined;
  return {
    operatorId: process.env.CUA_SUPERVISOR_ID ?? 'super1',
    operatorPassword: process.env.CUA_SUPERVISOR_PASSWORD ?? 'password',
    branch: process.env.CUA_MERIDIAN_BRANCH ?? '001',
  };
}

/**
 * Stand-in for a secrets manager. A real deployment resolves per-tenant
 * service credentials from a vault; the shape of the call is the same, which
 * is what matters for the design.
 */
export function resolveCredentials(tenantId: string): OperatorCredentials {
  // The parameter finally earns its keep. It was always here because a real
  // deployment resolves per-institution service credentials from a vault; a
  // second target with different operators is the first time that mattered.
  if (tenantId === 'meridian-core') {
    return {
      operatorId: process.env.CUA_MERIDIAN_OPERATOR ?? 'teller1',
      operatorPassword: process.env.CUA_MERIDIAN_PASSWORD ?? 'password',
      branch: process.env.CUA_MERIDIAN_BRANCH ?? '001',
    };
  }
  return {
    operatorId: process.env.CUA_OPERATOR_ID ?? 'teller01',
    operatorPassword: process.env.CUA_OPERATOR_PASSWORD ?? 'demo-password',
  };
}

export interface ModelConfig {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps: number;
  apiKey: string | undefined;
}

export function modelConfig(): ModelConfig {
  return {
    model: process.env.CUA_MODEL ?? 'claude-opus-5',
    effort: (process.env.CUA_EFFORT as ModelConfig['effort']) ?? 'high',
    maxSteps: Number(process.env.CUA_MAX_STEPS ?? 24),
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
}

/**
 * The model that turns a spoken request into a typed call.
 *
 * Deliberately not the discovery model. Discovery is one careful exploration
 * where reasoning quality is worth waiting for; routing an utterance is a
 * short, well-bounded classification that happens while a person is waiting to
 * hear something back. Opus spends four or five seconds on it, which in a voice
 * turn is not thoroughness, it is silence. A small fast model does the same job
 * inside a conversational pause, which is what a real deployment would use.
 */
export function voiceModel(): string {
  return process.env.CUA_VOICE_MODEL ?? 'claude-haiku-4-5-20251001';
}

export function headless(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return (process.env.CUA_HEADLESS ?? 'false').toLowerCase() === 'true';
}

export const OPERATOR_PORT = Number(process.env.CUA_OPERATOR_PORT ?? 7317);
