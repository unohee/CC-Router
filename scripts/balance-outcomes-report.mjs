#!/usr/bin/env node
/**
 * Put the live router's measured outcomes beside the simulator's prediction
 * for the same pool, and say whether the prediction held.
 *
 *   npx tsx scripts/balance-outcomes-report.mjs --health health.json \
 *     --date 2026-11-20 --fetched-at 2026-11-20T08:59:00Z \
 *     [--scenario live-week] [--start 2026-11-19T09:00:00Z] [--elapsed-hours N] \
 *     [--quota-file quota-outcomes.json] [--seeds 8] [--policy "d45639b (#54)"] \
 *     [--note "..."]... [--out-dir docs/balance]
 *
 * The script imports the simulator (src/__tests__/balance/sim.ts), which is
 * TypeScript, so it runs under tsx; `node` alone cannot load it. Writes
 * <out-dir>/live-outcomes-<date>.json and <out-dir>/live-outcomes-<date>.md.
 *
 * Measured: health's `balance.seats[].outcomes` (quota-history.ts
 * `SeatOutcomes`): per seat, the weekly resets the router saw over the last
 * `days` days, the mean share of the week left unused at them, and the
 * minutes the seat sat at or past the soft cap while another usable seat
 * under the cap had a fifth of its week left. The health file is saved to
 * disk by the caller (a read-only GET); nothing here talks to a server.
 *
 * Predicted: the scenario named by --scenario (balance/scenarios-3.ts), run
 * by the simulator under the policy in the working tree, over the hours that
 * had elapsed between the scenario's start and the health fetch (rounded to
 * the hour, at most the scenario's length): a run cut short is a prefix of
 * the full run for the same seed, so the figures are the ones baseline-3.json
 * holds for that seed up to that hour. The prediction is the scenario's own
 * seed; the band is the spread over `--seeds` consecutive seeds from it.
 *
 * Error rule, per seat and outcome, from how the figures are read and not
 * from the result:
 * - unusedAtReset: readings are hundredths (upstream reports utilization at
 *   two decimals), so two readings of one true share can differ by a
 *   hundredth. The measured share is within the prediction when, in whole
 *   hundredths, it lies in [min - 1, max + 1] of the seed band.
 * - strandedMinutes: both sides add one minute per tick and their ticks do
 *   not line up, so the measured minutes are within the prediction when they
 *   lie in [min - 1, max + 1] of the seed band.
 * A seat the scenario does not carry has no prediction and no verdict.
 *
 * What health alone cannot separate (stated in the report): the live
 * outcomes cover health's `outcomes.days` and may include minutes recorded
 * before the scenario's start; the simulated ones start at it. With
 * --quota-file, the router's on-disk quota-history.json (its `resets` and
 * `stranded` rows; the readings are not needed), the report also gives each
 * seat's stranded minutes and resets from the start to where the prediction
 * ends, and judges those too.
 *
 * The band covers the demand draw only (which sessions arrive when, how long
 * they live, what they send): it does not cover the captured starting state
 * (each seat's utilization from its newest reading at the start, which may be
 * hours old) or the fitted seat sizes. A miss outside the band points at one
 * of those, or at placement; the report cannot say which by itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOUR_MS = 3_600_000;
const DEFAULT_SEEDS = 8;
/** When each frozen run-3 scenario starts in wall-clock time (the capture's `capturedAt`). */
export const SCENARIO_START = { "live-week": "2026-11-19T09:00:00.000Z" };
/** Readings are hundredths of the week (quota-history.ts stores what upstream reports). */
export const SHARE_QUANTUM = 0.01;
/** The live tick and the simulated tick each add a minute; they do not line up. */
export const MINUTE_QUANTUM = 1;

const ERROR_RULE = {
  unusedAtReset: "within when the measured share, in whole hundredths, lies in [min - 1, max + 1] of the seed band: readings are hundredths, so two readings of one true share can differ by one",
  strandedMinutes: "within when the measured minutes lie in [min - 1, max + 1] of the seed band: each side adds one minute per tick and the ticks do not line up",
};

const hundredths = v => Math.round(v * 100);

