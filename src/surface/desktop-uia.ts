/**
 * The desktop driver, as a design rather than an implementation.
 *
 * Every method here throws, on purpose, and says what its Windows UI Automation
 * equivalent would be. This is not a stub in the sense of "unfinished": it is
 * the answer to the question the brief actually asks, which is whether the
 * artifact schema and the replay engine are genuinely surface-agnostic or only
 * claim to be. That claim is testable without a Windows machine, and this file
 * is the test: **the compiler accepts it as a `SurfaceDriver`.** If anything
 * above the driver had leaked a browser assumption, this file would not compile.
 *
 * A half-working driver would be worse than this. It would pass a demo, hide
 * which parts of `UiNode` are actually web-shaped, and leave nobody able to say
 * what it would cost to finish. What is useful to a reader is the mapping and
 * the honest list of what breaks, and both are below.
 *
 * ## The mapping
 *
 * `UiNode` was deliberately chosen as a subset of what UIA, macOS AX and AT-SPI
 * all already expose, which is why most of it is a rename rather than a design:
 *
 * | `UiNode`         | Windows UIA                                              |
 * |------------------|----------------------------------------------------------|
 * | `role`           | `ControlType` (Button, Edit, Text, DataItem…)             |
 * | `name`           | `Name` property, which is UIA's accessible name           |
 * | `value`          | `ValuePattern.Value`                                      |
 * | `text`           | `TextPattern.DocumentRange.GetText()`                     |
 * | `enabled`        | `IsEnabled`                                               |
 * | `focusable`      | `IsKeyboardFocusable`                                     |
 * | `box`            | `BoundingRectangle`                                       |
 * | `containerName`  | nearest ancestor with a `Name`, usually Window/Pane/Group  |
 * | `framePath`      | the window/pane ancestry, walked by `AutomationId`/`Name`  |
 * | `attributes`     | `AutomationId`, `ClassName`, `HelpText`                    |
 * | `rowHeader` / `columnHeader` | `TableItemPattern.GetRowHeaderItems()` / `GetColumnHeaderItems()` |
 *
 * The locator ladder survives that mapping nearly intact. `test_id` becomes
 * `AutomationId`, which is the closest thing the desktop has to a stable hook
 * and is more often present than a web `data-testid`. `role_name` is
 * `ControlType` plus `Name`, and is the tier most flows would actually resolve
 * at. `structural` becomes the UIA tree path. `coordinates` is unchanged, and
 * is the last resort for the same reason.
 *
 * ## What I expect to have got wrong
 *
 * The label heuristics, and specifically `nearestLabel`. On the web this file's
 * sibling infers a label from the adjacent table cell, because legacy consoles
 * have no `<label for>`. Win32 has the same problem and a different shape: a
 * `Static` control positioned to the left of an `Edit`, related by geometry and
 * nothing else, with no ancestor tying them together. The web heuristic reaches
 * for DOM adjacency, which does not exist there, so it would have to be
 * rewritten as pure spatial proximity with a reading-order bias. I would not
 * know how badly until it ran against a real application, and that is the
 * honest reason this file throws rather than pretending.
 *
 * Two other things I know are unresolved rather than merely unwritten:
 *
 *  - **Redaction.** The web driver masks sensitive regions before a screenshot
 *    exists, by finding elements and covering their boxes. UIA gives bounding
 *    rectangles too, so the same approach applies, but a desktop app can paint
 *    outside any element it reports, and the fail-closed rule would need to
 *    mean "mask the whole window" far more often.
 *  - **Human handoff.** `captureHumanActions` hooks page events on the web.
 *    The desktop equivalent is a UIA event subscription plus low-level input
 *    hooks, which is a materially harder thing to do safely and is where most
 *    of the remaining work is.
 */

import type { ActionClass, FrameStep, TargetDescriptor } from '../artifact/schema.js';
import type {
  HumanAction,
  PendingDialog,
  ResolutionResult,
  ScreenshotOptions,
  SurfaceDriver,
  SurfaceElement,
  SurfaceSnapshot,
  TypeOptions,
} from './types.js';

/**
 * Thrown with the UIA equivalent, so an error tells a reader what the work is
 * rather than only that there is some.
 */
export class NotImplementedOnDesktop extends Error {
  constructor(
    readonly method: string,
    readonly uiaEquivalent: string,
  ) {
    super(`${method} is not implemented for the desktop surface. UIA equivalent: ${uiaEquivalent}`);
    this.name = 'NotImplementedOnDesktop';
  }
}

/**
 * A `SurfaceDriver` for Windows UI Automation.
 *
 * The value of this class is that it compiles. Everything above the driver —
 * the artifact schema, the replay engine, policy, escalation, evidence — is
 * written against `UiNode` and `TargetDescriptor`, and this file is what proves
 * none of it quietly depends on a browser.
 */
