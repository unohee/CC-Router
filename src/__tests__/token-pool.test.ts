import { describe, it, expect, beforeEach } from "vitest";
import { TokenPool, EmptyPoolError, NoAvailableAccountError } from "../proxy/token-pool.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";
import { recordRateLimitCooldown } from "../proxy/model-cooldown.js";
import { SessionRouter } from "../proxy/session-router.js";

function makeAccount(id: string, healthy = true, busy = false): Account {
  return {
    id,
    tokens: {
      accessToken: `sk-ant-oat01-${id}`,
      refreshToken: `sk-ant-ort01-${id}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:profile"],
    },
    healthy,
    busy,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

describe("TokenPool — round-robin", () => {
  it("keeps Sonnet on its pin after Fable quota exhaustion and rotates only Fable", () => {
    const a = makeAccount("kyte");
    const b = makeAccount("other");
    const pool = new TokenPool([a, b]);
    const router = new SessionRouter();
    const targets = [a, b].map(a => ({provider: "anthropic" as const, accountId: a.id}));
    router.resolve("s", targets, t => pool.canServe(t.accountId, "claude-sonnet-4-6"));
    a.rateLimits.status = "rate_limited";
    expect(recordRateLimitCooldown(a, "claude-fable-5-1[1m]", "seven_day_overage_included", 3600)).toBe(true);
    expect(a.busy).toBe(false);
    expect(pool.canServe(a.id, "claude-sonnet-4-6")).toBe(true);
    expect(pool.canRetain(a.id, "claude-fable-5")).toBe(false);
    expect(router.resolve("s", targets, t => pool.canServe(t.accountId, "claude-sonnet-4-6"),
      undefined, t => pool.canRetain(t.accountId, "claude-sonnet-4-6"))?.accountId).toBe("kyte");
    expect(pool.getNext("claude-fable-5").id).toBe("other");
    expect(pool.getNext("claude-sonnet-4-6").id).toBe("kyte");
  });

  it("blocks all Fable requests without blocking Sonnet, then recovers at the deadline", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a]);
    recordRateLimitCooldown(a, "claude-fable-5", "seven_day_overage_included", 3600);
    expect(() => pool.getNext("claude-fable-5-1")).toThrow(NoAvailableAccountError);
    expect(pool.hasAvailableAccount("claude-fable-5")).toBe(false);
    expect(pool.hasAvailableAccount("claude-sonnet-4-6")).toBe(true);
    // A successful request to another model must not clear the Fable deadline.
    a.rateLimits = { ...DEFAULT_RATE_LIMITS };
    expect(pool.canServe("a", "claude-fable-5")).toBe(false);
    a.modelCooldowns!.fable = Date.now() - 1;
    expect(pool.getNext("claude-fable-5").id).toBe("a");
  });

  it("preserves account-wide limits even alongside model-specific failures", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a]);
    recordRateLimitCooldown(a, "claude-sonnet-4-6", "five_hour", 3600);
    recordRateLimitCooldown(a, "claude-fable-5", "seven_day_overage_included", 60);
    expect(pool.hasAvailableAccount("claude-sonnet-4-6")).toBe(false);
    expect(() => pool.getNext("claude-fable-5")).toThrow(NoAvailableAccountError);
  });
  it("cycles through all healthy accounts in order", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b"), makeAccount("c")]);
    const ids = Array.from({ length: 4 }, () => pool.getNext().id);
    expect(ids).toEqual(["a", "b", "c", "a"]);
  });

  it("wraps back to first account after the last", () => {
    const pool = new TokenPool([makeAccount("x"), makeAccount("y")]);
    expect(pool.getNext().id).toBe("x");
    expect(pool.getNext().id).toBe("y");
    expect(pool.getNext().id).toBe("x");
  });

  it("increments requestCount on every getNext()", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.getNext();
    pool.getNext();
    pool.getNext();
    expect(pool.getAll()[0].requestCount).toBe(3);
  });

  it("updates lastUsed timestamp on every getNext()", () => {
    const before = Date.now();
    const pool = new TokenPool([makeAccount("a")]);
    pool.getNext();
    expect(pool.getAll()[0].lastUsed).toBeGreaterThanOrEqual(before);
  });
});

describe("TokenPool — unhealthy accounts", () => {
  it("skips unhealthy accounts", () => {
    const pool = new TokenPool([
      makeAccount("a", false),
      makeAccount("b"),
      makeAccount("c"),
    ]);
    const ids = [pool.getNext().id, pool.getNext().id, pool.getNext().id];
    expect(ids).toEqual(["b", "c", "b"]);
  });

  it("returns first account when ALL are unhealthy (emergency fallback)", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b", false)]);
    expect(pool.getNext().id).toBe("a");
  });

  it("getHealthy() excludes unhealthy accounts", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b"), makeAccount("c")]);
    expect(pool.getHealthy().map(a => a.id)).toEqual(["b", "c"]);
  });
});

describe("TokenPool — busy accounts", () => {
  it("skips busy accounts in round-robin", () => {
    const pool = new TokenPool([makeAccount("a", true, true), makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
    expect(pool.getNext().id).toBe("b");
  });

  it("returns account with earliest reset when ALL healthy accounts are busy", () => {
    const a = makeAccount("a", true, true);
    const b = makeAccount("b", true, true);
    // Use future timestamps — past resets get swept to 0 before selection,
    // which would defeat the "earliest reset" comparison.
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourReset: nowSec + 7200 };
    b.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourReset: nowSec + 60 };
    const pool = new TokenPool([a, b]);
    expect(pool.getNext().id).toBe("b");
  });

  it("falls back to least-loaded of all when all are both busy AND unhealthy", () => {
    const a = makeAccount("a", false, true);
    const b = makeAccount("b", false, true);
    // All unhealthy → emergency path returns first account
    const pool = new TokenPool([a, b]);
    expect(pool.getNext().id).toBe("a");
  });

  it("does not bypass a cooldown when the only other account is capped", () => {
    const cooling = makeAccount("cooling");
    cooling.coolingUntil = Date.now() + 60_000;

    const capped = makeAccount("capped");
    capped.sessionLimitPercent = 50;
    capped.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourUtil: 0.6 };

    const pool = new TokenPool([cooling, capped]);
    expect(pool.getNext().id).toBe("capped");
  });

  it("fails fast instead of repeatedly sending to blocked keys", () => {
    const now = Date.now();
    const a = makeAccount("a");
    a.coolingUntil = now + 30_000;
    const b = makeAccount("b");
    b.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: Math.floor(now / 1000) + 90,
    };

    const pool = new TokenPool([a, b]);
    expect(() => pool.getNext()).toThrow(NoAvailableAccountError);
    try {
      pool.getNext();
    } catch (err) {
      expect(err).toBeInstanceOf(NoAvailableAccountError);
      expect((err as NoAvailableAccountError).retryAfterSeconds).toBeGreaterThanOrEqual(30);
      expect((err as NoAvailableAccountError).retryAfterSeconds).toBeLessThanOrEqual(90);
    }
    expect(a.requestCount).toBe(0);
    expect(b.requestCount).toBe(0);
  });
});

describe("TokenPool — stats", () => {
  it("getStats() returns one entry per account", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    pool.getNext(); // trigger one request
    const stats = pool.getStats();
    expect(stats).toHaveLength(2);
    expect(stats[0].id).toBe("a");
    expect(stats[0].requestCount).toBe(1);
    expect(typeof stats[0].expiresInMs).toBe("number");
  });

  it("getAll() returns all accounts including unhealthy", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b")]);
    expect(pool.getAll()).toHaveLength(2);
  });

  it("getStats() includes enabled and limit fields", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const s = pool.getStats()[0];
    expect(s.enabled).toBe(true);
    expect(s.sessionLimitPercent).toBe(100);
    expect(s.weeklyLimitPercent).toBe(100);
  });
});

describe("TokenPool — mutation API", () => {
  it("removeAccount mutates the original array in place (no reference desync)", () => {
    const accounts = [makeAccount("a"), makeAccount("b"), makeAccount("c")];
    const pool = new TokenPool(accounts);
    // The refresh loop captures `accounts` by reference — the array must
    // be mutated in place so the loop sees the removal.
    pool.removeAccount("b");
    expect(accounts).toHaveLength(2);
    expect(accounts.map(a => a.id)).toEqual(["a", "c"]);
    expect(pool.getAll()).toBe(accounts); // same reference
  });

  it("removeAccount returns false for unknown id", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.removeAccount("nope")).toBe(false);
    expect(pool.getAll()).toHaveLength(1);
  });

  it("addAccount appends to the original array", () => {
    const accounts = [makeAccount("a")];
    const pool = new TokenPool(accounts);
    const record: AccountRecord = {
      id: "b",
      accessToken: "sk-ant-oat01-b",
      refreshToken: "sk-ant-ort01-b",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    };
    pool.addAccount(record);
    expect(pool.getAll()).toHaveLength(2);
    expect(accounts).toHaveLength(2); // same reference
  });

  it("addAccount rejects duplicate ids", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const record: AccountRecord = {
      id: "a",
      accessToken: "x",
      refreshToken: "x",
      expiresAt: 0,
      scopes: [],
    };
    expect(() => pool.addAccount(record)).toThrow(/already exists/);
  });

  it("updateAccount patches enabled and limits", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.updateAccount("a", { enabled: false, weeklyLimitPercent: 42 });
    const a = pool.getAll()[0];
    expect(a.enabled).toBe(false);
    expect(a.weeklyLimitPercent).toBe(42);
    expect(a.sessionLimitPercent).toBe(100); // unchanged
  });

  it("updateAccount returns null for unknown id", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.updateAccount("nope", { enabled: false })).toBeNull();
  });

  it("getNext() throws EmptyPoolError when pool is empty", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.removeAccount("a");
    expect(() => pool.getNext()).toThrow(EmptyPoolError);
  });
});

describe("TokenPool — rate limit cooldown expiry", () => {
  it("auto-clears rate_limited status when the claimed reset window has passed", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 60;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    pool.getNext();
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("keeps rate_limited status when the claimed reset is still in the future", () => {
    const a = makeAccount("a");
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: futureSec,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // "a" is still capped → "b" should be used instead.
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.status).toBe("rate_limited");
  });

  it("returns a recovered account to rotation on the next getNext()", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "seven_day",
      sevenDayReset: pastSec,
    };
    const pool = new TokenPool([a, b]);
    // Round-robin across both accounts again after recovery.
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("fires onCooldownExpired when an account recovers", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    let recovered: Account | null = null;
    pool.onCooldownExpired = (acct) => { recovered = acct; };
    pool.getNext();
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe("a");
  });

  it("sweepExpiredCooldowns() clears status without selecting an account", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    const before = a.requestCount;
    pool.sweepExpiredCooldowns();
    expect(a.rateLimits.status).toBe("allowed");
    expect(a.requestCount).toBe(before); // sweep must not consume a turn
  });

  it("clears status when claim is empty and all known windows have expired", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "",
      fiveHourReset: pastSec,
      sevenDayReset: pastSec,
    };
    const pool = new TokenPool([a]);
    pool.getNext();
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("stays rate_limited when claim is empty but one window is still in the future", () => {
    const a = makeAccount("a");
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "",
      fiveHourReset: nowSec - 60,       // expired
      sevenDayReset: nowSec + 3600,     // still active
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // "a" is still limited by the 7-day window → pool skips it.
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.status).toBe("rate_limited");
    // But the 5h util should have been zeroed by the window rollover.
    expect(a.rateLimits.fiveHourUtil).toBe(0);
    expect(a.rateLimits.fiveHourReset).toBe(0);
  });
});

describe("TokenPool — user cap window rollover", () => {
  it("returns a capped account to rotation when its window resets", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    // Account was at 90% util (over the 80% cap) with a reset in the past.
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.9,
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // Before: "a" would be skipped as overUserCap. After sweep: util → 0
    // and "a" rejoins round-robin.
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(a.rateLimits.fiveHourUtil).toBe(0);
  });

  it("keeps a capped account out when the window has not reset yet", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.9,
      fiveHourReset: nowSec + 3600,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.fiveHourUtil).toBe(0.9); // unchanged
  });

  it("rolls over the 7-day window independently of the 5-hour window", () => {
    const a = makeAccount("a");
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.3,
      fiveHourReset: nowSec + 60,   // 5h still active
      sevenDayUtil: 0.99,
      sevenDayReset: nowSec - 1,    // 7d expired
    };
    const pool = new TokenPool([a]);
    pool.sweepExpiredCooldowns();
    expect(a.rateLimits.fiveHourUtil).toBe(0.3);       // untouched
    expect(a.rateLimits.fiveHourReset).toBe(nowSec + 60);
    expect(a.rateLimits.sevenDayUtil).toBe(0);         // rolled over
    expect(a.rateLimits.sevenDayReset).toBe(0);
  });
});

describe("TokenPool — user caps", () => {
  it("skips disabled accounts", () => {
    const a = makeAccount("a");
    a.enabled = false;
    const pool = new TokenPool([a, makeAccount("b")]);
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids).toEqual(["b", "b"]);
  });

  it("skips accounts over the weekly cap", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.55 }; // 55% > 50% cap
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
  });

  it("skips accounts over the session cap", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourUtil: 0.85 }; // 85% > 80% cap
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
  });

  it("falls back to capped account when ALL are over cap", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.6, fiveHourReset: 100 };
    const pool = new TokenPool([a]);
    // Should still return the account (advisory cap, not hard block)
    expect(pool.getNext().id).toBe("a");
  });

  it("fires onCapBypass when falling back to capped accounts", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.6, fiveHourReset: 100 };
    const pool = new TokenPool([a]);
    let bypassed: Account | null = null;
    pool.onCapBypass = (acct) => { bypassed = acct; };
    pool.getNext();
    expect(bypassed).not.toBeNull();
    expect(bypassed!.id).toBe("a");
  });
});

describe("TokenPool — hasAvailableAccount", () => {
  it("returns false for an empty pool without throwing", () => {
    const pool = new TokenPool([]);
    expect(() => pool.hasAvailableAccount()).not.toThrow();
    expect(pool.hasAvailableAccount()).toBe(false);
  });

  it("returns true when at least one account is healthy and idle", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    expect(pool.hasAvailableAccount()).toBe(true);
  });

  it("returns false when all accounts are busy", () => {
    const pool = new TokenPool([makeAccount("a", true, true), makeAccount("b", true, true)]);
    expect(pool.hasAvailableAccount()).toBe(false);
  });

  it("returns false when all accounts are rate_limited (reset still in the future)", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const limited = { ...DEFAULT_RATE_LIMITS, status: "rate_limited" as const, claim: "five_hour" as const, fiveHourReset: futureSec };
    a.rateLimits = { ...limited };
    b.rateLimits = { ...limited };
    const pool = new TokenPool([a, b]);
    expect(pool.hasAvailableAccount()).toBe(false);
  });

  it("returns false when all accounts are over their user-configured cap", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourUtil: 0.9 };
    const pool = new TokenPool([a]);
    expect(pool.hasAvailableAccount()).toBe(false);
  });

  it("returns true when only some accounts are unavailable (mixed)", () => {
    const busy = makeAccount("a", true, true);
    const nowSec = Math.floor(Date.now() / 1000);
    const limited = makeAccount("b");
    limited.rateLimits = { ...DEFAULT_RATE_LIMITS, status: "rate_limited", claim: "five_hour", fiveHourReset: nowSec + 3600 };
    const idle = makeAccount("c");
    const pool = new TokenPool([busy, limited, idle]);
    expect(pool.hasAvailableAccount()).toBe(true);
  });

  it("sweeps expired cooldowns before checking, same as getNext()", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, status: "rate_limited", claim: "five_hour", fiveHourReset: pastSec };
    const pool = new TokenPool([a]);
    expect(pool.hasAvailableAccount()).toBe(true);
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("never mutates requestCount, lastUsed, or round-robin position", () => {
    const accounts = [makeAccount("a"), makeAccount("b")];
    const pool = new TokenPool(accounts);
    pool.hasAvailableAccount();
    pool.hasAvailableAccount();
    pool.hasAvailableAccount();
    expect(accounts[0].requestCount).toBe(0);
    expect(accounts[0].lastUsed).toBe(0);
    // Round-robin cursor must be untouched — first getNext() still returns "a".
    expect(pool.getNext().id).toBe("a");
  });
});

describe("canServe / canRetain", () => {
  function poolWith(overrides: Partial<Account> = {}) {
    const account = {
      ...makeAccount("a"),
      ...overrides,
    } as Account;
    return { pool: new TokenPool([account]), account };
  }

  it("keeps a pinned account while a request is in flight, but will not place there", () => {
    // busy means "in flight", not "unusable". Dropping the pin over it rewrites
    // the whole conversation into another account's cache — while sending a NEW
    // session to a busy account is still the wrong choice.
    const { pool } = poolWith({ busy: true });

    expect(pool.canRetain("a")).toBe(true);
    expect(pool.canServe("a")).toBe(false);
  });

  it("drops a pinned account that is rate limited or unhealthy", () => {
    const limited = poolWith({
      // Reset in the future, or the cooldown sweep clears it before we look.
      rateLimits: {
        ...DEFAULT_RATE_LIMITS,
        status: "rate_limited",
        fiveHourReset: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    expect(limited.pool.canRetain("a")).toBe(false);

    const unhealthy = poolWith({ healthy: false });
    expect(unhealthy.pool.canRetain("a")).toBe(false);
  });

  it("respects a 429/529 cooldown even for a pinned session", () => {
    // The cooldown is expressed as busy + a timer, so retention has to
    // distinguish "upstream told us to stop" from "a request is in flight".
    const { pool } = poolWith({ busy: true, coolingUntil: Date.now() + 60_000 });

    expect(pool.canRetain("a")).toBe(false);
  });

  it("releases the pin once the cooldown deadline passes", () => {
    const { pool } = poolWith({ busy: true, coolingUntil: Date.now() - 1_000 });

    expect(pool.canRetain("a")).toBe(true);
  });

  it("knows nothing about an account it does not have", () => {
    const { pool } = poolWith();
    expect(pool.canServe("missing")).toBe(false);
    expect(pool.canRetain("missing")).toBe(false);
  });
});

describe("TokenPool — blockState", () => {
  it("reports no block while the pin can be retained", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a]);
    expect(pool.blockState("a")).toEqual({ kind: "none" });
  });

  it("reports an unknown account as indefinite rather than waitable", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.blockState("gone")).toEqual({ kind: "indefinite" });
  });

  it("reports a cooldown as temporary, with the seconds left on it", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a]);
    recordRateLimitCooldown(a, "claude-opus-5", "five_hour", 45);
    const block = pool.blockState("a", "claude-opus-5");
    expect(block.kind).toBe("temporary");
    if (block.kind !== "temporary") throw new Error("expected a temporary block");
    expect(block.retryAfterSeconds).toBeGreaterThan(40);
    expect(block.retryAfterSeconds).toBeLessThanOrEqual(45);
  });

  it("keeps a model-scoped cooldown off the families it does not cover", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a]);
    recordRateLimitCooldown(a, "claude-opus-5", "seven_day_opus", 3600);
    expect(pool.blockState("a", "claude-opus-5").kind).toBe("temporary");
    expect(pool.blockState("a", "claude-sonnet-4-6")).toEqual({ kind: "none" });
  });

  it("reports rate_limited with a known reset as temporary", () => {
    const a = makeAccount("a");
    a.rateLimits.status = "rate_limited";
    a.rateLimits.claim = "five_hour";
    a.rateLimits.fiveHourReset = Math.floor(Date.now() / 1000) + 30;
    const pool = new TokenPool([a]);
    const block = pool.blockState("a");
    expect(block.kind).toBe("temporary");
  });

  it("reports no block when a rate_limited flag has no window behind it", () => {
    // The sweep inside blockState returns such an account to rotation, because
    // a flag with no reset would otherwise strand it forever. So there is no
    // block left to classify — and consequently no "rate limited but waiting
    // for nothing" state for the migration policy to mishandle.
    const a = makeAccount("a");
    a.rateLimits.status = "rate_limited";
    const pool = new TokenPool([a]);
    expect(pool.blockState("a")).toEqual({ kind: "none" });
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("reports an unhealthy or disabled account as indefinite", () => {
    const unhealthy = makeAccount("u", false);
    const disabled = makeAccount("d");
    disabled.enabled = false;
    const pool = new TokenPool([unhealthy, disabled]);
    expect(pool.blockState("u")).toEqual({ kind: "indefinite" });
    expect(pool.blockState("d")).toEqual({ kind: "indefinite" });
  });

  it("reports an account over its user cap as indefinite", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 50;
    a.rateLimits.fiveHourUtil = 0.9;
    const pool = new TokenPool([a]);
    expect(pool.blockState("a")).toEqual({ kind: "indefinite" });
  });
});
