/**
 * Evidence.
 *
 * Every run, discovery or replay, writes one self-contained bundle:
 *
 *   runs/<runId>/
 *     log.jsonl        structured, append-only, one event per line
 *     result.json      the run's final typed result
 *     screenshots/     NNN-<label>.png, sensitive regions already masked
 *     dom/             NNN-<label>.html, captured on failure and escalation
 *     artifact.json    (discovery only) the capability that was emitted
 *     transcript.json  (discovery only) the redacted model transcript
 *
 * JSONL rather than a nested JSON document because a run that crashes halfway
 * still leaves a readable, parseable log, which is exactly the run you most
 * want to read.
 *
 * Every value that lands here has passed through the redactor first. There is
 * no "log the raw thing just this once" path, deliberately: that path is how
 * PII ends up in a bundle someone later commits to a public repo.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, defaultRedactor } from '../policy/redaction.js';

export type EvidenceEventType =
  | 'run_started'
  | 'run_finished'
  | 'step_started'
  | 'step_finished'
  | 'resolution'
  | 'policy_decision'
  | 'model_request'
  | 'model_response'
  | 'tool_call'
  | 'business_outcome'
  | 'recovery_attempt'
  | 'escalation_raised'
  | 'control_transfer'
  | 'human_action'
  | 'screenshot'
  | 'dom_snapshot'
  | 'note'
  | 'error';

export interface EvidenceEvent {
  ts: string;
  seq: number;
  runId: string;
  type: EvidenceEventType;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RunLoggerOptions {
  runId: string;
  rootDir?: string;
  redactor?: Redactor;
  /** Mirror events to stderr so the CLI is followable while it runs. */
  echo?: boolean;
}

let counter = 0;

export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  counter += 1;
  return `${prefix}-${stamp}-${String(counter).padStart(2, '0')}`;
}

export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private readonly logPath: string;
  private readonly redactor: Redactor;
  private readonly echo: boolean;
  private seq = 0;

  constructor(options: RunLoggerOptions) {
    this.runId = options.runId;
    this.redactor = options.redactor ?? defaultRedactor;
    this.echo = options.echo ?? true;
    this.dir = join(options.rootDir ?? 'runs', options.runId);

    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
    mkdirSync(join(this.dir, 'dom'), { recursive: true });
    this.logPath = join(this.dir, 'log.jsonl');
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, '');
  }

  event(type: EvidenceEventType, message?: string, data?: Record<string, unknown>): void {
    this.seq += 1;
    const event: EvidenceEvent = {
      ts: new Date().toISOString(),
      seq: this.seq,
      runId: this.runId,
      type,
      ...(message ? { message: this.redactor.text(message) } : {}),
      ...(data ? { data: this.redactor.deep(data) } : {}),
    };
    appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
    if (this.echo) {
      const suffix = event.message ? ` ${event.message}` : '';
      process.stderr.write(`  [${String(this.seq).padStart(3, '0')}] ${type}${suffix}\n`);
    }
  }

  /** Screenshots arrive already masked by the driver; this only files them. */
  screenshot(label: string, png: Buffer): string {
    const name = `${String(this.seq + 1).padStart(3, '0')}-${slug(label)}.png`;
    const path = join(this.dir, 'screenshots', name);
    writeFileSync(path, png);
    this.event('screenshot', label, { path: join('screenshots', name), bytes: png.byteLength });
    return path;
  }

  domSnapshot(label: string, html: string): string {
    const name = `${String(this.seq + 1).padStart(3, '0')}-${slug(label)}.html`;
    const path = join(this.dir, 'dom', name);
    writeFileSync(path, this.redactor.text(html));
    this.event('dom_snapshot', label, { path: join('dom', name), bytes: html.length });
    return path;
  }

  /**
   * Writes a file into the bundle verbatim.
   *
   * The one intentional non-redacted path, used for the emitted artifact -
   * which contains descriptors, never values, and is validated against the
   * schema before it gets here. Callers redact anything else themselves.
   */
  writeFile(name: string, contents: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, contents);
    return path;
  }

  writeJson(name: string, value: unknown, { redact = true }: { redact?: boolean } = {}): string {
    const payload = redact ? this.redactor.deep(value) : value;
    return this.writeFile(name, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'untitled';
}
