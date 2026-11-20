#!/usr/bin/env node
/**
 * Build a balance-simulator scenario (src/__tests__/balance/scenarios-2.ts,
 * `Scenario2`) from the router's recorded data instead of by hand.
 *
 *   node scripts/balance-capture.mjs --quota quota-history.json \
 *     --series usage-series-7d.json --usage usage-history.json --config config.json \
 *     [--health health.json] [--start 2026-11-19T07:00Z] [--days 1] [--seed 3101] [--window 1d|7d|14d|30d] \
 *     [--name live-week] --out scenario.json
 *
 * Inputs are the router's own views, saved to files: /cc-router/quota-history,
 * /cc-router/usage-series?range=7d, /cc-router/usage-history, config.json and,
 * optionally, /health. Nothing here talks to a server.
 *
 * What it fits (each rule is also written into the output's `notes`):
 * 1. Start: every account's newest reading at or before the start hour; an
 *    account with none is skipped.
 * 2. Seats: weekly and 5-hour utilization and reset from that reading (a reset
 *    of 0 or in the past is a fresh week), or from health's
 *    accounts[].rateLimits when that is newer: the hourly reading can be
 *    hours old at the start (live-week's lyra was four), while health carries
 *    the live value from the last response's headers with its `lastUpdated`.
 *    Health is used only when its lastUpdated is newer than the reading and
 *    not past the end of the start hour (a value from later than that is the
 *    seat's future, not its start). Every seat's source and age go in notes. Weekly size is the seat-size.ts
 *    pairing (same window, utilization and spend non-decreasing, >= 3 pairs,
 *    >= 0.08 moved, error band 0.01 / moved) over readings up to the start;
 *    unmeasured seats take capacityWeight x the median measured size, the
 *    median, or 450e6. The 5-hour size is the same pairing on the 5-hour
 *    window, else an ASSUMED 15% of the week when the seat ever reported a
 *    5-hour window, else 0.
 * 3. Demand: the hourly request profile folded by UTC hour, requests per day,
 *    and per-request token sizes from the usage totals. Sessions per day are
 *    health's placements (else requests / 40), but never fewer than keep
 *    requestChance at or under 0.6: placements alone can be far too few.
 * 4. Routing verbatim from config; throttle from config.throttle, missing keys
 *    at the throttle.ts defaults (minIntervalMs is not modelled).
 *
 * What it cannot recover, so it assumes (and says so in `notes`): session
 * lengths, the share of requests without a session id, the prompt-prefix cap,
 * sessions per day without health, and any per-seat demand (the views are
 * pool-wide, so every seat sees the same arrival stream).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR_MS = 3_600_000;
const MAX_AGE_MS = 14 * 24 * HOUR_MS;
const RESET_TOLERANCE_SEC = 600;
const MIN_SAMPLES = 3;
const MIN_MOVED = 0.08;
const UTIL_ROUNDING = 0.01;
const DEFAULT_WEEK = 450e6;
const FIVE_HOUR_SHARE = 0.15;
const REQUESTS_PER_SESSION = 40;
const SESSION_MINUTES = [30, 240];
const NO_SESSION_SHARE = 0.08;
/** Days each usage-history window covers. */
const WINDOW_DAYS = { "1d": 1, "7d": 7, "14d": 14, "30d": 30 };
const PREFIX_MAX_FLOOR = 350_000;
const SERVICE_SECONDS = 12;
/** Highest requestChance the fitted session count allows (the DENSE demand's value). */
const MAX_CHANCE = 0.6;
// Defaults of throttle.ts (DEFAULT_THROTTLE); config.throttle is a partial override.
const THROTTLE_DEFAULTS = { perAccountMaxInFlight: 4, startUtil: 0.75, hardUtil: 0.95, maxWaitMs: 20000 };

