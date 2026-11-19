/**
 * A discrete-time simulator of the seat pool, minute by minute over days.
 *
 * It drives the router's own placement code: SessionRouter, TokenPool, the
 * seat predicates and metrics of seat-metrics.ts, and pinnedAnthropicAccount,
 * configured from a scenario's verbatim `routing` block through the router's
 * own config parsers. What it models instead of running:
 *
 * - **Upstream.** Each seat has a 7-day window (always open, fixed reset) and,
 *   unless it reports none, a 5-hour window that opens on first use. A request
 *   is refused (429) when either window is spent. The router learns a seat's
 *   utilization only from that seat's answers, rounded to 0.01 as the headers
 *   are, so an idle seat's reading goes stale exactly as in production.
 * - **The proxy around placement.** A session request resolves its pin, takes
 *   the pinned seat if the pool lets it keep it, else the pool's own pick; a
 *   refusal cools the seat until the exhausted window resets and fails over to
 *   the coolest untried seat (seats.failoverPick). A request without a session
 *   id goes to TokenPool.getNext(). Not modelled: the hold-on-cooldown answer
 *   (session-migration.ts) holds a large session only for a cooldown of at
 *   most 60 s, and every cooldown here lasts until a window resets, so it
 *   would always proceed; OpenAI targets, which the live pool does not use.
 * - **The admission throttle**, when a scenario sets `throttle`: each seat
 *   serves at most `perAccountMaxInFlight` requests at once, each holding a
 *   slot for `serviceSeconds`, so a minute has a fixed number of slots per
 *   seat. Requests past that wait (first come first served), up to
 *   `maxWaitSeconds`, then go anyway as the live gate does. The wait is a
 *   reported cost (`queueWait`); it changes no token count, so the frozen
 *   scenarios, which set no `throttle`, score exactly as before.
 * - **Clients.** Sessions arrive by an hourly profile, live for a while, send a
 *   request in a minute with some chance, and grow a prompt prefix that sits in
 *   one seat's cache. Served elsewhere, the prefix is re-written there.
 *
 * Deterministic: a seeded generator and an injected clock. TokenPool reads
 * Date.now(), so the caller passes `setClock` (vi.setSystemTime under fake
 * timers); SessionRouter takes the same clock directly.
 */
import { SessionRouter, type SessionTarget, type ReassignReason } from "../../proxy/session-router.js";
import { TokenPool, NoAvailableAccountError, EmptyPoolError } from "../../proxy/token-pool.js";
import { createSeats, pinnedAnthropicAccount, type Seats } from "../../proxy/seat-metrics.js";
import { parseBalanceRules, parseCapacityWeights, parseSoftCapUtil, parseWeeklyPace } from "../../config/manager.js";
import { QuotaHistory } from "../../proxy/quota-history.js";
import { seatSizes, type SeatSize } from "../../proxy/seat-size.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../../proxy/types.js";
import type { SeatSpec } from "./scenarios.js";
import type { Scenario2 } from "./scenarios-2.js";
import type { RunMetrics } from "./score.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** Simulated runs start here (a Monday, 00:00 UTC), so hour-of-day profiles line up. */
export const SIM_EPOCH = Date.UTC(2026, 10, 16, 0, 0);

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Poisson draw by inversion; fine for the small means used here. */
function poisson(mean: number, rand: () => number): number {
  if (mean <= 0) return 0;
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do { k++; p *= rand(); } while (p > l);
  return k - 1;
}

/** The true state of one seat, which only upstream knows. */
interface SeatState {
  spec: SeatSpec;
  spentWeek: number;
  weekResetAt: number;
  spentFive: number;
  /** 0 while no 5-hour window is open. */
  fiveResetAt: number;
}

interface Session {
  id: string;
  endsAt: number;
  requests: number;
  /** Prompt prefix size, tokens. */
  prefix: number;
  /** The seat holding this session's prompt cache, if any. */
  cacheSeat: string | null;
}

