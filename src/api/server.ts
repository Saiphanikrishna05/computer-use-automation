/**
 * The capability API: recorded automation, exposed as something you can call.
 *
 * Everything below this is unchanged. An invocation runs the same deterministic
 * replay the CLI runs, under the same policy, writing the same evidence. The
 * API is a front door, not a second path, and that distinction is the whole
 * reason it is thin: the moment it starts making decisions of its own, the
 * guarantees underneath stop being guarantees.
 *
 * Three things it deliberately does not do:
 *
 *  - **It does not accept credentials.** Injected parameters are absent from
 *    the published schema and are resolved per-tenant at execution time. A
 *    caller cannot supply an operator password, cannot see that one exists,
 *    and cannot be talked into revealing one.
 *  - **It does not authorise irreversible work.** A capability that commits
 *    something is refused by policy in the driver, exactly as it is from the
 *    CLI. The API reports the refusal; it cannot override it. A wrapper that
 *    could would be a way around the guardrails rather than a way to reach
 *    them.
 *  - **It does not summarise away the result type.** Success, business
 *    outcome, escalation and failure arrive as four distinct shapes, because
 *    the distinction between "no such member" and "something broke" is the one
 *    a caller most needs and the easiest for a convenience layer to erase.
 */

import express from 'express';
import type { Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { catalogToolDefinitions, toolDefinitionFor } from '../catalog/tools.js';
import { listArtifacts, loadArtifact } from '../artifact/store.js';
import { runReplayCommand } from '../cli/replay-command.js';
import { freshnessReport, summariseFreshness } from '../artifact/staleness.js';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_TENANT, TENANT_RUNTIMES, modelConfig, voiceModel } from '../config.js';
import type { ReplayResult } from '../replay/result.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ApiServerOptions {
  port: number;
  /** Default tenant for invocations that do not name one. */
  tenant: string;
  headless?: boolean;
}

/**
 * What the chatbot is told, and the two things it must not do.
 *
 * It stands in for the AI agent a real deployment would put here, and its only
 * job is to turn a sentence into a typed call. It has no view of the console it
 * is driving and no way to reach it except through a published capability,
 * which is the point: the surface an agent can touch is exactly the set of
 * things a human approved.
 */
const CHAT_SYSTEM = `You are the assistant a member services representative talks to. They are already authenticated at their terminal; the tools you hold operate their institution's own systems under their existing entitlements.

Answer in one or two short sentences, the way a colleague would. Say amounts as a person would: "forty-two thousand and one dollars".

Some tools come back with an "outcome" rather than data — that no such member exists, that a share is on hold, that the balance is insufficient. Those are real answers, not failures. Report them plainly and do not retry.

Some come back as "needs_human". That means the work stopped on purpose because a step would move money or is otherwise irreversible, and a person has to authorise it. Say clearly what stopped and why. Never imply you completed it, and never try again.

If no tool covers what was asked, say you do not have a way to do it. Do not guess.`;

/** What a caller gets back. Deliberately mirrors the internal result contract
 *  rather than flattening it. */
export type InvocationResult =
  | { status: 'success'; capability: string; outputs: Record<string, unknown>; runId: string; durationMs: number; degradedLocators: number }
  | { status: 'business_outcome'; capability: string; outcome: string; explanation: string; runId: string; durationMs: number }
  | { status: 'needs_human'; capability: string; reason: string; step?: string; runId: string; durationMs: number }
  | { status: 'failure'; capability: string; code: string; expected: string; observed: string; step?: string; runId: string; durationMs: number };

/**
 * Maps a replay result onto the wire.
 *
 * `needs_human` covers both an explicit escalation and a policy refusal of an
 * irreversible step, because to a caller they are the same fact — the work
 * stopped and a person has to decide — and distinguishing them here would only
 * invite a caller to treat one as retryable.
 */
export function toInvocationResult(capability: string, r: ReplayResult): InvocationResult {
  const base = { capability, runId: r.evidence.runId, durationMs: r.durationMs };
  switch (r.status) {
    case 'success':
      return { ...base, status: 'success', outputs: r.outputs, degradedLocators: r.degradedResolutions };
    case 'business_outcome':
      return { ...base, status: 'business_outcome', outcome: r.outcome, explanation: r.outcomeDescription };
    case 'escalated':
      return { ...base, status: 'needs_human', reason: r.reason };
    case 'failure':
      if (r.error.code === 'POLICY_BLOCKED') {
        return { ...base, status: 'needs_human', reason: r.error.observed, ...(r.error.stepId ? { step: r.error.stepId } : {}) };
      }
      return {
        ...base,
        status: 'failure',
        code: r.error.code,
        expected: r.error.expected,
        observed: r.error.observed,
        ...(r.error.stepId ? { step: r.error.stepId } : {}),
      };
  }
}