const round1 = x => Math.round(x * 10) / 10;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const iso = ms => new Date(ms).toISOString();
function fail(msg) { throw new Error(msg); }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function checkQuota(quota) {
  if (!quota || !Array.isArray(quota.accounts)) fail("quota history: expected { accounts: [...] }");
  for (const a of quota.accounts) {
    if (!a || typeof a.id !== "string" || !Array.isArray(a.readings)) fail("quota history: every account needs { id, readings: [] }");
    for (const r of a.readings) {
      const ok = r && isNum(r.hour) && isNum(r.sampledAt) && r.fiveHour && r.sevenDay
        && isNum(r.fiveHour.util) && isNum(r.fiveHour.resetAt) && isNum(r.sevenDay.util) && isNum(r.sevenDay.resetAt)
        && (r.spentAt === null || r.spentAt === undefined || isNum(r.spentAt));
      if (!ok) fail(`quota history: malformed reading for ${a.id}`);
    }
  }
}

/** The latest hour with a reading for every account that has any; else the oldest per-account latest. */
export function defaultStart(quota) {
  checkQuota(quota);
  const sets = quota.accounts.filter(a => a.readings.length > 0).map(a => new Set(a.readings.map(r => r.hour)));
  if (sets.length === 0) fail("quota history: no readings at all");
  const common = [...sets[0]].filter(h => sets.every(s => s.has(h)));
  if (common.length > 0) return { startMs: Math.max(...common), common: true };
  return { startMs: Math.min(...sets.map(s => Math.max(...s))), common: false };
}

/** seat-size.ts measureWeeklySize, on either window: tokens per full window, or null. */
export function measureWindow(readings, window, nowMs) {
  const sorted = readings.filter(r => r.sampledAt >= nowMs - MAX_AGE_MS).sort((a, b) => a.sampledAt - b.sampledAt);
  let samples = 0, tokens = 0, moved = 0, first = null, last = null;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.spentAt == null || b.spentAt == null || b.spentAt < a.spentAt) continue;
    const ra = a[window].resetAt, rb = b[window].resetAt;
    if (!(ra > 0 && rb > 0 && Math.abs(ra - rb) <= RESET_TOLERANCE_SEC)) continue;
    const du = b[window].util - a[window].util;
    if (du < 0) continue;
    const spent = b.spentAt - a.spentAt;
    if (spent === 0 && du === 0) continue;
    samples++; tokens += spent; moved += du;
    if (first === null) first = a.sampledAt;
    last = b.sampledAt;
  }
  const spanHours = first !== null ? (last - first) / HOUR_MS : 0;
  if (samples < MIN_SAMPLES || moved < MIN_MOVED || tokens <= 0) return { tokens: null, samples, moved, spanHours, errorBand: null };
  return { tokens: tokens / moved, samples, moved, spanHours, errorBand: UTIL_ROUNDING / moved };
}

/**
 * The starting state of one seat: the newest quota-history reading at or
 * before the start, or health's live rate limits for it when those are newer
 * than that reading and taken before the start hour ended. `ageH` is how long
 * before the end of the start hour the value was taken (0 at the hour's end).
 */
export function startState(reading, account, startMs) {
  const endMs = startMs + HOUR_MS;
  const fromReading = {
    source: "quota-history", takenAt: reading.sampledAt,
    sevenDay: { util: reading.sevenDay.util, resetAt: reading.sevenDay.resetAt },
    fiveHour: { util: reading.fiveHour.util, resetAt: reading.fiveHour.resetAt },
  };
  const rl = account?.rateLimits;
  const at = rl?.lastUpdated;
  let why;
  if (!account) why = "not in health";
  else if (!rl || !isNum(at) || at <= 0) why = "health has no rate-limit reading";
  else if (at <= reading.sampledAt) why = `health's reading (${iso(at)}) is not newer`;
  else if (at > endMs) why = `health's reading (${iso(at)}) is after the start hour`;
  else if (!isNum(rl.sevenDayUtil) || !isNum(rl.sevenDayReset) || rl.sevenDayReset <= 0) why = "health's weekly window is unknown";
  if (why) return { ...fromReading, ageH: round1((endMs - reading.sampledAt) / HOUR_MS), why };
  const fiveKnown = isNum(rl.fiveHourUtil) && isNum(rl.fiveHourReset) && rl.fiveHourReset > 0;
  return {
    source: "health", takenAt: at,
    sevenDay: { util: rl.sevenDayUtil, resetAt: rl.sevenDayReset },
    fiveHour: fiveKnown ? { util: rl.fiveHourUtil, resetAt: rl.fiveHourReset } : fromReading.fiveHour,
    ageH: round1((endMs - at) / HOUR_MS),
    why: `newer than the quota-history reading of ${iso(reading.sampledAt)}${fiveKnown ? "" : "; its 5-hour window is unknown, so that one is the reading's"}`,
  };
}