/** The simulator's outcomes for one scenario over `days`, for every seed. */
export function predict(scenario, simulate, { days, seeds }) {
  const runs = seeds.map(seed => {
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const r = simulate({ ...scenario, seed, days }, { setClock: ms => { clock = ms; } });
      return { seed, outcomesBySeat: r.outcomesBySeat, strandedSeatMinutes: r.strandedSeatMinutes };
    } finally {
      Date.now = realNow;
    }
  });
  const own = runs[0];
  const bySeat = {};
  for (const seat of scenario.seats) {
    const all = runs.map(r => r.outcomesBySeat[seat.id]);
    const unused = all.map(o => o.unusedAtReset).filter(v => v !== null);
    const stranded = all.map(o => o.strandedMinutes);
    const o = own.outcomesBySeat[seat.id];
    bySeat[seat.id] = {
      resets: o.resets,
      unusedAtReset: o.unusedAtReset === null ? null : hundredths(o.unusedAtReset) / 100,
      strandedMinutes: o.strandedMinutes,
      band: {
        resets: [Math.min(...all.map(x => x.resets)), Math.max(...all.map(x => x.resets))],
        unusedAtReset: unused.length ? [hundredths(Math.min(...unused)) / 100, hundredths(Math.max(...unused)) / 100] : null,
        strandedMinutes: [Math.min(...stranded), Math.max(...stranded)],
      },
    };
  }
  return { seeds, days, bySeat, strandedSeatMinutes: own.strandedSeatMinutes, strandedSeatMinutesBand: [Math.min(...runs.map(r => r.strandedSeatMinutes)), Math.max(...runs.map(r => r.strandedSeatMinutes))] };
}

/** Measured against predicted for one seat; null verdicts where one side is missing. */
export function judge(measured, predicted) {
  if (!predicted) return { unusedAtReset: null, strandedMinutes: null, strandedMinutesSinceStart: null, withinError: { unusedAtReset: null, strandedMinutes: null, strandedMinutesSinceStart: null } };
  const m = measured;
  const pm = predicted;
  let unusedErr = null, unusedWithin = null;
  if (m.unusedAtReset !== null && pm.band.unusedAtReset) {
    const mh = hundredths(m.unusedAtReset);
    const [lo, hi] = pm.band.unusedAtReset.map(hundredths);
    unusedErr = (mh - hundredths(pm.unusedAtReset)) / 100;
    unusedWithin = mh >= lo - 1 && mh <= hi + 1;
  } else if (m.unusedAtReset !== null || pm.unusedAtReset !== null) {
    // A reset on one side only: the prediction missed it, or the live window had not reached it.
    unusedWithin = false;
  }
  const [slo, shi] = pm.band.strandedMinutes;
  const strandedErr = m.strandedMinutes - pm.strandedMinutes;
  const within = v => v >= slo - MINUTE_QUANTUM && v <= shi + MINUTE_QUANTUM;
  const since = measured.sinceStart;
  return {
    unusedAtReset: unusedErr,
    strandedMinutes: strandedErr,
    strandedMinutesSinceStart: since ? since.strandedMinutes - pm.strandedMinutes : null,
    withinError: { unusedAtReset: unusedWithin, strandedMinutes: within(m.strandedMinutes), strandedMinutesSinceStart: since ? within(since.strandedMinutes) : null },
  };
}

const hoursBetween = (startIso, endIso) => (Date.parse(endIso) - Date.parse(startIso)) / HOUR_MS;

/**
 * Per seat, what the router's own rows say happened from `start` to `end`:
 * stranded minutes in hour buckets that begin at or after the start and before
 * the end (a bucket that began before the start, with its minutes, is listed
 * as `before`; the end is on the hour, as the prediction's is) and the resets
 * at or after the start up to the end.
 */
export function sinceStart(quota, startIso, endIso) {
  const startSec = Math.floor(Date.parse(startIso) / 1000), endSec = Math.floor(Date.parse(endIso) / 1000);
  const out = {};
  const seat = id => (out[id] ??= { strandedMinutes: 0, strandedBefore: 0, resets: [] });
  for (const row of quota?.stranded ?? []) {
    const [hour, id, minutes] = row;
    // A bucket is the hour from `hour` on; one that begins at or after the end lies outside the window.
    if (typeof id !== "string" || !Number.isFinite(hour) || !Number.isFinite(minutes) || hour >= endSec) continue;
    if (hour >= startSec) seat(id).strandedMinutes += minutes;
    else seat(id).strandedBefore += minutes;
  }
  for (const row of quota?.resets ?? []) {
    const [at, id, util] = row;
    if (typeof id !== "string" || !Number.isFinite(at) || !Number.isFinite(util) || at < startSec || at > endSec) continue;
    seat(id).resets.push({ at: new Date(at * 1000).toISOString(), util, unused: Math.max(0, hundredths(1 - util) / 100) });
  }
  return out;
}

