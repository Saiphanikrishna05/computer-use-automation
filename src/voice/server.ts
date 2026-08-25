/**
 * The voice front door.
 *
 * This exists to make one architectural claim audible rather than arguable.
 *
 * A voice agent's turn has four parts: hear, understand, *do*, speak. Three of
 * those are milliseconds. The one that is not is "do", and it is the only one
 * this project is about. Put a model in that step, driving a screen, and the
 * caller waits forty seconds in silence; that is not a slow feature, it is a
 * dead call. Replace it with a recorded capability and the same work is a
 * second and a half, which is an ordinary conversational pause.
 *
 * So the endpoint below reports its timing *split*, and the split is the point:
 *
 *   understanding   a model, ~1s     unavoidable, and not what this system does
 *   doing           no model, ~1.5s  a recorded capability, deterministic
 *
 * Being straight about the first number matters. Something has to turn "what's
 * the balance for member 100001" into a typed call, and that something is a
 * model. Claiming otherwise would be claiming this project solved natural
 * language, which it did not. What it solved is the step after.
 *
 * Two routing modes, because a demo that depends on a network is a demo that
 * fails in the room:
 *
 *   llm     a real model chooses the capability, as a real deployment would
 *   rules   a deterministic matcher, for when there is no key or no wifi
 *
 * The rules mode is honest about what it is: it recognises a handful of
 * phrasings and nothing else. It is a stand-in for the understanding step, not
 * a claim to have replaced it.
 */

import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { catalogToolDefinitions } from '../catalog/tools.js';
import { runReplayCommand } from '../cli/replay-command.js';
import type { ReplayResult } from '../replay/result.js';
import { loadArtifact } from '../artifact/store.js';
import { modelConfig, voiceModel } from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const SYSTEM = `You are the voice assistant for a credit union, speaking to a member services representative who is already authenticated at their terminal. Your tools operate the institution's own servicing systems under that person's existing entitlements.

You are speaking out loud, so answer in one or two short sentences. No lists, no markdown, no reading out identifiers digit by digit unless asked. Say amounts the way a person would: "four thousand one hundred eighty-two dollars and fifty-five cents".

Some tools return an "outcome" rather than data, for instance that no such member exists, or that this operator is not entitled to view a record. Those are real answers. Say so plainly and do not retry.

If no tool covers what was asked, say that you do not have a way to do it yet. Do not guess, and do not describe what you would do if you could.`;

export interface VoiceServerOptions {
  port: number;
  tenant: string;
  /** 'llm' uses a model to choose the capability; 'rules' uses a matcher. */
  route: 'llm' | 'rules';
  headless?: boolean;
}

export interface Invocation {
  capability: string;
  inputs: Record<string, unknown>;
  status: string;
  outputs?: Record<string, unknown>;
  outcome?: string;
  durationMs: number;
  evidencePath: string;
  degradedResolutions: number;
}

export interface AskResult {
  heard: string;
  spoken: string;
  matched: boolean;
  invocations: Invocation[];
  timing: { understandingMs: number; doingMs: number; totalMs: number };
  route: 'llm' | 'rules';
  catalog: string[];
}

export async function startVoiceServer(options: VoiceServerOptions): Promise<Server> {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(HERE, 'public')));

  app.get('/api/catalog', (_req, res) => {
    res.json({
      capabilities: catalogToolDefinitions().map((t) => ({ name: t.name, description: t.description })),
      route: options.route,
    });
  });

  app.post('/api/ask', async (req, res) => {
    const utterance = String((req.body as { utterance?: unknown }).utterance ?? '').trim();
    if (!utterance) {
      res.status(400).json({ error: 'no utterance' });
      return;
    }
    try {
      res.json(await ask(utterance, options));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(options.port, () => resolve(server));
  });
}

