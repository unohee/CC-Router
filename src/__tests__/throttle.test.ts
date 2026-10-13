import { describe, expect, it } from "vitest";
import {
  DEFAULT_THROTTLE,
  admissionLimit,
  createThrottleGate,
  pacingIntervalMs,
} from "../proxy/throttle.js";
import type { ThrottleConfig, ThrottleGateDeps } from "../proxy/throttle.js";

/**
 * Deterministic clock for the gate: `sleep` records the requested ms and, when
 * that sleep fires, moves the fake clock to the deadline it was called with.
 * Time therefore stands still while synchronous code runs — exactly what the
 * gate needs to observe several reservations made in the same tick.
 */
function makeClock(start = 1_000, maxSleeps = 5_000) {
  let now = start;
  const sleeps: number[] = [];
  const deps: ThrottleGateDeps = {
    now: () => now,
    sleep: (ms: number) => {
      if (sleeps.length >= maxSleeps) {
        throw new Error(`fake sleep called ${maxSleeps} times — the gate never converged`);
      }
      sleeps.push(ms);
      const deadline = now + ms;
      return Promise.resolve().then(() => {
        now = Math.max(now, deadline);
      });
    },
  };
  return { deps, sleeps, time: () => now };
}

/** Baseline with the gate switched on, so no test leans on the shipped default alone. */
const GATE_ON: ThrottleConfig = { ...DEFAULT_THROTTLE, enabled: true };

describe("DEFAULT_THROTTLE", () => {
  it("ships the documented defaults with the gate disabled", () => {
    expect(DEFAULT_THROTTLE).toMatchObject({
      enabled: false,
      perAccountMaxInFlight: 4,
      startUtil: 0.75,
      hardUtil: 0.95,
      maxWaitMs: 20_000,
      pollMaxDelayMs: 250,
      minIntervalMs: 0,
      logSaturation: true,
    });
  });
});

/**
 * CANONICAL FORMULA — both pure functions below are defined by this block; keep
 * the tests and the implementation locked to it.
 *
 *   frac  = clamp((util - startUtil) / (hardUtil - startUtil), 0, 1)   // 0 when hardUtil <= startUtil
 *   admissionLimit    = L0 <= 0 ? +Infinity : max(1, round(L0 - frac * (L0 - 1)))
 *   pacingIntervalMs  = 0 when !enabled || minIntervalMs <= 0, else max(0, round(frac * minIntervalMs))
 */
