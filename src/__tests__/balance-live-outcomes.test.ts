import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeatOutcomes } from "../proxy/quota-history.js";
import type { ScenarioScore3 } from "./balance/score-3.js";
import { SCENARIOS_3 } from "./balance/scenarios-3.js";
import { simulate } from "./balance/sim.js";

// scripts/balance-outcomes-report.mjs puts the live router's measured outcomes
// (health balance.seats[].outcomes) beside the simulator's prediction for the
// same pool and says whether the prediction held. The dated report under
// docs/balance/ is what the person reads; these tests keep it honest: its
// measured half is health's verbatim, every seat health reports a reset for
// is in it, its prediction is the frozen baseline's figures for the hours it
// covers, and the script runs end to end on a fixture.
//
// The script is plain JS with no type declarations, so it is loaded through a
// non-literal dynamic import and typed here by hand.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/balance-outcomes-report.mjs");
const FIX = fileURLToPath(new URL("./fixtures/balance-live-outcomes/", import.meta.url));
const DOCS = join(ROOT, "docs/balance");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Measured extends SeatOutcomes { days: number | null; sinceStart?: { strandedMinutes: number; strandedBefore: number; resets: Array<{ at: string; util: number; unused: number }> } }
interface Predicted extends SeatOutcomes { band: { resets: [number, number]; unusedAtReset: [number, number] | null; strandedMinutes: [number, number] } }
interface SeatError {
  unusedAtReset: number | null;
  strandedMinutes: number | null;
  strandedMinutesSinceStart: number | null;
  withinError: { unusedAtReset: boolean | null; strandedMinutes: boolean | null; strandedMinutesSinceStart: boolean | null };
}
interface Report {
  reportDate: string;
  policy: string;
  health: { file: string | null; sha: string | null; fetchedAt: string; outcomesDays: number | null };
  quota: { file: string | null; resets: number; strandedRows: number } | null;
  scenario: { name: string; start: string; days: number; seed: number };
  prediction: { hours: number; days: number; elapsedHours: number; seeds: number[]; softCapUtil: number | null };
  errorRule: { unusedAtReset: string; strandedMinutes: string };
  seats: Array<{ id: string; measured: Measured; predicted: Predicted | null; error: SeatError }>;
  pool: { measured: { resets: number; unusedShareAtReset: number | null; strandedSeatMinutes: number }; predicted: { resets: number; unusedShareAtReset: number | null; strandedSeatMinutes: number; strandedSeatMinutesBand: [number, number] } };
  coverage: { seatsWithReset: string[]; notInScenario: string[]; notInHealth: string[] };
  notes: string[];
}
interface Script {
  SCENARIO_START: Record<string, string>;
  judge(measured: Measured, predicted: Predicted | null): SeatError;
  sinceStart(quota: Json, startIso: string, endIso: string): Record<string, Measured["sinceStart"]>;
  buildReport(input: Json): Report;
  renderMarkdown(r: Report): string;
}

let script: Script;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, "utf8"));
const fixtureHealth = (): Json => readJson(join(FIX, "health.json"));
const fixtureQuota = (): Json => readJson(join(FIX, "quota-outcomes.json"));
const liveWeek = SCENARIOS_3.find(s => s.name === "live-week")!;

