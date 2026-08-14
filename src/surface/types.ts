/**
 * The surface abstraction.
 *
 * This is the only place in the system that knows *how* a surface is perceived
 * and acted upon. Everything above it — the artifact schema, the replay
 * engine, policy, escalation, evidence — is written against `UiNode` and
 * `TargetDescriptor` and has no idea whether it is driving a browser, a
 * Win32 window, or a terminal emulator.
 *
 * Why this particular shape: `UiNode` is a deliberate subset of what both the
 * web accessibility tree and the desktop accessibility APIs (Windows UIA,
 * macOS AX, AT-SPI) already expose. Role, name, value, enabled/focusable
 * state, a container path and a bounding box exist in all of them. A desktop
 * driver is therefore a translation layer, not a redesign — and, critically,
 * artifacts recorded through one driver describe controls in terms the other
 * driver can also resolve.
 */

import type { ActionClass, FrameStep, SurfaceKind, TargetDescriptor } from '../artifact/schema.js';

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One control, normalized.
 *
 * `ref` is valid only within the snapshot that produced it. Nothing is ever
 * recorded into an artifact by `ref` — artifacts record descriptors, which are
 * re-resolved from scratch on every replay. This is the single most important
 * invariant for determinism: there is no hidden per-run state that a replay
 * could depend on.
 */
export interface UiNode {
  ref: string;
  role: string;
  /** Accessible name, computed the way a screen reader would. */
  name: string;
  /** Present value for inputs/selects. Redacted before egress. */
  value?: string;
  /** Visible text, trimmed and collapsed. */
  text?: string;

  disabled: boolean;
  focusable: boolean;
  editable: boolean;
  /** False for elements present in the tree but not rendered. */
  visible: boolean;

  framePath: FrameStep[];

  /** Nearest enclosing landmark/section, used to disambiguate duplicates. */
  containerRole?: string;
  containerName?: string;
  /**
   * The label a human would read as belonging to this control. In a legacy
   * console this is usually the adjacent table cell, not a <label for>.
   */
  nearestLabel?: string;
  /** True when `nearestLabel` came from proximity rather than a real association. */
  nearestLabelPositional?: boolean;

  /**
   * For table cells: the first cell of this row, and the cell at the same
   * index in the table's header row. Together they address a cell the way a
   * person reads a table — "the Savings row, Current Balance column" — which
   * survives re-ordering and restyling in a way `nth-child` does not.
   */
  rowHeader?: string;
  columnHeader?: string;

  placeholder?: string;
  /** Values from password fields are never captured, logged, or sent onward. */
  isPassword: boolean;

  /** Allowlisted attributes only — never a dump of every attribute on the node. */
  attributes: Record<string, string>;

  box?: BoundingBox;

  /** Web-only hint. Desktop drivers leave this undefined. */
  tag?: string;

  /** Index among siblings sharing this role and name within the same frame. */
  ordinalAmongPeers: number;
}

export interface PendingDialog {
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
}

export interface SurfaceSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  nodes: UiNode[];
  /** Present when a native modal is blocking the surface. */
  dialog?: PendingDialog;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The per-attempt record of resolving one descriptor.
 *
 * This is not just debug output. Aggregated across replays it *is* the drift
 * detector: a capability that used to resolve at tier 1 and now consistently
 * resolves at tier 5 has not failed yet, but the UI has moved and the
 * capability is one change away from breaking. Waiting for a hard failure to
 * find that out is the expensive way.
 */
export interface CandidateAttempt {
  kind: string;
  tier: number;
  matchCount: number;
  chosen: boolean;
  note?: string;
}

export interface ResolutionReport {
  targetDescription: string;
  attempts: CandidateAttempt[];
  /** Tier of the candidate that won, or null if nothing resolved. */
  winningTier: number | null;
  winningKind: string | null;
  /** True when we resolved, but via a worse signal than the artifact recorded. */
  degraded: boolean;
  elapsedMs: number;
}

export type ResolutionResult =
  | { ok: true; element: SurfaceElement; report: ResolutionReport }
  | { ok: false; reason: 'not_found' | 'ambiguous'; report: ResolutionReport };

/** Opaque driver-specific element handle. Never serialized, never persisted. */
export interface SurfaceElement {
  readonly __brand: 'SurfaceElement';
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  /** Mask regions that would otherwise burn sensitive data into a PNG on disk. */
  maskSensitive?: boolean;
  fullPage?: boolean;
}

export interface TypeOptions {
  clearFirst?: boolean;
  /** Suppresses the value from every log and evidence record. */
  secret?: boolean;
  actionClass?: ActionClass;
}

/**
 * A driver is responsible for exactly two things beyond mechanics:
 *
 *  - enforcing the allowlist, because a chokepoint the model cannot reach is
 *    the only kind that survives prompt injection; and
 *  - refusing to act when it does not hold the control lease, so a paused run
 *    cannot race the human who took over from it.
 *
 * Both checks live here rather than in the caller precisely because there are
 * several callers (discovery, replay, recovery) and only one driver.
 */
export interface SurfaceDriver {
  readonly kind: SurfaceKind;

  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  title(): Promise<string>;

  snapshot(): Promise<SurfaceSnapshot>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  /** Richer failure signal: serialized DOM, or an AX tree dump on desktop. */
  sourceSnapshot(): Promise<string>;

  resolve(target: TargetDescriptor): Promise<ResolutionResult>;

  /**
   * `actionClass` is the *declared semantic risk of the step*, which the driver
   * cannot infer. A click is a click: only the artifact knows whether this one
   * dismisses a notice or commits a funds transfer. Callers that know pass it;
   * the default is the conservative floor for a mutating action.
   */
  click(element: SurfaceElement, actionClass?: ActionClass): Promise<void>;
  type(element: SurfaceElement, text: string, options?: TypeOptions): Promise<void>;
  selectOption(element: SurfaceElement, value: string, actionClass?: ActionClass): Promise<void>;
  press(key: string, element?: SurfaceElement, actionClass?: ActionClass): Promise<void>;

  read(element: SurfaceElement, source: 'text' | 'value' | 'attribute', attribute?: string): Promise<string>;
  isVisible(element: SurfaceElement): Promise<boolean>;

  /** All visible text in the given frame (or every frame when omitted). */
  visibleText(framePath?: FrameStep[]): Promise<string>;

  pendingDialog(): PendingDialog | undefined;
  acceptDialog(): Promise<void>;
  dismissDialog(): Promise<void>;

  waitForSettled(timeoutMs?: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Human handoff
  // -------------------------------------------------------------------------

  /**
   * Begin recording what a human does on the live surface. Returns a function
   * that stops recording.
   *
   * This is what makes a handoff auditable rather than a gap in the log. In a
   * regulated setting "the automation stopped, something happened, the
   * automation resumed" is not an acceptable trail — the actions a person took
   * on a member's account have to be attributable too.
   */
  captureHumanActions(onAction: (action: HumanAction) => void): Promise<() => Promise<void>>;

  /**
   * Input performed *as the human*, not as the automation. These deliberately
   * assert the opposite lease state to every other action on this interface:
   * they are refused unless a human holds control. Same session, same page —
   * which is the requirement — but never both parties driving at once.
   */
  humanClickAt(x: number, y: number): Promise<void>;
  humanType(text: string): Promise<void>;
  humanPress(key: string): Promise<void>;

  close(): Promise<void>;
}

export interface HumanAction {
  at: string;
  kind: 'click' | 'input' | 'change' | 'submit' | 'navigate' | 'key';
  /** Description of the control, already redacted. */
  detail: string;
}