export interface SimOptions {
  /** Set the wall clock TokenPool reads (vi.setSystemTime). */
  setClock: (ms: number) => void;
}

export interface SimResult {
  metrics: RunMetrics;
  /** Seconds requests waited in the admission queue, per seat (0 without `throttle`). */
  queueWaitBySeat: Record<string, number>;
  /** Requests that waited at all, and that hit the cap and went anyway. */
  queued: number;
  queueCapped: number;
  /** Pin moves the router reported, by reason. */
  reassigned: Record<ReassignReason, number>;
  /** Sessions that got their first pin. */
  placed: number;
  /** Cost-weighted tokens each seat served. */
  servedBySeat: Record<string, number>;
  /** Each seat's 7-day utilization at every reset inside the run. */
  utilAtReset: Record<string, number[]>;
}

function round2(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
}

function makeAccount(id: string): Account {
  return {
    id,
    tokens: { accessToken: `sim-${id}`, refreshToken: "sim", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0,
    consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true,
    sessionLimitPercent: 100, weeklyLimitPercent: 100,
  };
}

/** What the response headers would tell the router about a seat right now. */
function reading(s: SeatState, now: number, status: "allowed" | "rate_limited", claim: string): Account["rateLimits"] {
  const five = s.spec.fiveHourCap > 0 && s.fiveResetAt > now;
  return {
    ...DEFAULT_RATE_LIMITS,
    status,
    fiveHourUtil: five ? round2(s.spentFive / s.spec.fiveHourCap) : 0,
    fiveHourReset: five ? Math.floor(s.fiveResetAt / 1000) : 0,
    sevenDayUtil: round2(s.spentWeek / s.spec.weeklyCap),
    sevenDayReset: Math.floor(s.weekResetAt / 1000),
    claim,
    lastUpdated: now,
  };
}

export function simulate(sc: Scenario2, opts: SimOptions): SimResult {
  const rand = rng(sc.seed);
  let now = SIM_EPOCH;
  opts.setClock(now);

  const states = new Map<string, SeatState>();
  const accounts: Account[] = [];
  for (const spec of sc.seats) {
    const fiveOpen = spec.fiveHourCap > 0 && spec.fiveHourResetMin !== undefined;
    const st: SeatState = {
      spec,
      spentWeek: spec.weeklyUtil * spec.weeklyCap,
      weekResetAt: now + spec.weeklyResetH * HOUR_MS,
      spentFive: fiveOpen ? (spec.fiveHourUtil ?? 0) * spec.fiveHourCap : 0,
      fiveResetAt: fiveOpen ? now + spec.fiveHourResetMin! * MIN_MS : 0,
    };
    states.set(spec.id, st);
    const a = makeAccount(spec.id);
    // At the start the router has read every seat recently.
    a.rateLimits = reading(st, now, "allowed", "five_hour");
    accounts.push(a);
  }

  // The router's quota history, fed as the proxy feeds it: spend on every
  // billed response, a reading per seat per hour. A pool whose history is
  // available starts with the last eight hours of it (each seat's weekly
  // utilization climbing a point an hour at its true size); one without starts
  // empty, so seat sizes must be learnt during the run.
  const quota = new QuotaHistory({ now: () => now });
  const toInput = (r: Account["rateLimits"]) => ({
    fiveHourUtil: r.fiveHourUtil, fiveHourReset: r.fiveHourReset, sevenDayUtil: r.sevenDayUtil, sevenDayReset: r.sevenDayReset,
  });
  if (sc.historyAvailable) {
    for (const a of accounts) {
      const st = states.get(a.id)!;
      let prev: number | null = null;
      for (let k = 8; k >= 0; k--) {
        const util = Math.max(0, Math.round((st.spec.weeklyUtil - 0.01 * k) * 100) / 100);
        // Spend only what moved the window: a seat at 0% had no past hours to bill.
        if (prev !== null && util > prev) quota.addSpend(a.id, (util - prev) * st.spec.weeklyCap);
        quota.sample(a.id, { ...toInput(a.rateLimits), sevenDayUtil: util }, now - k * HOUR_MS);
        prev = util;
      }
    }
  }
  const weights = parseCapacityWeights(sc.routing as never);
  let sizeMemo: { hour: number; sizes: Map<string, SeatSize> } | null = null;
  const sizeOf = (id: string): number => {
    const hour = Math.floor(now / HOUR_MS);
    if (!sizeMemo || sizeMemo.hour !== hour) {
      sizeMemo = { hour, sizes: seatSizes(accounts.map(a => a.id), quota.readings(), now, weights) };
    }
    return sizeMemo.sizes.get(id)?.relative ?? 1;
  };

  const pool = new TokenPool(accounts);
  const reassigned: Record<ReassignReason, number> = { unservable: 0, "soft-cap": 0, "weekly-pace": 0 };
  const router = new SessionRouter({
    now: () => now,
    softCapUtil: parseSoftCapUtil(sc.routing as never),
    weeklyPace: parseWeeklyPace(sc.routing as never),
    balance: parseBalanceRules(sc.routing as never),
    onReassign: ({ reason }) => { reassigned[reason]++; },
  });
  // As server.ts wires them: the failover pick and the no-session pick rank
  // through the router when the balance rules are on.
  const seats: Seats = createSeats({
    pool, openAIAccounts: [], canServeOpenAI: () => false, sizeOf,
    rank: (c, usable, utilOf, mode) => router.rank(c, usable, utilOf, mode),
  });
  const candidates: SessionTarget[] = accounts.map(a => ({ provider: "anthropic", accountId: a.id }));

  const m: RunMetrics = { unusedAtReset: 0, shortfallAtEnd: 0, dry: 0, moveCost: 0, demand: 0, refusals: 0, moves: 0, strandedMinutes: 0 };
  const servedBySeat: Record<string, number> = Object.fromEntries(sc.seats.map(s => [s.id, 0]));
  const queueWaitBySeat: Record<string, number> = Object.fromEntries(sc.seats.map(s => [s.id, 0]));
  let queued = 0, queueCapped = 0;
  // Admission throttle: requests a seat was given this minute, reset each tick.
  const thr = sc.throttle;
  const slotsPerMinute = thr ? Math.max(1, Math.floor(thr.perAccountMaxInFlight * 60 / thr.serviceSeconds)) : Infinity;
  const givenThisMinute: Record<string, number> = Object.fromEntries(sc.seats.map(s => [s.id, 0]));
  /** Charge the queue wait a request on `seat` pays this minute, as the live gate would. */
  const admit = (seat: string): void => {
    if (!thr) return;
    const n = givenThisMinute[seat]++;
    if (n < slotsPerMinute) return;
    // The (n - slots)th overflow request waits for that many service times
    // across the seat's slots, capped like the live gate (then it goes anyway).
    const wait = Math.min(thr.maxWaitSeconds, (n - slotsPerMinute + 1) * thr.serviceSeconds / thr.perAccountMaxInFlight);
    queueWaitBySeat[seat] += wait;
    queued++;
    if (wait >= thr.maxWaitSeconds) queueCapped++;
  };
  const utilAtReset: Record<string, number[]> = Object.fromEntries(sc.seats.map(s => [s.id, [] as number[]]));
  let placed = 0;
  let nextSession = 0;
  const sessions: Session[] = [];

  const newSession = (prefix = sc.demand.prefix.start, cacheSeat: string | null = null): Session => {
    const [lo, hi] = sc.demand.sessionMinutes;
    const s: Session = {
      id: `sim-${sc.seed}-${nextSession++}`,
      endsAt: now + Math.round(lo + rand() * (hi - lo)) * MIN_MS,
      requests: 0, prefix, cacheSeat,
    };
    sessions.push(s);
    return s;
  };

  // Restored pins: sessions already pinned, with their cache on that seat.
  const restored = sc.events?.restoredPins;
  if (restored) {
    const entries = [];
    for (const [seat, count] of Object.entries(restored.perSeat)) {
      for (let i = 0; i < count; i++) {
        const s = newSession(restored.prefix, seat);
        entries.push({ sessionId: s.id, provider: "anthropic" as const, accountId: seat, lastSeen: now });
      }
    }
    router.restore(entries);
  }

  /** Upstream: serve `cost` on a seat, or refuse when a window is spent. */
  const upstream = (a: Account, cost: number): boolean => {
    const s = states.get(a.id)!;
    const fiveSpent = s.spec.fiveHourCap > 0 && s.fiveResetAt > now && s.spentFive >= s.spec.fiveHourCap;
    const weekSpent = s.spentWeek >= s.spec.weeklyCap;
    if (fiveSpent || weekSpent) {
      m.refusals++;
      // The 429 carries the readings, and the router cools the seat until the
      // exhausted window resets (the longer one when both are spent).
      const until = weekSpent ? s.weekResetAt : s.fiveResetAt;
      a.rateLimits = reading(s, now, "allowed", weekSpent ? "seven_day" : "five_hour");
      a.coolingUntil = Math.max(a.coolingUntil ?? 0, until);
      quota.sample(a.id, toInput(a.rateLimits), now);
      return false;
    }
    if (s.spec.fiveHourCap > 0 && s.fiveResetAt <= now) { s.fiveResetAt = now + FIVE_HOURS_MS; s.spentFive = 0; }
    admit(a.id);
    s.spentWeek += cost;
    if (s.spec.fiveHourCap > 0) s.spentFive += cost;
    servedBySeat[a.id] += cost;
    a.rateLimits = reading(s, now, "allowed", "five_hour");
    quota.addSpend(a.id, cost);
    quota.sample(a.id, toInput(a.rateLimits), now);
    return true;
  };

  /** Send to `first`, failing over across the pool on a refusal. Returns the
   *  seat that answered. A session follows the seat failover served it from
   *  (server.ts does the same with SessionRouter.pinTo). */
  const send = (first: Account | null, costOn: (seat: string) => number, sessionId?: string): string | null => {
    const tried = new Set<string>();
    let a = first;
    while (a) {
      tried.add(a.id);
      if (upstream(a, costOn(a.id))) {
        if (sessionId && tried.size > 1) { router.pinTo(sessionId, { provider: "anthropic", accountId: a.id }); reassigned.unservable++; }
        return a.id;
      }
      a = seats.failoverPick(tried, undefined);
    }
    return null;
  };

  /** The seat for a request with no pin, as the /v1 handler picks it. */
  const getNext = (): Account | null => {
    const ranked = seats.pickForRequest(undefined);
    if (ranked) { ranked.requestCount++; ranked.lastUsed = now; return ranked; }
    try { return pool.getNext(); } catch (e) {
      if (e instanceof NoAvailableAccountError || e instanceof EmptyPoolError) return null;
      throw e;
    }
  };

  const sessionRequest = (s: Session): void => {
    const d = sc.demand;
    const base = s.prefix * 0.1 + d.freshInput * 1.25 + d.output * 5;
    m.demand += base;
    const before = router.peek(s.id);
    const target = router.resolve(s.id, candidates, t => seats.usable(t), seats.metrics, t => seats.retainable(t));
    if (!before && target) placed++;
    const first = pinnedAnthropicAccount(pool, target ?? undefined) ?? getNext();
    // A seat without this session's cache re-writes the whole prefix first.
    const rewrite = s.prefix * 1.25;
    const costOn = (seat: string) => (s.cacheSeat === null || s.cacheSeat === seat ? base : base + rewrite);
    const served = send(first, costOn, s.id);
    if (!served) { m.dry += base; return; }
    if (s.cacheSeat !== null && s.cacheSeat !== served) { m.moves++; m.moveCost += rewrite; }
    s.cacheSeat = served;
    s.requests++;
    // Grows from its own size: a restored session keeps the prefix it came with.
    s.prefix = Math.min(Math.max(d.prefix.max, s.prefix), s.prefix + d.prefix.perRequest);
  };

  const plainRequest = (): void => {
    const cost = sc.demand.noSessionCost;
    m.demand += cost;
    if (!send(getNext(), () => cost)) m.dry += cost;
  };

  /** Windows roll over upstream; a weekly reset scores what was left. */
  const rollWindows = (): void => {
    for (const s of states.values()) {
      while (s.weekResetAt <= now) {
        const util = Math.min(1, s.spentWeek / s.spec.weeklyCap);
        utilAtReset[s.spec.id].push(Math.round(util * 1000) / 1000);
        m.unusedAtReset += Math.max(0, s.spec.weeklyCap - s.spentWeek);
        s.spentWeek = 0;
        s.weekResetAt += WEEK_MS;
      }
      if (s.fiveResetAt > 0 && s.fiveResetAt <= now) { s.fiveResetAt = 0; s.spentFive = 0; }
    }
  };

  const profileSum = sc.demand.profile.reduce((x, y) => x + y, 0);
  const end = SIM_EPOCH + sc.days * 24 * HOUR_MS;
  const burst = sc.events?.burst;
  const wipeAt = sc.events?.wipeReadingsAtH;
  const noSessionRatio = sc.demand.noSessionShare / Math.max(1e-9, 1 - sc.demand.noSessionShare);

  for (; now < end; now += MIN_MS) {
    opts.setClock(now);
    for (const id in givenThisMinute) givenThisMinute[id] = 0;

    rollWindows();

    const elapsedH = (now - SIM_EPOCH) / HOUR_MS;
    if (wipeAt !== undefined && elapsedH === wipeAt) {
      for (const a of accounts) { a.rateLimits = { ...DEFAULT_RATE_LIMITS }; a.coolingUntil = undefined; }
    }

    // Stranded: a seat that cannot serve while another still has a fifth of its week.
    const spent = [...states.values()].map(s =>
      s.spentWeek >= s.spec.weeklyCap || (s.spec.fiveHourCap > 0 && s.fiveResetAt > now && s.spentFive >= s.spec.fiveHourCap));
    const roomy = [...states.values()].some((s, i) => !spent[i] && s.spentWeek <= 0.8 * s.spec.weeklyCap);
    if (roomy && spent.some(Boolean)) m.strandedMinutes++;

    // Arrivals.
    const hourOfDay = Math.floor(((now - SIM_EPOCH) % (24 * HOUR_MS)) / HOUR_MS);
    const perMinute = sc.demand.sessionsPerDay * (sc.demand.profile[hourOfDay] / profileSum) / 60;
    for (let k = poisson(perMinute, rand); k > 0; k--) newSession();
    if (burst && elapsedH >= burst.atH && elapsedH < burst.atH + burst.withinMin / 60) {
      for (let k = Math.round(burst.sessions / burst.withinMin); k > 0; k--) newSession();
    }

    // Requests, in session order; finished sessions leave.
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.endsAt <= now) { sessions.splice(i--, 1); continue; }
      if (rand() >= sc.demand.requestChance) continue;
      sessionRequest(s);
      if (rand() < noSessionRatio) plainRequest();
    }
  }

  // The end of the run: a reset due exactly now is scored as a reset, and a
  // window still open is charged for falling behind an even spend. A window
  // `e` of the way through should have spent at least `e` of its quota; what
  // it is short of that is quota on course to be lost. Without this, a policy
  // could hide leftover quota in windows that reset after the run ends.
  now = end;
  opts.setClock(now);
  rollWindows();
  for (const s of states.values()) {
    const elapsed = Math.min(1, Math.max(0, 1 - (s.weekResetAt - now) / WEEK_MS));
    m.shortfallAtEnd += Math.max(0, elapsed * s.spec.weeklyCap - s.spentWeek);
  }

  return { metrics: m, queueWaitBySeat, queued, queueCapped, reassigned, placed, servedBySeat, utilAtReset };
}
