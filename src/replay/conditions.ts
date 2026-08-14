/**
 * Condition evaluation.
 *
 * One evaluator serves four callers — step waits, the success checkpoint,
 * business-outcome detection, and recovery triggers. That is the whole reason
 * the artifact has a single condition language: four evaluators would mean
 * four subtly different notions of what "the text is present" means, and the
 * difference would only surface as a production bug.
 *
 * Conditions never throw. An unresolvable target is `false`, not an error —
 * because "is the not-found banner showing?" must be answerable on a page
 * where it isn't, and an exception there would turn a clean business outcome
 * into a crash.
 */

import type { Condition } from '../artifact/schema.js';
import type { SurfaceDriver } from '../surface/types.js';
import { interpolate } from './values.js';

export interface ConditionContext {
  driver: SurfaceDriver;
  values: Record<string, unknown>;
}

export async function evaluateCondition(ctx: ConditionContext, condition: Condition): Promise<boolean> {
  switch (condition.kind) {
    case 'all': {
      for (const c of condition.of) {
        if (!(await evaluateCondition(ctx, c))) return false;
      }
      return true;
    }
    case 'any': {
      for (const c of condition.of) {
        if (await evaluateCondition(ctx, c)) return true;
      }
      return false;
    }
    case 'not':
      return !(await evaluateCondition(ctx, condition.of));

    case 'element_visible': {
      const result = await ctx.driver.resolve(condition.target);
      if (!result.ok) return false;
      return ctx.driver.isVisible(result.element);
    }

    case 'element_absent': {
      const result = await ctx.driver.resolve(condition.target);
      if (!result.ok) return true;
      return !(await ctx.driver.isVisible(result.element));
    }

    case 'text_present':
    case 'text_absent': {
      const haystack = await ctx.driver.visibleText(condition.framePath);
      const needle = interpolate(condition.text, ctx.values);
      const found = condition.caseSensitive
        ? haystack.includes(needle)
        : haystack.toLowerCase().includes(needle.toLowerCase());
      return condition.kind === 'text_present' ? found : !found;
    }

    case 'dialog_present': {
      const dialog = ctx.driver.pendingDialog();
      if (!dialog) return false;
      if (!condition.textContains) return true;
      return dialog.message.toLowerCase().includes(condition.textContains.toLowerCase());
    }

    case 'url_matches': {
      const url = await ctx.driver.currentUrl();
      const pattern = interpolate(condition.pattern, ctx.values);
      try {
        return new RegExp(pattern).test(url);
      } catch {
        // A malformed pattern is an authoring bug, not a runtime state. Fall
        // back to substring so a bad regex degrades to something sane rather
        // than failing every run that touches it.
        return url.includes(pattern);
      }
    }
  }
}

/** Human-readable rendering, used in failure reports so "what was expected"
 *  reads as a sentence rather than a JSON blob. */
export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case 'all':
      return condition.of.map(describeCondition).join(' AND ');
    case 'any':
      return condition.of.map(describeCondition).join(' OR ');
    case 'not':
      return `NOT (${describeCondition(condition.of)})`;
    case 'element_visible':
      return `"${condition.target.description}" is visible`;
    case 'element_absent':
      return `"${condition.target.description}" is absent`;
    case 'text_present':
      return `page contains "${condition.text}"`;
    case 'text_absent':
      return `page does not contain "${condition.text}"`;
    case 'url_matches':
      return `URL matches /${condition.pattern}/`;
    case 'dialog_present':
      return condition.textContains
        ? `a modal containing "${condition.textContains}" is open`
        : 'a modal is open';
  }
}
