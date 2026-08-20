import type { AccountRateLimits } from "../../proxy/types.js";

/**
 * Codex reports quota through response headers, in two parallel series: the
 * plain `x-codex-*` set and an `x-codex-bengalfox-*` set (name unexplained by
 * the API). Each series carries a `primary` and `secondary` window, and the
 * windows do NOT line up between series — measured 2026-08-20, plain primary
 * was 10080 minutes (7 days) while bengalfox primary was 300 (5 hours).
 *
 * Slots are therefore assigned by the reported `window-minutes`, never by the
 * header's position in its series. When two series report the same window, the
 * higher utilisation wins: whichever limit binds first is the one that matters.
 */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;
const SERIES_PREFIXES = ["", "bengalfox-"] as const;
const SLOTS = ["primary", "secondary"] as const;

type HeaderLookup = (name: string) => string;

interface WindowReading {
  util: number;
  reset: number;
}

function readNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keep the reading that is closer to its limit — that is the binding one. */
function keepHigher(current: WindowReading | null, next: WindowReading): WindowReading {
  return current && current.util >= next.util ? current : next;
}

export function extractCodexRateLimits(get: HeaderLookup): AccountRateLimits | null {
  let fiveHour: WindowReading | null = null;
  let sevenDay: WindowReading | null = null;
  let sawAnyWindow = false;

  for (const prefix of SERIES_PREFIXES) {
    for (const slot of SLOTS) {
      const base = `x-codex-${prefix}${slot}`;
      const windowMinutes = readNumber(get(`${base}-window-minutes`));
      // A zero/absent window means the series does not use that slot.
      if (windowMinutes === null || windowMinutes <= 0) continue;

      const usedPercent = readNumber(get(`${base}-used-percent`));
      if (usedPercent === null) continue;
      sawAnyWindow = true;

      const resetAt = readNumber(get(`${base}-reset-at`));
      const resetAfter = readNumber(get(`${base}-reset-after-seconds`));
      const reading: WindowReading = {
        util: usedPercent / 100,
        // Prefer the absolute timestamp; derive one when only a delta is sent.
        reset: resetAt ?? (resetAfter !== null ? Math.floor(Date.now() / 1000) + resetAfter : 0),
      };

      if (windowMinutes <= FIVE_HOUR_MINUTES) {
        fiveHour = keepHigher(fiveHour, reading);
      } else if (windowMinutes >= SEVEN_DAY_MINUTES) {
        sevenDay = keepHigher(sevenDay, reading);
      }
      // Windows between the two named sizes are ignored rather than forced into
      // a slot they would misrepresent.
    }
  }

  if (!sawAnyWindow) return null;

  const fiveHourUtil = fiveHour?.util ?? 0;
  const sevenDayUtil = sevenDay?.util ?? 0;
  // Codex sends no explicit "you are limited" flag, so exhaustion is inferred
  // from utilisation reaching the cap.
  const exhausted = fiveHourUtil >= 1 || sevenDayUtil >= 1;

  return {
    status: exhausted ? "rate_limited" : "allowed",
    fiveHourUtil,
    fiveHourReset: fiveHour?.reset ?? 0,
    sevenDayUtil,
    sevenDayReset: sevenDay?.reset ?? 0,
    claim: fiveHourUtil >= sevenDayUtil ? "five_hour" : "seven_day",
    plan: get("x-codex-plan-type"),
    requestsLimit: 0,   // Codex publishes no per-minute request cap.
    lastUpdated: Date.now(),
  };
}
