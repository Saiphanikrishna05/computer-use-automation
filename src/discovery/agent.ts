/**
 * The discovery agent: observe → decide → act, until the goal is met.
 *
 * The design decision that matters most here is that **the model points, it
 * does not author locators.** Its tools take a `ref` from the last observation.
 * We synthesize the durable descriptor from what perception measured about
 * that element (see `perception/candidates.ts`), and then — critically — we
 * act *through that descriptor*, not through the raw reference.
 *
 * That last part is what makes the emitted artifact trustworthy. Every step it
 * contains was executed by resolving exactly the descriptor the artifact will
 * carry, against exactly the resolution engine replay will use. A capability
 * cannot be recorded with a locator that has never successfully resolved,
 * because resolving it is how the action got performed in the first place.
 *
 * Two other properties worth stating:
 *
 *  - The model never sees unredacted data. Observations are built from the
 *    driver's snapshot, which is redacted at the boundary, so member tax IDs
 *    and dates of birth are already masked before they reach the prompt.
 *  - Page text is data, never instruction. The system prompt says so, and the
 *    allowlist below the model means a page that tries to redirect the agent
 *    produces a blocked-navigation event rather than a navigation.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SurfaceDriver, SurfaceSnapshot, UiNode } from '../surface/types.js';
import type { RunLogger } from '../evidence/logger.js';
import { PolicyViolation } from '../policy/engine.js';
import { descriptorFor, describeNode } from '../perception/candidates.js';
import { StepRecorder, type FinishDeclaration } from './recorder.js';
import { DISCOVERY_TOOLS, SYSTEM_PROMPT } from './prompt.js';
import type { CapabilityArtifact, ActionClass } from '../artifact/schema.js';

export interface DiscoveryOptions {
  goal: string;
  entryUrl: string;
  driver: SurfaceDriver;
  logger: RunLogger;
  recorder: StepRecorder;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
  apiKey: string;
  /** Told to the model so it can sign on; never persisted into the artifact. */
  credentials: { operatorId: string; operatorPassword: string };
}

