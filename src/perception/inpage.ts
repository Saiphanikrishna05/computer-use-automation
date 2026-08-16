/**
 * The in-page half of perception and resolution.
 *
 * Everything in this file is serialized and executed inside the page, so it
 * must be self-contained: no imports, no closure over module scope, helpers
 * nested inside the exported functions.
 *
 * Why build an element model rather than delegate to a selector engine: the
 * artifact has to describe controls in terms that a *desktop* accessibility
 * API can also answer. Role, accessible name, the label a human would read as
 * belonging to a control, the enclosing panel, the row and column a cell sits
 * in, Windows UIA and macOS AX expose all of those. `td:nth-child(3)` is not
 * a question you can ask an AX tree. Owning the model is what keeps the
 * artifact schema portable across surfaces instead of quietly becoming a
 * container for CSS.
 *
 * The legacy-specific heuristics here (label-by-adjacent-table-cell, panel
 * name from a table's header row, row/column headers for cells) are not
 * incidental. In a console with no <label for>, no ARIA and no test ids, they
 * are the only signals that mean anything.
 */

export interface RawUiNode {
  index: number;
  tag: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  placeholder?: string;
  disabled: boolean;
  focusable: boolean;
  editable: boolean;
  visible: boolean;
  isPassword: boolean;
  containerRole?: string;
  containerName?: string;
  nearestLabel?: string;
  nearestLabelPositional?: boolean;
  rowHeader?: string;
  columnHeader?: string;
  attributes: Record<string, string>;
  box?: { x: number; y: number; width: number; height: number };
  ordinalAmongPeers: number;
  /** For a table cell, its position within its own row. */
  cellIndex?: number;
}

export interface RawSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  nodes: RawUiNode[];
}

/**
 * Walks the document and produces the normalized element model, stashing live
 * element references on `window.__cuaNodes` so the driver can obtain a handle
 * to node N without re-querying (and without mutating the page).
 */
