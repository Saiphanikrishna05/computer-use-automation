/**
 * Deterministic replay: the production execution path.
 *
 * No model is consulted here. Given the same artifact, the same inputs and the
 * same application state, this does the same thing every time. That is the
 * whole value proposition: discovery is expensive, non-deterministic and
 * unauditable; this is none of those.
 *
 * The loop before each step is the interesting part, and its ordering is a
 * decision, not an accident:
 *
 *   1. business outcomes, is the app telling us something the caller needs?
 *   2. declared failures , is the app broken in a way we recognise?
 *   3. recovery rules    , is this something we are allowed to fix ourselves?
 *   4. the step itself
 *
 * Outcomes are checked first because "no such member" must win over any
 * attempt to keep driving; a run that dismisses the not-found banner and
 * carries on is the exact bug the ordering exists to prevent. Recovery runs
 * last because it is the only branch that mutates the surface, and it should
 * only ever fire on states nothing else has claimed.
 */

import type {
  BusinessOutcome,
  CapabilityArtifact,
  Condition,
  OutputSpec,
  RecoveryRule,
  Step,
  TargetDescriptor,
} from '../artifact/schema.js';
import type { SurfaceDriver, SurfaceElement } from '../surface/types.js';
import { PolicyEngine, PolicyViolation } from '../policy/engine.js';
import type { RunLogger } from '../evidence/logger.js';
import { evaluateCondition, describeCondition } from './conditions.js';
import { bindInputs, coerceOutput, interpolate, interpolateTarget, InputValidationError } from './values.js';
import { assistedReresolve, type AssistedAttempt } from './assisted.js';
import type {
  FailureCode,
  RecoveryReport,
  ReplayFailure,
  ReplayResult,
  StepReport,
} from './result.js';

export interface InterventionRequest {
  capabilityId: string;
  capabilityVersion: number;
  runId: string;
  stepId?: string;
  stepIntent?: string;
  reason: string;
  code: string;
  /** Redacted snapshot of what the automation was looking at. */
  observed: string;
  screenshotPath?: string;
}

export interface InterventionOutcome {
  interventionId: string;
  /**
   * Three outcomes, not two, and the third one matters.
   *
   *   resumed             the operator cleared the blocker; retry the step
   *   completed_manually  the operator performed the step themselves; skip it
   *   aborted             stop the run
   *
   * Without `completed_manually`, escalating an irreversible action is
   * incoherent: the human is escalated to *precisely because* only a person
   * should perform that submit, and then the automation retries it and submits
   * a second time. Collapsing the two into "resumed" turns a safety mechanism
   * into a duplicate-transaction generator.
   */
  resolution: 'resumed' | 'completed_manually' | 'aborted';
  operatorId: string;
  note?: string;
  /** What the human did while they held the session, for the audit trail. */
  humanActions: Array<{ at: string; kind: string; detail: string }>;
}

export interface EscalationHandler {
  raise(request: InterventionRequest): Promise<InterventionOutcome>;
}

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, unknown>;
  driver: SurfaceDriver;
  policy: PolicyEngine;
  logger: RunLogger;
  /** Values bound into url templates, `baseUrl` and anything a tenant supplies. */
  bindings?: Record<string, string>;
  tenantId?: string;
  escalation?: EscalationHandler;
  /**
   * Allow one model call to locate a control the artifact can no longer find.
   *
   * Off unless asked for, so the default replay path stays provably model-free
   * and can still be run with no API key at all. See `replay/assisted.ts` for
   * why every constraint on it exists.
   */
  assist?: boolean;
}

export class ReplayEngine {
  private readonly steps: StepReport[] = [];
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly screenshots: string[] = [];
  private readonly domSnapshots: string[] = [];
  private degradedResolutions = 0;
  private values: Record<string, unknown> = {};
  /**
   * Recoveries that fired before any step was in flight, clearing a login
   * interstitial, for instance. They have no step to attach to yet, so they
   * are buffered and flushed onto the next step that starts. Dropping them
   * would make the commonest recovery of all invisible in the result.
   */
  private pendingRecoveries: RecoveryReport[] = [];
  /** Every time a model was consulted mid-run, for the result and the audit
   *  trail. A run that used one and reported plain success would be the worst
   *  possible version of this feature. */
  private assistedAttempts: AssistedAttempt[] = [];

