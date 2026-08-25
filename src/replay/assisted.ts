/**
 * Assisted re-resolution: the one recovery strategy declared rules cannot cover.
 *
 * The artifact already declares how to recover from conditions someone
 * anticipated — a dialog, a session drop — and the executor already runs them
 * with a bounded budget. What no declared rule can express is the commonest way
 * a capability actually dies: the control moved, and every recorded locator
 * candidate now matches nothing. There is no condition to declare, because the
 * failure *is* the absence of the thing the rule would key on.
 *
 * So this asks a model, once, where the control went.
 *
 * ## Why this does not break the headline claim
 *
 * The claim this system rests on is that the model discovers and deterministic
 * code executes. Putting a model into replay complicates that sentence, so
 * every constraint below exists to keep it true:
 *
 *  - **Off unless asked for.** No opt-in, no call. The default replay path is
 *    still provably model-free, which is checkable by running it with no API
 *    key at all.
 *  - **Once per run, not per step.** Same reasoning as the recovery budget: a
 *    capability that needs this repeatedly is not recovering, it is broken, and
 *    the honest outcome is a failure a human looks at.
 *  - **It points; it does not author.** The model picks a `ref` from the
 *    current observation. The descriptor is synthesised from measured
 *    properties by the same code discovery uses, and the action is performed
 *    *through* that descriptor. A model asked to write a selector writes one
 *    that works on the screen in front of it.
 *  - **Policy is below it.** The action ceiling and the allowlist are enforced
 *    in the driver, on a path the model cannot address. An assisted step cannot
 *    do anything the step it replaces was not already permitted to do.
 *  - **It is recorded.** The result says a model was consulted, on which step,
 *    and what it chose. A run that quietly used a model and reported plain
 *    success would be the worst possible version of this feature.
 *  - **It repairs nothing.** The artifact is not edited. What comes out is a
 *    *proposal*, written to the evidence bundle, for a human to apply. An
 *    approved capability that rewrites itself mid-run is not an approved
 *    capability.
 *
 * The last one is the line between this and self-healing. Getting today's run
 * finished and changing what runs tomorrow are different acts, and only the
 * first is safe to do without a person.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Step, TargetDescriptor } from '../artifact/schema.js';
import type { SurfaceDriver, SurfaceElement } from '../surface/types.js';
import type { RunLogger } from '../evidence/logger.js';
import { descriptorFor, describeNode } from '../perception/candidates.js';
import { renderSnapshot } from '../discovery/agent.js';
import { modelConfig } from '../config.js';

const SYSTEM = `A recorded UI automation has failed to find one control. Every locator it had for that control now matches nothing, which usually means the application changed underneath the recording.

You will be given what the automation was trying to find, in its own words, and the elements currently on screen.

Pick the element that is the same control, and call \`point_at\` with its ref. Judge by what the control *is for*, not by where it sits: a button reworded from "Submit Inquiry" to "Run Inquiry" in the same panel is the same control; a different button that happens to be in the same position is not.

If nothing on this screen is that control, call \`not_present\`. That is a real and useful answer. A wrong guess here causes the automation to click something nobody intended, on a live account, so say you cannot see it rather than picking the nearest thing.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'point_at',
    description: 'Name the element that is the control the automation was looking for.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the list you were given.' },
        because: { type: 'string', description: 'Why this is the same control. One sentence.' },
      },
      required: ['ref', 'because'],
      additionalProperties: false,
    },
  },
  {
    name: 'not_present',
    description: 'The control is not on this screen. Preferred over a guess.',
    input_schema: {
      type: 'object',
      properties: { because: { type: 'string', description: 'What you looked for and did not find.' } },
      required: ['because'],
      additionalProperties: false,
    },
  },
];

export interface AssistedAttempt {
  stepId: string;
  /** What the artifact was looking for. */
  wanted: string;
  outcome: 'resolved' | 'not_present' | 'unavailable' | 'refused';
  /** The model's reason, in its own words, for the audit trail. */
  because?: string;
  /** Description of what it pointed at, when it pointed at something. */
  chose?: string;
  /** The descriptor synthesised from the chosen element, offered as a repair. */
  proposal?: TargetDescriptor;
}

export interface AssistedResult {
  attempt: AssistedAttempt;
  element?: SurfaceElement;
}

export interface AssistedOptions {
  step: Step;
  target: TargetDescriptor;
  driver: SurfaceDriver;
  logger: RunLogger;
}

/**
 * One model call to locate a control the artifact can no longer find.
 *
 * Returns the element only when the model pointed at something *and* the
 * descriptor synthesised from it resolved cleanly through the ordinary
 * resolution engine. That second condition is not a formality: it is what keeps
 * an assisted step to exactly the same standard as a recorded one, and it means
 * a repair that could not be replayed tomorrow is never used today.
 */
