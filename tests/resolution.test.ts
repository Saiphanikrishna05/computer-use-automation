/**
 * The locator resolution engine, exercised against real markup.
 *
 * These run against a live Chromium with an inline page rather than a mocked
 * DOM, because the thing under test *is* the interaction with real layout:
 * computed accessible names, table geometry, visibility. A fake DOM would test
 * my model of the browser rather than the browser.
 *
 * The fixture reproduces the properties that make legacy console markup hard —
 * no test ids, no <label for>, table-based layout, ids regenerated per render,
 * and the same label text appearing in two panels.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { collectUiNodes, resolveCandidateInPage, type RawSnapshot } from '../src/perception/inpage.js';

const FIXTURE = `<html><body bgcolor="#d4d0c8">
  <table border="1"><tr><td>
    <table border="0">
      <tr bgcolor="#1c3f60"><td colspan="2"><b>Member Search</b></td></tr>
      <tr><td>Member ID</td><td><input type="text" name="memberId" id="ctl_a1b2_m" size="16"></td></tr>
      <tr><td>Surname</td><td><input type="text" name="surname" id="ctl_a1b2_n"></td></tr>
      <tr><td></td><td><input type="submit" name="go" id="ctl_a1b2_g" value="Search"></td></tr>
    </table>
  </td></tr></table>

  <table border="1"><tr><td>
    <table border="0">
      <tr bgcolor="#7f8b96"><td colspan="2"><b>Recent Terminal Activity</b></td></tr>
      <tr><td>Member ID</td><td><input type="text" name="recentMemberId" id="ctl_a1b2_h" readonly></td></tr>
    </table>
  </td></tr></table>

  <table border="1"><tr><td>
    <table border="0">
      <tr bgcolor="#1c3f60"><td colspan="4"><b>Accounts</b></td></tr>
      <tr bgcolor="#b8c4d0"><td><b>Account Type</b></td><td><b>Account Number</b></td><td><b>Current Balance</b></td><td><b>Date Opened</b></td></tr>
      <tr><td>Savings</td><td>000410028815</td><td><b>$4,182.55</b></td><td>11/02/1994</td></tr>
      <tr><td>Checking</td><td>000410028816</td><td><b>$918.20</b></td><td>01/17/1996</td></tr>
    </table>
  </td></tr></table>
</body></html>`;

let browser: Browser;
let page: Page;
let snapshot: RawSnapshot;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');
  snapshot = await page.evaluate(collectUiNodes);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const resolve = (candidate: Record<string, unknown>, anchor?: Record<string, unknown>) =>
  page.evaluate(resolveCandidateInPage, { candidate, anchor } as never);

const nodeAt = (index: number) => snapshot.nodes[index]!;

describe('perception on legacy markup', () => {
  it('infers a field label from the adjacent table cell, with no markup association', () => {
    const field = snapshot.nodes.find((n) => n.attributes['name'] === 'memberId')!;
    expect(field.nearestLabel).toBe('Member ID');
    // Flagged positional, because it was inferred from layout rather than a
    // <label for>. Replay scores it accordingly.
    expect(field.nearestLabelPositional).toBe(true);
    // And it genuinely has no accessible name of its own.
    expect(field.name).toBe('');
  });

  it('derives a submit button name from its value attribute', () => {
    const button = snapshot.nodes.find((n) => n.attributes['name'] === 'go')!;
    expect(button.role).toBe('button');
    expect(button.name).toBe('Search');
  });

  it('attributes each control to the panel it sits in', () => {
    const search = snapshot.nodes.find((n) => n.attributes['name'] === 'memberId')!;
    const recent = snapshot.nodes.find((n) => n.attributes['name'] === 'recentMemberId')!;
    expect(search.containerName).toBe('Member Search');
    expect(recent.containerName).toBe('Recent Terminal Activity');
  });

  it('reads a cell\'s row and column headers, skipping the colspan title row', () => {
    // The panel's first row is a colspan'd title bar; the real headings are in
    // the row beneath it. Getting this wrong makes every cell uncolumned.
    const balance = snapshot.nodes.find((n) => n.text === '$4,182.55')!;
    expect(balance.rowHeader).toBe('Savings');
    expect(balance.columnHeader).toBe('Current Balance');
  });
});

describe('candidate resolution', () => {
  it('finds a control by its inferred label', async () => {
    const matches = await resolve({ kind: 'label', text: 'Surname', expect: 'control' });
    expect(matches).toHaveLength(1);
    expect(nodeAt(matches[0]!).attributes['name']).toBe('surname');
  });

  it('reports ambiguity when a label appears in two panels', async () => {
    const matches = await resolve({ kind: 'label', text: 'Member ID', expect: 'control' });
    expect(matches).toHaveLength(2);
  });

  it('resolves that ambiguity with a container anchor', async () => {
    const matches = await resolve(
      { kind: 'label', text: 'Member ID', expect: 'control' },
      { containerName: 'Member Search' },
    );
    expect(matches).toHaveLength(1);
    expect(nodeAt(matches[0]!).attributes['name']).toBe('memberId');
  });

  it('addresses a table cell by row and column, the way a person reads one', async () => {
    const matches = await resolve({
      kind: 'label',
      text: 'Savings',
      expect: 'cell',
      column: 'Current Balance',
    });
    expect(matches).toHaveLength(1);
    expect(nodeAt(matches[0]!).text).toBe('$4,182.55');
  });

  it('picks the right row when several rows share a column', async () => {
    const matches = await resolve({ kind: 'label', text: 'Checking', expect: 'cell', column: 'Current Balance' });
    expect(nodeAt(matches[0]!).text).toBe('$918.20');
  });

  it('keeps "the field labelled X" and "the cell in row X" apart', async () => {
    // Both readings are reasonable on table markup; conflating them makes
    // every lookup on this kind of screen ambiguous.
    const control = await resolve({ kind: 'label', text: 'Member ID', expect: 'control' });
    const cell = await resolve({ kind: 'label', text: 'Member ID', expect: 'cell' });
    for (const index of control) expect(nodeAt(index).role).toBe('textbox');
    for (const index of cell) expect(nodeAt(index).role).toBe('cell');
  });

  it('absorbs tenant wording differences through non-exact matching', async () => {
    // A capability recorded against a tenant that says "Savings" still finds a
    // tenant whose build says "Regular Savings" — no override needed.
    await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('td'));
      const savings = cells.find((c) => c.textContent?.trim() === 'Savings');
      if (savings) savings.textContent = 'Regular Savings';
    });
    await page.evaluate(collectUiNodes);
    const matches = await resolve({ kind: 'label', text: 'Savings', expect: 'cell', column: 'Current Balance' });
    expect(matches).toHaveLength(1);

    await page.setContent(FIXTURE);
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');
    snapshot = await page.evaluate(collectUiNodes);
  });

  it('matches nothing for an empty expected value', async () => {
    // Guards the bug where "".includes(x) logic made every unnamed node match.
    const matches = await resolve({ kind: 'label', text: '', expect: 'control' });
    expect(matches).toHaveLength(0);
  });

  it('finds a button by role and accessible name', async () => {
    const matches = await resolve({ kind: 'role_name', role: 'button', name: 'Search', exact: true });
    expect(matches).toHaveLength(1);
  });

  it('supports a structural fallback on a stable attribute', async () => {
    const matches = await resolve({ kind: 'structural', css: 'input[name="memberId"]', ordinal: 0 });
    expect(matches).toHaveLength(1);
  });

  it('resolves by viewport-relative coordinates as a last resort', async () => {
    const button = snapshot.nodes.find((n) => n.attributes['name'] === 'go')!;
    const matches = await resolve({
      kind: 'coordinates',
      xFraction: (button.box!.x + button.box!.width / 2) / snapshot.viewport.width,
      yFraction: (button.box!.y + button.box!.height / 2) / snapshot.viewport.height,
    });
    expect(matches).toContain(button.index);
  });
});

describe('label/value grids are not tables', () => {
  const GRID = `<html><body>
    <table border="1"><tr><td>
      <table border="0">
        <tr bgcolor="#1c3f60"><td colspan="4"><b>Member Profile</b></td></tr>
        <tr><td>Member ID</td><td><b>100001</b></td><td>Status</td><td>Active</td></tr>
        <tr><td>Name</td><td>Dolores Ashcroft</td><td>Member Since</td><td>11/02/1994</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  it('does not treat the first row of a label/value grid as column headings', async () => {
    // "Member ID | 100001 | Status | Active" is a form rendered with <td>, not
    // a table with headings. Reading row 1 as headers gives every cell below a
    // column header of "100001" — a qualifier made of record data, which is
    // both meaningless and different for every member.
    const page2 = await browser.newPage();
    await page2.setContent(GRID);
    await page2.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');
    const snap = (await page2.evaluate(collectUiNodes)) as RawSnapshot;

    const name = snap.nodes.find((n) => n.text === 'Dolores Ashcroft')!;
    expect(name.rowHeader).toBe('Name');
    expect(name.columnHeader).toBeUndefined();
    await page2.close();
  });

  it('still reads column headings from a row that is actually styled as one', async () => {
    // The accounts table's heading row carries its own bgcolor and emphasises
    // every cell. That is what a real header row looks like in this markup.
    const balance = snapshot.nodes.find((n) => n.text === '$4,182.55')!;
    expect(balance.rowHeader).toBe('Savings');
    expect(balance.columnHeader).toBe('Current Balance');
  });
});