/** Seats at `startMs` from the quota history view (and health's live rate limits, see `startState`). Returns { seats, details, notes }. */
export function fitSeats(quota, startMs, routing = {}, health = undefined) {
  checkQuota(quota);
  if (!isNum(startMs)) fail("start: not a time");
  const startSec = startMs / 1000;
  const notes = [], details = {};
  const accounts = new Map((Array.isArray(health?.accounts) ? health.accounts : []).filter(a => a && typeof a.id === "string").map(a => [a.id, a]));
  const fitted = [];
  for (const a of quota.accounts) {
    const upTo = a.readings.filter(r => r.hour <= startMs);
    if (upTo.length === 0) { notes.push(`${a.id}: no reading at or before ${iso(startMs)}; skipped.`); continue; }
    const now = upTo.reduce((x, r) => (r.hour > x.hour || (r.hour === x.hour && r.sampledAt > x.sampledAt) ? r : x));
    const week = measureWindow(upTo, "sevenDay", startMs);
    const five = measureWindow(upTo, "fiveHour", startMs);
    fitted.push({ id: a.id, now, week, five, everFive: a.readings.some(r => r.fiveHour.resetAt > 0) });
  }
  const known = fitted.map(f => f.week.tokens).filter(t => t !== null);
  const med = known.length > 0 ? median(known) : null;
  const weights = routing?.balance?.capacityWeight;
  const seats = [];
  for (const f of fitted) {
    const st = startState(f.now, accounts.get(f.id), startMs);
    const d = { readingHour: iso(f.now.hour), startSource: st.source, startTakenAt: iso(st.takenAt), startAgeH: st.ageH, samples: f.week.samples, moved: Number(f.week.moved.toFixed(4)), spanHours: round1(f.week.spanHours), errorBand: f.week.errorBand, capSource: "measured" };
    let weeklyCap;
    if (f.week.tokens !== null) {
      weeklyCap = Math.round(f.week.tokens);
      notes.push(`${f.id}: weekly cap ${weeklyCap} measured from ${f.week.samples} pairs over ${round1(f.week.spanHours)} h, moved ${Number(f.week.moved.toFixed(4))}, error band +/-${(f.week.errorBand * 100).toFixed(1)}%.`);
    } else {
      const w = weights && Object.prototype.hasOwnProperty.call(weights, f.id) ? weights[f.id] : undefined;
      const wOk = isNum(w) && w >= 0.05 && w <= 50;
      if (wOk && med !== null) { weeklyCap = Math.round(w * med); d.capSource = "weight"; notes.push(`${f.id}: weekly cap unmeasured (${f.week.samples} pairs, moved ${Number(f.week.moved.toFixed(4))}); capacityWeight ${w} x median measured ${Math.round(med)}.`); }
      else if (med !== null) { weeklyCap = Math.round(med); d.capSource = "median"; notes.push(`${f.id}: weekly cap unmeasured (${f.week.samples} pairs, moved ${Number(f.week.moved.toFixed(4))}); median measured cap ${Math.round(med)}.`); }
      else { weeklyCap = DEFAULT_WEEK; d.capSource = "default"; notes.push(`${f.id}: weekly cap unmeasured and no seat measured; default ${DEFAULT_WEEK}.`); }
    }
    let fiveHourCap;
    if (f.five.tokens !== null) { fiveHourCap = Math.round(f.five.tokens); d.fiveCapSource = "measured"; notes.push(`${f.id}: 5-hour cap ${fiveHourCap} measured from ${f.five.samples} pairs, moved ${Number(f.five.moved.toFixed(4))}, error band +/-${(f.five.errorBand * 100).toFixed(1)}%.`); }
    else if (f.everFive) { fiveHourCap = Math.round(FIVE_HOUR_SHARE * weeklyCap); d.fiveCapSource = "assumed"; notes.push(`${f.id}: 5-hour cap ASSUMED ${FIVE_HOUR_SHARE * 100}% of the week (not measurable from ${f.five.samples} pairs).`); }
    else { fiveHourCap = 0; d.fiveCapSource = "none"; notes.push(`${f.id}: never reported a 5-hour window; fiveHourCap 0.`); }
    const seat = { id: f.id, weeklyCap, fiveHourCap, weeklyUtil: 0, weeklyResetH: 168 };
    notes.push(`${f.id}: start state from ${st.source} taken ${iso(st.takenAt)}, ${st.ageH} h before the start hour ended (${st.why}).`);
    const wr = st.sevenDay.resetAt;
    if (wr > startSec) { seat.weeklyUtil = st.sevenDay.util; seat.weeklyResetH = Math.min(168, round1((wr - startSec) / 3600)); }
    else notes.push(`${f.id}: weekly reset ${wr === 0 ? "unknown" : "already passed"} at the start; modelled as a fresh week (util 0, reset in 168 h).`);
    const fr = st.fiveHour.resetAt;
    if (fr > startSec) { seat.fiveHourUtil = st.fiveHour.util; seat.fiveHourResetMin = Math.round((fr - startSec) / 60);
      // The reading can be taken late in the start hour, so its reset can lie
      // past a full window from the hour's start; no window is longer than 5 h.
      if (seat.fiveHourResetMin > 300) { notes.push(`${f.id}: 5-hour reset ${seat.fiveHourResetMin} min after the start hour, clamped to 300.`); seat.fiveHourResetMin = 300; }
    }
    if (st.source === "quota-history" && f.now.hour < startMs) notes.push(`${f.id}: newest reading is ${round1((startMs - f.now.hour) / HOUR_MS)} h before the start; its utilization may be stale.`);
    seats.push(seat);
    details[f.id] = d;
  }
  if (seats.length === 0) fail("quota history: no account has a reading at or before the start");
  return { seats, details, notes };
}