export async function assistedReresolve(options: AssistedOptions): Promise<AssistedResult> {
  const { step, target, driver, logger } = options;
  const wanted = target.description;
  const model = modelConfig();

  if (!model.apiKey) {
    logger.event('note', `assisted re-resolution unavailable for ${step.id}: no API key configured`);
    return { attempt: { stepId: step.id, wanted, outcome: 'unavailable' } };
  }

  logger.event('assisted_attempt', `asking a model where "${wanted}" went`, { stepId: step.id, wanted });

  const snapshot = await driver.snapshot();
  const nodesByRef = new Map(snapshot.nodes.map((n) => [n.ref, n]));

  const client = new Anthropic({ apiKey: model.apiKey });
  const response = await client.messages.create({
    model: model.model,
    max_tokens: 1_000,
    system: SYSTEM,
    tools: TOOLS,
    messages: [
      {
        role: 'user',
        content: [
          `The automation is trying to: ${step.intent}`,
          `The control it cannot find is described as: "${wanted}"`,
          '',
          'The screen as it is now:',
          '',
          renderSnapshot(snapshot),
        ].join('\n'),
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    logger.event('note', `assisted re-resolution declined by the model for ${step.id}`);
    return { attempt: { stepId: step.id, wanted, outcome: 'refused' } };
  }

  const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!call || call.name === 'not_present') {
    const because = String((call?.input as { because?: string } | undefined)?.because ?? 'no answer given');
    logger.event('note', `assisted re-resolution: control not on screen (${because})`);
    return { attempt: { stepId: step.id, wanted, outcome: 'not_present', because } };
  }

  const input = call.input as { ref?: string; because?: string };
  const node = input.ref ? nodesByRef.get(input.ref) : undefined;
  if (!node) {
    logger.event('note', `assisted re-resolution named ref "${input.ref}", which is not on screen`);
    return { attempt: { stepId: step.id, wanted, outcome: 'not_present', because: 'named an element that does not exist' } };
  }

  // Synthesised the same way a recorded step's descriptor is, then resolved
  // through the same engine. The model chose an element; it did not describe
  // one, and nothing it wrote becomes a locator.
  const proposal = descriptorFor(node, snapshot.viewport);
  const resolved = await driver.resolve(proposal);

  logger.event('assisted_attempt', `model chose ${describeNode(node)}`, {
    stepId: step.id,
    because: input.because,
    resolvedThroughProposal: resolved.ok,
    report: resolved.report,
  });

  if (!resolved.ok) {
    // It pointed at something real that we cannot address durably. Using it
    // would get this run through at the cost of a step nobody can replay.
    return {
      attempt: {
        stepId: step.id,
        wanted,
        outcome: 'not_present',
        because: 'the chosen element could not be described durably enough to replay',
        chose: describeNode(node),
      },
    };
  }

  return {
    attempt: {
      stepId: step.id,
      wanted,
      outcome: 'resolved',
      because: input.because ?? '',
      chose: describeNode(node),
      proposal,
    },
    element: resolved.element,
  };
}

/**
 * The durable output: a patch a human can read, decide on, and apply.
 *
 * Deliberately a document rather than an edit. A capability is approved on the
 * strength of what a reviewer read; a system that rewrites the approved thing
 * on its own has made that approval mean nothing. Writing the proposal next to
 * the evidence keeps the two acts separate: this run is finished, and whether
 * tomorrow's run changes is somebody's decision.
 */
export function repairProposal(capabilityId: string, version: number, attempts: AssistedAttempt[]): string {
  const repairs = attempts.filter((a) => a.outcome === 'resolved' && a.proposal);
  const lines: string[] = [];
  const w = (l = '') => lines.push(l);

  w(`# Proposed repair — \`${capabilityId}\` v${version}`);
  w();
  w(`Generated ${new Date().toISOString()} from a run in which ${attempts.length} step(s) could not find their `
    + 'control and a model was asked where it went.');
  w();
  w('**Nothing here has been applied.** The capability on disk is unchanged. This is a proposal, because a '
    + 'capability is approved on the strength of what a reviewer read, and a system that rewrites the approved '
    + 'thing on its own has made that approval worth nothing.');
  w();

  if (repairs.length === 0) {
    w('No repair is proposed: no step was successfully re-resolved.');
    w();
  }

  for (const repair of repairs) {
    w(`## Step \`${repair.stepId}\``);
    w();
    w(`Recorded target: **${repair.wanted}**`);
    w(`Model chose: **${repair.chose}**`);
    w(`Because: *${repair.because}*`);
    w();
    w('Proposed replacement descriptor:');
    w();
    w('```json');
    w(JSON.stringify(repair.proposal, null, 2));
    w('```');
    w();
    w('Before applying: confirm this is the same control and not merely one in the same place. Then re-probe '
      + 'the capability, because a moved control usually means the screen moved, and the declared outcomes were '
      + 'verified against the old one.');
    w();
  }

  for (const failed of attempts.filter((a) => a.outcome !== 'resolved')) {
    w(`## Step \`${failed.stepId}\` — no repair`);
    w();
    w(`Recorded target: **${failed.wanted}**`);
    w(`Outcome: \`${failed.outcome}\`${failed.because ? ` — ${failed.because}` : ''}`);
    w();
  }

  return lines.join('\n');
}
