import type { Account } from "./types.js";
import type { SeatExplanation, SeatTier } from "./session-router.js";
import type { SeatSize } from "./seat-size.js";
import type { PlacementCounts } from "./seat-metrics.js";
import { WEEK_SEC } from "./weekly-pace.js";
import { DAY_MS } from "./usage-history.js";
import type { SeatOutcomes } from "./quota-history.js";

/**
 * The `balance` block of health: what placement knows about each seat, as it
 * knows it. Built from the router's own explanation (SessionRouter.explain),
 * the measured seat sizes (seat-size.ts) and the hourly placement counts, so
 * the dashboard, the TUI and a smoke check read the figures placement ranks
 * by, not a second computation of them.
 */

export interface BalanceSeatView {
  id: string;
  /** Weekly quota relative to a typical seat, and where that came from.
   *  `spanHours`: the history the measurement covers (oldest to newest reading
   *  used); `errorBand`: its relative error bound (±), from the headers'
   *  two-place rounding over the utilization the pairs moved. */
  size: { relative: number; source: SeatSize["source"]; tokensPerWeek: number | null; samples: number; spanHours: number; errorBand: number | null };
  /** Cost-weighted tokens left in the 7-day window, when the size is measured. */
  remainingTokens: number | null;
  /** Pace ratio of the 7-day window (1 = even spend); null with no window. */
  weekRatio: number | null;
  /** Pace ratio of the 5-hour window; null with no open window. */
  fiveHourRatio: number | null;
  /** Cost-weighted tokens per hour by which an even spend from now to the
   *  weekly reset would fall short of the pace line (quota per hour at an even
   *  spend over the whole week). Positive: the seat has spent faster than the
   *  week elapses and must spend this much less per hour than the line to
   *  last to its reset (it is behind pace). Negative: it has that much per
   *  hour to spare above the line, quota that is lost at the reset unless
   *  something spends it. Null when the size is unknown or no weekly window is
   *  open. (Was surplusPerHour, with the opposite sign.) */
  paceDeficitPerHour: number | null;
  onPace: boolean;
  overCap: boolean;
  /** The tier placement puts the seat in (see SeatTier). */
  tier: SeatTier;
  /** The balance score (cost-weighted tokens left per hour to the weekly reset,
   *  scaled by size, 5-hour room, load and saturation); what rank orders by. */
  score: number;
  /** The last response carried a 5-hour utilization header; false means the
   *  seat reports no 5-hour window (fiveHourRatio is null then, not 0). Null
   *  for a seat with no reading yet. */
  fiveHourReported: boolean | null;
  usable: boolean;
  /** Requests in the last ten minutes, as sessions at one a minute. */
  load: number;
  /** Where a new session would be placed now: 1 first. */
  rank: number;
  placeable: boolean;
  /** What placement achieved for this seat over the last OUTCOMES_DAYS days
   *  (quota-history.ts): unused quota at its weekly resets, minutes stranded at
   *  the cap while another seat had week left. */
  outcomes: SeatOutcomes & { days: number };
}

/** The window the outcomes are summed over. */
export const OUTCOMES_DAYS = 7;

export interface BalanceView {
  /** The balance rules are in force (false: `routing.balance.legacy`, or neither softCapUtil nor weeklyPace set). */
  rules: "balance" | "legacy";
  seats: BalanceSeatView[];
  /** Session placements by reason, whole hours overlapping the last hour / day. */
  placements: { lastHour: PlacementCounts; lastDay: PlacementCounts };
}

export function balanceView(
  accounts: ReadonlyArray<Account>,
  explained: Map<string, SeatExplanation> | null,
  sizes: Map<string, SeatSize>,
  placements: BalanceView["placements"],
  nowMs: number,
  outcomesOf: (id: string, windowMs: number) => SeatOutcomes,
): BalanceView {
  const nowSec = nowMs / 1000;
  const seats: BalanceSeatView[] = accounts.map(a => {
    const x = explained?.get(`anthropic:${a.id}`);
    const size = sizes.get(a.id) ?? { relative: 1, source: "equal" as const, tokensPerWeek: null, samples: 0, spanHours: 0, errorBand: null, moved: 0 };
    const r = a.rateLimits;
    const weekOpen = r.sevenDayReset > nowSec;
    const remaining = size.tokensPerWeek !== null && weekOpen ? Math.max(0, 1 - r.sevenDayUtil) * size.tokensPerWeek : null;
    // Even spend from now to the reset would use remaining / hoursLeft per
    // hour; the pace line allows tokensPerWeek / (hours in a week) per hour.
    let deficit: number | null = null;
    if (remaining !== null && size.tokensPerWeek !== null) {
      const hoursLeft = Math.max(1 / 60, (r.sevenDayReset - nowSec) / 3600);
      deficit = size.tokensPerWeek / (WEEK_SEC / 3600) - remaining / hoursLeft;
    }
    return {
      id: a.id,
      size: {
        relative: round(size.relative, 2) ?? 1, source: size.source,
        tokensPerWeek: size.tokensPerWeek === null ? null : Math.round(size.tokensPerWeek),
        samples: size.samples, spanHours: round(size.spanHours, 1) ?? 0, errorBand: round(size.errorBand, 3),
      },
      remainingTokens: remaining === null ? null : Math.round(remaining),
      weekRatio: x ? round(x.weekRatio, 3) : null,
      fiveHourRatio: x ? round(x.fiveHourRatio, 3) : null,
      paceDeficitPerHour: deficit === null ? null : Math.round(deficit),
      onPace: x?.onPace ?? true,
      overCap: x?.overCap ?? false,
      tier: x?.tier ?? "on-pace",
      // Significant digits, not decimal places: scores run from 1e-4 down to 1e-7.
      score: x && Number.isFinite(x.score) ? Number(x.score.toPrecision(4)) : 0,
      fiveHourReported: r.lastUpdated > 0 ? r.fiveHourReported ?? (r.fiveHourReset > 0 || r.fiveHourUtil > 0) : null,
      usable: x?.usable ?? a.enabled,
      load: x?.load ?? 0,
      rank: x?.rank ?? 0,
      placeable: x?.placeable ?? false,
      outcomes: outcomesView(outcomesOf(a.id, OUTCOMES_DAYS * DAY_MS)),
    };
  });
  return { rules: explained ? "balance" : "legacy", seats, placements };
}

function outcomesView(o: SeatOutcomes): BalanceSeatView["outcomes"] {
  return {
    days: OUTCOMES_DAYS,
    resets: o.resets,
    unusedAtReset: round(o.unusedAtReset, 3),
    strandedMinutes: Math.round(o.strandedMinutes),
  };
}

function round(n: number | null, digits: number): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
