/**
 * The desktop driver as a claim about the rest of the system.
 *
 * The brief asks whether the artifact schema and the replay engine generalise
 * beyond a browser. The strongest available answer without a Windows machine is
 * that a second `SurfaceDriver` compiles and is accepted everywhere the first
 * one is: if anything above the driver had leaked a browser assumption, that
 * would not be true.
 *
 * These tests pin the parts a compiler cannot. That every method exists, that
 * none silently returns a plausible-looking empty value, and that each failure
 * says what the Windows equivalent would be — because an unimplemented method
 * whose error tells you the work is a design note, and one that just throws is
 * a gap.
 */

import { describe, expect, it } from 'vitest';
import { DesktopUiaSurface, NotImplementedOnDesktop } from '../src/surface/desktop-uia.js';
import type { SurfaceDriver } from '../src/surface/types.js';

/** Typed as the interface, not the class: this assignment is the claim. */
const driver: SurfaceDriver = new DesktopUiaSurface();

const METHODS: Array<[keyof SurfaceDriver, unknown[]]> = [
  ['navigate', ['app://x']],
  ['currentUrl', []],
  ['title', []],
  ['snapshot', []],
  ['screenshot', []],
  ['sourceSnapshot', []],
  ['visibleText', []],
  ['resolve', [{ description: 'x', framePath: [], candidates: [], evidence: {} }]],
  ['isVisible', [{}]],
  ['click', [{}]],
  ['type', [{}, 'text']],
  ['selectOption', [{}, 'v']],
  ['press', ['Enter']],
  ['read', [{}, 'text']],
  ['acceptDialog', []],
  ['dismissDialog', []],
  ['waitForSettled', []],
  ['captureHumanActions', [() => {}]],
  ['humanClickAt', [1, 2]],
  ['humanType', ['x']],
  ['humanPress', ['Enter']],
];

describe('DesktopUiaSurface', () => {
  it('is accepted as a SurfaceDriver, which is the whole point of it', () => {
    // If the schema, resolver, executor or policy had a browser assumption in
    // them, there would be no way to write this file at all.
    expect(driver.kind).toBe('desktop');
  });

  it('implements every method the interface requires', () => {
    for (const [name] of METHODS) {
      expect(typeof driver[name]).toBe('function');
    }
  });

  it('refuses loudly rather than returning something plausible', async () => {
    // The dangerous version of an unfinished driver is one that returns "" and
    // an empty node list: replay would report a clean, confident, wrong answer.
    for (const [name, args] of METHODS) {
      const call = (driver[name] as (...a: unknown[]) => Promise<unknown>).bind(driver);
      await expect(call(...args)).rejects.toBeInstanceOf(NotImplementedOnDesktop);
    }
  });

  it('names the Windows equivalent in every failure, so the error is a design note', async () => {
    for (const [name, args] of METHODS) {
      const call = (driver[name] as (...a: unknown[]) => Promise<unknown>).bind(driver);
      await call(...args).catch((error: NotImplementedOnDesktop) => {
        expect(error.uiaEquivalent, `${String(name)} should say what UIA would do`).toBeTruthy();
        expect(error.message).toContain('UIA equivalent');
      });
    }
  });

  it('reports no pending dialog rather than throwing, because callers poll it', () => {
    // `pendingDialog` is read on the hot path by condition evaluation. Throwing
    // there would turn "is a dialog up" into an exception on every check.
    expect(driver.pendingDialog()).toBeUndefined();
  });

  it('closes without throwing, so cleanup cannot mask a real error', async () => {
    // A `finally` block that throws replaces the original failure with a
    // less interesting one.
    await expect(driver.close()).resolves.toBeUndefined();
  });
});