export class DesktopUiaSurface implements SurfaceDriver {
  readonly kind = 'desktop' as const;

  private fail(method: string, uia: string): never {
    throw new NotImplementedOnDesktop(method, uia);
  }

  // --- navigation ----------------------------------------------------------
  // "Navigate" on a desktop is launching or focusing a window, so the URL
  // template becomes a launch target. The artifact does not need to change:
  // `entryUrlTemplate` is already just a string the driver interprets.

  async navigate(_url: string): Promise<void> {
    this.fail('navigate', 'Process.Start or AutomationElement.RootElement.FindFirst on the window title');
  }
  async currentUrl(): Promise<string> {
    this.fail('currentUrl', 'the focused window\'s AutomationId and Name, as a stable identifier');
  }
  async title(): Promise<string> {
    this.fail('title', 'AutomationElement.Current.Name on the top-level window');
  }

  // --- perception ----------------------------------------------------------

  async snapshot(): Promise<SurfaceSnapshot> {
    this.fail('snapshot', 'TreeWalker over RawViewWalker, projecting each element into UiNode');
  }
  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    this.fail('screenshot', 'PrintWindow or Graphics.CopyFromScreen over BoundingRectangle');
  }
  async sourceSnapshot(): Promise<string> {
    this.fail('sourceSnapshot', 'a serialised UIA subtree, the desktop analogue of a DOM dump');
  }
  async visibleText(_framePath?: FrameStep[]): Promise<string> {
    this.fail('visibleText', 'TextPattern.DocumentRange.GetText across visible descendants');
  }

  // --- resolution ----------------------------------------------------------

  async resolve(_target: TargetDescriptor): Promise<ResolutionResult> {
    this.fail(
      'resolve',
      'the same ladder against UIA: AutomationId, then ControlType+Name, then the tree path, then coordinates',
    );
  }
  async isVisible(_element: SurfaceElement): Promise<boolean> {
    this.fail('isVisible', 'IsOffscreen inverted, and a non-empty BoundingRectangle');
  }

  // --- actions -------------------------------------------------------------
  // The action-class ceiling is enforced above this layer and does not change,
  // which is the point of putting policy in the driver interface rather than
  // in any one implementation of it.

  async click(_element: SurfaceElement, _actionClass?: ActionClass): Promise<void> {
    this.fail('click', 'InvokePattern.Invoke, falling back to synthesised input at BoundingRectangle centre');
  }
  async type(_element: SurfaceElement, _text: string, _options?: TypeOptions): Promise<void> {
    this.fail('type', 'ValuePattern.SetValue, or SendInput when the control has no ValuePattern');
  }
  async selectOption(_element: SurfaceElement, _value: string, _actionClass?: ActionClass): Promise<void> {
    this.fail('selectOption', 'SelectionItemPattern.Select on the matching child');
  }
  async press(_key: string, _element?: SurfaceElement, _actionClass?: ActionClass): Promise<void> {
    this.fail('press', 'SendInput with the mapped virtual key code');
  }
  async read(
    _element: SurfaceElement,
    _source: 'text' | 'value' | 'attribute',
    _attribute?: string,
  ): Promise<string> {
    this.fail('read', 'ValuePattern.Value, TextPattern range text, or the named UIA property');
  }

  // --- dialogs -------------------------------------------------------------
  // Closer to the web than most of this file: a modal is a window with
  // IsModal set, and "accept" is invoking its default button.

  pendingDialog(): PendingDialog | undefined {
    return undefined;
  }
  async acceptDialog(): Promise<void> {
    this.fail('acceptDialog', 'InvokePattern on the default button of the modal window');
  }
  async dismissDialog(): Promise<void> {
    this.fail('dismissDialog', 'InvokePattern on the cancel button, or WM_CLOSE');
  }

  async waitForSettled(_timeoutMs?: number): Promise<void> {
    this.fail('waitForSettled', 'wait for the UI thread to go idle, then for the UIA tree to stop changing');
  }

  // --- human handoff -------------------------------------------------------
  // The hardest part, and the least like the web. See the note at the top.

  async captureHumanActions(_onAction: (action: HumanAction) => void): Promise<() => Promise<void>> {
    this.fail('captureHumanActions', 'AddAutomationEventHandler plus a low-level input hook');
  }
  async humanClickAt(_x: number, _y: number): Promise<void> {
    this.fail('humanClickAt', 'SendInput at absolute screen coordinates');
  }
  async humanType(_text: string): Promise<void> {
    this.fail('humanType', 'SendInput as unicode key events');
  }
  async humanPress(_key: string): Promise<void> {
    this.fail('humanPress', 'SendInput with the mapped virtual key code');
  }

  async close(): Promise<void> {
    // Deliberately does not throw. Cleanup that fails on a driver which never
    // opened anything would turn every `finally` block into a second error
    // that hides the first.
  }
}