export interface RunSummary {
  runId: string;
  kind: 'discovery' | 'replay' | 'probe' | 'other';
  capability?: string;
  tenant?: string;
  status?: string;
  outcome?: string;
  failureCode?: string;
  startedAt?: string;
  durationMs?: number;
  degradedLocators?: number;
  screenshots: number;
  domSnapshots: number;
  path: string;
}

const RUN_ROOTS = ['runs', 'evidence'];

/** Every run on disk, newest first. Working output and committed evidence
 *  both, because a reviewer wants to see what just happened as readily as what
 *  was curated. */
export function listRuns(limit = 60): RunSummary[] {
  const out: RunSummary[] = [];

  for (const root of RUN_ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      const logPath = join(dir, 'log.jsonl');
      if (!existsSync(logPath)) continue;

      const kind: RunSummary['kind'] = entry.includes('discovery')
        ? 'discovery'
        : entry.includes('probe')
          ? 'probe'
          : entry.includes('replay')
            ? 'replay'
            : 'other';

      const summary: RunSummary = {
        runId: entry,
        kind,
        screenshots: countIn(join(dir, 'screenshots')),
        domSnapshots: countIn(join(dir, 'dom')),
        path: dir,
      };

      const resultPath = join(dir, 'result.json');
      if (existsSync(resultPath)) {
        try {
          const r = JSON.parse(readFileSync(resultPath, 'utf8')) as ReplayResult;
          summary.capability = r.capabilityId;
          summary.tenant = r.tenantId;
          summary.status = r.status;
          summary.startedAt = r.startedAt;
          summary.durationMs = r.durationMs;
          summary.degradedLocators = r.degradedResolutions;
          if (r.status === 'business_outcome') summary.outcome = r.outcome;
          if (r.status === 'failure') summary.failureCode = r.error.code;
        } catch { /* a malformed bundle is listed without detail, not dropped */ }
      } else {
        // Discovery and probe bundles have no result.json; the first log line
        // still says what they were.
        try {
          const first = readFileSync(logPath, 'utf8').split('\n')[0];
          if (first) {
            const e = JSON.parse(first) as { ts?: string; message?: string; data?: { capability?: string } };
            summary.startedAt = e.ts;
            summary.capability = e.data?.capability;
            summary.status = kind;
          }
        } catch { /* as above */ }
      }
      out.push(summary);
    }
  }

  return out
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, limit);
}

