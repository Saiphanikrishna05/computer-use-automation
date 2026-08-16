/**
 * The web implementation of `SurfaceDriver`.
 *
 * Three things happen here that do not happen anywhere else, and they are the
 * reason this class exists rather than callers using Playwright directly:
 *
 *  1. **The allowlist is enforced.** Every navigation and every action passes
 *     through the policy engine on a code path the model cannot address. A page
 *     that tries to talk the agent into leaving the allowlist produces a
 *     blocked-navigation event.
 *
 *  2. **The control lease is asserted.** Automation cannot touch the surface
 *     unless it holds control, so a run that has handed off to a human cannot
 *     race them on the same live page.
 *
 *  3. **Screenshots are masked before they exist.** Sensitive regions are
 *     covered at capture time, so a PNG containing a member's tax ID is never
 *     written to disk in the first place, as opposed to being written and
 *     then cleaned up, which is not the same guarantee.
 */

import type { Browser, BrowserContext, Dialog, ElementHandle, Frame, Locator, Page } from 'playwright';
import { chromium } from 'playwright';
import {
  CANDIDATE_TIER,
  HEALTHY_TIER_CEILING,
  type ActionClass,
  type FrameStep,
  type LocatorCandidate,
  type TargetDescriptor,
} from '../artifact/schema.js';
import { PolicyEngine, PolicyViolation, type ActionKind } from '../policy/engine.js';
import { Redactor, defaultRedactor } from '../policy/redaction.js';
import type { ControlLease } from '../escalation/lease.js';
import { collectUiNodes, resolveCandidateInPage, type RawSnapshot, type RawUiNode } from '../perception/inpage.js';
import type {
  CandidateAttempt,
  HumanAction,
  PendingDialog,
  ResolutionReport,
  ResolutionResult,
  ScreenshotOptions,
  SurfaceDriver,
  SurfaceElement,
  SurfaceSnapshot,
  TypeOptions,
  UiNode,
} from './types.js';

const MASK_ATTRIBUTE = 'data-cua-mask';

interface WebElement extends SurfaceElement {
  handle: ElementHandle<Element>;
  frame: Frame;
  nodeIndex: number;
}

export interface PlaywrightWebSurfaceOptions {
  policy: PolicyEngine;
  lease?: ControlLease;
  redactor?: Redactor;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Directory for Playwright's own video recording, when evidence wants it. */
  recordVideoDir?: string;
  onEvent?: (type: string, message: string, data?: Record<string, unknown>) => void;
}

