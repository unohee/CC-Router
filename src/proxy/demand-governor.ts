/**
 * The demand governor: when the pool is spending faster than the supply model
 * says it can afford, tighten in stages instead of running into the wall.
 *
 *   0  normal
 *   1  pace placement (weekly and 5-hour) even when it is not configured
 *   2  + the admission throttle starts earlier on accounts ahead of pace
 *   3  + Ollama spill widened: listed tiers spill at a lower pool utilization
 *   4  + low-priority requests (short one-shots, haiku-tier, or marked low)
 *       wait a moment before they are sent
 *
 * Off by default. Enabled without `enforce` it only observes: it picks and
 * logs the stage it would apply and counts changes, so its judgement can be
 * read before it is trusted. With `enforce` the stage takes effect.
 *
 * Two promises hold at every stage: it never refuses a request, and it never
 * delays anything opus-tier. A main conversation that stalls is the outcome a
 * governor exists to prevent.
 */

import { claudeTierOf } from "../protocol/model-ref.js";
import { isShortRequest } from "./short-request.js";
import { HOUR_MS } from "./usage-history.js";
import { DEFAULT_WEEKLY_PACE, type WeeklyPaceConfig } from "./weekly-pace.js";
import type { OllamaSpillConfig } from "../providers/ollama/fallback-policy.js";

export type GovernorStage = 0 | 1 | 2 | 3 | 4;

export interface GovernorConfig {
  enabled: boolean;
  enforce: boolean;
  /** Operator pin: hold this stage whatever the pressure. Null to judge. */
  stageOverride: GovernorStage | null;
  /** Pressure at which stages 1..4 begin, ascending. */
  thresholds: [number, number, number, number];
  /** A stage is left only when pressure falls this far below where it began. */
  hysteresis: number;
  /** How long stage 4 holds a low-priority request, ms. */
  delayMs: number;
  /** Utilization added to an ahead-of-pace account's reading for the throttle at stage 2+. */
  throttleBoost: number;
  /** Spill line at stage 3+: the pool counts as tight below this 5-hour utilization. */
  spillPoolUtil: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  enabled: false,
  enforce: false,
  stageOverride: null,
  thresholds: [0.9, 1.0, 1.15, 1.3],
  hysteresis: 0.05,
  delayMs: 2_000,
  throttleBoost: 0.15,
  spillPoolUtil: 0.75,
};

/** Header a client may set to mark its own traffic (a subagent, say) as low priority. */
export const PRIORITY_HEADER = "x-cc-router-priority";

/**
 * How hard demand presses on supply: the larger of what the pool spent over
 * the last 24 hours and what it is expected to spend over the next 24, over
 * today's budget. Null when there is no budget to compare with.
 */
export function pressureOf(spentLast24h: number, forecastNext24h: number | null, budget: number | null): number | null {
  if (budget === null || !(budget > 0)) return null;
  const demand = Math.max(spentLast24h > 0 ? spentLast24h : 0, forecastNext24h !== null && forecastNext24h > 0 ? forecastNext24h : 0);
  return demand / budget;
}

/**
 * The stage for a pressure. Going up is immediate; coming down needs the
 * pressure to fall `hysteresis` below the stage's threshold, so a reading
 * that wobbles on a boundary does not flap the stage every minute.
 */
export function pickStage(pressure: number | null, prev: GovernorStage, cfg: GovernorConfig): GovernorStage {
  if (pressure === null) return 0;
  let raw: GovernorStage = 0;
  cfg.thresholds.forEach((t, i) => { if (pressure >= t) raw = (i + 1) as GovernorStage; });
  if (raw >= prev) return raw;
  // Step down only as far as the hysteresis allows.
  let stage = prev;
  while (stage > raw && pressure < cfg.thresholds[stage - 1] - cfg.hysteresis) stage = (stage - 1) as GovernorStage;
  return stage;
}

/** Stage 1+: pace placement, even where the operator has not turned it on. */
export function governedWeeklyPace(base: WeeklyPaceConfig | null, stage: GovernorStage): WeeklyPaceConfig | null {
  if (stage < 1) return base;
  return base ? { ...base, fiveHour: true } : { ...DEFAULT_WEEKLY_PACE, fiveHour: true };
}

/** Stage 2+: the utilization the throttle sees for an account `ahead` of pace. */
export function governedThrottleUtil(util: number, ahead: number, stage: GovernorStage, cfg: GovernorConfig): number {
  if (stage < 2 || !(ahead > 0)) return util;
  return Math.min(1, util + cfg.throttleBoost);
}

/**
 * Stage 3+: spill widened. The operator's tiers are kept (the default ones,
 * never opus, when none were configured) and the line drops to
 * `spillPoolUtil` unless the operator's own line is already lower.
 */
export function governedSpill(base: OllamaSpillConfig | null, stage: GovernorStage, cfg: GovernorConfig): OllamaSpillConfig | null {
  if (stage < 3) return base;
  const tiers = base?.tiers ?? ["haiku", "sonnet"];
  return { tiers, poolUtil: Math.min(base?.poolUtil ?? 1, cfg.spillPoolUtil) };
}

/**
 * Low priority for stage 4: never anything opus-tier; otherwise a short
 * one-shot (a plugin's classifier), a haiku-tier request (Claude Code's
 * background model, which its lighter subagents use), or one the client
 * marked low with `x-cc-router-priority: low`.
 */
export function isLowPriority(body: unknown, model: string | undefined, header: unknown): boolean {
  const tier = claudeTierOf(model);
  if (tier === "opus" || tier === "frontier") return false;
  if (typeof header === "string" && header.trim().toLowerCase() === "low") return true;
  return tier === "haiku" || isShortRequest(body);
}

