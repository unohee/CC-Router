/**
 * Token usage kept per hour and per model, so the dashboard can show history
 * that outlives a restart.
 *
 * `stats` only holds totals since the process started plus the last hundred
 * log entries, which is nothing a day-by-day view can be built from. This is the
 * missing layer: an additive store keyed by (hour, provider, model), pruned to a
 * fixed retention, small enough to rewrite whole.
 *
 * Hours are stored rather than days so that "which day" can be decided later,
 * in the viewer's own time zone. A day boundary baked in at write time would be
 * wrong for everyone not on the server's clock.
 */

export type UsageProvider = "anthropic" | "openai" | "ollama";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/**
 * Two days longer than the 90 the page shows. A viewer 14 hours ahead of UTC has
 * a local "90 days ago" midnight that is earlier than `now - 90d`, so keeping
 * exactly 90 would clip the oldest displayed day.
 */
export const RETENTION_DAYS = 92;
/** Distinct model names kept; later ones are folded into "other". */
export const MAX_MODELS = 32;

export const UNKNOWN_MODEL = "unknown";
export const OTHER_MODEL = "other";

export interface UsageSample {
  /** When the usage happened. Clamped into the retention window. */
  ts: number;
  provider: UsageProvider;
  /** Client-influenced, so untrusted: anything may arrive here. */
  model: unknown;
  /** Undefined means "not measured", which is not the same as 0. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** Count one metered request. Set on exactly one of a request's records. */
  request?: boolean;
}

export interface UsageBucket {
  /** Start of the hour, epoch ms. */
  hour: number;
  provider: UsageProvider;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
}

/** On-disk shape. Rows are tuples to keep the file small. */
export interface UsageFile {
  version: 1;
  /** First time anything was recorded; never pruned. Null until then. */
  since: number | null;
  rows: Array<[
    hourSec: number, provider: UsageProvider, model: string,
    input: number, output: number, cacheRead: number, cacheCreation: number, requests: number,
  ]>;
}

/**
 * A model name that is safe to store, key on and print.
 *
 * It arrives from request bodies, and a plain-object lookup upstream can even
 * hand back a function for a name like "constructor". Anything that is not a
 * non-empty string becomes "unknown"; the rest is cut to one bounded, printable
 * line.
 */
export function sanitizeModel(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN_MODEL;
  const cleaned = raw.trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
  return cleaned === "" || cleaned === "-" ? UNKNOWN_MODEL : cleaned;
}