export function collectUiNodes(): RawSnapshot {
  const w = window as unknown as { __cuaNodes?: Element[]; __cuaSnapshot?: RawSnapshot };

  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const r = rects[0]!;
    return r.width > 0 && r.height > 0;
  };

  const ownText = (el: Element): string => {
    // Text of the element and its descendants, minus anything from a nested
    // interactive control (whose text belongs to that control, not this one).
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('input, select, textarea, button, script, style').forEach((n) => n.remove());
    return norm(clone.textContent);
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'hidden') return 'hidden';
      return 'textbox';
    }
    const map: Record<string, string> = {
      a: 'link',
      button: 'button',
      select: 'combobox',
      textarea: 'textbox',
      table: 'table',
      tr: 'row',
      td: 'cell',
      th: 'columnheader',
      form: 'form',
      img: 'img',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      label: 'label',
      option: 'option',
      iframe: 'frame',
    };
    return map[tag] ?? 'generic';
  };

  /**
   * Accessible name, following the spec's precedence closely enough to match
   * what a screen reader would announce. Deliberately does *not* fall through
   * to adjacent-cell text; that is a weaker, positional signal and is kept
   * separate as `nearestLabel` so the artifact can record which one it used.
   */
  const accessibleName = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => !!n)
        .map((n) => norm(n.textContent));
      if (parts.join(' ').trim()) return norm(parts.join(' '));
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (norm(ariaLabel)) return norm(ariaLabel);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type)) {
        const v = norm(el.getAttribute('value'));
        if (v) return v;
      }
    }

    const id = el.getAttribute('id');
    if (id) {
      const explicitLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (explicitLabel) {
        const t = norm(explicitLabel.textContent);
        if (t) return t;
      }
    }

    const ancestorLabel = el.closest('label');
    if (ancestorLabel && ancestorLabel !== el) {
      const t = norm(ancestorLabel.textContent);
      if (t) return t;
    }

    if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'option', 'label'].includes(tag)) {
      const t = ownText(el);
      if (t) return t;
    }

    const title = norm(el.getAttribute('title'));
    if (title) return title;

    const placeholder = norm(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;

    if (tag === 'img') return norm(el.getAttribute('alt'));

    return '';
  };

  const cellOf = (el: Element): HTMLTableCellElement | null =>
    el.closest('td, th') as HTMLTableCellElement | null;

  /**
   * The label a human reads as belonging to this control.
   *
   * In this class of application the answer is almost always "the text in the
   * table cell immediately to the left", with no markup association at all.
   * `positional: true` records that we inferred it from layout, which is
   * weaker than a real association and is scored accordingly on replay.
   */
  const nearestLabelOf = (el: Element): { text: string; positional: boolean } | null => {
    const id = el.getAttribute('id');
    if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) {
      const t = norm(document.querySelector(`label[for="${CSS.escape(id)}"]`)!.textContent);
      if (t) return { text: t, positional: false };
    }

    const cell = cellOf(el);
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = ownText(prev);
        if (t) return { text: t, positional: true };
        prev = prev.previousElementSibling;
      }
      // Label may sit in the cell above, in a stacked layout.
      const row = cell.closest('tr');
      const prevRow = row?.previousElementSibling as HTMLTableRowElement | null;
      if (prevRow && cell.cellIndex >= 0) {
        const above = prevRow.cells?.[cell.cellIndex];
        if (above) {
          const t = ownText(above);
          if (t) return { text: t, positional: true };
        }
      }
    }

    let sib = el.previousElementSibling;
    while (sib) {
      const t = ownText(sib);
      if (t) return { text: t, positional: true };
      sib = sib.previousElementSibling;
    }

    return null;
  };

  /** Row header = first cell of this cell's row. Column header = the cell at
   *  the same index in the table's first row. Together they address a cell the
   *  way a person reads a table: "Savings / Current Balance". */
  const headersOf = (el: Element): { row?: string; column?: string } => {
    const cell = cellOf(el);
    if (!cell) return {};
    const row = cell.closest('tr') as HTMLTableRowElement | null;
    const table = cell.closest('table') as HTMLTableElement | null;
    if (!row || !table) return {};

    const out: { row?: string; column?: string } = {};

    const firstCell = row.cells?.[0];
    if (firstCell && firstCell !== cell) {
      const t = ownText(firstCell);
      if (t) out.row = t;
    }

    // Finding the header row takes two tests, and the second one matters more
    // than it looks.
    //
    // Matching cell count skips the colspan'd title bar ("Accounts") that a
    // legacy panel table puts in row 0. But cell count alone is not enough:
    // a *label/value grid*, "Member ID | 100001 | Status | Active", is not a
    // table at all; it is a form rendered with <td>. Its first row has the
    // same arity as every other, so it gets mistaken for headings and every
    // cell below inherits a column header of "100001".
    //
    // So the candidate must also *look* like a header: styled as a row (a
    // bgcolor of its own) or emphasised in every cell. A label/value grid
    // emphasises only its values, which is exactly what distinguishes it.
    const looksLikeHeaderRow = (candidate: HTMLTableRowElement): boolean => {
      if (candidate.hasAttribute('bgcolor')) return true;
      const cells = Array.from(candidate.cells);
      if (cells.length === 0) return false;
      const withText = cells.filter((c) => ownText(c).length > 0);
      if (withText.length === 0) return false;
      return withText.every((c) => c.tagName === 'TH' || c.querySelector('b, strong, th') !== null);
    };

    const rows = Array.from(table.rows ?? []);
    const myIndex = rows.indexOf(row);
    let headerRow: HTMLTableRowElement | undefined;
    for (let i = 0; i < myIndex; i += 1) {
      const candidate = rows[i];
      if (candidate && candidate.cells.length === row.cells.length && looksLikeHeaderRow(candidate)) {
        headerRow = candidate;
        break;
      }
    }

    if (headerRow && cell.cellIndex >= 0) {
      const headerCell = headerRow.cells?.[cell.cellIndex];
      if (headerCell) {
        const t = ownText(headerCell);
        if (t) out.column = t;
      }
    }

    return out;
  };

  /**
   * The enclosing panel. In this markup a panel is a table whose first row is
   * a styled header, which is how a legacy console draws a titled section.
   * This is what tells "Member ID in the search panel" apart from "Member ID
   * in the recent-activity panel".
   */
  const containerOf = (el: Element): { role?: string; name?: string } => {
    const explicit = el.closest('[role="region"], fieldset, section, form');
    if (explicit) {
      const legend = explicit.querySelector('legend');
      const name = legend ? norm(legend.textContent) : norm(explicit.getAttribute('aria-label'));
      if (name) return { role: explicit.tagName.toLowerCase(), name };
    }

    let table = el.closest('table') as HTMLTableElement | null;
    while (table) {
      const firstRow = table.rows?.[0];
      if (firstRow && !firstRow.contains(el)) {
        const looksLikeHeader =
          firstRow.querySelector('b, th, strong') !== null || firstRow.hasAttribute('bgcolor');
        if (looksLikeHeader) {
          const name = ownText(firstRow.cells?.[0] ?? firstRow);
          if (name) return { role: 'panel', name };
        }
      }
      table = table.parentElement?.closest('table') as HTMLTableElement | null;
    }

    return {};
  };

  const INTERESTING = 'input, select, textarea, button, a[href], h1, h2, h3, h4, h5, h6, td, th, [role]';
  const ATTRIBUTE_ALLOWLIST = [
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
    'name',
    'type',
    'href',
    'aria-label',
    'role',
  ];

  const elements: Element[] = [];
  const nodes: RawUiNode[] = [];
  const peerCounts = new Map<string, number>();

  document.querySelectorAll(INTERESTING).forEach((el) => {
    const role = roleOf(el);
    if (role === 'hidden') return;

    const visible = isVisible(el);
    const text = ownText(el);
    const isFormControl = ['input', 'select', 'textarea', 'button'].includes(el.tagName.toLowerCase());

    // Structural cells with no text of their own carry no information and
    // would triple the node count for nothing.
    if (!isFormControl && !text && role !== 'img') return;
    if (!visible) return;

    const name = accessibleName(el);
    const label = nearestLabelOf(el);
    const headers = headersOf(el);
    const container = containerOf(el);

    const attributes: Record<string, string> = {};
    for (const attr of ATTRIBUTE_ALLOWLIST) {
      const v = el.getAttribute(attr);
      if (v !== null) attributes[attr] = v;
    }

    const rect = el.getBoundingClientRect();
    const peerKey = `${role} ${name}`;
    const ordinal = peerCounts.get(peerKey) ?? 0;
    peerCounts.set(peerKey, ordinal + 1);

    const inputEl = el as HTMLInputElement;
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    const node: RawUiNode = {
      index: elements.length,
      tag: el.tagName.toLowerCase(),
      role,
      name,
      disabled: isFormControl ? !!inputEl.disabled : false,
      focusable: isFormControl || el.tagName.toLowerCase() === 'a',
      editable: ['textbox', 'combobox'].includes(role) && !inputEl.disabled && !inputEl.readOnly,
      visible,
      isPassword: type === 'password',
      attributes,
      ordinalAmongPeers: ordinal,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };

    if (text) node.text = text;
    if (isFormControl && typeof inputEl.value === 'string' && type !== 'password') node.value = inputEl.value;
    const ph = norm(el.getAttribute('placeholder'));
    if (ph) node.placeholder = ph;
    if (label) {
      node.nearestLabel = label.text;
      node.nearestLabelPositional = label.positional;
    }
    const ownCell = el.closest('td, th') as HTMLTableCellElement | null;
    if (ownCell === el && ownCell.cellIndex >= 0) node.cellIndex = ownCell.cellIndex;
    if (headers.row) node.rowHeader = headers.row;
    if (headers.column) node.columnHeader = headers.column;
    if (container.role) node.containerRole = container.role;
    if (container.name) node.containerName = container.name;

    elements.push(el);
    nodes.push(node);
  });

  const snapshot: RawSnapshot = {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nodes,
  };

  // Live element references and the model are stored together so that
  // resolution and handle acquisition always operate on the same generation of
  // the page. A resolver that scored a stale model and then grabbed a fresh
  // handle would silently act on the wrong element.
  w.__cuaNodes = elements;
  w.__cuaSnapshot = snapshot;

  return snapshot;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveRequest {
  candidate: Record<string, unknown>;
  anchor?: { containerRole?: string; containerName?: string; nearestLabel?: string };
}