/**
 * The report: every seat health carries, with its measured outcomes verbatim,
 * the prediction where the scenario has the seat, and the error.
 */
export function buildReport({ health, scenario, simulate, date, fetchedAt, start, elapsedHours, seeds = DEFAULT_SEEDS, policy = "working tree", healthFile = null, quota = null, quotaFile = null, notes = [] }) {
  const seatsIn = health?.balance?.seats;
  if (!Array.isArray(seatsIn) || seatsIn.length === 0) throw new Error("health has no balance.seats");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error(`--fetched-at is not a date: ${fetchedAt}`);
  if (!Number.isFinite(Date.parse(start))) throw new Error(`--start is not a date: ${start}`);
  const fullHours = scenario.days * 24;
  const elapsed = elapsedHours ?? Math.round(hoursBetween(start, fetchedAt));
  if (!Number.isFinite(elapsed) || elapsed < 1) throw new Error(`the health was fetched before the scenario's first hour (elapsed ${elapsed} h)`);
  const hours = Math.min(fullHours, elapsed);
  const seedList = Array.from({ length: seeds }, (_, i) => scenario.seed + i);
  const prediction = predict(scenario, simulate, { days: hours / 24, seeds: seedList });
  // The rows are cut where the prediction ends: at the fetch, or at the scenario's length when the fetch came later.
  const predictionEnd = new Date(Date.parse(start) + hours * HOUR_MS).toISOString();
  const rows = quota ? sinceStart(quota, start, predictionEnd) : null;

  const seats = seatsIn.map(s => {
    const o = s.outcomes ?? { days: null, resets: 0, unusedAtReset: null, strandedMinutes: 0 };
    const measured = { days: o.days ?? null, resets: o.resets, unusedAtReset: o.unusedAtReset, strandedMinutes: o.strandedMinutes };
    if (rows) measured.sinceStart = rows[s.id] ?? { strandedMinutes: 0, strandedBefore: 0, resets: [] };
    const predicted = prediction.bySeat[s.id] ?? null;
    const error = judge(measured, predicted);
    return { id: s.id, measured, predicted, error };
  });
  const inScenario = new Set(Object.keys(prediction.bySeat));
  const notInScenario = seats.filter(s => !inScenario.has(s.id)).map(s => s.id);
  const notInHealth = [...inScenario].filter(id => !seats.some(s => s.id === id));

  const withReset = seats.filter(s => s.measured.resets > 0);
  const measuredPool = {
    resets: withReset.reduce((a, s) => a + s.measured.resets, 0),
    unusedShareAtReset: withReset.length ? withReset.reduce((a, s) => a + s.measured.unusedAtReset * s.measured.resets, 0) / withReset.reduce((a, s) => a + s.measured.resets, 0) : null,
    strandedSeatMinutes: seats.reduce((a, s) => a + s.measured.strandedMinutes, 0),
  };
  const predSeats = Object.values(prediction.bySeat);
  const predResets = predSeats.reduce((a, p) => a + p.resets, 0);
  const predictedPool = {
    resets: predResets,
    unusedShareAtReset: predResets ? predSeats.filter(p => p.unusedAtReset !== null).reduce((a, p) => a + p.unusedAtReset * p.resets, 0) / predResets : null,
    strandedSeatMinutes: prediction.strandedSeatMinutes,
    strandedSeatMinutesBand: prediction.strandedSeatMinutesBand,
  };

  return {
    reportDate: date,
    policy,
    health: { file: healthFile, sha: health.build?.sha ?? null, builtAt: health.build?.builtAt ?? null, fetchedAt, outcomesDays: seatsIn[0]?.outcomes?.days ?? null },
    quota: quota ? { file: quotaFile, resets: (quota.resets ?? []).length, strandedRows: (quota.stranded ?? []).length } : null,
    scenario: { name: scenario.name, start, days: scenario.days, seed: scenario.seed },
    prediction: { hours, days: hours / 24, elapsedHours: elapsed, end: predictionEnd, seeds: seedList, softCapUtil: scenario.routing?.softCapUtil ?? null },
    errorRule: ERROR_RULE,
    seats,
    pool: { measured: measuredPool, predicted: predictedPool, error: { strandedSeatMinutes: measuredPool.strandedSeatMinutes - predictedPool.strandedSeatMinutes } },
    coverage: { seatsWithReset: withReset.map(s => s.id), notInScenario, notInHealth },
    notes,
  };
}