  constructor(private readonly options: ReplayOptions) {}

  /** What a model was asked mid-run, for callers that write the repair
   *  proposal. Exposed rather than reached into. */
  get assisted(): readonly AssistedAttempt[] {
    return this.assistedAttempts;
  }

  async run(): Promise<ReplayResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const { artifact, driver, logger } = this.options;

    logger.event('run_started', `replay ${artifact.id} v${artifact.version}`, {
      capability: artifact.id,
      version: artifact.version,
      tenant: this.options.tenantId,
      inputKeys: Object.keys(this.options.inputs),
    });

    try {
      // Gate 1: is this capability allowed to run unattended at all?
      const approval = this.options.policy.checkArtifactApproval(artifact.approval.state);
      if (!approval.allowed) {
        return this.fail(startedAt, t0, {
          code: 'ARTIFACT_NOT_APPROVED',
          expected: 'an approved capability',
          observed: `capability is in "${artifact.approval.state}" state`,
          detail: approval.reason,
        });
      }

      // Gate 2: do the caller's arguments satisfy the declared contract?
      try {
        this.values = {
          ...(this.options.bindings ?? {}),
          ...bindInputs(artifact.inputs, this.options.inputs),
        };
      } catch (error) {
        if (error instanceof InputValidationError) {
          return this.fail(startedAt, t0, {
            code: 'INPUT_VALIDATION_FAILED',
            expected: `inputs matching the declared contract for ${artifact.id}`,
            observed: error.message,
          });
        }
        throw error;
      }

      await driver.navigate(interpolate(artifact.target.entryUrlTemplate, this.values));

      for (const step of artifact.steps) {
        const interception = await this.checkSurfaceState(step);
        if (interception) return this.finishFromInterception(interception, startedAt, t0);

        const stepResult = await this.runStep(step);
        if (stepResult.kind === 'failed') {
          const escalated = await this.tryEscalate(step, stepResult.failure);
          if (escalated) {
            this.recordHumanActions(step, escalated);

            if (escalated.resolution === 'aborted') {
              return this.escalate(startedAt, t0, escalated, false);
            }

            if (escalated.resolution === 'completed_manually') {
              // The operator performed this step by hand. Retrying it would
              // repeat whatever they just did, on an irreversible step, twice.
              logger.event('note', `step ${step.id} was completed manually by ${escalated.operatorId}`);
              const report = this.steps[this.steps.length - 1];
              if (report) {
                report.status = 'ok';
                report.note = `performed manually by ${escalated.operatorId}${escalated.note ? `: ${escalated.note}` : ''}`;
              }
              continue;
            }

            // Blocker cleared. Re-run the step against the surface as the
            // operator left it, rather than assuming their actions matched
            // what ours would have been.
            const retry = await this.runStep(step);
            if (retry.kind === 'failed') return this.fail(startedAt, t0, retry.failure);
            continue;
          }
          return this.fail(startedAt, t0, stepResult.failure);
        }
        if (stepResult.kind === 'outcome') {
          return this.finishFromInterception({ type: 'outcome', outcome: stepResult.outcome }, startedAt, t0);
        }
      }

      // A final sweep: the last step may itself have produced an outcome (a
      // submit that returns "not found"), which no pre-step check would see.
      const finalState = await this.checkSurfaceState();
      if (finalState) return this.finishFromInterception(finalState, startedAt, t0);

      const checkpointHeld = await evaluateCondition(
        { driver, values: this.values },
        artifact.checkpoint.condition,
      );
      if (!checkpointHeld) {
        await this.captureFailureEvidence('checkpoint-failed');
        return this.fail(startedAt, t0, {
          code: 'CHECKPOINT_FAILED',
          expected: `${artifact.checkpoint.description} (${describeCondition(artifact.checkpoint.condition)})`,
          observed: (await driver.visibleText()).replace(/\s+/g, ' ').slice(0, 400),
        });
      }
      logger.event('note', `checkpoint held: ${artifact.checkpoint.description}`);

      const outputs = await this.extractOutputs(artifact.outputs);
      if ('failure' in outputs) return this.fail(startedAt, t0, outputs.failure);

      this.screenshots.push(logger.screenshot('replay-success', await driver.screenshot()));

      return this.done(startedAt, t0, { status: 'success', outputs: outputs.values });
    } catch (error) {
      await this.captureFailureEvidence('unexpected-error');
      const code: FailureCode = error instanceof PolicyViolation ? 'POLICY_BLOCKED' : 'INTERNAL_ERROR';
      return this.fail(startedAt, t0, {
        code,
        expected: 'the flow to complete',
        observed: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Surface-state classification
  // -------------------------------------------------------------------------

  private async checkSurfaceState(
    step?: Step,
  ): Promise<
    | { type: 'outcome'; outcome: BusinessOutcome }
    | { type: 'failure'; failure: ReplayFailure }
    | undefined
  > {
    const { artifact, driver, logger } = this.options;
    const ctx = { driver, values: this.values };

    for (const outcome of artifact.outcomes) {
      if (await evaluateCondition(ctx, outcome.when)) {
        logger.event('business_outcome', `${outcome.code}: ${outcome.description}`, { code: outcome.code });
        return { type: 'outcome', outcome };
      }
    }

    for (const rule of artifact.failures) {
      if (await evaluateCondition(ctx, rule.when)) {
        // Give recovery a chance before declaring it fatal, session expiry is
        // usually both (recoverable by re-auth, fatal if re-auth is exhausted).
        const recovered = await this.tryRecovery();
        if (recovered) continue;

        await this.captureFailureEvidence(`declared-failure-${rule.code.toLowerCase()}`);
        return {
          type: 'failure',
          failure: {
            code: rule.code,
            stepId: step?.id,
            expected: step ? `to perform: ${step.intent}` : 'the application to be in a usable state',
            observed: `${rule.description} (${describeCondition(rule.when)})`,
            detail: (await driver.visibleText()).replace(/\s+/g, ' ').slice(0, 400),
          },
        };
      }
    }

    await this.tryRecovery();
    return undefined;
  }

  /**
   * Applies the first recovery rule whose condition holds and whose attempt
   * budget is not spent. Returns true when one fired.
   *
   * Attempts are counted per rule per run, not per step. A rule that keeps
   * firing is a rule that is not working, and letting it retry from a fresh
   * budget at every step turns a broken capability into an infinite loop.
   */
  private async tryRecovery(): Promise<boolean> {
    const { artifact, driver, logger } = this.options;
    const ctx = { driver, values: this.values };

    for (const rule of artifact.recovery) {
      const used = this.recoveryAttempts.get(rule.code) ?? 0;
      if (used >= rule.maxAttempts) continue;
      if (!(await evaluateCondition(ctx, rule.when))) continue;

      this.recoveryAttempts.set(rule.code, used + 1);
      logger.event('recovery_attempt', `${rule.code} (attempt ${used + 1}/${rule.maxAttempts})`, {
        code: rule.code,
        description: rule.description,
      });

      const report: RecoveryReport = { code: rule.code, attempt: used + 1, succeeded: false };
      try {
        await this.applyRecovery(rule);
        report.succeeded = !(await evaluateCondition(ctx, rule.when));
        if (!report.succeeded) report.note = 'condition still holds after recovery';
      } catch (error) {
        report.note = String(error);
      }

      const last = this.steps[this.steps.length - 1];
      if (last && last.status !== 'failed') {
        last.recoveries.push(report);
        if (report.succeeded && last.status === 'ok') last.status = 'recovered';
      } else {
        this.pendingRecoveries.push(report);
      }
      return true;
    }
    return false;
  }

  /**
   * One model call, once per run, and only when the caller asked for it.
   *
   * Budgeted per run rather than per step for the same reason declared
   * recovery is: a capability needing this twice is not recovering, it is
   * broken, and the useful outcome is a failure a person looks at rather than
   * a run that limps to the end through a sequence of guesses.
   *
   * Ambiguity is deliberately excluded. `TARGET_AMBIGUOUS` means several
   * elements matched and the artifact does not say which — that is an
   * under-specified recording, and asking a model to break the tie would paper
   * over the actual defect with a coin toss on a live account.
   */
  private async tryAssist(
    step: Step,
    target: TargetDescriptor,
    reason: 'not_found' | 'ambiguous',
  ): Promise<SurfaceElement | undefined> {
    if (!this.options.assist) return undefined;
    if (reason === 'ambiguous') return undefined;
    if (this.assistedAttempts.length > 0) {
      this.options.logger.event('note', `assisted re-resolution already used this run; ${step.id} fails`);
      return undefined;
    }

    const { attempt, element } = await assistedReresolve({
      step,
      target,
      driver: this.options.driver,
      logger: this.options.logger,
    });
    this.assistedAttempts.push(attempt);
    return element;
  }

  private async applyRecovery(rule: RecoveryRule): Promise<void> {
    const { driver } = this.options;
    for (const action of rule.then) {
      switch (action.kind) {
        case 'click': {
          const resolved = await driver.resolve(interpolateTarget(action.target, this.values));
          if (resolved.ok) await driver.click(resolved.element);
          break;
        }
        case 'accept_dialog':
          await driver.acceptDialog();
          break;
        case 'dismiss_dialog':
          await driver.dismissDialog();
          break;
        case 'wait':
          await new Promise((r) => setTimeout(r, action.ms));
          break;
        case 'reload':
          await driver.navigate(await driver.currentUrl());
          break;
        case 'restart_from_step':
          // Deliberately unimplemented: re-entering the step loop mid-recovery
          // makes the run non-linear and the evidence bundle unreadable. The
          // schema keeps the case so the seam is visible; see REPORT §7.
          throw new Error('restart_from_step recovery is not implemented in this build');
      }
      await driver.waitForSettled();
    }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private async runStep(
    step: Step,
  ): Promise<
    | { kind: 'ok' }
    | { kind: 'outcome'; outcome: BusinessOutcome }
    | { kind: 'failed'; failure: ReplayFailure }
  > {
    const { driver, logger } = this.options;
    const t0 = Date.now();
    const report: StepReport = {
      stepId: step.id,
      intent: step.intent,
      action: step.action.kind,
      status: 'ok',
      elapsedMs: 0,
      recoveries: [],
    };
    // Anything recovered on the way in belongs to this step: it is why the
    // step could run at all.
    if (this.pendingRecoveries.length > 0) {
      report.recoveries.push(...this.pendingRecoveries);
      report.status = 'recovered';
      this.pendingRecoveries = [];
    }

    this.steps.push(report);
    logger.event('step_started', `${step.id}: ${step.intent}`, { action: step.action.kind, risk: step.risk });

    const finishFailed = (failure: ReplayFailure): { kind: 'failed'; failure: ReplayFailure } => {
      report.status = 'failed';
      report.elapsedMs = Date.now() - t0;
      logger.event('step_finished', `${step.id} FAILED: ${failure.code}`, { failure });
      return { kind: 'failed', failure };
    };

    try {
      const action = step.action;

      // Every action that touches an element resolves it here, so the
      // resolution report is attached to the step exactly once regardless of
      // which action kind it was.
      let element: SurfaceElement | undefined;
      if ('target' in action && action.target) {
        const resolved = await driver.resolve(interpolateTarget(action.target, this.values));
        report.resolution = resolved.report;
        if (resolved.report.degraded) this.degradedResolutions += 1;
        logger.event('resolution', `${step.id} → ${resolved.report.winningKind ?? 'unresolved'}`, {
          report: resolved.report,
        });

        if (!resolved.ok) {
          // The one failure a declared recovery rule cannot express: there is
          // no condition to key on, because the failure *is* the absence of
          // the thing the rule would look for.
          const assisted = await this.tryAssist(step, action.target, resolved.reason);
          if (assisted) {
            element = assisted;
            report.note = 'target re-resolved with model assistance; see the repair proposal in the bundle';
            report.status = report.status === 'failed' ? report.status : 'recovered';
          } else {
            await this.captureFailureEvidence(`unresolved-${step.id}`);
            return finishFailed({
            code: resolved.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
            stepId: step.id,
            expected: `to locate ${action.target.description}`,
            observed:
              resolved.reason === 'ambiguous'
                ? 'several elements matched and the artifact records no ordinal to choose between them'
                : 'no element matched any recorded locator candidate',
            resolution: resolved.report,
            });
          }
        } else {
          element = resolved.element;
        }
      }

      switch (action.kind) {
        case 'navigate':
          await driver.navigate(interpolate(action.urlTemplate, this.values));
          break;
        case 'click':
          // The step's declared risk, not the driver's guess. This is the line
          // that makes `risk: "mutate_irreversible"` in an artifact mean
          // something: without it a submit-the-transaction click is
          // indistinguishable from dismissing a banner.
          await driver.click(element!, step.risk);
          break;
        case 'type': {
          const value = interpolate(action.valueTemplate, this.values);
          await driver.type(element!, value, {
            clearFirst: action.clearFirst,
            secret: action.secret,
            actionClass: step.risk,
          });
          logger.event('note', `typed into ${action.target.description}`, {
            value: action.secret ? '[redacted:secret]' : value,
          });
          break;
        }
        case 'select':
          await driver.selectOption(element!, interpolate(action.valueTemplate, this.values), step.risk);
          break;
        case 'press':
          await driver.press(action.key, element, step.risk);
          break;
        case 'wait_for': {
          const held = await this.waitForCondition(action.condition, action.timeoutMs);
          if (!held) {
            await this.captureFailureEvidence(`wait-timeout-${step.id}`);
            return finishFailed({
              code: 'STEP_TIMEOUT',
              stepId: step.id,
              expected: describeCondition(action.condition),
              observed: `condition still false after ${action.timeoutMs}ms`,
            });
          }
          break;
        }
        case 'extract':
          // Extraction is performed once, at the end, against the declared
          // outputs. The step exists so the flow reads correctly to a human.
          break;
        case 'assert': {
          const held = await evaluateCondition({ driver, values: this.values }, action.condition);
          if (!held) {
            await this.captureFailureEvidence(`assert-${step.id}`);
            return finishFailed({
              code: 'POSTCONDITION_FAILED',
              stepId: step.id,
              expected: describeCondition(action.condition),
              observed: (await driver.visibleText()).replace(/\s+/g, ' ').slice(0, 300),
            });
          }
          break;
        }
      }

      // An outcome that appears as a direct result of this step (a submit that
      // returns "not found") must be caught before the postconditions run,
      // otherwise a legitimate business answer is reported as a broken step.
      for (const outcome of this.options.artifact.outcomes) {
        if (await evaluateCondition({ driver, values: this.values }, outcome.when)) {
          report.status = 'ok';
          report.elapsedMs = Date.now() - t0;
          logger.event('step_finished', `${step.id} → business outcome ${outcome.code}`);
          return { kind: 'outcome', outcome };
        }
      }

      for (const condition of step.postconditions) {
        const held = await this.waitForCondition(condition, Math.min(step.timeoutMs, 8_000));
        if (!held) {
          await this.captureFailureEvidence(`postcondition-${step.id}`);
          return finishFailed({
            code: 'POSTCONDITION_FAILED',
            stepId: step.id,
            expected: describeCondition(condition),
            observed: (await driver.visibleText()).replace(/\s+/g, ' ').slice(0, 300),
            detail: 'the action reported success but the surface did not reach the expected state',
          });
        }
      }

      report.elapsedMs = Date.now() - t0;
      logger.event('step_finished', `${step.id} ok`, { elapsedMs: report.elapsedMs });
      return { kind: 'ok' };
    } catch (error) {
      if (error instanceof PolicyViolation) {
        return finishFailed({
          code: 'POLICY_BLOCKED',
          stepId: step.id,
          expected: `to perform: ${step.intent}`,
          observed: error.message,
          detail: error.decision.escalatable ? 'escalatable: a human may authorise this action' : undefined,
        });
      }
      await this.captureFailureEvidence(`error-${step.id}`);
      return finishFailed({
        code: 'INTERNAL_ERROR',
        stepId: step.id,
        expected: `to perform: ${step.intent}`,
        observed: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Polls rather than racing an event, because conditions span frames and a
   *  Playwright-level wait cannot express "text visible anywhere in the app". */
  private async waitForCondition(condition: Condition, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const ctx = { driver: this.options.driver, values: this.values };
    for (;;) {
      if (await evaluateCondition(ctx, condition)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  private async extractOutputs(
    specs: OutputSpec[],
  ): Promise<{ values: Record<string, unknown> } | { failure: ReplayFailure }> {
    const { driver, logger } = this.options;
    const values: Record<string, unknown> = {};

    for (const spec of specs) {
      const resolved = await driver.resolve(interpolateTarget(spec.extract.target, this.values));

      // Output extraction resolves targets exactly as steps do, so it must
      // report them the same way. Without this the drift counter could
      // increment with nothing in the log to explain it, a headline signal
      // that cannot be investigated is not a signal.
      logger.event('resolution', `output "${spec.name}" → ${resolved.report.winningKind ?? 'unresolved'}`, {
        report: resolved.report,
      });

      if (!resolved.ok) {
        if (!spec.required) continue;
        await this.captureFailureEvidence(`extract-${spec.name}`);
        return {
          failure: {
            code: 'OUTPUT_EXTRACTION_FAILED',
            expected: `to read output "${spec.name}" from ${spec.extract.target.description}`,
            observed: `target did not resolve (${resolved.reason})`,
            resolution: resolved.report,
          },
        };
      }
      if (resolved.report.degraded) this.degradedResolutions += 1;

      const raw = await driver.read(resolved.element, spec.extract.source, spec.extract.attribute);
      values[spec.name] = coerceOutput(raw, spec);

      // The extracted value itself is *not* redacted, returning it is the
      // whole point of the capability. It is the log line that gets redacted.
      logger.event('note', `extracted output "${spec.name}"`, {
        name: spec.name,
        sensitivity: spec.sensitivity,
        value: spec.sensitivity === 'none' ? values[spec.name] : '[redacted:by-sensitivity]',
      });
    }

    return { values };
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  private async tryEscalate(step: Step, failure: ReplayFailure): Promise<InterventionOutcome | undefined> {
    const handler = this.options.escalation;
    if (!handler) return undefined;

    // Only conditions a human can actually resolve are worth a person's time.
    // Escalating a schema bug would page an operator who can do nothing.
    const escalatable: FailureCode[] = [
      'POLICY_BLOCKED',
      'TARGET_NOT_FOUND',
      'TARGET_AMBIGUOUS',
      'POSTCONDITION_FAILED',
      'STEP_TIMEOUT',
      'SESSION_EXPIRED',
      'UNHANDLED_DIALOG',
    ];
    if (!escalatable.includes(failure.code)) return undefined;

    const { driver, logger, artifact } = this.options;
    const screenshotPath = this.pushScreenshot(logger.screenshot(`escalation-${step.id}`, await driver.screenshot()));

    logger.event('escalation_raised', `${failure.code} at ${step.id}`, { failure });

    return handler.raise({
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      runId: logger.runId,
      stepId: step.id,
      stepIntent: step.intent,
      code: failure.code,
      reason: `${failure.expected}, but ${failure.observed}`,
      observed: (await driver.visibleText()).replace(/\s+/g, ' ').slice(0, 800),
      screenshotPath,
    });
  }

  // -------------------------------------------------------------------------
  // Result assembly
  // -------------------------------------------------------------------------

  /**
   * Folds the operator's actions into the step report.
   *
   * A handoff must not be a hole in the audit trail. "Automation stopped,
   * something happened, automation resumed" is not an acceptable record of who
   * touched a member's account, so what the human did lands in the same
   * structure as what the automation did.
   */
  private recordHumanActions(step: Step, outcome: InterventionOutcome): void {
    const report = this.steps[this.steps.length - 1];
    if (!report) return;
    for (const action of outcome.humanActions) {
      report.recoveries.push({
        code: `HUMAN_${action.kind.toUpperCase()}`,
        attempt: 1,
        succeeded: true,
        note: `${outcome.operatorId} at ${action.at}: ${action.detail}`,
      });
    }
    this.options.logger.event(
      'control_transfer',
      `operator ${outcome.operatorId} ${outcome.resolution} step ${step.id} after ${outcome.humanActions.length} action(s)`,
      { interventionId: outcome.interventionId, resolution: outcome.resolution },
    );
  }

  private pushScreenshot(path: string): string {
    this.screenshots.push(path);
    return path;
  }

  private async captureFailureEvidence(label: string): Promise<void> {
    const { driver, logger } = this.options;
    try {
      this.pushScreenshot(logger.screenshot(label, await driver.screenshot()));
      this.domSnapshots.push(logger.domSnapshot(label, await driver.sourceSnapshot()));
    } catch (error) {
      logger.event('note', `failed to capture evidence for ${label}: ${String(error)}`);
    }
  }

  private base(startedAt: string, t0: number) {
    const { artifact, logger } = this.options;
    if (this.pendingRecoveries.length > 0) {
      // The run ended before a step could claim them. Surface them as a
      // synthetic entry rather than losing them.
      this.steps.push({
        stepId: '(before first step)',
        intent: 'clearing the surface before the flow could begin',
        action: 'recovery',
        status: 'recovered',
        elapsedMs: 0,
        recoveries: this.pendingRecoveries,
      });
      this.pendingRecoveries = [];
    }
    return {
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      tenantId: this.options.tenantId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      steps: this.steps,
      degradedResolutions: this.degradedResolutions,
      ...(this.assistedAttempts.length > 0 ? { assisted: this.assistedAttempts } : {}),
      evidence: {
        runId: logger.runId,
        bundlePath: logger.dir,
        screenshots: this.screenshots,
        domSnapshots: this.domSnapshots,
      },
    };
  }

  private done(startedAt: string, t0: number, tail: { status: 'success'; outputs: Record<string, unknown> }): ReplayResult {
    const result = { ...this.base(startedAt, t0), ...tail } as ReplayResult;
    this.options.logger.event('run_finished', 'success');
    return result;
  }

  private fail(startedAt: string, t0: number, error: ReplayFailure): ReplayResult {
    const result = { ...this.base(startedAt, t0), status: 'failure' as const, error };
    this.options.logger.event('run_finished', `failure ${error.code}`, { error });
    return result;
  }

  private escalate(
    startedAt: string,
    t0: number,
    outcome: InterventionOutcome,
    resumable: boolean,
  ): ReplayResult {
    const result = {
      ...this.base(startedAt, t0),
      status: 'escalated' as const,
      interventionId: outcome.interventionId,
      reason: outcome.note ?? 'operator ended the run',
      resumable,
    };
    this.options.logger.event('run_finished', `escalated ${outcome.interventionId}`);
    return result;
  }

  private async finishFromInterception(
    interception: { type: 'outcome'; outcome: BusinessOutcome } | { type: 'failure'; failure: ReplayFailure },
    startedAt: string,
    t0: number,
  ): Promise<ReplayResult> {
    if (interception.type === 'failure') return this.fail(startedAt, t0, interception.failure);

    const { outcome } = interception;
    const data = await this.extractOutputs(outcome.extract);
    this.pushScreenshot(
      this.options.logger.screenshot(`outcome-${outcome.code.toLowerCase()}`, await this.options.driver.screenshot()),
    );

    const result = {
      ...this.base(startedAt, t0),
      status: 'business_outcome' as const,
      outcome: outcome.code,
      outcomeDescription: outcome.description,
      data: 'values' in data ? data.values : {},
    };
    this.options.logger.event('run_finished', `business outcome ${outcome.code}`);
    return result;
  }
}