async function ask(utterance: string, options: VoiceServerOptions): Promise<AskResult> {
  const tools = catalogToolDefinitions();
  const started = Date.now();
  const invocations: Invocation[] = [];
  let doingMs = 0;

  /**
   * Runs one capability and records what it cost in wall-clock time.
   *
   * `doingMs` is accumulated separately from everything else so the split
   * survives into the response. A single number would hide exactly the thing
   * worth showing.
   */
  const invoke = async (capability: string, inputs: Record<string, unknown>) => {
    const t0 = Date.now();
    const result = await runReplayCommand({
      capability,
      inputs: inputs as Record<string, string>,
      tenant: options.tenant,
      headless: options.headless ?? true,
      operator: false,
      json: true,
    });
    doingMs += Date.now() - t0;

    invocations.push({
      capability,
      inputs,
      status: result.status,
      ...(result.status === 'success' ? { outputs: result.outputs } : {}),
      ...(result.status === 'business_outcome' ? { outcome: result.outcome } : {}),
      durationMs: result.durationMs,
      evidencePath: result.evidence.bundlePath,
      degradedResolutions: result.degradedResolutions,
    });
    return result;
  };

  const spoken =
    options.route === 'rules'
      ? await answerByRules(utterance, tools.map((t) => t.name), invoke)
      : await answerByModel(utterance, tools, invoke);

  const totalMs = Date.now() - started;
  return {
    heard: utterance,
    spoken,
    matched: invocations.length > 0,
    invocations,
    // Understanding is whatever was not spent driving the surface. Derived
    // rather than measured directly, so the two always sum to the total the
    // caller actually waited.
    timing: { understandingMs: Math.max(0, totalMs - doingMs), doingMs, totalMs },
    route: options.route,
    catalog: tools.map((t) => t.name),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Runs one capability. Typed as the real replay contract rather than a loose
 *  bag, so both routers narrow on `status` instead of casting their way to the
 *  fields they want. */
type Invoker = (capability: string, inputs: Record<string, unknown>) => Promise<ReplayResult>;

async function answerByModel(
  utterance: string,
  tools: ReturnType<typeof catalogToolDefinitions>,
  invoke: Invoker,
): Promise<string> {
  const model = modelConfig();
  if (!model.apiKey) {
    return 'The understanding step needs a model, and no API key is configured. Restart with --route rules to use the deterministic matcher instead.';
  }
  if (tools.length === 0) {
    return 'I do not have any approved capabilities yet, so there is nothing I can do.';
  }

  const client = new Anthropic({ apiKey: model.apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: utterance }];
  let said = '';

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await client.messages.create({
      model: voiceModel(),
      max_tokens: 1_000,
      system: SYSTEM,
      tools: tools as unknown as Anthropic.Tool[],
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return 'I am not able to answer that one.';
    }

    messages.push({ role: 'assistant', content: response.content });
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) said = block.text.trim();
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) return said || 'I did not catch that.';

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await invoke(use.name, use.input as Record<string, unknown>);
      // The agent receives the typed contract, not our internals. A business
      // outcome arrives as a successful call carrying a real answer, which is
      // what stops it retrying a member that does not exist.
      const payload =
        result.status === 'success'
          ? { status: 'success', outputs: result.outputs }
          : result.status === 'business_outcome'
            ? { status: 'outcome', outcome: result.outcome, explanation: result.outcomeDescription }
            : result.status === 'escalated'
              ? { status: 'escalated', explanation: 'A human operator is required to finish this.' }
              : { status: 'error', explanation: result.error.observed };

      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(payload),
        ...(payload.status === 'error' ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return said || 'I could not finish that.';
}

/**
 * The offline stand-in for understanding.
 *
 * Deliberately small and deliberately dumb: a member id, and a few ways people
 * ask for a balance. It exists so the demo survives a room with no wifi, not
 * because a regular expression is a natural-language system. When it does not
 * recognise something it says so, rather than guessing at the nearest
 * capability, because a voice assistant that acts on a misheard request is
 * worse than one that admits it did not follow.
 */
async function answerByRules(utterance: string, catalog: string[], invoke: Invoker): Promise<string> {
  const text = utterance.toLowerCase();
  const memberId = text.match(/\b(\d{6})\b/)?.[1];

  const wantsBalance = /\bbalance\b|\bhow much\b|\bsavings\b/.test(text);
  const capability = 'lookup_member_savings_balance';

  if (!wantsBalance || !catalog.includes(capability)) {
    return catalog.length === 0
      ? 'I do not have any approved capabilities yet, so there is nothing I can do.'
      : 'I do not have a way to do that yet.';
  }
  if (!memberId) {
    return 'I need a six digit member number for that.';
  }

  const result = await invoke(capability, { memberId });

  if (result.status === 'business_outcome') {
    return result.outcome === 'MEMBER_NOT_FOUND'
      ? `There is no member with the number ${memberId.split('').join(' ')}.`
      : 'That record is not one this operator is entitled to view.';
  }
  if (result.status !== 'success') {
    return 'Something went wrong reading that record.';
  }

  const outputs = result.outputs as { savingsBalance?: number; memberName?: string };
  const name = outputs.memberName ?? `member ${memberId}`;
  return `${name}'s savings balance is ${speakMoney(Number(outputs.savingsBalance ?? 0))}.`;
}

/** Speech synthesis reads "$4,182.55" as characters, so amounts are spelled
 *  into words before they are spoken. */
export function speakMoney(amount: number): string {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  const d = `${dollars.toLocaleString('en-US')} dollar${dollars === 1 ? '' : 's'}`;
  return cents === 0 ? d : `${d} and ${cents} cent${cents === 1 ? '' : 's'}`;
}

/** Whether a capability exists and is approved, used by the page to show the
 *  catalog state that makes "I cannot do that" a fact rather than a script. */
export function capabilityExists(id: string): boolean {
  try {
    return loadArtifact(id).approval.state === 'approved';
  } catch {
    return false;
  }
}