const pct = v => (v === null || v === undefined ? "none" : `${hundredths(v)}%`);
const pct1 = v => (v === null || v === undefined ? "none" : `${(Math.round(v * 1000) / 10).toString()}%`);
const pctRange = b => (b ? `${hundredths(b[0])}–${hundredths(b[1])}%` : "none");
const yesno = v => (v === null ? "no verdict" : v ? "within" : "OUTSIDE");
const signed = v => `${v >= 0 ? "+" : ""}${v}`;
/** "+13 min, +1.7%" against the predicted minutes; no share when the prediction is 0. */
const minutesErr = (err, predicted) => `${signed(err)} min${predicted > 0 ? `, ${signed(Math.round((err / predicted) * 1000) / 10)}%` : ""}`;

/** The Markdown page a person reads. */
export function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Live outcomes vs the simulator, ${r.reportDate}`);
  lines.push("");
  lines.push(`Measured: health \`balance.seats[].outcomes\` from build ${r.health.sha ? r.health.sha.slice(0, 7) : "unknown"}, fetched ${r.health.fetchedAt}, over the last ${r.health.outcomesDays ?? "?"} days (saved as \`${r.health.file ?? "health.json"}\`).`);
  const span = r.prediction.elapsedHours > r.prediction.hours
    ? `for its full ${r.prediction.hours} h (the fetch came ${r.prediction.elapsedHours} h after the start, so the measured window is longer than the simulated one)`
    : `for the ${r.prediction.hours} h that had elapsed at the fetch`;
  lines.push(`Predicted: scenario \`${r.scenario.name}\` (start ${r.scenario.start}, ${r.scenario.days} days) simulated under policy ${r.policy} ${span}, seed ${r.scenario.seed} with a band over seeds ${r.prediction.seeds[0]}–${r.prediction.seeds[r.prediction.seeds.length - 1]}; soft cap ${r.prediction.softCapUtil === null ? "none" : `${hundredths(r.prediction.softCapUtil)}%`}.`);
  lines.push("");
  lines.push("## Seats with a weekly reset");
  lines.push("");
  const withReset = r.seats.filter(s => s.measured.resets > 0);
  if (withReset.length === 0) lines.push("None: the router recorded no weekly reset in the window.");
  for (const s of withReset) {
    const m = s.measured, p = s.predicted, e = s.error;
    lines.push(`### ${s.id}`);
    lines.push("");
    lines.push(`- Measured: ${m.resets} reset${m.resets === 1 ? "" : "s"}, ${pct(m.unusedAtReset)} of the week left unused at it, ${m.strandedMinutes} stranded minutes.`);
    if (!p) {
      lines.push("- Predicted: no prediction, the scenario does not carry this seat.");
    } else {
      lines.push(`- Predicted: ${p.resets} reset${p.resets === 1 ? "" : "s"}, ${pct(p.unusedAtReset)} unused (seeds ${pctRange(p.band.unusedAtReset)}), ${p.strandedMinutes} stranded minutes (seeds ${p.band.strandedMinutes[0]}–${p.band.strandedMinutes[1]}).`);
      lines.push(`- Unused share: ${yesno(e.withinError.unusedAtReset)}${e.unusedAtReset === null ? "" : ` (measured − predicted ${e.unusedAtReset >= 0 ? "+" : ""}${hundredths(e.unusedAtReset)} points)`}.`);
      lines.push(`- Stranded minutes: ${yesno(e.withinError.strandedMinutes)} (measured − predicted ${minutesErr(e.strandedMinutes, p.strandedMinutes)}).`);
      if (m.sinceStart) {
        const ss = m.sinceStart;
        const resets = ss.resets.map(x => `${x.at} at ${hundredths(x.util)}% (${pct(x.unused)} unused)`).join("; ") || "none";
        lines.push(`- From the scenario's start to ${r.prediction.end} (router rows): ${ss.strandedMinutes} stranded minutes (${ss.strandedBefore} before the start), reset ${resets}: ${yesno(e.withinError.strandedMinutesSinceStart)} (${minutesErr(e.strandedMinutesSinceStart, p.strandedMinutes)}).`);
      }
    }
    lines.push("");
  }
  lines.push("## Every seat");
  lines.push("");
  lines.push("| seat | resets | unused at reset | stranded min | predicted resets | predicted unused | predicted stranded (band) | unused | stranded |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of r.seats) {
    const m = s.measured, p = s.predicted, e = s.error;
    lines.push(`| ${s.id} | ${m.resets} | ${pct(m.unusedAtReset)} | ${m.strandedMinutes} | ${p ? p.resets : "–"} | ${p ? pct(p.unusedAtReset) : "–"} | ${p ? `${p.strandedMinutes} (${p.band.strandedMinutes[0]}–${p.band.strandedMinutes[1]})` : "–"} | ${p ? yesno(e.withinError.unusedAtReset) : "–"} | ${p ? yesno(e.withinError.strandedMinutes) : "–"} |`);
  }
  lines.push("");
  const mp = r.pool.measured, pp = r.pool.predicted;
  lines.push(`Pool: measured ${mp.resets} resets, ${pct1(mp.unusedShareAtReset)} unused share, ${mp.strandedSeatMinutes} stranded seat-minutes; predicted ${pp.resets} resets, ${pct1(pp.unusedShareAtReset)} unused share, ${pp.strandedSeatMinutes} stranded seat-minutes (seeds ${pp.strandedSeatMinutesBand[0]}–${pp.strandedSeatMinutesBand[1]}).`);
  lines.push("");
  lines.push("## How the error is judged");
  lines.push("");
  lines.push(`- Unused share: ${r.errorRule.unusedAtReset}.`);
  lines.push(`- Stranded minutes: ${r.errorRule.strandedMinutes}.`);
  lines.push(`- The band is the spread over the demand draw (seeds) only: it does not cover the captured starting state (each seat's utilization from its newest reading at the start, possibly hours old) or the fitted seat sizes. A miss outside it points at one of those, or at placement; the report cannot say which by itself.`);
  lines.push(`- The measured outcomes cover health's window (${r.health.outcomesDays ?? "?"} days) and may include minutes recorded before the scenario's start; the simulated ones start at it.${r.quota ? ` The router's own rows (\`${r.quota.file ?? "quota-history.json"}\`) give the minutes from the start to where the prediction ends, judged on the same band.` : ""}`);
  if (r.coverage.notInScenario.length) lines.push(`- Seats health reports that the scenario does not carry (no prediction): ${r.coverage.notInScenario.join(", ")}.`);
  if (r.coverage.notInHealth.length) lines.push(`- Seats the scenario carries that health does not report: ${r.coverage.notInHealth.join(", ")}.`);
  if (r.notes.length) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    if (key === "note") out.notes.push(val);
    else out[key] = val;
  }
  return out;
}