/** Demand from the usage series (profile, requests/day) and the usage history window (token split). */
export function fitDemand(series, usage, health, opts = {}) {
  const notes = [];
  const window = opts.window ?? "1d";
  if (!WINDOW_DAYS[window]) fail(`window: expected one of ${Object.keys(WINDOW_DAYS).join(", ")}, got ${window}`);
  if (!series || !Array.isArray(series.points) || !Array.isArray(series.series)) fail("usage series: expected { series: [], points: [] }");
  if (series.step !== "hour") fail(`usage series: needs an hourly range (24h or 7d), got step ${series.step}`);
  const folded = new Array(24).fill(0);
  let requests = 0, hours = 0;
  for (const p of series.points) {
    if (!p || !isNum(p.start) || !Array.isArray(p.requests) || !p.requests.every(isNum)) fail("usage series: malformed point");
    if (p.recorded === false) continue;
    const n = p.requests.reduce((x, y) => x + y, 0);
    folded[new Date(p.start).getUTCHours()] += n;
    requests += n; hours++;
  }
  if (hours < series.points.length) notes.push(`Usage series: ${series.points.length - hours} of ${series.points.length} hours were not recorded and are left out.`);
  const peak = Math.max(...folded);
  if (!(peak > 0)) fail("usage series: no requests in the range, the profile is all zero");
  const profile = folded.map(x => Math.round((x / peak) * 100) / 100);
  const days = hours / 24;
  notes.push(`Profile: requests summed over every model and folded by UTC hour over ${round1(days)} days of the series; profile[h] is UTC hour h. The simulator starts at 00:00 UTC, so a start at another hour shifts demand against the seats by that many hours.`);
  const otherIdx = series.series.map((s, i) => (s && s.provider && s.provider !== "anthropic" ? i : -1)).filter(i => i >= 0);
  if (otherIdx.length > 0) {
    let other = 0;
    for (const p of series.points) if (p.recorded !== false) for (const i of otherIdx) other += p.requests[i] ?? 0;
    notes.push(`Demand includes non-anthropic models (${otherIdx.map(i => series.series[i].model).join(", ")}): ${((other / requests) * 100).toFixed(1)}% of requests, which spend no seat quota.`);
  }

  // The rate and the token sizes come from one usage-history window. The
  // default is the last day: the seats are captured at a point in time, and
  // the demand that met them is the recent rate, not a week's average (live
  // on 2026-11-19 the last day ran at twice the 7-day mean).
  const key = window;
  const t = usage?.windows?.[key];
  if (!t || !["input", "output", "cacheRead", "cacheCreation", "requests"].every(k => isNum(t[k]))) fail(`usage history: expected windows["${key}"] with input, output, cacheRead, cacheCreation, requests`);
  if (!(t.requests > 0)) fail(`usage history: windows["${key}"] has no requests`);
  if (t.partial) notes.push(`Usage history: the ${key} window is partial (recording began inside it).`);
  const requestsPerDay = t.requests / WINDOW_DAYS[key];
  const seriesPerDay = requests / days;
  notes.push(`Requests per day ${Math.round(requestsPerDay)} from usage-history ${key} (${t.requests} requests over ${WINDOW_DAYS[key]} day${WINDOW_DAYS[key] === 1 ? "" : "s"}); the series' ${round1(days)}-day mean is ${Math.round(seriesPerDay)}.`);
  const freshInput = Math.round(t.input / t.requests);
  const output = Math.round(t.output / t.requests);
  const start = Math.round(t.cacheRead / t.requests);
  const perRequest = Math.round(t.cacheCreation / t.requests);
  notes.push(`Token sizes per request from usage-history ${key}: input ${freshInput}, output ${output}, prefix.start = cache read ${start}, prefix.perRequest = cache write ${perRequest}.`);
  notes.push(`prefix.max ASSUMED max(2 x prefix.start, ${PREFIX_MAX_FLOOR}): the prefix cap is not recorded.`);

  // Sessions per day: placements (or requests / 40) can be far too few for the
  // recorded request rate (live: 13 placed against ~2,600 requests an hour),
  // which would need requestChance > 1. So it is never below the count that
  // keeps requestChance at or under MAX_CHANCE, the DENSE demand's value.
  const meanMinutes = (SESSION_MINUTES[0] + SESSION_MINUTES[1]) / 2;
  // The share of requests without a session id: measured from health's recent
  // log when it has entries. Such requests spend no cache and rotate across
  // every seat under the cap, which is how a seat with no weekly reading gets
  // one; the share decides how long such a seat waits for work. The log shows
  // /messages only (count_tokens never appears in it), so this is what the
  // router routes as sessions' traffic, not every request it sees.
  const logs = Array.isArray(health?.recentLogs) ? health.recentLogs.filter(e => e && e.statusCode !== undefined) : [];
  const noSessionShare = logs.length >= 20
    ? Math.round((logs.filter(e => !e.sessionId).length / logs.length) * 100) / 100
    : NO_SESSION_SHARE;
  notes.push(logs.length >= 20
    ? `noSessionShare ${noSessionShare}: ${logs.filter(e => !e.sessionId).length} of ${logs.length} recent /messages log entries had no session id (count_tokens is not logged, so requests outside sessions may be undercounted).`
    : `noSessionShare ASSUMED ${noSessionShare}: no health log to measure it from.`);
  const sessionRequests = requestsPerDay * (1 - noSessionShare);
  const floor = Math.max(1, Math.ceil(sessionRequests / (meanMinutes * MAX_CHANCE)));
  const placed = health?.balance?.placements?.lastDay?.placed;
  const fromPlaced = isNum(placed) && placed > 0;
  const counted = fromPlaced ? placed : Math.max(1, Math.round(requestsPerDay / REQUESTS_PER_SESSION));
  const countedWhat = fromPlaced ? `health balance.placements.lastDay.placed (${placed})` : `ASSUMED requestsPerDay / ${REQUESTS_PER_SESSION} (${counted}, no health placements)`;
  const sessionsPerDay = Math.max(counted, floor);
  notes.push(counted >= floor
    ? `sessionsPerDay ${sessionsPerDay} from ${countedWhat}; it is above the floor ${floor} that keeps requestChance <= ${MAX_CHANCE}.`
    : `sessionsPerDay ${sessionsPerDay} is the floor ceil(requestsPerDay x (1 - noSessionShare) / (${meanMinutes} x ${MAX_CHANCE})), which keeps requestChance <= ${MAX_CHANCE}; ${countedWhat} was lower.`);
  notes.push(`sessionMinutes ASSUMED [${SESSION_MINUTES.join(", ")}]: session lengths are not recorded.`);
  const rawChance = sessionRequests / (sessionsPerDay * meanMinutes);
  const requestChance = Math.min(1, Math.max(0.05, Math.round(rawChance * 1000) / 1000));
  notes.push(`requestChance = requestsPerDay x (1 - noSessionShare) / (sessionsPerDay x ${meanMinutes}) = ${rawChance.toFixed(3)}, clamped to [0.05, 1].`);
  notes.push("noSessionCost = 1.25 x freshInput + 5 x output (cost weights: input 1, output 5, cache write 1.25, cache read 0.1).");
  notes.push("Demand is pool-wide: the views carry no per-seat demand.");
  return {
    demand: {
      sessionsPerDay, profile, sessionMinutes: [...SESSION_MINUTES], requestChance,
      prefix: { start, perRequest, max: Math.max(start * 2, PREFIX_MAX_FLOOR) },
      freshInput, output, noSessionShare,
      noSessionCost: Math.round(1.25 * freshInput + 5 * output),
    },
    requestsPerDay, days, notes,
  };
}

