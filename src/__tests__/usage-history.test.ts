import { describe, it, expect } from "vitest";
import {
  UsageHistory, sanitizeModel, openAISample, HOUR_MS, DAY_MS, RETENTION_DAYS, UNKNOWN_MODEL, OTHER_MODEL,
} from "../proxy/usage-history.js";

const NOW = Date.UTC(2026, 9, 16, 12, 30); // 2026-10-16 12:30Z
const HOUR = Date.UTC(2026, 9, 16, 12);

function store(opts: { now?: number; maxModels?: number } = {}) {
  const clock = { t: opts.now ?? NOW };
  const h = new UsageHistory({ now: () => clock.t, maxModels: opts.maxModels });
  return { h, clock };
}

describe("sanitizeModel", () => {
  it("keeps an ordinary name and trims it", () => {
    expect(sanitizeModel("  claude-sonnet-5-5 ")).toBe("claude-sonnet-5-5");
  });

  it("maps anything that is not a usable string to unknown", () => {
    for (const bad of [undefined, null, 7, {}, [], () => "x", Symbol("s"), "", "   ", "-"]) {
      expect(sanitizeModel(bad)).toBe(UNKNOWN_MODEL);
    }
  });

  it("makes control characters and non-ASCII printable, and bounds the length", () => {
    expect(sanitizeModel("a\u0000b\nc")).toBe("a?b?c");
    expect(sanitizeModel("x".repeat(500))).toHaveLength(80);
  });
});

describe("UsageHistory.record", () => {
  it("adds the input half and the output half of one request into one bucket", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: 10, cacheRead: 100, cacheCreation: 5, request: true });
    h.record({ ts: NOW, provider: "anthropic", model: "m", output: 7 });
    expect(h.buckets()).toEqual([{
      hour: HOUR, provider: "anthropic", model: "m", input: 10, output: 7, cacheRead: 100, cacheCreation: 5, requests: 1,
    }]);
  });

  it("separates hours, providers and models", () => {
    const { h, clock } = store({ now: HOUR + 2 * HOUR_MS });
    h.record({ ts: HOUR + HOUR_MS - 1, provider: "anthropic", model: "m", input: 1, request: true });
    h.record({ ts: HOUR + HOUR_MS, provider: "anthropic", model: "m", input: 1, request: true });
    h.record({ ts: HOUR, provider: "openai", model: "m", input: 1, request: true });
    h.record({ ts: HOUR, provider: "anthropic", model: "other-model", input: 1, request: true });
    expect(h.buckets()).toHaveLength(4);
    expect(clock.t).toBeGreaterThan(HOUR);
  });

  it("leaves nothing behind for a response whose usage was never read", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m" });
    expect(h.buckets()).toEqual([]);
    expect(h.since).toBeNull();
    expect(h.dirty).toBe(false);
  });

  it("still counts a request that carried no tokens, as a request with zero tokens", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m", request: true });
    expect(h.buckets()[0]).toMatchObject({ requests: 1, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it("treats a provided 0 as a measurement, not as missing", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m", output: 0 });
    expect(h.buckets()).toHaveLength(1);
    expect(h.since).toBe(NOW);
  });

  it("counts bad numbers as 0 and floors fractions", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: NaN, output: -5, cacheRead: Infinity, cacheCreation: 3.9, request: true });
    expect(h.buckets()[0]).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheCreation: 3 });
  });

  it("ignores a provider that is not one of the two it knows", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "bogus" as never, model: "m", input: 1, request: true });
    expect(h.buckets()).toEqual([]);
  });

  it("clamps a timestamp into the retention window, so a clock jump cannot make future or ancient buckets", () => {
    const { h } = store();
    h.record({ ts: NOW + 5 * DAY_MS, provider: "anthropic", model: "future", input: 1, request: true });
    h.record({ ts: NOW - 400 * DAY_MS, provider: "anthropic", model: "ancient", input: 1, request: true });
    h.record({ ts: NaN, provider: "anthropic", model: "nan", input: 1, request: true });
    const byModel = Object.fromEntries(h.buckets().map(b => [b.model, b.hour]));
    expect(byModel["future"]).toBe(HOUR);
    expect(byModel["nan"]).toBe(HOUR);
    expect(byModel["ancient"]).toBe(Math.floor((NOW - RETENTION_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS);
  });

  it("remembers the earliest instant it ever recorded, and never moves it later", () => {
    const { h } = store();
    h.record({ ts: NOW - HOUR_MS, provider: "anthropic", model: "m", input: 1 });
    expect(h.since).toBe(NOW - HOUR_MS);
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: 1 });
    expect(h.since).toBe(NOW - HOUR_MS);
    h.record({ ts: NOW - 3 * HOUR_MS, provider: "anthropic", model: "m", input: 1 });
    expect(h.since).toBe(NOW - 3 * HOUR_MS);
  });

  it("returns copies, so a caller cannot edit the store through buckets()", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: 1 });
    h.buckets()[0].input = 999;
    expect(h.buckets()[0].input).toBe(1);
  });
});