function countIn(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

export function readRun(runId: string): { events: unknown[]; result?: unknown; screenshots: string[] } | undefined {
  for (const root of RUN_ROOTS) {
    const dir = join(root, runId);
    if (!existsSync(join(dir, 'log.jsonl'))) continue;
    const events = readFileSync(join(dir, 'log.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const resultPath = join(dir, 'result.json');
    const shotDir = join(dir, 'screenshots');
    return {
      events,
      ...(existsSync(resultPath) ? { result: JSON.parse(readFileSync(resultPath, 'utf8')) } : {}),
      screenshots: existsSync(shotDir) ? readdirSync(shotDir) : [],
    };
  }
  return undefined;
}

export async function startApiServer(options: ApiServerOptions): Promise<Server> {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(HERE, 'public')));
  // /chat is a page, not an endpoint; the API lives under /api.
  app.get('/chat', (_req, res) => res.sendFile(join(HERE, 'public', 'chat.html')));

  // --- the callable catalog ------------------------------------------------

  const scope = TENANT_RUNTIMES[options.tenant]?.app;

  app.get('/api/capabilities', (_req, res) => {
    const artifacts = listArtifacts();
    res.json(
      catalogToolDefinitions().map((tool) => {
        const artifact = artifacts.find((a) => a.id === tool.name);
        return {
          ...tool,
          risk: artifact?.maxRisk,
          approval: artifact?.approval.state,
          outcomes: artifact?.outcomes.map((o) => ({ code: o.code, evidence: o.evidence.state })) ?? [],
          evidenceSummary: artifact ? summariseFreshness(freshnessReport(artifact)) : '',
          // Which application this was recorded against. The store holds
          // capabilities for three different products; without saying so, a
          // dashboard headed "Meridian Core" lists a shopping cart and looks
          // like a bug rather than the point.
          app: artifact?.target.app
            ? { vendor: artifact.target.app.vendor, product: artifact.target.app.product }
            : undefined,
          servedHere:
            artifact?.target.app.vendor === scope?.vendor &&
            artifact?.target.app.product === scope?.product,
        };
      }),
    );
  });

  app.get('/api/capabilities/:id', (req, res) => {
    try {
      const artifact = loadArtifact(req.params.id);
      res.json({ tool: toolDefinitionFor(artifact), artifact });
    } catch {
      res.status(404).json({ error: `No capability "${req.params.id}"` });
    }
  });

  // --- invocation ----------------------------------------------------------

  app.post('/api/capabilities/:id/invoke', async (req, res) => {
    const body = (req.body ?? {}) as { inputs?: Record<string, string>; tenant?: string };
    try {
      const result = await runReplayCommand({
        capability: req.params.id,
        inputs: body.inputs ?? {},
        tenant: body.tenant ?? options.tenant,
        headless: options.headless ?? true,
        // No operator console from an API call. A request that parked waiting
        // for a human at a terminal nobody is watching would hang the caller
        // and hide the escalation; reporting it is what lets the caller act.
        operator: false,
        json: true,
      });
      res.json(toInvocationResult(req.params.id, result));
    } catch (error) {
      res.status(400).json({
        status: 'failure',
        capability: req.params.id,
        code: 'INVOCATION_REJECTED',
        observed: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- the chatbot ---------------------------------------------------------
  //
  // A demo driver over the API, not a second product. It picks a capability and
  // fills its typed arguments; everything after that is the same invocation
  // path as a direct API call, guardrails included.

  /** The application this server is invoking against, used to scope what an
   *  agent is offered. */

  app.post('/api/chat', async (req, res) => {
    const message = String((req.body as { message?: unknown }).message ?? '').trim();
    if (!message) { res.status(400).json({ error: 'no message' }); return; }

    const model = modelConfig();
    const tools = catalogToolDefinitions(scope);
    if (!model.apiKey) {
      res.json({ reply: 'The understanding step needs a model, and no API key is configured here.', invocations: [] });
      return;
    }

    const started = Date.now();
    const invocations: InvocationResult[] = [];
    let doingMs = 0;

    try {
      const client = new Anthropic({ apiKey: model.apiKey });
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: message }];
      let said = '';

      for (let turn = 0; turn < 4; turn += 1) {
        const response = await client.messages.create({
          model: voiceModel(),
          max_tokens: 1_000,
          system: CHAT_SYSTEM,
          tools: tools as unknown as Anthropic.Tool[],
          messages,
        });
        if (response.stop_reason === 'refusal') { said = 'I am not able to answer that one.'; break; }

        messages.push({ role: 'assistant', content: response.content });
        for (const b of response.content) if (b.type === 'text' && b.text.trim()) said = b.text.trim();

        const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (uses.length === 0) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          const t0 = Date.now();
          const raw = await runReplayCommand({
            capability: use.name,
            inputs: use.input as Record<string, string>,
            tenant: options.tenant,
            headless: options.headless ?? true,
            operator: false,
            json: true,
          });
          doingMs += Date.now() - t0;
          const shaped = toInvocationResult(use.name, raw);
          invocations.push(shaped);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(shaped),
            // Only a genuine fault is an error. A business outcome and a stop
            // for human authorisation are both successful calls carrying a real
            // answer, and flagging them as errors is what makes an agent retry.
            ...(shaped.status === 'failure' ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }

      const totalMs = Date.now() - started;
      res.json({
        reply: said || 'I did not catch that.',
        invocations,
        timing: { understandingMs: Math.max(0, totalMs - doingMs), doingMs, totalMs },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), invocations });
    }
  });

  // --- what happened -------------------------------------------------------

  app.get('/api/runs', (req, res) => {
    const limit = Number(req.query.limit ?? 60);
    res.json(listRuns(Number.isFinite(limit) ? limit : 60));
  });

  app.get('/api/runs/:runId', (req, res) => {
    const run = readRun(req.params.runId);
    if (!run) { res.status(404).json({ error: `No run "${req.params.runId}"` }); return; }
    res.json(run);
  });

  app.get('/api/runs/:runId/screenshots/:name', (req, res) => {
    for (const root of RUN_ROOTS) {
      // Resolved against a fixed root and checked, so a crafted name cannot
      // walk out of the evidence directory.
      const path = join(root, req.params.runId, 'screenshots', req.params.name);
      if (existsSync(path) && path.startsWith(root)) { res.sendFile(path, { root: process.cwd() }); return; }
    }
    res.status(404).end();
  });

  app.get('/api/tenants', (_req, res) => {
    // "default" means the tenant this server is actually invoking against, not
    // the one compiled in as a fallback. The dashboard puts it in the header,
    // and a header naming the wrong institution is worse than no header.
    res.json(
      Object.values(TENANT_RUNTIMES).map((t) => ({
        id: t.id,
        name: t.name,
        baseUrl: t.baseUrl,
        default: t.id === options.tenant,
        configuredFallback: t.id === DEFAULT_TENANT,
      })),
    );
  });

  return new Promise((resolve) => {
    const server = app.listen(options.port, () => resolve(server));
  });
}