export interface GovernorHour {
  /** Start of the hour, epoch ms. */
  hour: number;
  changes: number;
  /** Highest stage held during the hour. */
  maxStage: GovernorStage;
  /** Requests stage 4 held back (enforce only). */
  delayed: number;
}

export interface GovernorInput {
  spentLast24h: number;
  forecastNext24h: number | null;
  budget: number | null;
}

export interface GovernorChange {
  from: GovernorStage;
  to: GovernorStage;
  pressure: number | null;
  reason: string;
  enforce: boolean;
}

export interface GovernorSnapshot {
  enabled: boolean;
  enforce: boolean;
  /** The judged stage, applied or not. */
  stage: GovernorStage;
  /** What is applied: the stage under enforce, 0 otherwise. */
  applied: GovernorStage;
  pressure: number | null;
  reason: string;
  /** When the stage last changed, epoch ms; null before the first change. */
  changedAt: number | null;
  /** The last 24 hours that saw a change or a delay, oldest first. */
  hours: GovernorHour[];
}

const KEEP_HOURS = 48;

export class DemandGovernor {
  private current: GovernorStage = 0;
  private pressure: number | null = null;
  private reason = "not evaluated yet";
  private changedAt: number | null = null;
  private readonly byHour = new Map<number, GovernorHour>();

  constructor(
    readonly config: GovernorConfig,
    private readonly opts: { now?: () => number; onChange?: (c: GovernorChange) => void } = {},
  ) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** The judged stage. */
  get stage(): GovernorStage { return this.config.enabled ? this.current : 0; }
  /** The stage in effect: 0 unless enforcing. */
  get applied(): GovernorStage { return this.config.enabled && this.config.enforce ? this.current : 0; }

  /** Re-judge from the latest spend, forecast and budget. */
  update(input: GovernorInput): GovernorStage {
    if (!this.config.enabled) return 0;
    let next: GovernorStage;
    if (this.config.stageOverride !== null) {
      next = this.config.stageOverride;
      this.pressure = pressureOf(input.spentLast24h, input.forecastNext24h, input.budget);
      this.reason = "stage pinned by routing.governor.stageOverride";
    } else {
      this.pressure = pressureOf(input.spentLast24h, input.forecastNext24h, input.budget);
      next = pickStage(this.pressure, this.current, this.config);
      this.reason = this.pressure === null
        ? "no budget yet (capacity unknown), so no pressure to act on"
        : `demand at ${Math.round(this.pressure * 100)}% of today's budget`;
    }
    const hour = this.hourOf(this.now());
    if (next !== this.current) {
      const change: GovernorChange = { from: this.current, to: next, pressure: this.pressure, reason: this.reason, enforce: this.config.enforce };
      this.current = next;
      this.changedAt = this.now();
      hour.changes++;
      this.opts.onChange?.(change);
    }
    if (this.current > hour.maxStage) hour.maxStage = this.current;
    return this.current;
  }

  /** Count a request stage 4 held back. */
  noteDelayed(): void { this.hourOf(this.now()).delayed++; }

  /** How long to hold this request: 0 unless enforcing stage 4 and it is low priority. */
  delayFor(body: unknown, model: string | undefined, header: unknown): number {
    if (this.applied < 4 || !isLowPriority(body, model, header)) return 0;
    return this.config.delayMs;
  }

  snapshot(): GovernorSnapshot {
    const from = Math.floor(this.now() / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
    return {
      enabled: this.config.enabled,
      enforce: this.config.enforce,
      stage: this.stage,
      applied: this.applied,
      pressure: this.pressure,
      reason: this.config.enabled ? this.reason : "off (routing.governor.enabled is not true)",
      changedAt: this.changedAt,
      hours: [...this.byHour.values()].filter(h => h.hour >= from).sort((a, b) => a.hour - b.hour).map(h => ({ ...h })),
    };
  }

  private hourOf(ts: number): GovernorHour {
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    let h = this.byHour.get(hour);
    if (!h) {
      h = { hour, changes: 0, maxStage: this.current, delayed: 0 };
      this.byHour.set(hour, h);
      for (const k of this.byHour.keys()) if (k < hour - KEEP_HOURS * HOUR_MS) this.byHour.delete(k);
    }
    return h;
  }
}

/** `routing.governor` from config, with every bad field at its default. */
export function resolveGovernorConfig(raw: unknown): GovernorConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_GOVERNOR };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  const t = r["thresholds"];
  const thresholds: GovernorConfig["thresholds"] = Array.isArray(t) && t.length === 4
    && t.every((x, i) => typeof x === "number" && Number.isFinite(x) && x > 0 && (i === 0 || x > (t[i - 1] as number)))
    ? [t[0], t[1], t[2], t[3]] as GovernorConfig["thresholds"]
    : [...DEFAULT_GOVERNOR.thresholds];
  const o = r["stageOverride"];
  return {
    enabled: r["enabled"] === true,
    enforce: r["enforce"] === true,
    stageOverride: o === 0 || o === 1 || o === 2 || o === 3 || o === 4 ? o : null,
    thresholds,
    hysteresis: num(r["hysteresis"], DEFAULT_GOVERNOR.hysteresis, 0, 1),
    delayMs: Math.round(num(r["delayMs"], DEFAULT_GOVERNOR.delayMs, 0, 30_000)),
    throttleBoost: num(r["throttleBoost"], DEFAULT_GOVERNOR.throttleBoost, 0, 1),
    spillPoolUtil: num(r["spillPoolUtil"], DEFAULT_GOVERNOR.spillPoolUtil, 0.01, 1),
  };
}