describe("model names from the outside", () => {
  it("stores hostile names as inert text without touching Object.prototype", () => {
    const { h } = store();
    for (const model of ["__proto__", "constructor", "toString", "<img src=x onerror=alert(1)>"]) {
      h.record({ ts: NOW, provider: "anthropic", model, input: 1, request: true });
    }
    expect(h.buckets().map(b => b.model).sort()).toEqual(["<img src=x onerror=alert(1)>", "__proto__", "constructor", "toString"]);
    expect(({} as Record<string, unknown>)["input"]).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("files a function or object where a name belongs under unknown", () => {
    const { h } = store();
    h.record({ ts: NOW, provider: "anthropic", model: function constructor() { /* noop */ }, input: 1, request: true });
    h.record({ ts: NOW, provider: "anthropic", model: { a: 1 }, input: 1, request: true });
    expect(h.buckets().map(b => b.model)).toEqual([UNKNOWN_MODEL]);
    expect(h.buckets()[0].requests).toBe(2);
  });

  it("folds names past the cap into other, but keeps feeding the ones it already knew", () => {
    const { h } = store({ maxModels: 2 });
    for (const model of ["a", "b", "c", "d"]) h.record({ ts: NOW, provider: "anthropic", model, input: 1, request: true });
    h.record({ ts: NOW, provider: "anthropic", model: "a", input: 1, request: true });
    const by = Object.fromEntries(h.buckets().map(b => [b.model, b.input]));
    expect(by).toEqual({ a: 2, b: 1, [OTHER_MODEL]: 2 });
  });

  it("does not spend the cap on unknown or other", () => {
    const { h } = store({ maxModels: 2 });
    h.record({ ts: NOW, provider: "anthropic", model: undefined, input: 1, request: true });
    h.record({ ts: NOW, provider: "anthropic", model: "a", input: 1, request: true });
    h.record({ ts: NOW, provider: "anthropic", model: "b", input: 1, request: true });
    expect(h.buckets().map(b => b.model).sort()).toEqual(["a", "b", UNKNOWN_MODEL]);
  });
});

describe("retention", () => {
  it("drops aged-out buckets once time moves on, but keeps `since`", () => {
    const { h, clock } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "old", input: 1, request: true });
    clock.t = NOW + (RETENTION_DAYS + 1) * DAY_MS;
    h.record({ ts: clock.t, provider: "anthropic", model: "new", input: 1, request: true });
    expect(h.buckets().map(b => b.model)).toEqual(["new"]);
    expect(h.since).toBe(NOW);
  });

  it("marks itself dirty when pruning removed something", () => {
    const { h, clock } = store();
    h.record({ ts: NOW, provider: "anthropic", model: "old", input: 1, request: true });
    h.markClean();
    clock.t = NOW + (RETENTION_DAYS + 1) * DAY_MS;
    expect(h.prune()).toBe(1);
    expect(h.dirty).toBe(true);
  });

  it("frees the model cap when the buckets using a name age out", () => {
    const { h, clock } = store({ maxModels: 1 });
    h.record({ ts: NOW, provider: "anthropic", model: "a", input: 1, request: true });
    clock.t = NOW + (RETENTION_DAYS + 1) * DAY_MS;
    h.prune();
    h.record({ ts: clock.t, provider: "anthropic", model: "b", input: 1, request: true });
    expect(h.buckets().map(b => b.model)).toEqual(["b"]);
  });
});

describe("dirty / markClean", () => {
  it("is dirty after a record, clean after markClean, dirty again after the next record", () => {
    const { h } = store();
    expect(h.dirty).toBe(false);
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: 1 });
    expect(h.dirty).toBe(true);
    h.markClean();
    expect(h.dirty).toBe(false);
    h.record({ ts: NOW, provider: "anthropic", model: "m", input: 1 });
    expect(h.dirty).toBe(true);
  });
});