export async function main(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const args = parseArgs(argv);
  for (const k of ["health", "date", "fetched-at"]) if (!args[k]) throw new Error(`--${k} is required`);
  const name = args.scenario ?? "live-week";
  const here = fileURLToPath(new URL(".", import.meta.url));
  const scenarios = await import(pathToFileURL(resolve(here, "../src/__tests__/balance/scenarios-3.ts")).href);
  const sim = await import(pathToFileURL(resolve(here, "../src/__tests__/balance/sim.ts")).href);
  const scenario = scenarios.SCENARIOS_3.find(s => s.name === name);
  if (!scenario) throw new Error(`no scenario named ${name} in scenarios-3.ts`);
  const start = args.start ?? SCENARIO_START[name];
  if (!start) throw new Error(`--start is required for ${name}`);
  const healthPath = resolve(cwd, args.health);
  const health = JSON.parse(readFileSync(healthPath, "utf8"));
  const quota = args["quota-file"] ? JSON.parse(readFileSync(resolve(cwd, args["quota-file"]), "utf8")) : null;
  const report = buildReport({
    health, scenario, simulate: sim.simulate, quota, quotaFile: args["quota-file"] ?? null,
    date: args.date, fetchedAt: args["fetched-at"], start,
    elapsedHours: args["elapsed-hours"] === undefined ? undefined : Number(args["elapsed-hours"]),
    seeds: args.seeds === undefined ? DEFAULT_SEEDS : Number(args.seeds),
    policy: args.policy, healthFile: args.health, notes: args.notes,
  });
  const outDir = resolve(cwd, args["out-dir"] ?? "docs/balance");
  const jsonPath = resolve(outDir, `live-outcomes-${args.date}.json`);
  const mdPath = resolve(outDir, `live-outcomes-${args.date}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(report));
  log(`wrote ${jsonPath}`);
  log(`wrote ${mdPath}`);
  return report;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
