/**
 * Play back a committed run, at the speed it actually happened.
 *
 * Discovery is the one step in this system that needs a network, a model and
 * about forty seconds, which makes it the one step that can fail in front of an
 * audience for reasons that have nothing to do with the work. So this replays
 * the `log.jsonl` of a run that already happened, with the original gaps
 * between events preserved.
 *
 * It is not a video and it is not a reconstruction: every line printed is an
 * event from the committed bundle, in order, with its real timing. The banner
 * says so, because a recording presented as a live run is a lie whether or not
 * anyone notices, and the honest version is more interesting anyway — the point
 * being made is that this run happened, not that it is happening now.
 *
 *   npx tsx scripts/replay-recording.ts evidence/discovery-capability-gap-closed
 *   npx tsx scripts/replay-recording.ts <bundle> --speed 2     # twice as fast
 *   npx tsx scripts/replay-recording.ts <bundle> --instant     # no waiting
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface LogEvent {
  ts: string;
  seq: number;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Longest pause to honour. A run that stalled twenty seconds waiting on a
 *  model is faithful but unwatchable; the cap keeps the shape without the dead
 *  air, and anything trimmed is reported rather than hidden. */
const MAX_GAP_MS = 4_000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bundle = args.find((a) => !a.startsWith('--'));
  if (!bundle) {
    process.stderr.write('usage: replay-recording.ts <evidence-bundle> [--speed N] [--instant]\n');
    process.exit(1);
  }

  const instant = args.includes('--instant');
  const speedArg = args.indexOf('--speed');
  const speed = speedArg >= 0 ? Number(args[speedArg + 1]) || 1 : 1;

  const lines = readFileSync(join(bundle, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
  const events: LogEvent[] = lines.map((l) => JSON.parse(l));
  if (events.length === 0) {
    process.stderr.write(`${bundle} has no events\n`);
    process.exit(1);
  }

  const first = new Date(events[0]!.ts).getTime();
  const last = new Date(events[events.length - 1]!.ts).getTime();
  const wall = ((last - first) / 1000).toFixed(1);

  process.stdout.write(
    `\n${DIM}${'─'.repeat(72)}${RESET}\n` +
      `  ${BOLD}Replaying a recorded run.${RESET} ${DIM}Not live.${RESET}\n` +
      `  ${DIM}${bundle}${RESET}\n` +
      `  ${DIM}${events.length} events, ${wall}s of wall clock when it happened` +
      `${instant ? ', played instantly' : speed !== 1 ? `, played at ${speed}x` : ', played at real speed'}${RESET}\n` +
      `${DIM}${'─'.repeat(72)}${RESET}\n\n`,
  );

  let trimmed = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (i > 0 && !instant) {
      const gap = new Date(event.ts).getTime() - new Date(events[i - 1]!.ts).getTime();
      const capped = Math.min(gap, MAX_GAP_MS);
      trimmed += gap - capped;
      await sleep(capped / speed);
    }
    const suffix = event.message ? ` ${event.message}` : '';
    process.stdout.write(`  [${String(event.seq).padStart(3, '0')}] ${event.type}${suffix}\n`);
  }

  process.stdout.write(
    `\n${DIM}${'─'.repeat(72)}${RESET}\n` +
      `  ${DIM}End of recording.${RESET}` +
      (trimmed > 1_000 ? ` ${DIM}${(trimmed / 1000).toFixed(1)}s of waiting was trimmed from long gaps.${RESET}` : '') +
      `\n${DIM}${'─'.repeat(72)}${RESET}\n\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
