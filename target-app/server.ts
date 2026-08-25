/**
 * "Meridian Core, Servicing Console": a stand-in for the class of application
 * this system exists to automate.
 *
 * It is deliberately hostile in the ways real back-office banking software is
 * hostile, and every one of these is a decision, not an accident:
 *
 *   - a real <frameset>, so frame traversal is mandatory rather than optional;
 *   - table-based layout with <font> tags and bgcolor attributes;
 *   - element ids regenerated on every render, so id selectors are worthless;
 *   - no test ids, no semantic class names, no ARIA;
 *   - form fields whose only label is the adjacent table cell, no <label for>;
 *   - the same label text ("Member ID") appearing in two different panels, so
 *     a name-only match is ambiguous and container context is required;
 *   - per-tenant differences in frame names and button wording.
 *
 * Two institutions run it on different ports from the same code, which is what
 * makes the cross-tenant reuse demo honest: it is genuinely the same product,
 * configured differently, not two apps I wrote to look similar.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MEMBERS, OPERATOR_CREDENTIALS, formatMoney, type Member } from './data.js';
import { CASCADE_TENANT, MERIDIAN_TENANT, type TenantConfig } from './tenants.js';
import { FaultStore, FAULT_KINDS, type FaultKind, type FaultScope } from './faults.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Session {
  user: string;
  createdAt: number;
  /** Tenant B shows its system notice only once per session. */
  noticeShown: boolean;
}