/** The dated reports committed under docs/balance, newest last. */
function datedReports(): Array<{ date: string; json: Report; md: string }> {
  return readdirSync(DOCS)
    .filter(f => /^live-outcomes-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map(f => ({ date: f.slice("live-outcomes-".length, -".json".length), json: readJson(join(DOCS, f)) as Report, md: readFileSync(join(DOCS, f.replace(/\.json$/, ".md")), "utf8") }));
}

/** health's outcomes block, as quota-history.ts SeatOutcomes plus `days`. */
function isHealthOutcomes(o: unknown): o is Measured {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return typeof x["resets"] === "number" && Number.isInteger(x["resets"]) && x["resets"] >= 0
    && (x["unusedAtReset"] === null || (typeof x["unusedAtReset"] === "number" && x["unusedAtReset"] >= 0 && x["unusedAtReset"] <= 1))
    && ((x["unusedAtReset"] === null) === (x["resets"] === 0))
    && typeof x["strandedMinutes"] === "number" && x["strandedMinutes"] >= 0
    && (x["days"] === null || typeof x["days"] === "number");
}

const band = (lo: number, hi: number, unused: [number, number] | null = [0.02, 0.02]): Predicted =>
  ({ resets: 1, unusedAtReset: unused ? unused[0] : null, strandedMinutes: lo, band: { resets: [1, 1], unusedAtReset: unused, strandedMinutes: [lo, hi] } });
const m = (unusedAtReset: number | null, strandedMinutes: number, resets = unusedAtReset === null ? 0 : 1): Measured => ({ days: 7, resets, unusedAtReset, strandedMinutes });

beforeAll(async () => {
  script = (await import(/* @vite-ignore */ SCRIPT)) as Script;
});

describe("the error rule", () => {
  it("takes an unused share within a hundredth of the seed band, from the readings' quantum, and not two", () => {
    const p = band(956, 1125);
    expect(script.judge(m(0.02, 1000), p).withinError.unusedAtReset).toBe(true);
    expect(script.judge(m(0.03, 1000), p).withinError.unusedAtReset).toBe(true);
    expect(script.judge(m(0.01, 1000), p).withinError.unusedAtReset).toBe(true);
    expect(script.judge(m(0.04, 1000), p).withinError.unusedAtReset).toBe(false);
    expect(script.judge(m(0, 1000), p).withinError.unusedAtReset).toBe(false);
    // Compared in whole hundredths, so float noise in the simulator's share does not decide.
    expect(script.judge(m(0.03, 1000), band(956, 1125, [0.020000000000000018, 0.020000000000000018])).withinError.unusedAtReset).toBe(true);
    expect(script.judge(m(0.03, 1000), p).unusedAtReset).toBeCloseTo(0.01, 10);
  });

  it("takes stranded minutes within a minute of the seed band and reports the signed error against the scenario seed", () => {
    const p = band(956, 1125);
    for (const [minutes, within] of [[955, true], [954, false], [1126, true], [1127, false], [1000, true], [1393, false]] as const) {
      const e = script.judge(m(0.02, minutes), p);
      expect(e.withinError.strandedMinutes, `${minutes}`).toBe(within);
      expect(e.strandedMinutes).toBe(minutes - 956);
    }
  });

  it("gives no verdict without a prediction, no unused verdict without a reset on either side, and a miss when only one side reset", () => {
    expect(script.judge(m(0.02, 10), null).withinError).toEqual({ unusedAtReset: null, strandedMinutes: null, strandedMinutesSinceStart: null });
    const noReset: Predicted = { resets: 0, unusedAtReset: null, strandedMinutes: 0, band: { resets: [0, 0], unusedAtReset: null, strandedMinutes: [0, 0] } };
    expect(script.judge(m(null, 0), noReset).withinError).toEqual({ unusedAtReset: null, strandedMinutes: true, strandedMinutesSinceStart: null });
    expect(script.judge(m(0.02, 0), noReset).withinError.unusedAtReset).toBe(false);
    expect(script.judge(m(null, 0), band(0, 0)).withinError.unusedAtReset).toBe(false);
  });

  it("judges the since-start minutes on the same band when the router's rows are given", () => {
    const measured: Measured = { ...m(0.03, 1393), sinceStart: { strandedMinutes: 1000, strandedBefore: 15, resets: [] } };
    const e = script.judge(measured, band(956, 1125));
    expect(e.withinError.strandedMinutes).toBe(false);
    expect(e.withinError.strandedMinutesSinceStart).toBe(true);
    expect(e.strandedMinutesSinceStart).toBe(1000 - 956);
  });
});

describe("the router's rows from the start on", () => {
  it("splits stranded minutes at the start hour, drops rows after the fetch, and lists resets inside the window", () => {
    const quota = {
      resets: [[1795125600, "rigel", 0.98, 1795129207], [1795161600, "lyra", 0.97, 1795164954], [1795000000, "lyra", 0.5, 1795000001], [1795200000, "rigel", 0.9, 1795200001]],
      stranded: [[1795075200, "lyra", 15], [1795078800, "lyra", 59], [1795082400, "lyra", 60], [1795165200, "lyra", 60], [1795078800, 7, 5]],
    };
    const since = script.sinceStart(quota, "2026-11-19T09:00:00Z", "2026-11-20T08:59:00Z");
    expect(since["lyra"]).toEqual({ strandedMinutes: 119, strandedBefore: 15, resets: [{ at: "2026-11-20T08:00:00.000Z", util: 0.97, unused: 0.03 }] });
    expect(since["rigel"]).toEqual({ strandedMinutes: 0, strandedBefore: 0, resets: [{ at: "2026-11-19T22:00:00.000Z", util: 0.98, unused: 0.02 }] });
    expect(Object.keys(since)).toEqual(["lyra", "rigel"]);
  });
});

describe("a report from a health file", () => {
  let report: Report;
  beforeAll(() => {
    report = script.buildReport({
      health: fixtureHealth(), quota: fixtureQuota(), scenario: liveWeek, simulate,
      date: "2026-11-20", fetchedAt: "2026-11-20T08:59:00Z", start: "2026-11-19T09:00:00Z", seeds: 2, policy: "test",
      healthFile: "health.json", quotaFile: "quota-outcomes.json", notes: ["a note"],
    });
  });

  it("carries every seat health reports, its outcomes verbatim, and names the seats outside the scenario or outside health", () => {
    const seats = fixtureHealth()["balance"]["seats"] as Json[];
    expect(report.seats.map(s => s.id)).toEqual(seats.map(s => s["id"]));
    for (const s of seats) {
      const row = report.seats.find(r => r.id === s["id"])!;
      expect(isHealthOutcomes(row.measured)).toBe(true);
      const { sinceStart: _since, ...plain } = row.measured; // eslint-disable-line @typescript-eslint/no-unused-vars
      expect(plain).toEqual(s["outcomes"]);
    }
    expect(report.coverage.seatsWithReset).toEqual(["rigel", "lyra", "nova"]);
    expect(report.coverage.notInScenario).toEqual(["nova"]);
    expect(report.coverage.notInHealth).toEqual(["kyte", "vega"]);
    const nova = report.seats.find(s => s.id === "nova")!;
    expect(nova.predicted).toBeNull();
    expect(nova.error.withinError).toEqual({ unusedAtReset: null, strandedMinutes: null, strandedMinutesSinceStart: null });
    const heewon = report.seats.find(s => s.id === "heewon")!;
    expect(heewon.measured.unusedAtReset).toBeNull();
    expect(heewon.error.withinError.unusedAtReset).toBeNull();
  });

  it("predicts the hours elapsed at the fetch, from the scenario's seed, with a band over the seeds asked for", () => {
    expect(report.prediction).toEqual({ hours: 24, days: 1, elapsedHours: 24, seeds: [3101, 3102], softCapUtil: 0.98 });
    expect(report.scenario).toEqual({ name: "live-week", start: "2026-11-19T09:00:00Z", days: 2, seed: 3101 });
    const rigel = report.seats.find(s => s.id === "rigel")!;
    expect(rigel.predicted).toEqual({ resets: 1, unusedAtReset: 0.02, strandedMinutes: 780, band: { resets: [1, 1], unusedAtReset: [0.02, 0.02], strandedMinutes: [780, 780] } });
    const lyra = report.seats.find(s => s.id === "lyra")!;
    expect(lyra.predicted!.band.strandedMinutes[0]).toBeLessThanOrEqual(lyra.predicted!.strandedMinutes);
    expect(lyra.predicted!.band.strandedMinutes[1]).toBeGreaterThanOrEqual(lyra.predicted!.strandedMinutes);
    expect(lyra.measured.sinceStart).toEqual({ strandedMinutes: 1378, strandedBefore: 15, resets: [{ at: "2026-11-20T08:00:00.000Z", util: 0.97, unused: 0.03 }] });
    expect(report.pool.measured).toEqual({ resets: 3, unusedShareAtReset: (0.02 + 0.03 + 0.1) / 3, strandedSeatMinutes: 793 + 1393 + 100 });
    expect(report.pool.predicted.resets).toBe(2);
  });

  it("caps the prediction at the scenario's length and refuses a fetch before the first hour", () => {
    const late = script.buildReport({ health: fixtureHealth(), scenario: liveWeek, simulate, date: "2026-11-25", fetchedAt: "2026-11-25T00:00:00Z", start: "2026-11-19T09:00:00Z", seeds: 1 });
    expect(late.prediction.hours).toBe(48);
    expect(late.prediction.elapsedHours).toBe(135);
    expect(() => script.buildReport({ health: fixtureHealth(), scenario: liveWeek, simulate, date: "2026-11-19", fetchedAt: "2026-11-19T09:10:00Z", start: "2026-11-19T09:00:00Z", seeds: 1 })).toThrow(/first hour/);
    expect(() => script.buildReport({ health: { balance: { seats: [] } }, scenario: liveWeek, simulate, date: "2026-11-19", fetchedAt: "2026-11-20T09:00:00Z", start: "2026-11-19T09:00:00Z" })).toThrow(/balance.seats/);
    expect(() => script.buildReport({ health: fixtureHealth(), scenario: liveWeek, simulate, date: "20261120", fetchedAt: "2026-11-20T09:00:00Z", start: "2026-11-19T09:00:00Z" })).toThrow(/YYYY-MM-DD/);
  });

  it("renders a page that states, per seat with a reset, the unused share and both verdicts", () => {
    const md = script.renderMarkdown(report);
    expect(md).toMatch(/^# Live outcomes vs the simulator, 2026-11-20/);
    expect(md).toContain("### rigel\n\n- Measured: 1 reset, 2% of the week left unused at it, 793 stranded minutes.");
    expect(md).toContain("- Unused share: within (measured − predicted +0 points).");
    expect(md).toContain("### lyra\n\n- Measured: 1 reset, 3% of the week left unused at it, 1393 stranded minutes.");
    expect(md).toMatch(/### lyra[\s\S]*- Stranded minutes: OUTSIDE \(measured − predicted \+\d+ min\)/);
    expect(md).toMatch(/### lyra[\s\S]*From the scenario's start on \(router rows\): 1378 stranded minutes \(15 before it\)/);
    expect(md).toContain("### nova\n\n- Measured: 1 reset, 10% of the week left unused at it, 100 stranded minutes.\n- Predicted: no prediction, the scenario does not carry this seat.");
    expect(md).toContain("| heewon | 0 | none | 0 | 0 | none | 0 (0–0) | no verdict | within |");
    expect(md).toContain("Seats health reports that the scenario does not carry (no prediction): nova.");
    expect(md).toContain("Seats the scenario carries that health does not report: kyte, vega.");
    expect(md).toContain("## Notes\n\n- a note\n");
  });
});

describe("the script", () => {
  it("runs end to end on the fixture under tsx and writes the dated pair", () => {
    const out = mkdtempSync(join(tmpdir(), "live-outcomes-"));
    const args = ["--health", join(FIX, "health.json"), "--quota-file", join(FIX, "quota-outcomes.json"), "--date", "2026-11-20", "--fetched-at", "2026-11-20T08:59:00Z", "--seeds", "2", "--policy", "fixture", "--note", "one", "--note", "two", "--out-dir", out];
    const ok = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/wrote .*live-outcomes-2026-11-20\.json/);
    const json = readJson(join(out, "live-outcomes-2026-11-20.json")) as Report;
    expect(json.scenario.start).toBe("2026-11-19T09:00:00.000Z");
    expect(json.prediction.seeds).toEqual([3101, 3102]);
    expect(json.notes).toEqual(["one", "two"]);
    expect(json.seats.map(s => s.id)).toEqual(["heewon", "rigel", "lyra", "nova"]);
    expect(json.health.sha).toMatch(/^fixture/);
    expect(json.quota).toEqual({ file: join(FIX, "quota-outcomes.json"), resets: 3, strandedRows: 39 });
    const md = readFileSync(join(out, "live-outcomes-2026-11-20.md"), "utf8");
    expect(md).toContain("### rigel");
    expect(md).toContain("policy fixture");

    const bad = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--health", join(FIX, "health.json"), "--date", "2026-11-20"], { cwd: ROOT, encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/--fetched-at is required/);
  });

  it("starts live-week where its capture did", () => {
    const captured = readJson(join(DOCS, "capture-2026-11-19/live-week.scenario.json"))["capturedAt"] as string;
    expect(script.SCENARIO_START["live-week"]).toBe(captured);
    expect(Date.parse(captured)).toBe(Date.UTC(2026, 10, 19, 9));
  });
});

describe("the dated reports under docs/balance", () => {
  const reports = datedReports();

  it("exist, each with its Markdown page and the health it was built from", () => {
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(r.json.reportDate).toBe(r.date);
      expect(r.json.health.file).not.toBeNull();
      expect(existsSync(join(ROOT, r.json.health.file!))).toBe(true);
      expect(r.md).toContain(`# Live outcomes vs the simulator, ${r.date}`);
    }
  });

  it("carry health's outcomes verbatim, in health's schema, for every seat health reports, and every seat with a reset", () => {
    for (const r of reports) {
      const health = readJson(join(ROOT, r.json.health.file!));
      const seats = health["balance"]["seats"] as Json[];
      expect(r.json.health.sha).toBe(health["build"]["sha"]);
      expect(r.json.seats.map(s => s.id).sort()).toEqual(seats.map(s => s["id"]).sort());
      for (const s of seats) {
        expect(isHealthOutcomes(s["outcomes"]), `${r.date} ${s["id"]} in health`).toBe(true);
        const row = r.json.seats.find(x => x.id === s["id"])!;
        expect(isHealthOutcomes(row.measured), `${r.date} ${s["id"]} in the report`).toBe(true);
        const { sinceStart: _since, ...plain } = row.measured; // eslint-disable-line @typescript-eslint/no-unused-vars
        expect(plain).toEqual(s["outcomes"]);
        if (s["outcomes"].resets > 0) {
          expect(r.json.coverage.seatsWithReset).toContain(s["id"]);
          expect(r.md).toContain(`### ${s["id"]}`);
          expect(r.md).toContain(`${Math.round(s["outcomes"].unusedAtReset * 100)}% of the week left unused at it`);
        }
      }
      expect(r.json.coverage.seatsWithReset.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("predict live-week from its own seed over the hours elapsed, with the value inside the band and the verdict by the stated rule", () => {
    for (const r of reports) {
      expect(r.json.scenario.name).toBe("live-week");
      expect(r.json.scenario.seed).toBe(liveWeek.seed);
      expect(r.json.scenario.start).toBe(script.SCENARIO_START["live-week"]);
      expect(r.json.prediction.seeds[0]).toBe(liveWeek.seed);
      expect(r.json.prediction.hours).toBeLessThanOrEqual(liveWeek.days * 24);
      expect(r.json.prediction.hours).toBeGreaterThanOrEqual(1);
      for (const s of r.json.seats) {
        if (!s.predicted) continue;
        expect(s.predicted.band.strandedMinutes[0]).toBeLessThanOrEqual(s.predicted.strandedMinutes);
        expect(s.predicted.band.strandedMinutes[1]).toBeGreaterThanOrEqual(s.predicted.strandedMinutes);
        expect(s.error.withinError.strandedMinutes).toBe(s.measured.strandedMinutes >= s.predicted.band.strandedMinutes[0] - 1 && s.measured.strandedMinutes <= s.predicted.band.strandedMinutes[1] + 1);
        expect(s.error.strandedMinutes).toBe(s.measured.strandedMinutes - s.predicted.strandedMinutes);
      }
    }
  });

  // The policy a dated report was run under is the one in its `policy` field; a
  // later placement change does not rewrite history, so only the reports made
  // under the baseline's policy are held to baseline-3's figures.
  const UNDER_BASELINE_POLICY = ["2026-11-20"];

  it("made under baseline-3's policy are a prefix of its live-week: the scenario seed's figures for the hours covered", () => {
    const baseline = (readJson(join(DOCS, "baseline-3.json"))["scenarios"] as Record<string, ScenarioScore3>)["live-week"];
    const held = reports.filter(r => UNDER_BASELINE_POLICY.includes(r.date));
    expect(held.map(r => r.date)).toEqual(UNDER_BASELINE_POLICY);
    for (const r of held) {
      for (const s of r.json.seats) {
        if (!s.predicted) continue;
        const b = baseline.outcomesBySeat[s.id];
        expect(b, `${s.id} in baseline-3`).toBeDefined();
        expect(s.predicted.resets).toBeLessThanOrEqual(b.resets);
        expect(s.predicted.strandedMinutes).toBeLessThanOrEqual(b.strandedMinutes);
        if (s.predicted.resets === b.resets && b.unusedAtReset !== null) {
          expect(Math.round(s.predicted.unusedAtReset! * 100)).toBe(Math.round(b.unusedAtReset * 100));
          // A seat whose reset fell inside the hours covered is not at the cap after it: the prefix holds the whole figure.
          if (s.predicted.resets > 0) expect(s.predicted.strandedMinutes).toBe(b.strandedMinutes);
        }
      }
    }
  });

  it("are quoted by troubleshooting with their date and figures", () => {
    const doc = readFileSync(join(ROOT, "docs/troubleshooting.md"), "utf8");
    const latest = reports[reports.length - 1]!;
    expect(doc).toContain(`live-outcomes-${latest.date}`);
    for (const id of latest.json.coverage.seatsWithReset) {
      const s = latest.json.seats.find(x => x.id === id)!;
      expect(doc, `${id} unused share`).toContain(`${Math.round(s.measured.unusedAtReset! * 100)}%`);
      expect(doc, `${id} stranded minutes`).toContain(`${s.measured.strandedMinutes}`);
    }
  });
});
