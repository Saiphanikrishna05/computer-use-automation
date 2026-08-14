/**
 * `agent-demo` — the loop closed.
 *
 * An AI agent is given a request in natural language and the catalog of
 * approved capabilities as callable tools. It decides *what* to do; this
 * system does *how*, deterministically, with no model anywhere near the UI.
 *
 * This is the shape the whole project exists to produce. The expensive,
 * non-deterministic reasoning happened once, during discovery. What runs in
 * production is a typed function call against a legacy screen that has no API
 * — and the agent invoking it neither knows nor needs to know that a browser
 * was involved.
 *
 * The detail worth noticing is how a business outcome comes back. When the
 * capability returns MEMBER_NOT_FOUND, that is handed to the agent as a
 * successful tool result describing a real answer — not as an error. An agent
 * told "the tool failed" retries; an agent told "there is no such member"
 * reports it and stops. Getting that distinction right is the difference
 * between a system that gives up gracefully and one that hammers a host
 * looking for a record that was never there.
 */

import Anthropic from '@anthropic-ai/sdk';
import { catalogToolDefinitions } from '../catalog/tools.js';
import { runReplayCommand } from './replay-command.js';
import { modelConfig } from '../config.js';

const SYSTEM = `You are an assistant used by staff inside a credit union's own servicing environment. The person talking to you is an authorised employee at their terminal, and the tools you have operate that institution's internal systems under their existing entitlements — the same screens they would drive by hand.

Use the tools to answer the request, then explain the result in plain language.

Some tools return an "outcome" instead of data — that no such member exists, or that the signed-on operator is not entitled to view a record. These are real answers, not failures. Report them plainly and do not retry the call.`;

export interface AgentDemoOptions {
  tenant: string;
  headless?: boolean;
}

export async function runAgentDemoCommand(request: string, opts: AgentDemoOptions): Promise<number> {
  const model = modelConfig();
  if (!model.apiKey) {
    process.stderr.write('\nANTHROPIC_API_KEY is not set. This demo needs a model to play the calling agent.\n\n');
    return 1;
  }

  const tools = catalogToolDefinitions();
  if (tools.length === 0) {
    process.stderr.write(
      '\nNo approved capabilities in the catalog.\n' +
        'Draft capabilities are deliberately not published to agents. Approve one first:\n' +
        '  npx tsx src/cli/index.ts catalog approve <capability>\n\n',
    );
    return 1;
  }

  process.stdout.write(`\n${'─'.repeat(72)}\n  Agent request: ${request}\n`);
  process.stdout.write(`  Capabilities offered: ${tools.map((t) => t.name).join(', ')}\n${'─'.repeat(72)}\n\n`);

  const client = new Anthropic({ apiKey: model.apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request }];

  for (let turn = 0; turn < 6; turn += 1) {
    // Safety classifiers can decline a request outright (HTTP 200 with
    // `stop_reason: "refusal"`). Server-side fallbacks re-run the declined
    // request on another model inside the same call, so a false positive on a
    // legitimate request degrades instead of failing. Worth having in any code
    // path a person is waiting on.
    const response = await client.beta.messages.create({
      model: model.model,
      max_tokens: 4_000,
      system: SYSTEM,
      tools: tools as unknown as Anthropic.Tool[],
      messages: messages as never,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as never) as unknown as Anthropic.Message;

    if (response.stop_reason === 'refusal') {
      const category = (response as { stop_details?: { category?: string | null } }).stop_details?.category;
      process.stderr.write(
        `The agent declined the request${category ? ` (category: ${category})` : ''}, and the fallback model ` +
          'declined it too.\n',
      );
      return 1;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        process.stdout.write(`${block.text.trim()}\n\n`);
      }
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) return 0;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      process.stdout.write(
        `  ▸ agent invokes capability "${use.name}" with ${JSON.stringify(use.input)}\n` +
          '    (executing deterministically — no model in the loop from here)\n\n',
      );

      const result = await runReplayCommand({
        capability: use.name,
        inputs: use.input as Record<string, string>,
        tenant: opts.tenant,
        headless: opts.headless ?? true,
        operator: false,
        json: true,
      });

      // What the agent gets back is the typed contract, not our internals: no
      // step reports, no resolution telemetry, no evidence paths. Those exist
      // for operators and auditors, and putting them in the model's context
      // would be tokens spent on something it cannot act on.
      const payload =
        result.status === 'success'
          ? { status: 'success', outputs: result.outputs }
          : result.status === 'business_outcome'
            ? { status: 'outcome', outcome: result.outcome, explanation: result.outcomeDescription }
            : result.status === 'escalated'
              ? { status: 'escalated', explanation: 'A human operator was required to complete this request.' }
              : { status: 'error', code: result.error.code, explanation: result.error.observed };

      process.stdout.write(`  ◂ ${JSON.stringify(payload)}\n\n`);

      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(payload),
        // Only a genuine failure is flagged as an error. A business outcome is
        // a successful call that returned a non-success answer.
        ...(payload.status === 'error' ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: results });
  }

  return 0;
}