/** ThrottleSpec from config.throttle, or undefined when the config has none. */
export function fitThrottle(config, health) {
  const notes = [];
  const raw = config?.throttle;
  if (raw === undefined || raw === null) return { throttle: undefined, notes: ["No throttle in config; the scenario models none."] };
  if (typeof raw !== "object" || Array.isArray(raw)) fail("config: throttle must be an object");
  const pick = k => {
    if (isNum(raw[k])) return raw[k];
    notes.push(`config.throttle has no ${k}; the throttle.ts default ${THROTTLE_DEFAULTS[k]} is used.`);
    return THROTTLE_DEFAULTS[k];
  };
  if (raw.enabled !== true) notes.push("config.throttle is not enabled; modelled as if it were.");
  // minIntervalMs (pacing) is not modelled by the simulator and is ignored.
  let serviceSeconds = SERVICE_SECONDS;
  const p50 = health?.performance?.pool?.p50Ms;
  if (isNum(p50) && p50 > 0) { serviceSeconds = round1(p50 / 1000); notes.push(`serviceSeconds ${serviceSeconds} from health performance.pool.p50Ms.`); }
  else notes.push(`serviceSeconds ASSUMED ${SERVICE_SECONDS} (no p50 finish time).`);
  return {
    throttle: {
      perAccountMaxInFlight: pick("perAccountMaxInFlight"), startUtil: pick("startUtil"), hardUtil: pick("hardUtil"),
      serviceSeconds, maxWaitSeconds: pick("maxWaitMs") / 1000,
    },
    notes,
  };
}