/** Short random suffix so ids differ on every single render. */
function rid(): string {
  return randomBytes(3).toString('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createApp(tenant: TenantConfig) {
  const app = express();
  const sessions = new Map<string, Session>();
  const faults = new FaultStore();

  /**
   * Simulates a vendor point release: the kind of change that actually happens
   * to enterprise software between releases. A button is reworded, a table's
   * columns are re-ordered, a new column appears, the styling is refreshed.
   *
   * Nothing about the *flow* changes, which is exactly the case a recorded
   * capability is supposed to survive, and the case that separates a locator
   * ladder from a stored selector.
   */
  let drifted = false;
  // A heavier change than `drifted`: the vendor renames the control *and* its
  // form field, so no recorded locator survives at any tier. `drifted` models a
  // point release, this models a major version, and the difference matters:
  // one degrades a capability, the other stops it dead.
  let rewritten = false;

  app.set('view engine', 'ejs');
  app.set('views', join(here, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Base render locals every view gets.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.tenant = tenant;
    res.locals.drifted = drifted;
    res.locals.rewritten = rewritten;
    res.locals.rid = rid();
    res.locals.formatMoney = formatMoney;
    next();
  });

  const sessionOf = (req: Request): Session | undefined => {
    const sid = parseCookies(req.headers.cookie)['mcsid'];
    return sid ? sessions.get(sid) : undefined;
  };

  /**
   * Applies whatever fault is armed for this scope. Returns true when the
   * response has been sent and the caller must stop.
   */
  const applyFault = async (
    req: Request,
    res: Response,
    scope: Exclude<FaultScope, 'any'>,
  ): Promise<{ handled: boolean; dialog?: string }> => {
    const fault = faults.consume(scope);
    if (!fault) return { handled: false };

    switch (fault) {
      case 'slow':
        await new Promise((r) => setTimeout(r, 6000));
        return { handled: false };
      case 'app_error':
        res.status(500).render('error', {
          code: 'MCX-5013',
          detail: 'Unhandled exception in servicing module (SVC.MEMBER.LOOKUP).',
        });
        return { handled: true };
      case 'session_expired': {
        const sid = parseCookies(req.headers.cookie)['mcsid'];
        if (sid) sessions.delete(sid);
        res.status(200).render('expired', {});
        return { handled: true };
      }
      case 'unexpected_dialog':
        return { handled: false, dialog: 'System notice: nightly posting is in progress. Continue?' };
      case 'validation_error':
        res.render('search', {
          error: 'Member ID must be exactly 6 digits. Correct the entry and try again.',
          query: String(req.body?.memberId ?? req.query.memberId ?? ''),
        });
        return { handled: true };
      case 'permission_denied':
        res.render('denied', { memberId: String(req.body?.memberId ?? req.query.memberId ?? '') });
        return { handled: true };
    }
  };

  // -------------------------------------------------------------------------
  // Fault-injection control plane. Namespaced under /_admin so it can never be
  // confused with the application surface the agent is allowed to drive.
  // -------------------------------------------------------------------------

  app.get('/_admin/faults', (_req, res) => res.json({ armed: faults.list(), kinds: FAULT_KINDS }));

  app.post('/_admin/faults', (req, res) => {
    const kind = req.body?.kind as FaultKind;
    if (!FAULT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `unknown fault kind: ${kind}`, kinds: FAULT_KINDS });
    }
    faults.arm(kind, Number(req.body?.count ?? 1), (req.body?.scope as FaultScope) ?? 'any');
    return res.json({ armed: faults.list() });
  });

  app.post('/_admin/reset', (_req, res) => {
    faults.reset();
    sessions.clear();
    drifted = false;
    rewritten = false;
    res.json({ ok: true });
  });

  app.get('/_admin/drift', (_req, res) => res.json({ drifted, rewritten }));

  app.post('/_admin/drift', (req, res) => {
    drifted = req.body?.enabled !== false;
    rewritten = req.body?.rewritten === true;
    res.json({ drifted, rewritten });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  app.get('/', (req, res) => {
    if (sessionOf(req)) return res.redirect('/console');
    return res.render('login', { error: null });
  });

  app.post('/auth', (req, res) => {
    const { username, password } = req.body ?? {};
    if (username !== OPERATOR_CREDENTIALS.username || password !== OPERATOR_CREDENTIALS.password) {
      return res.status(200).render('login', { error: 'Sign-on failed. Verify your user ID and password.' });
    }
    const sid = randomBytes(16).toString('hex');
    sessions.set(sid, { user: username, createdAt: Date.now(), noticeShown: false });
    res.setHeader('Set-Cookie', `mcsid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect('/console');
  });

  app.get('/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie)['mcsid'];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'mcsid=; Path=/; Max-Age=0');
    res.redirect('/');
  });

  // -------------------------------------------------------------------------
  // Console shell and frames
  // -------------------------------------------------------------------------

  app.get('/console', (req, res) => {
    if (!sessionOf(req)) return res.redirect('/');
    return res.render('console', {});
  });

  app.get('/console/nav', (req, res) => {
    if (!sessionOf(req)) return res.status(200).render('expired', {});
    return res.render('nav', {});
  });

  app.get('/console/content', async (req, res) => {
    const session = sessionOf(req);
    if (!session) return res.status(200).render('expired', {});

    const view = String(req.query.view ?? 'search');

    // Tenant B interrupts the first content load with a system notice. This is
    // the tenant-local interstitial the overlay's extra recovery rule handles.
    if (tenant.showsLoginNotice && !session.noticeShown && view === 'search') {
      session.noticeShown = true;
      return res.render('notice', {
        heading: 'System Notice',
        body: 'Scheduled maintenance window begins at 23:00 local time. Member servicing will be unavailable for approximately 40 minutes.',
        continueTo: '/console/content?view=search',
      });
    }

    if (view === 'member') {
      const outcome = await applyFault(req, res, 'member_detail');
      if (outcome.handled) return undefined;

      const id = String(req.query.id ?? '');
      const member = MEMBERS[id];
      if (!member) return res.render('notfound', { memberId: id });
      if (member.restricted) return res.render('denied', { memberId: id });

      return res.render('member', {
        member,
        popupMessage:
          outcome.dialog ?? (member.raisesNotice ? 'System notice: this record is flagged dormant. Continue?' : null),
      });
    }

    if (view === 'sub_account') {
      const id = String(req.query.id ?? '');
      const member = MEMBERS[id];
      if (!member) return res.render('notfound', { memberId: id });
      return res.render('subaccount', { member, error: null });
    }

    return res.render('search', { error: null, query: '' });
  });

  // -------------------------------------------------------------------------
  // Member search
  // -------------------------------------------------------------------------

  app.post('/console/content/search', async (req, res) => {
    if (!sessionOf(req)) return res.status(200).render('expired', {});

    const outcome = await applyFault(req, res, 'search');
    if (outcome.handled) return undefined;

    const memberId = String(req.body?.memberId ?? '').trim();

    if (!/^\d{6}$/.test(memberId)) {
      return res.render('search', {
        error: 'Member ID must be exactly 6 digits. Correct the entry and try again.',
        query: memberId,
      });
    }

    const member = MEMBERS[memberId];
    if (!member) return res.render('notfound', { memberId });
    if (member.restricted) return res.render('denied', { memberId });

    return res.render('member', {
      member,
      popupMessage: member.raisesNotice ? 'System notice: this record is flagged dormant. Continue?' : null,
    });
  });

  // -------------------------------------------------------------------------
  // Sub-account opening, the irreversible flow
  // -------------------------------------------------------------------------

  app.post('/console/content/sub_account', async (req, res) => {
    if (!sessionOf(req)) return res.status(200).render('expired', {});

    const outcome = await applyFault(req, res, 'sub_account');
    if (outcome.handled) return undefined;

    const memberId = String(req.body?.memberId ?? '').trim();
    const member: Member | undefined = MEMBERS[memberId];
    if (!member) return res.render('notfound', { memberId });

    const productType = String(req.body?.productType ?? '').trim();
    const initialDeposit = String(req.body?.initialDeposit ?? '').trim();

    if (!productType || !/^\d+(\.\d{2})?$/.test(initialDeposit)) {
      return res.render('subaccount', {
        member,
        error: 'Product type is required and initial deposit must be a dollar amount (e.g. 25.00).',
      });
    }

    return res.render('subaccount_confirm', {
      member,
      productType,
      initialDeposit,
      reference: `SA-${randomBytes(3).toString('hex').toUpperCase()}`,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Entry point: both tenants, one process.
// ---------------------------------------------------------------------------

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  for (const tenant of [MERIDIAN_TENANT, CASCADE_TENANT]) {
    createApp(tenant).listen(tenant.port, () => {
      process.stdout.write(
        `${tenant.name} (Meridian Core ${tenant.productVersion}) → http://localhost:${tenant.port}\n`,
      );
    });
  }
  process.stdout.write(`\nSign-on: ${OPERATOR_CREDENTIALS.username} / ${OPERATOR_CREDENTIALS.password}\n`);
}