describe("admissionLimit — util → per-account limit", () => {
  it("keeps the full per-account concurrency at or below the start util", () => {
    expect(admissionLimit(0.1, GATE_ON)).toBe(4);
    expect(admissionLimit(0.75, GATE_ON)).toBe(4);
  });

  it("scales the limit by the remaining headroom between start and hard util", () => {
    expect(admissionLimit(0.8, GATE_ON)).toBe(3);    // frac 0.25 → round(4 - 0.25 × 3) = round(3.25) = 3
    expect(admissionLimit(0.85, GATE_ON)).toBe(3);   // frac 0.5  → round(4 - 0.5  × 3) = round(2.5)  = 3
    expect(admissionLimit(0.9, GATE_ON)).toBe(2);    // frac 0.75 → round(4 - 0.75 × 3) = round(1.75) = 2
    // Math.round(2.5) === 3 is intended JS behaviour (half rounds up), not a bug to "fix".
  });

  it("rounds the ramp to the nearest whole slot and holds it at one", () => {
    const ramp = { ...GATE_ON, perAccountMaxInFlight: 3, startUtil: 0, hardUtil: 1 };
    expect(admissionLimit(0.1, ramp)).toBe(3);    // frac 0.1  → round(3 - 0.1  × 2) = 3 (top of the ramp)
    expect(admissionLimit(0.5, ramp)).toBe(2);    // frac 0.5  → round(3 - 0.5  × 2) = 2
    expect(admissionLimit(0.25, ramp)).toBe(3);   // frac 0.25 → round(3 - 0.25 × 2) = round(2.5) = 3
    expect(admissionLimit(0.9, ramp)).toBe(1);    // frac 0.9  → round(3 - 0.9  × 2) = 1
  });

  it("never drops the ramp below a single slot just under the hard util", () => {
    expect(admissionLimit(0.9499, GATE_ON)).toBe(1);
  });

  it("pins the limit to one slot at or above the hard util", () => {
    expect(admissionLimit(0.95, GATE_ON)).toBe(1);
    expect(admissionLimit(0.99, GATE_ON)).toBe(1);
    expect(admissionLimit(1, GATE_ON)).toBe(1);
  });

  it("turns the concurrency gate off when perAccountMaxInFlight is zero or negative", () => {
    expect(admissionLimit(0.5, { ...GATE_ON, perAccountMaxInFlight: 0 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(admissionLimit(0.99, { ...GATE_ON, perAccountMaxInFlight: 0 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(admissionLimit(0.99, { ...GATE_ON, perAccountMaxInFlight: -1 })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("clamps an infinite util to a bound of the ramp rather than returning nonsense", () => {
    expect(admissionLimit(Number.NEGATIVE_INFINITY, GATE_ON)).toBe(4);
    expect(admissionLimit(Number.POSITIVE_INFINITY, GATE_ON)).toBe(1);
  });

  it("keeps a NaN util inside the ramp bounds", () => {
    const limit = admissionLimit(Number.NaN, GATE_ON);
    expect(Number.isNaN(limit) || (limit >= 1 && limit <= 4)).toBe(true);
  });

  it("still returns a usable slot count when hardUtil collapses onto startUtil", () => {
    const collapsed = { ...GATE_ON, startUtil: 0.9, hardUtil: 0.9 };
    for (const util of [0.1, 0.9, 0.99, Number.POSITIVE_INFINITY]) {
      const limit = admissionLimit(util, collapsed);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(4);
    }
  });
});

describe("pacingIntervalMs — util → pacing interval", () => {
  it("paces nothing when the gate is disabled", () => {
    expect(pacingIntervalMs(0.99, { ...GATE_ON, enabled: false, minIntervalMs: 1_000 })).toBe(0);
  });

  it("paces nothing when minIntervalMs is zero", () => {
    expect(pacingIntervalMs(0.99, { ...GATE_ON, minIntervalMs: 0 })).toBe(0);
  });

  it("paces nothing at or below the start util", () => {
    expect(pacingIntervalMs(0.2, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(0);
    expect(pacingIntervalMs(0.75, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(0);
  });

  it("ramps the interval linearly between the start and hard util", () => {
    expect(pacingIntervalMs(0.76, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(50);
    expect(pacingIntervalMs(0.8, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(250);
    expect(pacingIntervalMs(0.85, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(500);
    expect(pacingIntervalMs(0.9, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(750);
  });

  it("rounds a sub-millisecond ramp down to no wait", () => {
    expect(pacingIntervalMs(0.7501, { ...GATE_ON, minIntervalMs: 100 })).toBe(0);
  });

  it("uses the full minIntervalMs at or above the hard util", () => {
    expect(pacingIntervalMs(0.95, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(1_000);
    expect(pacingIntervalMs(1, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(1_000);
    expect(pacingIntervalMs(Number.POSITIVE_INFINITY, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(
      1_000,
    );
  });

  it("never returns a negative interval", () => {
    expect(pacingIntervalMs(Number.NEGATIVE_INFINITY, { ...GATE_ON, minIntervalMs: 1_000 })).toBe(0);
    for (const util of [-1, 0, 0.5, 0.7501, 0.8, 0.94, 0.95, 1, 2]) {
      expect(pacingIntervalMs(util, { ...GATE_ON, minIntervalMs: 1_000 })).toBeGreaterThanOrEqual(
        0,
      );
    }
  });
});

describe("createThrottleGate — disabled gate", () => {
  it("admits immediately and touches no state when disabled", async () => {
    const clock = makeClock();
    const gate = createThrottleGate(
      { ...DEFAULT_THROTTLE, enabled: false, minIntervalMs: 1_000 },
      clock.deps,
    );

    await expect(gate.admit("a", 0.99)).resolves.toBeUndefined();

    expect(gate.inFlight("a")).toBe(0);
    expect(gate.inFlight("unknown")).toBe(0);
    expect(gate.snapshot()).toEqual({});
    expect(clock.sleeps).toEqual([]);
  });
});

describe("createThrottleGate — slots", () => {
  it("leaves slot accounting to acquire and release, not to admit", async () => {
    const clock = makeClock();
    const gate = createThrottleGate({ ...GATE_ON, minIntervalMs: 0 }, clock.deps);

    await gate.admit("a", 0.5);           // waiting for a slot is not taking one
    expect(gate.inFlight("a")).toBe(0);
    expect(gate.snapshot()).toEqual({});

    gate.acquire("a");
    expect(gate.inFlight("a")).toBe(1);
    expect(gate.snapshot()).toEqual({ a: 1 });

    gate.release("a");
    expect(gate.inFlight("a")).toBe(0);
    expect(gate.snapshot()).toEqual({});
  });

  it("reports acquire and release counts per account", () => {
    const gate = createThrottleGate(GATE_ON, makeClock().deps);

    gate.acquire("a");
    gate.acquire("a");
    gate.acquire("b");

    expect(gate.inFlight("a")).toBe(2);
    expect(gate.inFlight("b")).toBe(1);
    expect(gate.snapshot()).toEqual({ a: 2, b: 1 });

    gate.release("a");

    expect(gate.inFlight("a")).toBe(1);
    expect(gate.snapshot()).toEqual({ a: 1, b: 1 });
  });

  it("never lets a release drop an account below zero in flight", () => {
    const gate = createThrottleGate(GATE_ON, makeClock().deps);

    gate.acquire("a");
    gate.release("a");
    gate.release("a");      // repeated release must be harmless
    gate.release("ghost");  // and must not invent a negative count

    expect(gate.inFlight("a")).toBe(0);
    expect(gate.inFlight("ghost")).toBe(0);
    expect(Object.values(gate.snapshot()).every(count => count >= 0)).toBe(true);
  });

  it("does not let a saturated account delay admits on another account", async () => {
    const clock = makeClock();
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 1, minIntervalMs: 1_000 },
      clock.deps,
    );

    gate.acquire("a");                    // "a" has one slot and it is taken
    const before = clock.time();

    await gate.admit("b", 0.85);          // "b" is untouched, so nothing to wait for

    expect(clock.sleeps.filter(ms => ms > 0)).toEqual([]);
    expect(clock.time()).toBe(before);
    expect(gate.snapshot()).toEqual({ a: 1 });
  });
});

describe("createThrottleGate — pacing", () => {
  it("spaces two sequential admits on one account by the pacing interval", async () => {
    const clock = makeClock();
    const gate = createThrottleGate({ ...GATE_ON, minIntervalMs: 1_000 }, clock.deps);

    await gate.admit("a", 0.85);          // 0.85 util → 500 ms pacing interval
    const afterFirst = clock.time();
    await gate.admit("a", 0.85);

    expect(clock.sleeps.filter(ms => ms > 0)).toEqual([500]);
    expect(clock.time() - afterFirst).toBe(500);
  });

  it("reserves pacing synchronously so concurrent admits queue one interval apart", async () => {
    const clock = makeClock();
    // Concurrency gate off, so the only thing that can hold these calls up is pacing.
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 0, minIntervalMs: 1_000 },
      clock.deps,
    );
    const start = clock.time();

    const pending = [gate.admit("a", 0.85), gate.admit("a", 0.85), gate.admit("a", 0.85)];
    await Promise.all(pending);

    // Three admits at t=1_000, spaced 500 ms apart: waits of 500 and 1_000.
    expect(clock.sleeps.filter(ms => ms > 0)).toEqual([500, 1_000]);
    expect(clock.time()).toBe(start + 1_000);
  });
});

describe("createThrottleGate — maxWaitMs cap and fail-open", () => {
  it("caps a pacing wait at maxWaitMs instead of sleeping the whole interval", async () => {
    const clock = makeClock();
    // Concurrency gate off, so the wait under test is pacing alone.
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 0, minIntervalMs: 100_000, maxWaitMs: 20_000 },
      clock.deps,
    );

    await gate.admit("a", 0.99);          // the first admit owes no pacing wait
    const afterFirst = clock.time();
    expect(clock.sleeps.filter(ms => ms > 0)).toEqual([]);

    await gate.admit("a", 0.99);          // 100 s of pacing owed, capped at 20 s

    const waited = clock.time() - afterFirst;
    expect(waited).toBeGreaterThanOrEqual(19_750);
    expect(waited).toBeLessThanOrEqual(20_250);
    expect(clock.sleeps.every(ms => ms <= 20_000)).toBe(true);
  });

  it("stops polling for a slot as soon as the caller releases one", async () => {
    const clock = makeClock();
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 1, minIntervalMs: 0 },
      clock.deps,
    );

    gate.acquire("a");                    // the only slot is taken
    const before = clock.time();
    const pending = gate.admit("a", 0.5); // parks on the first poll
    expect(clock.sleeps).toEqual([250]);  // pollMaxDelayMs

    gate.release("a");
    await pending;

    expect(clock.time() - before).toBe(250);
    expect(clock.time() - before).toBeLessThan(GATE_ON.maxWaitMs);
    expect(gate.inFlight("a")).toBe(0);
  });

  it("admits anyway once maxWaitMs passes without a free slot", async () => {
    const clock = makeClock();
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 1, minIntervalMs: 0 },
      clock.deps,
    );

    gate.acquire("a");                    // the only slot stays taken for the whole wait
    const before = clock.time();

    await expect(gate.admit("a", 0.5)).resolves.toBeUndefined();

    const waited = clock.time() - before;
    expect(waited).toBeGreaterThanOrEqual(19_750);
    expect(waited).toBeLessThanOrEqual(20_250);
    expect(clock.sleeps.every(ms => ms <= 20_000)).toBe(true);
    expect(gate.inFlight("a")).toBeGreaterThanOrEqual(1);
  });

  it("never sleeps past the maxWaitMs budget in total while polling for a slot", async () => {
    const clock = makeClock();
    const gate = createThrottleGate(
      { ...GATE_ON, perAccountMaxInFlight: 1, minIntervalMs: 0 },
      clock.deps,
    );

    gate.acquire("a");                    // the only slot stays taken for the whole wait
    const before = clock.time();

    await expect(gate.admit("a", 0.5)).resolves.toBeUndefined();

    const totalSlept = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(totalSlept).toBeLessThanOrEqual(GATE_ON.maxWaitMs);
    expect(totalSlept).toBeGreaterThanOrEqual(19_750);    // the budget is actually spent
    expect(clock.time() - before).toBe(totalSlept);       // no waiting that skipped the fake clock
  });
});