/** A usable count: finite, non-negative, whole. Everything else is 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isProvider(value: unknown): value is UsageProvider {
  return value === "anthropic" || value === "openai" || value === "ollama";
}

export interface UsageHistoryOptions {
  now?: () => number;
  retentionDays?: number;
  maxModels?: number;
}

export class UsageHistory {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxModels: number;
  // Maps only: model names are untrusted, and an object keyed by "__proto__"
  // would not behave.
  private readonly byKey = new Map<string, UsageBucket>();
  private readonly models = new Set<string>();
  private firstSeen: number | null = null;
  private isDirty = false;
  private lastPruneHour = -Infinity;

  constructor(opts: UsageHistoryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? RETENTION_DAYS) * DAY_MS;
    this.maxModels = opts.maxModels ?? MAX_MODELS;
  }

  get since(): number | null { return this.firstSeen; }
  get dirty(): boolean { return this.isDirty; }

  /** Add one sample. Safe to call with anything: bad numbers count as 0. */
  record(sample: UsageSample): void {
    const unmeasured = sample.input === undefined && sample.output === undefined
      && sample.cacheRead === undefined && sample.cacheCreation === undefined;
    // A response whose usage could not be read must not leave a bucket behind:
    // that would turn "not measured" into a recorded zero.
    if (unmeasured && !sample.request) return;
    if (!isProvider(sample.provider)) return;

    const now = this.now();
    const ts = Number.isFinite(sample.ts) ? Math.min(Math.max(sample.ts, now - this.retentionMs), now) : now;
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const bucket = this.bucketFor(hour, sample.provider, this.modelKey(sanitizeModel(sample.model)));

    bucket.input += count(sample.input);
    bucket.output += count(sample.output);
    bucket.cacheRead += count(sample.cacheRead);
    bucket.cacheCreation += count(sample.cacheCreation);
    if (sample.request) bucket.requests += 1;

    if (this.firstSeen === null || ts < this.firstSeen) this.firstSeen = ts;
    this.isDirty = true;
    if (hour > this.lastPruneHour) this.prune();
  }

  /** A copy, so callers cannot mutate the store through it. */
  buckets(): UsageBucket[] {
    return [...this.byKey.values()].map(b => ({ ...b }));
  }

  /** Drop buckets that have aged out. Returns how many went. */
  prune(): number {
    const now = this.now();
    this.lastPruneHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const cutoff = now - this.retentionMs;
    let removed = 0;
    for (const [key, b] of this.byKey) {
      if (b.hour + HOUR_MS <= cutoff) { this.byKey.delete(key); removed++; }
    }
    if (removed > 0) {
      this.models.clear();
      for (const b of this.byKey.values()) this.trackModel(b.model);
      this.isDirty = true;
    }
    return removed;
  }

  toFile(): UsageFile {
    const rows = [...this.byKey.values()]
      .sort((a, b) => a.hour - b.hour || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
      .map(b => [b.hour / 1000, b.provider, b.model, b.input, b.output, b.cacheRead, b.cacheCreation, b.requests] as UsageFile["rows"][number]);
    return { version: 1, since: this.firstSeen, rows };
  }

  /** Call only after the snapshot reached disk; a failed write must stay dirty. */
  markClean(): void { this.isDirty = false; }

  /**
   * Merge a file into the store. False when the file is not a usage file at
   * all, in which case nothing was taken. Individual rows that are malformed are
   * skipped rather than failing the whole history.
   */
  restore(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const file = raw as { version?: unknown; since?: unknown; rows?: unknown };
    if (file.version !== 1 || !Array.isArray(file.rows)) return false;

    for (const row of file.rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== 8) continue;
      const [hourSec, provider, model, input, output, cacheRead, cacheCreation, requests] = row as unknown[];
      if (typeof hourSec !== "number" || !Number.isFinite(hourSec) || !isProvider(provider)) continue;
      const hour = Math.floor(hourSec * 1000 / HOUR_MS) * HOUR_MS;
      const b = this.bucketFor(hour, provider, this.modelKey(sanitizeModel(model)));
      b.input += count(input);
      b.output += count(output);
      b.cacheRead += count(cacheRead);
      b.cacheCreation += count(cacheCreation);
      b.requests += count(requests);
    }
    if (typeof file.since === "number" && Number.isFinite(file.since)
      && (this.firstSeen === null || file.since < this.firstSeen)) {
      this.firstSeen = file.since;
    }
    // The dirty flag is left alone on purpose: what was merged is already on disk,
    // but anything recorded before the merge is not, and must still be saved.
    this.prune();
    return true;
  }

  private bucketFor(hour: number, provider: UsageProvider, model: string): UsageBucket {
    const key = `${hour}|${provider}|${model}`;
    let bucket = this.byKey.get(key);
    if (!bucket) {
      bucket = { hour, provider, model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
      this.byKey.set(key, bucket);
      this.trackModel(model);
    }
    return bucket;
  }

  /** Count real model names only; "unknown" and "other" are not subject to the cap. */
  private trackModel(model: string): void {
    if (model !== UNKNOWN_MODEL && model !== OTHER_MODEL) this.models.add(model);
  }

  /** The name to key on: a new name past the cap is folded into "other". */
  private modelKey(model: string): string {
    if (model === UNKNOWN_MODEL || model === OTHER_MODEL || this.models.has(model)) return model;
    return this.models.size >= this.maxModels ? OTHER_MODEL : model;
  }
}

/**
 * The sample for one OpenAI response, or null when it reported no usage.
 *
 * OpenAI reports no cache fields, and its `input_tokens` already include any
 * cached tokens, so none are passed on: the summary leaves OpenAI rows out of
 * the cache ratio for that reason, and recording a made-up 0 here would only
 * look like a measurement.
 */
export function openAISample(
  usage: { input_tokens: number; output_tokens: number } | undefined,
  model: unknown,
  ts: number,
): UsageSample | null {
  if (!usage) return null;
  return { ts, provider: "openai", model, input: usage.input_tokens, output: usage.output_tokens, request: true };
}

/**
 * A request answered by the Ollama fallback, as a usage-history sample.
 *
 * Its own provider, so these tokens are never counted against a Claude account
 * or read as OpenAI traffic. Unlike Codex, Ollama reports cache reads, so they
 * are kept.
 */
export function ollamaSample(
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined,
  model: unknown,
  ts: number,
): UsageSample | null {
  if (!usage) return null;
  return {
    ts, provider: "ollama", model, input: usage.input_tokens, output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens, cacheCreation: usage.cache_creation_input_tokens,
    request: true,
  };
}

/** The process-wide store the proxy records into and the usage endpoint reads. */
export const usageHistory = new UsageHistory();