export class PlaywrightWebSurface implements SurfaceDriver {
  readonly kind = 'web' as const;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly options: PlaywrightWebSurfaceOptions,
  ) {
    this.redactor = options.redactor ?? defaultRedactor;
    this.policy = options.policy;

    // Dialogs are captured, never auto-dismissed. An unexpected confirm() is a
    // first-class runtime condition the artifact declares how to handle; if
    // Playwright silently dismissed it we would never see it, and the recovery
    // rule that exists to handle it would be dead code.
    this.page.on('dialog', (dialog: Dialog) => {
      this.dialogHandle = dialog;
      this.dialog = { kind: dialog.type() as PendingDialog['kind'], message: dialog.message() };
      this.emit('note', `native dialog raised: ${dialog.message()}`);
    });

    // In a frameset app the interesting navigations are *frame* navigations -
    // a form in one pane retargets another. `page.waitForLoadState` does not
    // see those, so we track them ourselves.
    this.page.on('framenavigated', () => {
      this.navCount += 1;
      this.lastNavigationAt = Date.now();
    });
  }

  private readonly redactor: Redactor;
  private policy: PolicyEngine;
  private dialog: PendingDialog | undefined;
  private dialogHandle: Dialog | undefined;
  private navCount = 0;
  private lastNavigationAt = 0;

  static async launch(options: PlaywrightWebSurfaceOptions): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir } } : {}),
    });
    const page = await context.newPage();
    return new PlaywrightWebSurface(browser, context, page, options);
  }

  private emit(type: string, message: string, data?: Record<string, unknown>): void {
    this.options.onEvent?.(type, message, data);
  }

  private guard(action: string): void {
    this.options.lease?.assertAutomationHolds(action);
  }

  private enforce(kind: ActionKind, actionClass: Parameters<PolicyEngine['checkAction']>[1]): void {
    const decision = this.policy.checkAction(kind, actionClass);
    this.emit('policy_decision', `${kind}/${actionClass}: ${decision.allowed ? 'allow' : decision.code}`, {
      kind,
      actionClass,
      decision,
    });
    if (!decision.allowed) throw new PolicyViolation(decision);
  }

  /** Widen the allowlist at runtime, e.g. once a tenant's base URL is known. */
  allowOrigins(origins: string[]): void {
    this.policy = this.policy.withOrigins(origins);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  async navigate(url: string): Promise<void> {
    this.guard(`navigate ${url}`);
    const decision = this.policy.checkNavigation(url);
    this.emit('policy_decision', `navigate ${url}: ${decision.allowed ? 'allow' : decision.code}`, { url, decision });
    if (!decision.allowed) throw new PolicyViolation(decision);

    this.enforce('navigate', 'read');
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.waitForSettled();
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  /**
   * Resolves a frame path by name, then URL pattern, then, only if both fail
   *, position. The ordering matters: frame *order* is one of the first things
   * that differs between two tenants running the same vendor build, so leaning
   * on it early would produce automation that appears to work and silently
   * drives the wrong pane.
   */
  private findFrameOnce(framePath: FrameStep[]): Frame | { error: string } {
    let current: Frame = this.page.mainFrame();

    for (const step of framePath) {
      const children = current.childFrames();
      let next: Frame | undefined;

      if (step.name) {
        next = children.find((f) => f.name() === step.name);
      }
      if (!next && step.urlPattern) {
        const pattern = step.urlPattern.replace(/\{\{[^}]+\}\}/g, '');
        next = children.find((f) => f.url().includes(pattern));
      }
      if (!next && typeof step.ordinal === 'number') {
        next = children[step.ordinal];
      }
      if (!next) {
        const available = children.map((f) => f.name() || '(unnamed)').join(', ') || 'none';
        return { error: `Frame not found for step ${JSON.stringify(step)}. Available child frames: ${available}` };
      }
      current = next;
    }
    return current;
  }

  /**
   * Frames in a frameset attach asynchronously and are unnamed until they do,
   * so a lookup immediately after a navigation legitimately misses. Polling
   * briefly is the difference between "this app is flaky" and "this app has
   * frames"; a hard failure on the first miss would make every post-navigation
   * step racy.
   */
  private async findFrame(framePath: FrameStep[] | undefined, timeoutMs = 2_500): Promise<Frame> {
    if (!framePath || framePath.length === 0) return this.page.mainFrame();

    const deadline = Date.now() + timeoutMs;
    let lastError = 'frame path not resolved';
    for (;;) {
      const result = this.findFrameOnce(framePath);
      if (!('error' in result)) return result;
      lastError = result.error;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(lastError);
  }

  private allFrames(): Frame[] {
    return this.page.frames();
  }

  private framePathOf(frame: Frame): FrameStep[] {
    const path: FrameStep[] = [];
    let cursor: Frame | null = frame;
    while (cursor && cursor.parentFrame()) {
      const parent: Frame = cursor.parentFrame()!;
      const ordinal = parent.childFrames().indexOf(cursor);
      const step: FrameStep = { ordinal: ordinal >= 0 ? ordinal : undefined };
      if (cursor.name()) step.name = cursor.name();
      const url = cursor.url();
      if (url && url !== 'about:blank') {
        try {
          step.urlPattern = new URL(url).pathname;
        } catch {
          /* leave unset */
        }
      }
      path.unshift(step);
      cursor = parent;
    }
    return path;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  /**
   * Playwright serializes an evaluated function via `Function.prototype
   * .toString()`. Our TypeScript is transpiled by esbuild with `keepNames`
   * enabled, which wraps every named function and arrow-const in a `__name()`
   * call, a helper that exists in the Node module scope and not in the page.
   * The serialized source therefore references an undefined identifier.
   *
   * Defining a no-op `__name` in the page satisfies it. The alternative is to
   * pre-bundle the in-page module to a plain string, which costs a build step
   * and loses type checking across the boundary for no behavioural gain.
   */
  private async ensureEvalShim(frame: Frame): Promise<void> {
    await frame
      .evaluate('globalThis.__name = globalThis.__name || function (fn) { return fn; }')
      .catch(() => undefined);
  }

  private async collect(frame: Frame, retryOnce = true): Promise<RawSnapshot | undefined> {
    try {
      await this.ensureEvalShim(frame);
      return await frame.evaluate(collectUiNodes);
    } catch (error) {
      // "Execution context was destroyed" means we read the frame mid-
      // navigation. That is a timing artefact, not a property of the page, so
      // it earns exactly one retry after things settle.
      if (retryOnce && /context was destroyed|Execution context/i.test(String(error))) {
        await this.waitForSettled();
        return this.collect(frame, false);
      }
      // Frames navigate out from under us constantly in a frameset app. A
      // frame we cannot read this instant is not a run-ending problem, but it
      // is worth surfacing, a frame that is *never* readable looks identical
      // to one that is merely busy unless the reason is recorded.
      this.emit('note', `frame not readable (${frame.name() || 'main'}): ${String(error).slice(0, 200)}`);
      return undefined;
    }
  }

  async snapshot(): Promise<SurfaceSnapshot> {
    const frames = this.allFrames();
    const nodes: UiNode[] = [];
    let viewport = { width: 1280, height: 900 };

    for (const frame of frames) {
      const raw = await this.collect(frame);
      if (!raw) continue;
      if (frame === this.page.mainFrame()) viewport = raw.viewport;

      const framePath = this.framePathOf(frame);
      for (const node of raw.nodes) {
        nodes.push(this.toUiNode(node, framePath, frame));
      }
    }

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      viewport,
      nodes,
      ...(this.dialog ? { dialog: this.dialog } : {}),
      capturedAt: new Date().toISOString(),
    };
  }

  private toUiNode(raw: RawUiNode, framePath: FrameStep[], frame: Frame): UiNode {
    const frameKey = framePath.map((s) => s.name ?? s.ordinal ?? '?').join('/') || 'main';
    return {
      ref: `${frameKey}#${raw.index}`,
      role: raw.role,
      name: this.redactor.text(raw.name),
      ...(raw.value !== undefined && !raw.isPassword ? { value: this.redactor.text(raw.value) } : {}),
      ...(raw.text !== undefined ? { text: this.redactor.text(raw.text) } : {}),
      ...(raw.placeholder !== undefined ? { placeholder: raw.placeholder } : {}),
      disabled: raw.disabled,
      focusable: raw.focusable,
      editable: raw.editable,
      visible: raw.visible,
      isPassword: raw.isPassword,
      framePath,
      // Every text-bearing field is redacted, not just the obvious ones.
      // `nearestLabel` is the cell adjacent to a control, and in an accounts
      // table that neighbour is the account number, so an incomplete
      // redaction here put a member's account number into the model's prompt
      // and into the saved artifact, via a field whose name does not suggest
      // it carries member data at all.
      ...(raw.containerRole !== undefined ? { containerRole: raw.containerRole } : {}),
      ...(raw.containerName !== undefined ? { containerName: this.redactor.text(raw.containerName) } : {}),
      ...(raw.nearestLabel !== undefined ? { nearestLabel: this.redactor.text(raw.nearestLabel) } : {}),
      ...(raw.nearestLabelPositional !== undefined
        ? { nearestLabelPositional: raw.nearestLabelPositional }
        : {}),
      ...(raw.rowHeader !== undefined ? { rowHeader: this.redactor.text(raw.rowHeader) } : {}),
      ...(raw.columnHeader !== undefined ? { columnHeader: this.redactor.text(raw.columnHeader) } : {}),
      ...(raw.cellIndex !== undefined ? { cellIndex: raw.cellIndex } : {}),
      attributes: raw.attributes,
      ...(raw.box ? { box: raw.box } : {}),
      tag: raw.tag,
      ordinalAmongPeers: raw.ordinalAmongPeers,
      // `frame` is intentionally not stored on the node: nodes are serialized
      // into evidence, and a live Playwright object has no business there.
      ...(frame ? {} : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  async resolve(target: TargetDescriptor): Promise<ResolutionResult> {
    const started = Date.now();
    const attempts: CandidateAttempt[] = [];

    let frame: Frame;
    try {
      frame = await this.findFrame(target.framePath);
    } catch (error) {
      return {
        ok: false,
        reason: 'not_found',
        report: {
          targetDescription: target.description,
          attempts: [{ kind: 'frame', tier: -1, matchCount: 0, chosen: false, note: String(error) }],
          winningTier: null,
          winningKind: null,
          degraded: false,
          elapsedMs: Date.now() - started,
        },
      };
    }

    // Re-collect immediately before resolving. Costs one round trip and buys
    // the guarantee that scoring and handle acquisition see the same DOM.
    const raw = await this.collect(frame);
    if (!raw) {
      return {
        ok: false,
        reason: 'not_found',
        report: {
          targetDescription: target.description,
          attempts: [{ kind: 'collect', tier: -1, matchCount: 0, chosen: false, note: 'frame not readable' }],
          winningTier: null,
          winningKind: null,
          degraded: false,
          elapsedMs: Date.now() - started,
        },
      };
    }

    const ordered = [...target.candidates].sort(
      (a, b) => CANDIDATE_TIER[a.kind] - CANDIDATE_TIER[b.kind],
    );
    const bestRecordedTier = ordered.length > 0 ? CANDIDATE_TIER[ordered[0]!.kind] : null;

    for (const candidate of ordered) {
      const tier = CANDIDATE_TIER[candidate.kind];
      let indices: number[] = [];
      try {
        await this.ensureEvalShim(frame);
        indices = await frame.evaluate(resolveCandidateInPage, {
          candidate: candidate as unknown as Record<string, unknown>,
          anchor: target.anchor,
        });
      } catch (error) {
        attempts.push({ kind: candidate.kind, tier, matchCount: 0, chosen: false, note: String(error) });
        continue;
      }

      if (indices.length === 0) {
        attempts.push({ kind: candidate.kind, tier, matchCount: 0, chosen: false });
        continue;
      }

      // More than one match is only acceptable when the artifact says which one
      // it meant. Guessing here is how automation quietly does the wrong thing.
      let chosenIndex: number | undefined;
      if (indices.length === 1) {
        chosenIndex = indices[0];
      } else if (typeof target.ordinal === 'number' && target.ordinal < indices.length) {
        chosenIndex = indices[target.ordinal];
      }

      if (chosenIndex === undefined) {
        attempts.push({
          kind: candidate.kind,
          tier,
          matchCount: indices.length,
          chosen: false,
          note: 'ambiguous: multiple matches and no ordinal recorded',
        });
        continue;
      }

      const handle = await frame
        .evaluateHandle((i) => (window as unknown as { __cuaNodes: Element[] }).__cuaNodes[i], chosenIndex)
        .then((h) => h.asElement() as ElementHandle<Element> | null);

      if (!handle) {
        attempts.push({ kind: candidate.kind, tier, matchCount: indices.length, chosen: false, note: 'handle lost' });
        continue;
      }

      attempts.push({ kind: candidate.kind, tier, matchCount: indices.length, chosen: true });

      const report: ResolutionReport = {
        targetDescription: target.description,
        attempts,
        winningTier: tier,
        winningKind: candidate.kind,
        degraded: bestRecordedTier !== null && tier > bestRecordedTier && tier > HEALTHY_TIER_CEILING,
        elapsedMs: Date.now() - started,
      };

      if (report.degraded) {
        this.emit(
          'note',
          `drift signal: "${target.description}" resolved at tier ${tier} (${candidate.kind}) but was recorded at tier ${bestRecordedTier}`,
          { report },
        );
      }

      const element: WebElement = { __brand: 'SurfaceElement', handle, frame, nodeIndex: chosenIndex };
      return { ok: true, element, report };
    }

    const anyAmbiguous = attempts.some((a) => a.matchCount > 1);
    return {
      ok: false,
      reason: anyAmbiguous ? 'ambiguous' : 'not_found',
      report: {
        targetDescription: target.description,
        attempts,
        winningTier: null,
        winningKind: null,
        degraded: false,
        elapsedMs: Date.now() - started,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private static unwrap(element: SurfaceElement): WebElement {
    return element as WebElement;
  }

  async click(element: SurfaceElement, actionClass: ActionClass = 'mutate_reversible'): Promise<void> {
    this.guard('click');
    this.enforce('click', actionClass);
    const before = this.navCount;
    await PlaywrightWebSurface.unwrap(element).handle.click({ timeout: 10_000 });
    await this.settleAfterAction(before);
  }

  async type(element: SurfaceElement, text: string, options: TypeOptions = {}): Promise<void> {
    this.guard('type');
    this.enforce('type', options.actionClass ?? 'mutate_reversible');
    const el = PlaywrightWebSurface.unwrap(element).handle;
    if (options.clearFirst ?? true) await el.fill('');
    await el.type(text, { delay: 12 });
  }

  async selectOption(element: SurfaceElement, value: string, actionClass: ActionClass = 'mutate_reversible'): Promise<void> {
    this.guard('select');
    this.enforce('select', actionClass);
    await PlaywrightWebSurface.unwrap(element).handle.selectOption(value);
  }

  async press(key: string, element?: SurfaceElement, actionClass: ActionClass = 'mutate_reversible'): Promise<void> {
    this.guard(`press ${key}`);
    this.enforce('press', actionClass);
    const before = this.navCount;
    if (element) await PlaywrightWebSurface.unwrap(element).handle.press(key);
    else await this.page.keyboard.press(key);
    await this.settleAfterAction(before);
  }

  async read(
    element: SurfaceElement,
    source: 'text' | 'value' | 'attribute',
    attribute?: string,
  ): Promise<string> {
    this.enforce('read', 'read');
    const el = PlaywrightWebSurface.unwrap(element).handle;
    if (source === 'value') return (await el.inputValue().catch(() => '')) ?? '';
    if (source === 'attribute') return (await el.getAttribute(attribute ?? '')) ?? '';
    return ((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  }

  async isVisible(element: SurfaceElement): Promise<boolean> {
    return PlaywrightWebSurface.unwrap(element).handle.isVisible().catch(() => false);
  }

  /**
   * Frame-scoped text, with a deliberately short frame wait and no throwing.
   *
   * This backs every text-based condition, and conditions are evaluated
   * constantly, before every step, for every declared outcome and failure
   * rule. Two consequences follow. It must not throw, because "is the
   * not-found banner showing?" has to be answerable on a page where that frame
   * does not exist at all; a missing frame simply contains no text. And it must
   * not wait long, because a five-second frame poll multiplied by five rules
   * multiplied by seven steps is three minutes of doing nothing. Actions get
   * the patient lookup; observations get the impatient one.
   */
  async visibleText(framePath?: FrameStep[]): Promise<string> {
    if (framePath && framePath.length > 0) {
      const frame = await this.findFrame(framePath, 250).catch(() => undefined);
      if (!frame) return '';
      return (await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string;
    }
    const chunks: string[] = [];
    for (const frame of this.allFrames()) {
      const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (text) chunks.push(text as string);
    }
    return chunks.join('\n');
  }

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  pendingDialog(): PendingDialog | undefined {
    return this.dialog;
  }

  async acceptDialog(): Promise<void> {
    if (!this.dialogHandle) return;
    await this.dialogHandle.accept().catch(() => undefined);
    this.dialogHandle = undefined;
    this.dialog = undefined;
    await this.waitForSettled();
  }

  async dismissDialog(): Promise<void> {
    if (!this.dialogHandle) return;
    await this.dialogHandle.dismiss().catch(() => undefined);
    this.dialogHandle = undefined;
    this.dialog = undefined;
    await this.waitForSettled();
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  /**
   * Marks every node whose visible content would be redacted, plus every
   * password field, so Playwright covers them during capture. The attribute is
   * removed immediately afterwards; it exists for the duration of one
   * screenshot and is never present while an action runs.
   */
  /**
   * Marks the regions a screenshot must cover, and, just as importantly -
   * reports the frames it could not inspect.
   *
   * Redaction has to fail *closed*. If a frame cannot be collected, or marking
   * throws because the page navigated mid-call, we do not know what is on that
   * frame; the safe reading is "possibly a tax ID", not "nothing to mask". The
   * caller covers those frames whole rather than shipping a screenshot that
   * silently proves nothing.
   *
   * This is not hypothetical. Frames captured while the engine was navigating
   * came out unmasked, and the only reason it was caught is that a person
   * looked at the image.
   */
  private async markSensitive(): Promise<{ touched: Frame[]; unverified: Frame[] }> {
    const touched: Frame[] = [];
    const unverified: Frame[] = [];
    for (const frame of this.allFrames()) {
      const raw = await this.collect(frame);
      if (!raw) {
        unverified.push(frame);
        continue;
      }

      const sensitive = raw.nodes
        .filter(
          (n) =>
            n.isPassword ||
            (n.text ? this.redactor.wouldRedact(n.text) : false) ||
            (n.value ? this.redactor.wouldRedact(n.value) : false),
        )
        .map((n) => n.index);

      if (sensitive.length === 0) continue;

      await frame
        .evaluate(
          ({ indices, attr }) => {
            const els = (window as unknown as { __cuaNodes: Element[] }).__cuaNodes ?? [];
            const marked: Element[] = [];
            for (const i of indices) {
              const el = els[i];
              if (el) {
                el.setAttribute(attr, '1');
                marked.push(el);
              }
            }

            // Mask only the deepest match. An element's text includes its
            // descendants' text, so a tax ID in one cell also matches the row,
            // the table, and the body, and masking those blacks out the whole
            // screen. A screenshot that hides everything is not evidence, it
            // is an absence of evidence, so keep the innermost element and
            // release its ancestors.
            for (const el of marked) {
              if (marked.some((other) => other !== el && el.contains(other))) {
                el.removeAttribute(attr);
              }
            }
          },
          { indices: sensitive, attr: MASK_ATTRIBUTE },
        )
        .then(() => touched.push(frame))
        .catch(() => unverified.push(frame));
    }
    return { touched, unverified };
  }

  private async unmarkSensitive(frames: Frame[]): Promise<void> {
    for (const frame of frames) {
      await frame
        .evaluate((attr) => {
          document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
        }, MASK_ATTRIBUTE)
        .catch(() => undefined);
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const shouldMask = options.maskSensitive ?? true;
    let marked: Frame[] = [];
    try {
      const masks: Locator[] = [];

      if (shouldMask) {
        const { touched, unverified } = await this.markSensitive();
        marked = touched;
        masks.push(...touched.map((f) => f.locator(`[${MASK_ATTRIBUTE}]`)));

        // A frame we could not inspect is covered entirely. An obviously
        // redacted screenshot is a worse diagnostic and a correct one; an
        // apparently clean screenshot that was never actually checked is the
        // failure mode this whole layer exists to prevent.
        for (const frame of unverified) masks.push(frame.locator('body'));
        if (unverified.length > 0) {
          this.emit(
            'redaction_incomplete',
            `${unverified.length} frame(s) could not be inspected before capture and were masked whole`,
            { frames: unverified.map((f) => f.name() || f.url()) },
          );
        }
      }

      return await this.page.screenshot({
        fullPage: options.fullPage ?? false,
        ...(masks.length > 0 ? { mask: masks, maskColor: '#111827' } : {}),
      });
    } finally {
      if (marked.length > 0) await this.unmarkSensitive(marked);
    }
  }

  async sourceSnapshot(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.allFrames()) {
      const name = frame.name() || '(main)';
      const html = await frame.content().catch(() => '<!-- frame unreadable -->');
      parts.push(`<!-- ===== frame: ${name} · ${frame.url()} ===== -->\n${html}`);
    }
    return parts.join('\n\n');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * "Settled" means no frame has navigated for a short quiet period.
   *
   * This is the honest definition for a frameset application: a click in the
   * nav pane navigates the content pane, and neither `page.waitForLoadState`
   * nor the click's own auto-wait observes that. Waiting for quiet is the
   * cheap, general answer, as opposed to hard-coding which action navigates
   * which pane, which would be true only of this one app.
   */
  async waitForSettled(timeoutMs = 5_000): Promise<void> {
    // Never wait on a page blocked behind a modal, the wait cannot succeed,
    // and burning the timeout hides the condition that actually needs handling.
    if (this.dialog) return;

    await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);

    const quietMs = 200;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.dialog) return;
      const sinceLastNav = Date.now() - this.lastNavigationAt;
      if (sinceLastNav >= quietMs || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(50, quietMs - sinceLastNav)));
    }
  }

  /**
   * Waits out any navigation an action triggered. The short opening window
   * exists because a submit returns before the navigation it causes has begun;
   * without it we would measure quiet that had not started yet.
   */
  private async settleAfterAction(navCountBefore: number): Promise<void> {
    if (this.dialog) return;
    const openingWindowEnds = Date.now() + 750;
    while (this.navCount === navCountBefore && Date.now() < openingWindowEnds) {
      if (this.dialog) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.waitForSettled();
  }

  // -------------------------------------------------------------------------
  // Human handoff
  // -------------------------------------------------------------------------

  async captureHumanActions(onAction: (action: HumanAction) => void): Promise<() => Promise<void>> {
    const bindingName = '__cuaHumanAction';

    await this.page
      .exposeBinding(bindingName, (_source, payload: { kind: string; detail: string }) => {
        onAction({
          at: new Date().toISOString(),
          kind: payload.kind as HumanAction['kind'],
          // Redacted at the boundary: a human typing a member's tax ID into a
          // field must not put it into the audit log verbatim.
          detail: this.redactor.text(payload.detail),
        });
      })
      .catch(() => undefined);

    const script = `(() => {
      if (window.__cuaCaptureInstalled) return;
      window.__cuaCaptureInstalled = true;
      const describe = (el) => {
        if (!el || !el.tagName) return 'unknown element';
        const tag = el.tagName.toLowerCase();
        const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.value || el.textContent || '';
        return tag + ' "' + String(label).replace(/\\s+/g, ' ').trim().slice(0, 80) + '"';
      };
      const report = (kind, el) => {
        try { window.__cuaHumanAction({ kind, detail: describe(el) }); } catch (e) { /* binding not ready */ }
      };
      document.addEventListener('click', (e) => report('click', e.target), true);
      document.addEventListener('change', (e) => report('change', e.target), true);
      document.addEventListener('submit', (e) => report('submit', e.target), true);
    })();`;

    // Applies to frames that navigate during the handoff...
    await this.page.addInitScript(script).catch(() => undefined);
    // ...and to the frames that already exist right now.
    for (const frame of this.allFrames()) {
      await frame.evaluate(script).catch(() => undefined);
    }

    this.emit('note', 'human action capture installed');

    return async () => {
      for (const frame of this.allFrames()) {
        await frame.evaluate('window.__cuaCaptureInstalled = false;').catch(() => undefined);
      }
    };
  }

  private guardHuman(action: string): void {
    const lease = this.options.lease;
    if (lease && lease.holder !== 'human') {
      throw new Error(`Operator attempted "${action}" while control was held by ${lease.holder}`);
    }
  }

  async humanClickAt(x: number, y: number): Promise<void> {
    this.guardHuman('click');
    const before = this.navCount;
    await this.page.mouse.click(x, y);
    await this.settleAfterAction(before);
  }

  async humanType(text: string): Promise<void> {
    this.guardHuman('type');
    await this.page.keyboard.type(text, { delay: 15 });
  }

  async humanPress(key: string): Promise<void> {
    this.guardHuman(`press ${key}`);
    const before = this.navCount;
    await this.page.keyboard.press(key);
    await this.settleAfterAction(before);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
