/**
 * Turning an observed element into a durable descriptor.
 *
 * This is where record-time and replay-time meet, and it embodies the single
 * most important decision in the system: **the model never authors a
 * locator.** It points at an element it can see; we synthesize the full ranked
 * candidate ladder from what perception measured about that element.
 *
 * The reason is not tidiness. A model asked to write a selector will write one
 * that works on the page in front of it — the volatile id, the nth-child path
 * — because it has no way to know which signals are durable. Synthesizing the
 * ladder from measured properties means every artifact gets the same, best
 * available set of signals, and improving that judgement improves every
 * capability ever recorded rather than only the next one.
 */

import type { LocatorCandidate, TargetDescriptor } from '../artifact/schema.js';
import type { UiNode } from '../surface/types.js';

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-qa', 'data-cy'];

const CELL_ROLES = new Set(['cell', 'columnheader', 'row']);

/**
 * Rejects any string that redaction has touched, as a locator signal.
 *
 * This started as a leak fix and turned out to be a correctness fix. In an
 * accounts table the cell to the left of a balance is the *account number*, so
 * it becomes that balance's `nearestLabel` — and a locator built from it is
 * wrong twice over. It writes a member's account number into an artifact that
 * gets committed and reviewed, and it cannot generalise: the whole point of the
 * capability is to run for a different member tomorrow, whose account number is
 * different. Record data is never chrome, and only chrome makes a durable
 * locator.
 */
function isUsableAsLocator(value: string | undefined): value is string {
  return !!value && !value.includes('[redacted:');
}

export function candidatesFor(node: UiNode): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];

  for (const attr of TEST_ID_ATTRIBUTES) {
    const value = node.attributes[attr];
    if (value) candidates.push({ kind: 'test_id', attribute: attr, value });
  }

  // Role + accessible name is the strongest semantic signal and the one most
  // likely to survive a restyle, a framework upgrade, or a tenant rebrand.
  //
  // Except on a table cell, where the accessible name *is the cell's content*.
  // "The cell named $4,182.55" is not an identifier, it is today's answer: it
  // matches exactly one member and fails for every other, which is the reverse
  // of what a reusable capability needs. Cells are addressed by their row and
  // column instead, below.
  if (isUsableAsLocator(node.name) && !CELL_ROLES.has(node.role)) {
    candidates.push({ kind: 'role_name', role: node.role, name: node.name, exact: true });
  }

  if (isUsableAsLocator(node.nearestLabel)) {
    candidates.push({
      kind: 'label',
      text: node.nearestLabel,
      positional: node.nearestLabelPositional ?? false,
      expect: CELL_ROLES.has(node.role) ? 'cell' : 'control',
    });
  }

  // A cell is addressed by where it sits in the table, the way a person reads
  // one. This survives both column re-ordering and row movement, which is more
  // than can be said for any index-based alternative.
  if (CELL_ROLES.has(node.role) && isUsableAsLocator(node.rowHeader)) {
    candidates.push({
      kind: 'label',
      text: node.rowHeader,
      positional: true,
      expect: 'cell',
      ...(isUsableAsLocator(node.columnHeader) ? { column: node.columnHeader } : {}),
    });
  }

  if (isUsableAsLocator(node.placeholder)) {
    candidates.push({ kind: 'placeholder', text: node.placeholder });
  }

  if (isUsableAsLocator(node.text) && ['button', 'link', 'cell'].includes(node.role) && node.text !== node.name) {
    candidates.push({ kind: 'text', text: node.text, exact: true });
  }

  // A structural fallback, but only from attributes that mean something. This
  // application regenerates every element id on each render, so an id-based
  // path would be a candidate that is guaranteed to fail — worse than none,
  // because it burns a resolution attempt and muddies the drift signal.
  const nameAttr = node.attributes['name'];
  if (nameAttr && node.tag) {
    candidates.push({ kind: 'structural', css: `${node.tag}[name="${cssEscape(nameAttr)}"]`, ordinal: 0 });
  }

  // Coordinates last, and as viewport fractions rather than pixels so a
  // different window size still lands on the control. This tier exists for
  // surfaces that expose no tree at all — a Citrix-published app, a canvas
  // widget — and its presence in the ladder is what keeps the schema honest
  // about supporting them.
  if (node.box && node.box.width > 0 && node.box.height > 0) {
    const viewportWidth = 1280;
    const viewportHeight = 900;
    candidates.push({
      kind: 'coordinates',
      xFraction: clamp01((node.box.x + node.box.width / 2) / viewportWidth),
      yFraction: clamp01((node.box.y + node.box.height / 2) / viewportHeight),
    });
  }

  return candidates;
}

