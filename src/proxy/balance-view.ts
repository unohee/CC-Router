import type { Account } from "./types.js";
import type { SeatExplanation } from "./session-router.js";
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
  /** Weekly quota relative to a typical seat, and where that came from. */
  size: { relative: number; source: SeatSize["source"]; tokensPerWeek: number | null; samples: number };
  /** Cost-weighted tokens left in the 7-day window, when the size is measured. */
  remainingTokens: number | null;
  /** Pace ratio of the 7-day window (1 = even spend); null with no window. */
  weekRatio: number | null;
  /** Pace ratio of the 5-hour window; null with no open window. */
  fiveHourRatio: number | null;
  /** Cost-weighted tokens per hour the seat could add and still reach its
   *  weekly reset at an even spend: positive is surplus, negative is deficit.
   *  Null when the size is unknown or no weekly window is open. */
  surplusPerHour: number | null;
  onPace: boolean;
  overCap: boolean;
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
    const size = sizes.get(a.id) ?? { relative: 1, source: "equal" as const, tokensPerWeek: null, samples: 0 };
    const r = a.rateLimits;
    const weekOpen = r.sevenDayReset > nowSec;
    const remaining = size.tokensPerWeek !== null && weekOpen ? Math.max(0, 1 - r.sevenDayUtil) * size.tokensPerWeek : null;
    // Even spend from now to the reset would use remaining / hoursLeft per
    // hour; the pace line allows tokensPerWeek / (hours in a week) per hour.
    let surplus: number | null = null;
    if (remaining !== null && size.tokensPerWeek !== null) {
      const hoursLeft = Math.max(1 / 60, (r.sevenDayReset - nowSec) / 3600);
      surplus = remaining / hoursLeft - size.tokensPerWeek / (WEEK_SEC / 3600);
    }
    return {
      id: a.id,
      size: { relative: round(size.relative, 2) ?? 1, source: size.source, tokensPerWeek: size.tokensPerWeek === null ? null : Math.round(size.tokensPerWeek), samples: size.samples },
      remainingTokens: remaining === null ? null : Math.round(remaining),
      weekRatio: x ? round(x.weekRatio, 3) : null,
      fiveHourRatio: x ? round(x.fiveHourRatio, 3) : null,
      surplusPerHour: surplus === null ? null : Math.round(surplus),
      onPace: x?.onPace ?? true,
      overCap: x?.overCap ?? false,
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