describe("toFile / restore", () => {
  it("round-trips everything, including `since`", () => {
    const a = store().h;
    a.record({ ts: NOW - 2 * HOUR_MS, provider: "anthropic", model: "m", input: 1, output: 2, cacheRead: 3, cacheCreation: 4, request: true });
    a.record({ ts: NOW, provider: "openai", model: "gpt", input: 5, output: 6, request: true });
    const b = store().h;
    expect(b.restore(JSON.parse(JSON.stringify(a.toFile())))).toBe(true);
    expect(b.buckets()).toEqual(a.buckets());
    expect(b.since).toBe(a.since);
    expect(b.dirty).toBe(false);
  });

  it("writes rows in a stable order so unchanged data produces an unchanged file", () => {
    const a = store().h;
    a.record({ ts: NOW, provider: "openai", model: "z", input: 1 });
    a.record({ ts: NOW - HOUR_MS, provider: "anthropic", model: "b", input: 1 });
    a.record({ ts: NOW, provider: "anthropic", model: "a", input: 1 });
    expect(a.toFile().rows.map(r => `${r[0]}|${r[1]}|${r[2]}`)).toEqual([
      `${(HOUR - HOUR_MS) / 1000}|anthropic|b`, `${HOUR / 1000}|anthropic|a`, `${HOUR / 1000}|openai|z`,
    ]);
  });

  it("does not forget samples that were recorded before the restore and are not saved yet", () => {
    const saved = store().h;
    saved.record({ ts: NOW, provider: "anthropic", model: "m", input: 1 });
    const h = store().h;
    h.record({ ts: NOW, provider: "anthropic", model: "later", input: 1 });
    expect(h.dirty).toBe(true);
    h.restore(saved.toFile());
    expect(h.dirty).toBe(true);
    expect(h.buckets()).toHaveLength(2);
  });

  it("adds a restored file onto what is already there rather than replacing it", () => {
    const a = store().h;
    a.record({ ts: NOW, provider: "anthropic", model: "m", input: 10, request: true });
    const b = store().h;
    b.record({ ts: NOW, provider: "anthropic", model: "m", input: 1, request: true });
    b.restore(a.toFile());
    expect(b.buckets()[0]).toMatchObject({ input: 11, requests: 2 });
  });

  it("refuses something that is not a usage file, and takes nothing from it", () => {
    for (const junk of [null, undefined, 5, "x", [], {}, { version: 2, rows: [] }, { version: 1 }, { version: 1, rows: "x" }]) {
      const { h } = store();
      expect(h.restore(junk)).toBe(false);
      expect(h.buckets()).toEqual([]);
    }
  });

  it("skips a malformed row but keeps the good ones", () => {
    const { h } = store();
    const ok = [HOUR / 1000, "anthropic", "m", 1, 2, 3, 4, 1];
    expect(h.restore({
      version: 1, since: NOW,
      rows: [ok, null, [1, 2, 3], ["x", "anthropic", "m", 1, 1, 1, 1, 1], [HOUR / 1000, "bogus", "m", 1, 1, 1, 1, 1], "row"],
    })).toBe(true);
    expect(h.buckets()).toHaveLength(1);
    expect(h.buckets()[0]).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4, requests: 1 });
  });

  it("sanitises model names and caps arriving from a file just as it does for live samples", () => {
    const { h } = store({ maxModels: 1 });
    h.restore({
      version: 1, since: null,
      rows: [[HOUR / 1000, "anthropic", "a", 1, 0, 0, 0, 1], [HOUR / 1000, "anthropic", "b", 1, 0, 0, 0, 1], [HOUR / 1000, "anthropic", 42, 1, 0, 0, 0, 1]],
    });
    expect(h.buckets().map(b => b.model).sort()).toEqual([OTHER_MODEL, UNKNOWN_MODEL, "a"].sort());
  });

  it("ignores a non-finite `since` and drops rows that are already past retention", () => {
    const { h } = store();
    h.restore({
      version: 1, since: "yesterday",
      rows: [[(NOW - 200 * DAY_MS) / 1000, "anthropic", "old", 1, 0, 0, 0, 1], [HOUR / 1000, "anthropic", "new", 1, 0, 0, 0, 1]],
    });
    expect(h.since).toBeNull();
    expect(h.buckets().map(b => b.model)).toEqual(["new"]);
  });
});

describe("openAISample", () => {
  it("makes a sample carrying input and output only, counted as one request", () => {
    const sample = openAISample({ input_tokens: 7, output_tokens: 3 }, "gpt-5.6-terra", NOW)!;
    expect(sample).toEqual({ ts: NOW, provider: "openai", model: "gpt-5.6-terra", input: 7, output: 3, request: true });
    expect("cacheRead" in sample).toBe(false);
    expect("cacheCreation" in sample).toBe(false);
  });

  it("makes nothing when the response reported no usage", () => {
    expect(openAISample(undefined, "gpt", NOW)).toBeNull();
  });

  it("lands in history as an OpenAI row with no cache tokens", () => {
    const { h } = store();
    h.record(openAISample({ input_tokens: 7, output_tokens: 3 }, "gpt", NOW)!);
    expect(h.buckets()).toEqual([{
      hour: HOUR, provider: "openai", model: "gpt", input: 7, output: 3, cacheRead: 0, cacheCreation: 0, requests: 1,
    }]);
  });
});