/** The whole Scenario2 plus `notes`, `capturedAt`, `source`, and per-seat fit details. */
export function buildScenario({ quota, series, usage, config, health, startMs, days = 1, seed = 3101, name = "live-week", window = "1d" }) {
  checkQuota(quota);
  const notes = [];
  if (startMs === undefined) {
    const d = defaultStart(quota);
    startMs = d.startMs;
    notes.push(d.common ? `Start ${iso(startMs)}: the latest hour with a reading for every account.`
      : `Start ${iso(startMs)}: no hour has a reading for every account; the oldest of the accounts' latest hours.`);
  } else {
    startMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
    notes.push(`Start ${iso(startMs)}: given, floored to the hour.`);
  }
  if (!config || typeof config !== "object") fail("config: expected an object");
  const routing = config.routing && typeof config.routing === "object" ? config.routing : {};
  notes.push(routing !== config.routing ? "config has no routing block; routing is {}." : "routing: config.routing verbatim.");
  const s = fitSeats(quota, startMs, routing, health);
  const d = fitDemand(series, usage, health, { window });
  const t = fitThrottle(config, health);
  // The simulator's clock starts at 00:00 UTC while the seats are in their
  // state as of the start hour: rotate the profile so that simulated hour 0 is
  // the start hour's demand, and the seats meet the demand that followed them.
  const startHour = new Date(startMs).getUTCHours();
  const profile = d.demand.profile.map((_, h) => d.demand.profile[(h + startHour) % 24]);
  const scenario = {
    name,
    description: `The live pool captured at ${iso(startMs)} from the router's recorded quota and usage, over ${days} day${days === 1 ? "" : "s"}.`,
    seed, days, seats: s.seats, demand: { ...d.demand, profile }, routing, historyAvailable: true,
  };
  if (startHour !== 0) notes.push(`Profile rotated by ${startHour} h: simulated hour h carries the demand of UTC hour (h + ${startHour}) % 24, so the seats' start state meets the demand that followed it live.`);
  if (t.throttle) scenario.throttle = t.throttle;
  scenario.notes = [...notes, ...s.notes, ...d.notes, ...t.notes];
  scenario.capturedAt = iso(startMs);
  scenario.source = { quotaGeneratedAt: isNum(quota.generatedAt) ? iso(quota.generatedAt) : null, usageRange: series.range ?? null };
  return { scenario, details: s.details, requestsPerDay: d.requestsPerDay };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
    out[a.slice(2)] = v;
  }
  return out;
}