/**
 * Returns the indices of every node matching one candidate. Returning all of
 * them rather than the first is deliberate: "how many matched" is what lets
 * the caller distinguish a clean hit from an ambiguous one, and ambiguity is a
 * failure mode worth reporting rather than silently resolving by taking [0].
 */
export function resolveCandidateInPage(request: ResolveRequest): number[] {
  const w = window as unknown as { __cuaSnapshot?: RawSnapshot };
  const snapshot = w.__cuaSnapshot;
  if (!snapshot) return [];

  const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
  const fold = (s: unknown): string => norm(s).toLowerCase();

  const textMatches = (actual: unknown, expected: unknown, exact: boolean): boolean => {
    const a = fold(actual);
    const e = fold(expected);
    // An absent value matches nothing. Without this, `"".includes(x)` logic
    // makes every unnamed node in the document a candidate.
    if (!a || !e) return false;
    if (exact) return a === e;
    // Containment is checked both ways so wording differences between tenant
    // builds are absorbed without an override: a recorded "Savings" still
    // finds "Regular Savings". The reverse direction is length-guarded so a
    // two-character label cannot match half the page.
    return a.includes(e) || (a.length >= 3 && e.includes(a));
  };

  const isInteractive = (node: RawUiNode): boolean =>
    node.editable ||
    node.focusable ||
    ['textbox', 'combobox', 'checkbox', 'radio', 'button', 'link'].includes(node.role);

  const c = request.candidate as Record<string, any>;
  const anchor = request.anchor;

  let matches = snapshot.nodes.filter((node) => {
    switch (c.kind) {
      case 'test_id':
        return node.attributes[String(c.attribute)] === String(c.value);

      case 'role_name':
        return node.role === String(c.role) && textMatches(node.name, c.name, !!c.exact);

      case 'label': {
        // A column qualifier changes what is being asked for. Without one the
        // question is "the *control* labelled X", so only interactive nodes
        // can answer, otherwise the <td> holding the label text competes with
        // the field it labels and every lookup is ambiguous. With one, the
        // question is "the *cell* at row X, column Y", which only cells can
        // answer. Keeping these apart is what makes the candidate unambiguous
        // on a screen built entirely out of tables.
        if (c.expect === 'cell') {
          if (node.role !== 'cell' && node.role !== 'columnheader') return false;
          const rowHit =
            textMatches(node.rowHeader, c.text, false) || textMatches(node.nearestLabel, c.text, false);
          if (!rowHit) return false;
          return c.column ? textMatches(node.columnHeader, c.column, false) : true;
        }

        if (!isInteractive(node)) return false;
        return (
          textMatches(node.nearestLabel, c.text, false) ||
          textMatches(node.name, c.text, false) ||
          textMatches(node.rowHeader, c.text, false)
        );
      }

      case 'placeholder':
        return textMatches(node.placeholder, c.text, false);

      case 'text':
        return textMatches(node.text, c.text, !!c.exact);

      case 'structural': {
        const el = (window as any).__cuaNodes?.[node.index] as Element | undefined;
        if (!el) return false;
        try {
          const scope: ParentNode = c.containerCss ? (el.closest(String(c.containerCss)) ?? document) : document;
          const found = Array.from(scope.querySelectorAll(String(c.css)));
          return found.includes(el);
        } catch {
          return false;
        }
      }

      case 'coordinates': {
        if (!node.box) return false;
        const targetX = Number(c.xFraction) * snapshot.viewport.width;
        const targetY = Number(c.yFraction) * snapshot.viewport.height;
        return (
          targetX >= node.box.x &&
          targetX <= node.box.x + node.box.width &&
          targetY >= node.box.y &&
          targetY <= node.box.y + node.box.height
        );
      }

      default:
        return false;
    }
  });

  // Anchors never widen a match set, only narrow it, and only when they
  // actually help. Narrowing to zero would turn a usable ambiguous result into
  // a failure, so a fruitless anchor is discarded rather than applied.
  if (anchor && matches.length > 1) {
    const narrowed = matches.filter((node) => {
      if (anchor.containerName && !textMatches(node.containerName, anchor.containerName, false)) return false;
      if (anchor.containerRole && node.containerRole !== anchor.containerRole) return false;
      if (anchor.nearestLabel && !textMatches(node.nearestLabel, anchor.nearestLabel, false)) return false;
      return true;
    });
    if (narrowed.length > 0) matches = narrowed;
  }

  return matches.map((n) => n.index);
}