export type DiscoveryResult =
  | { status: 'succeeded'; artifact: CapabilityArtifact; turns: number; summary: string }
  | { status: 'gave_up'; reason: string; turns: number }
  | { status: 'exhausted'; turns: number }
  | { status: 'refused'; category: string | null };

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const { driver, logger, recorder } = options;

  let snapshot: SurfaceSnapshot | undefined;
  let nodesByRef = new Map<string, UiNode>();

  const refresh = async (): Promise<SurfaceSnapshot> => {
    snapshot = await driver.snapshot();
    nodesByRef = new Map(snapshot.nodes.map((n) => [n.ref, n]));
    return snapshot;
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `GOAL: ${options.goal}`,
        '',
        `The application is already open at ${options.entryUrl}.`,
        `If the application asks you to sign on, use operator id "${options.credentials.operatorId}"`,
        `with password "${options.credentials.operatorPassword}".`,
        '',
        'Start by calling observe to see the current screen.',
      ].join('\n'),
    },
  ];

  const transcript: Array<{ turn: number; role: string; content: unknown }> = [];

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    logger.event('model_request', `turn ${turn}`, { turn, messageCount: messages.length });

    const request = {
      model: options.model,
      max_tokens: 8_000,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // The system prompt and tool list are byte-identical on every turn,
          // so the whole prefix is cacheable. On a twenty-turn run that is the
          // difference between paying for the instructions once and paying for
          // them twenty times.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: DISCOVERY_TOOLS,
      messages,
      // `output_config.effort` is current API surface; the installed SDK's
      // types lag it. Sent explicitly rather than dropped because effort is
      // the main cost/quality lever on a multi-turn agentic loop.
      output_config: { effort: options.effort },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    const response = await client.messages.create(request);

    // Safety classifiers can decline a request: HTTP 200, `stop_reason:
    // "refusal"`, empty content. Checked before reading content, because code
    // that indexes content[0] unconditionally breaks here.
    if (response.stop_reason === 'refusal') {
      const category = (response as { stop_details?: { category?: string | null } }).stop_details?.category ?? null;
      logger.event('error', `model refused (${category ?? 'unspecified'})`);
      return { status: 'refused', category };
    }

    messages.push({ role: 'assistant', content: response.content });
    transcript.push({ turn, role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logger.event('model_response', block.text.trim().slice(0, 500));
      }
    }

    if (toolUses.length === 0) {
      messages.push({
        role: 'user',
        content:
          'You did not call a tool. Call observe to look at the screen, an action tool to make progress, ' +
          'or finish if the goal is already met.',
      });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const input = use.input as Record<string, unknown>;
      logger.event('tool_call', `${use.name}`, { name: use.name, input: summarizeInput(use.name, input) });

      // --- terminal tools -------------------------------------------------
      if (use.name === 'finish') {
        const declaration = input as unknown as FinishDeclaration;
        const artifact = recorder.build(declaration);
        logger.writeJson('transcript.json', transcript);
        return {
          status: 'succeeded',
          artifact,
          turns: turn,
          summary: String(input.description ?? ''),
        };
      }

      if (use.name === 'give_up') {
        logger.writeJson('transcript.json', transcript);
        return { status: 'gave_up', reason: String(input.reason ?? 'unspecified'), turns: turn };
      }

      // --- observation ----------------------------------------------------
      if (use.name === 'observe') {
        const current = await refresh();
        const wantsScreenshot = input.withScreenshot === true;
        const content: Anthropic.ToolResultBlockParam['content'] = [
          { type: 'text', text: renderSnapshot(current) },
        ];
        if (wantsScreenshot) {
          const png = await driver.screenshot({ maskSensitive: true });
          logger.screenshot(`discovery-turn-${turn}`, png);
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          });
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content });
        continue;
      }

      // --- actions --------------------------------------------------------
      try {
        const outcome = await performAction(use.name, input, {
          driver,
          logger,
          recorder,
          nodesByRef,
          snapshot: snapshot ?? (await refresh()),
        });
        await refresh();
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome });
      } catch (error) {
        const message =
          error instanceof PolicyViolation
            ? `BLOCKED BY POLICY: ${error.message}. This action is not permitted. Choose a different approach.`
            : `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        logger.event('error', message);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: message, is_error: true });
      }
    }

    messages.push({ role: 'user', content: results });
  }

  logger.writeJson('transcript.json', transcript);
  return { status: 'exhausted', turns: options.maxTurns };
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

interface ActionContext {
  driver: SurfaceDriver;
  logger: RunLogger;
  recorder: StepRecorder;
  nodesByRef: Map<string, UiNode>;
  snapshot: SurfaceSnapshot;
}

const RISK_BY_TOOL: Record<string, ActionClass> = {
  navigate: 'read',
  click: 'mutate_reversible',
  type: 'mutate_reversible',
  select: 'mutate_reversible',
  press: 'mutate_reversible',
  extract_value: 'read',
};

async function performAction(
  name: string,
  input: Record<string, unknown>,
  ctx: ActionContext,
): Promise<string> {
  const { driver, recorder, snapshot } = ctx;
  const intent = String(input.intent ?? name);

  if (name === 'navigate') {
    const url = String(input.url);
    await driver.navigate(url);
    recorder.record({ kind: 'navigate', intent, risk: 'read', url });
    return `Navigated to ${url}. Call observe to see the new screen.`;
  }

  const ref = String(input.ref ?? '');
  const node = ctx.nodesByRef.get(ref);
  if (!node) {
    return `ERROR: no element with ref "${ref}" in the last observation. The page may have changed — call observe again.`;
  }

  // The descriptor is built first and then *used* to perform the action. If it
  // cannot resolve, the action does not happen and nothing is recorded — which
  // is exactly the guarantee we want, because a step whose locator only worked
  // via a raw index would fail the first time it was replayed.
  const descriptor = descriptorFor(node, snapshot.viewport);
  const resolved = await driver.resolve(descriptor);
  ctx.logger.event('resolution', `discovery ${name} → ${resolved.report.winningKind ?? 'unresolved'}`, {
    report: resolved.report,
  });

  if (!resolved.ok) {
    return (
      `ERROR: could not act on ${describeNode(node)} — the durable locator built from it ` +
      `${resolved.reason === 'ambiguous' ? 'matched several elements' : 'matched nothing'}. ` +
      `Pick a different element, or one with a clearer label.`
    );
  }

  switch (name) {
    case 'click':
      await driver.click(resolved.element);
      recorder.record({ kind: 'click', intent, risk: RISK_BY_TOOL[name]!, target: descriptor });
      return `Clicked ${describeNode(node)}. Call observe to see the result.`;

    case 'type': {
      const text = String(input.text ?? '');
      await driver.type(resolved.element, text, { clearFirst: true });
      recorder.record({ kind: 'type', intent, risk: RISK_BY_TOOL[name]!, target: descriptor, value: text });
      return `Typed into ${describeNode(node)}.`;
    }

    case 'select': {
      const value = String(input.value ?? '');
      await driver.selectOption(resolved.element, value);
      recorder.record({ kind: 'select', intent, risk: RISK_BY_TOOL[name]!, target: descriptor, value });
      return `Selected "${value}" in ${describeNode(node)}.`;
    }

    case 'press': {
      const key = String(input.key ?? 'Enter');
      await driver.press(key, resolved.element);
      recorder.record({ kind: 'press', intent, risk: RISK_BY_TOOL[name]!, target: descriptor, key });
      return `Pressed ${key}. Call observe to see the result.`;
    }

    case 'extract_value': {
      const value = await driver.read(resolved.element, 'text');
      recorder.declareOutput({
        name: String(input.name),
        type: (input.type as 'string' | 'number' | 'money' | 'boolean') ?? 'string',
        description: String(input.description ?? ''),
        sensitivity: (input.sensitivity as 'none' | 'pii' | 'financial' | 'secret') ?? 'none',
        target: descriptor,
        observedValue: value,
      });
      return `Recorded output "${String(input.name)}". Current value on screen: "${value}".`;
    }

    default:
      return `ERROR: unknown tool "${name}".`;
  }
}

// ---------------------------------------------------------------------------
// Observation rendering
// ---------------------------------------------------------------------------

/**
 * A compact text rendering of the element model.
 *
 * Text rather than a screenshot as the default: it is roughly two orders of
 * magnitude cheaper per turn, it is what the resolution engine actually
 * operates on, and it carries the signals a screenshot cannot — the panel a
 * control belongs to, the row and column a cell sits in, whether a label is a
 * real association or an inference. Screenshots are available on request for
 * the cases where layout genuinely matters.
 */
export function renderSnapshot(snapshot: SurfaceSnapshot): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `TITLE: ${snapshot.title}`,
    snapshot.dialog ? `NATIVE DIALOG OPEN (${snapshot.dialog.kind}): "${snapshot.dialog.message}"` : '',
    '',
    'ELEMENTS (act on these by ref):',
  ].filter(Boolean);

  const byFrame = new Map<string, UiNode[]>();
  for (const node of snapshot.nodes) {
    const key = node.framePath.map((f) => f.name ?? `#${f.ordinal}`).join(' › ') || '(main frame)';
    const list = byFrame.get(key) ?? [];
    list.push(node);
    byFrame.set(key, list);
  }

  for (const [frame, nodes] of byFrame) {
    lines.push('', `── frame: ${frame} ──`);
    for (const node of nodes) {
      const bits: string[] = [];
      if (node.nearestLabel) bits.push(`label:"${node.nearestLabel}"`);
      if (node.rowHeader) bits.push(`row:"${node.rowHeader}"`);
      if (node.columnHeader) bits.push(`col:"${node.columnHeader}"`);
      if (node.containerName) bits.push(`panel:"${node.containerName}"`);
      if (node.disabled) bits.push('disabled');
      if (node.value) bits.push(`value:"${node.value}"`);

      const label = node.name || node.text || '';
      lines.push(
        `  [${node.ref}] ${node.role}${label ? ` "${truncate(label, 60)}"` : ''}` +
          (bits.length ? `  (${bits.join(' · ')})` : ''),
      );
    }
  }

  return lines.join('\n');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function summarizeInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name === 'type') {
    // Typed text is logged, but the redactor still runs over it downstream and
    // the recorder templates credentials out of the artifact regardless.
    return { ref: input.ref, intent: input.intent, text: input.text };
  }
  return input;
}