function readJson(path, what) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (e) { fail(`${what}: cannot read ${path} (${e.code ?? e.message})`); }
  try { return JSON.parse(text); } catch { fail(`${what}: ${path} is not valid JSON`); }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ["quota", "series", "usage", "config", "out"]) if (!args[k]) fail(`--${k} is required`);
  const num = (k, def) => {
    if (args[k] === undefined) return def;
    const n = Number(args[k]);
    if (!Number.isInteger(n) || n <= 0) fail(`--${k} must be a positive integer`);
    return n;
  };
  let startMs;
  if (args.start !== undefined) { startMs = Date.parse(args.start); if (!Number.isFinite(startMs)) fail(`--start ${args.start} is not an ISO time`); }
  const { scenario, details, requestsPerDay } = buildScenario({
    quota: readJson(args.quota, "quota history"), series: readJson(args.series, "usage series"),
    usage: readJson(args.usage, "usage history"), config: readJson(args.config, "config"),
    health: args.health ? readJson(args.health, "health") : undefined,
    startMs, days: num("days", 1), seed: num("seed", 3101), name: args.name ?? "live-week", window: args.window ?? "1d",
  });
  writeFileSync(resolve(args.out), JSON.stringify(scenario, null, 2) + "\n");
  console.log(`${scenario.name} at ${scenario.capturedAt} -> ${args.out}`);
  for (const s of scenario.seats) {
    const d = details[s.id];
    const band = d.errorBand !== null ? ` +/-${(d.errorBand * 100).toFixed(1)}%` : "";
    console.log(`  ${s.id}: week ${(s.weeklyUtil * 100).toFixed(0)}% reset ${s.weeklyResetH} h (${d.startSource}, ${d.startAgeH} h old), cap ${(s.weeklyCap / 1e6).toFixed(0)}M (${d.capSource}, ${d.samples} pairs${band}), 5h cap ${(s.fiveHourCap / 1e6).toFixed(1)}M (${d.fiveCapSource})`);
  }
  const dm = scenario.demand;
  console.log(`  demand: ${Math.round(requestsPerDay)} req/day, ${dm.sessionsPerDay} sessions/day, requestChance ${dm.requestChance}, input ${dm.freshInput}, output ${dm.output}, prefix ${dm.prefix.start}+${dm.prefix.perRequest}/req`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`balance-capture: ${e.message}`); process.exit(1); }
}