export function describeNode(node: UiNode): string {
  const bits: string[] = [];
  if (node.name) bits.push(`"${node.name}"`);
  else if (node.nearestLabel) bits.push(`labelled "${node.nearestLabel}"`);
  else if (node.text) bits.push(`"${truncate(node.text, 40)}"`);
  const where = node.containerName ? ` in the ${node.containerName} panel` : '';
  return `${node.role}${bits.length ? ` ${bits.join(' ')}` : ''}${where}`;
}

export function descriptorFor(node: UiNode, viewport: { width: number; height: number }): TargetDescriptor {
  const candidates = candidatesFor(node).map((c) =>
    c.kind === 'coordinates' && node.box
      ? {
          ...c,
          xFraction: clamp01((node.box.x + node.box.width / 2) / viewport.width),
          yFraction: clamp01((node.box.y + node.box.height / 2) / viewport.height),
        }
      : c,
  );

  const anchor: TargetDescriptor['anchor'] = {};
  if (node.containerRole) anchor.containerRole = node.containerRole;
  if (isUsableAsLocator(node.containerName)) anchor.containerName = node.containerName;
  // The nearest label is recorded as an anchor only when it is not already
  // carrying the identification — otherwise the anchor restates the candidate
  // and narrows nothing.
  if (isUsableAsLocator(node.nearestLabel) && node.name) anchor.nearestLabel = node.nearestLabel;

  return {
    description: describeNode(node),
    framePath: node.framePath,
    candidates:
      candidates.length > 0
        ? candidates
        : // Nothing durable was measurable. An empty candidate list fails schema
          // validation, which is the correct outcome: a descriptor that can find
          // nothing must not reach disk pretending to be usable.
          [{ kind: 'text', text: isUsableAsLocator(node.text) ? node.text : '', exact: false }],
    ...(Object.keys(anchor).length > 0 ? { anchor } : {}),
    ...(ordinalFor(node) !== undefined ? { ordinal: ordinalFor(node) } : {}),
    evidence: {
      role: node.role,
      ...(isUsableAsLocator(node.name) ? { accessibleName: node.name } : {}),
      ...(node.tag ? { tag: node.tag } : {}),
      ...(isUsableAsLocator(node.text) ? { textSnippet: truncate(node.text, 120) } : {}),
      ...(node.box ? { boundingBox: node.box } : {}),
      viewport,
    },
  };
}

/**
 * Which match to take when a candidate legitimately resolves to several.
 *
 * For a table cell this is its position within its own row, minus the row
 * header. A label/value grid — "Member ID | 100001 | Status | Active" — has no
 * column headings for the row-label candidate to qualify against, so that
 * candidate matches every value cell in the row. Recording the position makes
 * the choice deterministic; without it the ladder falls through to
 * coordinates, which is both brittle and a silent downgrade.
 *
 * Everything else records an ordinal only when it genuinely had peers. A
 * gratuitous ordinal would let an ambiguous match resolve quietly instead of
 * being reported, which is the failure mode this whole design is built to
 * avoid.
 */
function ordinalFor(node: UiNode): number | undefined {
  if (CELL_ROLES.has(node.role) && typeof node.cellIndex === 'number' && node.cellIndex > 0) {
    return node.cellIndex - 1;
  }
  return node.ordinalAmongPeers > 0 ? node.ordinalAmongPeers : undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
