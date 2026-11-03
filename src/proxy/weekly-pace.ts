/**
 * Weekly pacing: is an account spending its 7-day window faster than the week
 * allows?
 *
 * Every seat in the pool now has a 7-day window, each with its own reset time.
 * Placement used to rank on the 5-hour window alone, so one seat could burn its
 * whole week in two days and then go dark until its reset while the others
 * still had room. Pacing compares the share of the window already spent with
 * the share of the window already elapsed: a seat ahead of that line should
 * take new sessions only after the seats that are on pace.
 *
 * Pace only reorders. It never makes an account unusable; the hard edge stays
 * `weeklyLimitPercent`.
 */

export const WEEK_SEC = 7 * 24 * 60 * 60;

export interface WeeklyPaceConfig {
  /** Allowance above the linear line, as a fraction of the window (0–1). A
   *  seat at `elapsed + slack` is still on pace. */
  slack: number;
  /** How far ahead (fraction of the window) a pinned session's seat must be
   *  before the session is moved to an on-pace seat. */
  migrateAhead: number;
}

export const DEFAULT_WEEKLY_PACE: WeeklyPaceConfig = { slack: 0.10, migrateAhead: 0.15 };

export interface WeeklyPace {
  /** Utilization the seat may have reached by now and still be on pace. */
  target: number;
  /** `util - target`. Positive means ahead of pace. */
  ahead: number;
}

/** Neutral reading for a seat with no known open weekly window. */
export const NO_PACE: WeeklyPace = { target: 1, ahead: -1 };

/**
 * Pure. Pace of one seat's 7-day window at `nowMs`.
 *
 *   elapsed = 1 - (reset - now) / 7d       clamped to [0, 1]
 *   target  = min(1, elapsed + slack)
 *   ahead   = util - target
 *
 * With no reset known, or a reset already past (the window has rolled and the
 * reading is stale), the seat is neutral: `NO_PACE`.
 */
export function weeklyPace(
  util: number,
  resetAtSec: number | undefined,
  nowMs: number,
  slack: number = DEFAULT_WEEKLY_PACE.slack,
): WeeklyPace {
  const nowSec = nowMs / 1000;
  if (!resetAtSec || resetAtSec <= nowSec || !Number.isFinite(util)) return NO_PACE;
  const elapsed = Math.min(1, Math.max(0, 1 - (resetAtSec - nowSec) / WEEK_SEC));
  const target = Math.min(1, elapsed + Math.max(0, slack));
  return { target, ahead: util - target };
}
