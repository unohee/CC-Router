import { describe, expect, it } from "vitest";
import { computeSeverity } from "../proxy/severity.js";
import type { LogEntry } from "../proxy/stats.js";
import { accountLine, buildFrame, detailLines, logLine, pickAccounts, stripLine } from "../ui/status-frame.js";
import type { FrameInput } from "../ui/status-frame.js";
import { DETAILS_LINES, LOG_VISIBLE, planLayout } from "../ui/status-layout.js";
import type { AccountStat, HealthData } from "../ui/status-types.js";
import { cellWidth, fitSegs, padCells, segsWidth, truncateCells } from "../ui/term-text.js";
import type { Seg } from "../ui/term-text.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const text = (line: Seg[]) => line.map(s => s.text).join("");

function limits(five: number, seven = 0.1) {
  return {
    status: "allowed", fiveHourUtil: five, fiveHourReset: Math.floor((NOW + 156 * MIN) / 1000),
    sevenDayUtil: seven, sevenDayReset: Math.floor((NOW + 27 * 60 * MIN) / 1000),
    claim: "five_hour", plan: "Max 20x", requestsLimit: 0, lastUpdated: NOW - 1000,
  };
}

function account(id: string, over: Partial<AccountStat> = {}): AccountStat {
  return {
    id, provider: "anthropic_subscription", healthy: true, busy: false, requestCount: 1234, errorCount: 0,
    expiresInMs: 5 * 60 * MIN, lastUsedMs: NOW - 3 * MIN, lastRefreshMs: 0, enabled: true,
    sessionLimitPercent: 100, weeklyLimitPercent: 100, rateLimits: limits(0.41), ...over,
  };
}

function log(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: NOW - 5_000, accountId: "lyra", model: "claude-opus-5-5", type: "route", method: "POST",
    path: "/messages", statusCode: 200, durationMs: 2064, source: "cli", sessionId: "fb61c7c5-51f0-4c06-a5fc-fd58fc05c57d",
    cacheReadTokens: 532_300, cacheCreationTokens: 2_800, inputTokens: 2, outputTokens: 233, ...over,
  };
}

function health(accounts: AccountStat[], logs: LogEntry[] = [], over: Partial<HealthData> = {}): HealthData {
  return {
    status: "ok", mode: "standalone", target: "https://api.anthropic.com", uptime: 7_500,
    totalRequests: 1234, totalErrors: 0, totalRefreshes: 7, totalCacheReadTokens: 270_000_000,
    totalCacheCreationTokens: 14_000_000, totalInputTokens: 126_000, totalOutputTokens: 2_200_000,
    accounts, recentLogs: logs, ...over,
  };
}

function frameInput(data: HealthData, over: Partial<FrameInput> = {}): FrameInput {
  return {
    data, now: NOW, cols: 80, rows: 20, baseUrl: "http://router:3456", updatedAgoSec: 3,
    focus: "logs", mode: "view", editBuffer: "", selectedLogIndex: 0, selectedAccountIndex: 0,
    detailsOpen: false, modelsStatus: null, selectedModelIndex: 0, banner: null, ...over,
  };
}

const names = ["lyra", "heewon", "rigel", "kyte", "vega", "intrect", "codex", "nova", "orion", "atlas", "luna", "sol"];
const pool = (n: number) => names.slice(0, n).map(id => account(id));
const manyLogs = (n: number) => Array.from({ length: n }, (_, i) => log({ ts: NOW - i * 3000, accountId: names[i % 5]! }));

describe("term-text", () => {
  it("counts terminal cells, not characters", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("한글")).toBe(4);
    expect(cellWidth("é")).toBe(1);   // e + combining acute
    expect(cellWidth("█░✓▲■↻→")).toBe(7);
  });

  it("cuts to a width and says so", () => {
    expect(truncateCells("abcdef", 4)).toBe("abc…");
    expect(truncateCells("abcdef", 6)).toBe("abcdef");
    expect(truncateCells("한글한글", 5)).toBe("한글…");   // never splits a double-width character
    expect(cellWidth(truncateCells("한글한글", 5))).toBeLessThanOrEqual(5);
    expect(truncateCells("abc", 0)).toBe("");
  });

  it("pads and cuts to exactly the width", () => {
    expect(padCells("ab", 5)).toBe("ab   ");
    expect(padCells("ab", 5, "right")).toBe("   ab");
    expect(padCells("abcdefgh", 5)).toBe("abcd…");
    expect(cellWidth(padCells("한", 5))).toBe(5);
  });

  it("keeps each segment's style when a line is cut", () => {
    const fitted = fitSegs([{ text: "abc", color: "red" }, { text: "defgh", color: "green", bold: true }], 6);
    expect(fitted).toEqual([{ text: "abc", color: "red" }, { text: "de…", color: "green", bold: true }]);
    expect(segsWidth(fitted)).toBe(6);
    expect(fitSegs([{ text: "abc" }], 10)).toEqual([{ text: "abc" }]);
  });
});

describe("planLayout", () => {
  it("reserves an Ollama row without overflowing or taking away the footer", () => {
    for (let rows = 2; rows <= 40; rows++) {
      for (const cols of [40, 80, 110, 160]) {
        const data = health(pool(12), manyLogs(20), {
          ollamaFallback: { enabled: true, ready: true, requests: 5, errors: 1 },
        });
        const { lines, plan } = buildFrame(frameInput(data, { rows, cols }));
        expect(lines.length).toBeLessThanOrEqual(plan.budget);
        expect(lines.every(line => segsWidth(line) <= plan.fit)).toBe(true);
        if (plan.ollamaRow) expect(lines.map(text).join("\n")).toContain("Ollama Cloud");
      }
    }
  });

  it("never spends more than rows - 1 lines, in any pane", () => {
    // Exhaustive and cheap, as long as violations are collected: one expect()
    // per case made this sweep alone outlast the 5 s timeout under a loaded suite.
    const violations: string[] = [];
    for (let rows = 1; rows <= 70; rows++) {
      for (let cols = 1; cols <= 200; cols += 7) {
        for (const accountCount of [0, 1, 5, 12, 40]) {
          for (const region of ["activity", "models"] as const) {
            for (const detailsOpen of [false, true]) {
              const p = planLayout({ rows, cols, accountCount, region, detailsOpen });
              const label = `${cols}x${rows} a=${accountCount} ${region} d=${detailsOpen}`;
              if (p.lines > p.budget) violations.push(`${label}: ${p.lines} lines > budget ${p.budget}`);
              if (p.fit !== Math.max(1, cols - 1)) violations.push(`${label}: fit ${p.fit}`);
            }
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it("shows the strip, every account and a useful log at 80x20 with five accounts", () => {
    const p = planLayout({ rows: 20, cols: 80, accountCount: 5, region: "activity", detailsOpen: false });
    expect(p).toMatchObject({ accountRows: 5, accountFold: false, regionTitle: true, footer: true, minimal: false });
    expect(p.regionBody).toBeGreaterThanOrEqual(10);
    expect(p.details).toBe(false);
  });

  it("gives accounts their rows before the log gets any", () => {
    const p = planLayout({ rows: 12, cols: 80, accountCount: 9, region: "activity", detailsOpen: false });
    expect(p.accountRows).toBe(9);
    expect(p.regionBody).toBe(0);
    expect(p.regionTitle).toBe(false);
  });

  it("folds the account list, and says so, only when it cannot fit", () => {
    const p = planLayout({ rows: 10, cols: 80, accountCount: 12, region: "activity", detailsOpen: false });
    expect(p.accountFold).toBe(true);
    expect(p.accountRows).toBe(6);   // 9 lines - strip - footer = 7, one of them the fold line
  });

  it("opens details only when the log keeps at least four rows beside them", () => {
    const big = planLayout({ rows: 27, cols: 100, accountCount: 5, region: "activity", detailsOpen: true });
    expect(big.details).toBe(true);
    expect(big.regionBody).toBeGreaterThanOrEqual(4);
    const small = planLayout({ rows: 14, cols: 80, accountCount: 5, region: "activity", detailsOpen: true });
    expect(small.details).toBe(false);
    expect(small.detailsSuppressed).toBe(true);
  });

  it("keeps totals and the operations block for panes with room to spare", () => {
    expect(planLayout({ rows: 20, cols: 80, accountCount: 5, region: "activity", detailsOpen: false }).totals).toBe(false);
    expect(planLayout({ rows: 27, cols: 100, accountCount: 5, region: "activity", detailsOpen: false }).totals).toBe(true);
    expect(planLayout({ rows: 27, cols: 140, accountCount: 5, region: "activity", detailsOpen: false }).operations).toBe(false);
    expect(planLayout({ rows: 50, cols: 140, accountCount: 5, region: "activity", detailsOpen: false }).operations).toBe(true);
  });

  it("is down to the verdict alone when the pane is tiny", () => {
    expect(planLayout({ rows: 3, cols: 20, accountCount: 5, region: "activity", detailsOpen: false })).toMatchObject({ minimal: true, lines: 1 });
  });
});

describe("pickAccounts", () => {
  const rungs = ["ok", "ok", "problem", "ok", "watch", "ok", "off"] as const;

  it("takes all of them when they fit", () => {
    expect(pickAccounts(rungs, 7, false, 0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("shows the ones that need a look first when it cannot show them all", () => {
    expect(pickAccounts(rungs, 3, false, 0)).toEqual([0, 2, 4]);   // problem, watch, then the first ok
  });

  it("follows the cursor while the operator is working in the list", () => {
    expect(pickAccounts(rungs, 3, true, 6)).toEqual([4, 5, 6]);
    expect(pickAccounts(rungs, 3, true, 1)).toEqual([0, 1, 2]);
  });
});

describe("the frame", () => {
  it("shows Codex windows and Ollama monthly credits together without inventing 5h or 7d credits", () => {
    const data = health([
      account("lyra"),
      account("codex", { provider: "openai_subscription", rateLimits: { ...limits(0.23, 0.67), plan: "pro" } }),
    ], [], {
      ollamaFallback: {
        enabled: true, ready: true, requests: 4, errors: 0,
        quota: {
          status: "known", source: "https://ollama.com/api/balance", checkedAt: NOW - 30_000,
          balance: { includedUsd: 273.04, allowanceUsd: 300, purchasedUsd: 0 }, resetsAt: NOW + 30 * 86_400_000,
        },
      },
    });
    for (const cols of [80, 110, 160]) {
      const { lines } = buildFrame(frameInput(data, { cols }));
      const codex = lines.map(text).find(line => line.includes("codex"))!;
      expect(codex).toContain("23%");
      expect(codex).toContain("67%");
      if (cols >= 110) expect(codex).toContain("[Codex pro]");
      const ollama = lines.map(text).find(line => line.includes("Ollama Cloud"))!;
      expect(ollama).toContain("monthly $273.04/$300.00 left (9% used)");
      expect(ollama).not.toMatch(/5h|7d/);
    }
  });

  it("keeps an unavailable or expired Ollama credit reading unknown", () => {
    for (const status of ["unavailable", "known"] as const) {
      const data = health([], [], {
        ollamaFallback: {
          enabled: true, ready: true,
          quota: {
            status, source: "https://ollama.com/api/balance", checkedAt: NOW - 60_000,
            balance: { includedUsd: 300, allowanceUsd: 300, purchasedUsd: 0 },
            resetsAt: status === "known" ? NOW - 1 : null,
            reason: status === "unavailable" ? "HTTP 503" : undefined,
          },
        },
      });
      const output = buildFrame(frameInput(data)).lines.map(text).join("\n");
      expect(output).toMatch(/quota (unavailable|reset)/);
      expect(output).not.toContain("0% used");
      expect(output).not.toContain("$300");
    }
  });

  it("marks Ollama credit exhaustion instead of reporting ready, while preserving prepaid capacity", () => {
    for (const purchasedUsd of [0, 5]) {
      const data = health([], [], {
        ollamaFallback: {
          enabled: true, ready: true,
          quota: { status: "known", source: "https://ollama.com/api/balance", checkedAt: NOW, balance: { includedUsd: 0, allowanceUsd: 300, purchasedUsd }, resetsAt: NOW + 60_000 },
        },
      });
      const line = buildFrame(frameInput(data, { cols: 160 })).lines.find(line => text(line).includes("Ollama Cloud"))!;
      if (purchasedUsd === 0) {
        expect(text(line)).toContain("credits exhausted");
        expect(line.find(seg => seg.text === "Ollama Cloud")?.color).toBe("red");
      } else {
        expect(text(line)).toContain("ready");
        expect(text(line)).toContain("+$5.00 prepaid");
      }
    }
  });

  it("fits every pane: never taller than rows - 1, never wider than cols - 1, strip first", () => {
    const logs = [
      ...manyLogs(30),
      log({ type: "error", statusCode: 429, details: "rate limited (5-hour limit) — cooldown 18000s — upstream said: 한글 오류 메시지 and a very long reason that goes on and on and on" }),
      log({ accountId: "한글계정이름이아주긴계정", details: "line\u001b[31mred\u0007 bell" }),
    ];
    const bad = account("rigel", { coolingUntil: NOW + 4 * MIN });
    const datas = [pool(1), pool(5), [bad, ...pool(11)], [] as AccountStat[]].map(a => health(a, logs));
    const foci = ["logs", "accounts", "models"] as const;
    // Width-tier edges: each pair straddles a point where the layout changes.
    const edgeCols = [24, 30, 40, 59, 60, 66, 79, 80, 100, 109, 110, 140, 200];
    // Violations are collected, not asserted one by one: thousands of frames run here.
    const violations: string[] = [];
    const seen = new Set<string>();
    const combos = new Set<string>();
    const check = (data: HealthData, cols: number, rows: number, detailsOpen: boolean, focus: typeof foci[number], tag: string) => {
      const label = `${cols}x${rows} accounts=${data.accounts.length} ${focus} d=${detailsOpen}${tag}`;
      if (seen.has(label)) return;
      seen.add(label);
      const fixture = datas.indexOf(data);
      if (fixture >= 0) combos.add(`${fixture} ${focus} ${detailsOpen}`);
      const { lines } = buildFrame(frameInput(data, { cols, rows, detailsOpen, focus }));
      if (lines.length > rows - 1 || lines.length < 1) violations.push(`${label}: ${lines.length} lines`);
      for (const l of lines) if (segsWidth(l) > cols - 1) violations.push(`${label}: wide line ${text(l)}`);
      if (!/CC-Router|CC-R|…/.test(text(lines[0]!))) violations.push(`${label}: strip is not first: ${text(lines[0]!)}`);
    };

    // 1. Every height at every edge width, three of the 24 content/focus/details
    //    combinations per cell, rotated so each combination recurs across sizes.
    //    (Every combination at every cell was 18k frames, too slow for a loaded suite.)
    for (let rows = 3; rows <= 60; rows++) {
      edgeCols.forEach((cols, ci) => {
        for (let k = 0; k < 3; k++) {
          const c = ((rows * edgeCols.length + ci) * 3 + k) % 24;
          check(datas[c % 4]!, cols, rows, c % 8 >= 4, foci[c % 3]!, "");
        }
      });
    }
    // 2. The worst content in full at the small heights, where folding and
    //    details decisions change from one row to the next.
    for (let rows = 3; rows <= 24; rows++) {
      for (const cols of edgeCols) for (const detailsOpen of [false, true]) for (const focus of foci) {
        check(datas[2]!, cols, rows, detailsOpen, focus, "");
      }
    }
    // 3. A seeded sample of sizes and pool sizes the grid never names.
    const seed = 0x5eed_cc01;
    let state = seed;
    const rnd = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 800; i++) {
      const n = Math.floor(rnd() * 41);
      const accounts = Array.from({ length: n }, (_, j) => account(`a${j}`, j % 7 === 3 ? { coolingUntil: NOW + 4 * MIN } : {}));
      const data = health(accounts, logs);
      check(data, 24 + Math.floor(rnd() * 237), 3 + Math.floor(rnd() * 78), rnd() < 0.5, foci[Math.floor(rnd() * 3)]!, ` seed=${seed.toString(16)}#${i}`);
    }

    expect(combos.size).toBe(24);
    expect(seen.size).toBeGreaterThan(3_500);
    expect(violations.slice(0, 5)).toEqual([]);
  }, 60_000);

  it("never lets a control character through to the terminal", () => {
    const data = health(pool(2), [log({ details: "evil\u001b[2J\u0007", accountId: "a\u001bb" })]);
    const { lines } = buildFrame(frameInput(data, { cols: 120, rows: 30, detailsOpen: true }));
    expect(lines.map(text).join("\n")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("leads with the verdict: quiet when healthy", () => {
    const { lines } = buildFrame(frameInput(health(pool(5), manyLogs(10))));
    expect(text(lines[0]!)).toContain("CC-Router");
    expect(text(lines[0]!)).toContain("✓ All 5 accounts healthy");
    expect(text(lines[0]!)).not.toMatch(/Problem|Watch/);
  });

  it("leads with the problem when there is one, worst first", () => {
    const accounts = [account("lyra", { rateLimits: limits(0.96) }), account("rigel", { coolingUntil: NOW + 4 * MIN }), ...pool(3).slice(2)];
    const { lines } = buildFrame(frameInput(health(accounts, manyLogs(10))));
    expect(text(lines[0]!)).toContain("■ Problem — lyra 5h 96% · rigel cooling 4m");
    expect(lines[0]![2]).toMatchObject({ color: "red", bold: true });
  });

  it("shows every account on its own line at 80x20, with its state and quota", () => {
    const accounts = [account("lyra"), account("heewon", { rateLimits: limits(0.84, 0.3) }), account("rigel", { coolingUntil: NOW + 4 * MIN }),
      account("kyte", { enabled: false, healthy: false }), account("vega", { rateLimits: limits(0.96, 0.9) })];
    const { lines, plan } = buildFrame(frameInput(health(accounts, manyLogs(20)), { cols: 80, rows: 20 }));
    expect(lines.length).toBeLessThanOrEqual(19);
    const rows = lines.slice(1, 1 + 5).map(text);
    expect(rows.map(r => r.slice(0, 20))).toEqual(expect.arrayContaining([expect.stringContaining("lyra")]));
    expect(rows[0]).toMatch(/✓ lyra\s+ok\s+5h [█░]{8}\s+41%\s+↻2h36m\s+7d [█░]{8}\s+10%/);
    expect(rows[1]).toMatch(/▲ heewon\s+hot\s+5h .*84%/);
    expect(rows[2]).toMatch(/■ rigel\s+COOL 4m/);
    expect(rows[3]).toMatch(/– kyte\s+off/);
    expect(rows[4]).toMatch(/■ vega\s+NEAR\s+5h .*96%/);
    expect(plan.accountFold).toBe(false);
  });

  it("says 'no reading' for a window that was never measured, never 0%", () => {
    const fresh = account("lyra", { rateLimits: { ...limits(0), lastUpdated: 0, fiveHourReset: 0, sevenDayReset: 0 } });
    const none = account("heewon", { rateLimits: undefined });
    const { lines } = buildFrame(frameInput(health([fresh, none]), { cols: 100 }));
    const joined = lines.slice(1, 3).map(text).join("\n");
    expect(joined).toContain("not measured yet");
    expect(joined).not.toMatch(/\b0%/);
  });

  it("degrades the account line with the pane, dropping extras before the quota", () => {
    const a = account("lyra", { sessionLimitPercent: 80, coolingUntil: undefined });
    const s = computeSeverity([a], [], NOW).accounts[0]!;
    const th = { watch: 0.8, problem: 0.95 };
    const plan = (cols: number) => ({ width: planLayout({ rows: 30, cols, accountCount: 1, region: "activity", detailsOpen: false }).width, fit: cols - 1 });
    const wide = text(accountLine(a, s, plan(160), false, NOW, th));
    expect(wide).toContain("[Max 20x]");
    expect(wide).toMatch(/req\s+1234\s+err\s+0/);
    expect(wide).toMatch(/cap 5h≤80%/);
    const normal = text(accountLine(a, s, plan(80), false, NOW, th));
    expect(normal).not.toContain("[Max 20x]");
    expect(normal).toMatch(/5h [█░]{8}\s+41%/);
    const narrow = text(accountLine(a, s, plan(66), false, NOW, th));
    expect(narrow).not.toMatch(/[█░]/);
    expect(narrow).toMatch(/5h\s+41%\s+↻2h36m/);
    const tiny = text(accountLine(a, s, plan(44), false, NOW, th));
    expect(tiny).toMatch(/5h\s+41%\s+7d\s+10%/);
    expect(cellWidth(tiny)).toBeLessThanOrEqual(43);
  });

  it("says a 7-day window is absent only when upstream has said none exists, and in plain words when it has not", () => {
    const noWeekly = { ...limits(0.3), sevenDayUtil: 0, sevenDayReset: 0 };
    const row = (weeklyWindow: AccountStat["weeklyWindow"], cols = 80) =>
      text(buildFrame(frameInput(health([account("lyra", { rateLimits: noWeekly, weeklyWindow })]), { cols })).lines[1]!);
    expect(row("not-reported")).toContain("7d no 7d window");
    expect(row("unknown")).toContain("7d no reading");
    expect(row(undefined)).toContain("7d no reading");
    expect(row("seen")).toContain("7d no reading");   // it has a window; this reading just lost it to a roll-over
    expect(row("not-reported", 66)).toMatch(/7d\s+—/);   // narrow panes show a dash, as before
  });

  it("puts the age of an old reading beside the warning, in the state column and in the strip", () => {
    const idle = account("kyte", { rateLimits: { ...limits(0), fiveHourUtil: 0, fiveHourReset: 0, sevenDayUtil: 0.88, lastUpdated: NOW - 43 * 60 * MIN } });
    const live = account("lyra", { rateLimits: limits(0.84) });
    const { lines } = buildFrame(frameInput(health([live, idle], manyLogs(3))));
    const joined = lines.map(text);
    expect(joined[0]).toContain("Watch — lyra 5h 84% · kyte 7d 88% · 43h old");
    expect(joined.slice(1).find(l => l.includes("kyte"))).toMatch(/▲ kyte\s+hot 43h\s+5h/);
    // The live account's state word has no age, so a warning on fresh data is not cluttered.
    expect(joined.slice(1).find(l => l.includes("lyra"))).toMatch(/▲ lyra\s+hot\s{3,}5h/);
    // The age must still fit the state column on a near-limit row.
    expect(cellWidth("NEAR 100d")).toBeLessThanOrEqual(9);
  });

  it("colours a window red once it reaches the routing cap, not only the problem line", () => {
    const a = account("lyra", { sessionLimitPercent: 40 });
    const s = computeSeverity([a], [], NOW).accounts[0]!;
    const line = accountLine(a, s, { width: "normal", fit: 79 }, false, NOW, { watch: 0.8, problem: 0.95 });
    const bar = line.find(seg => /[█░]/.test(seg.text));
    expect(bar?.color).toBe("red");
  });

  it("folds the account list with a line that says what was left out", () => {
    // Seven accounts in trouble and five fine, in a pane with room for six rows of them.
    const accounts = [...pool(5).map(a => account(a.id)), ...names.slice(5, 12).map(id => account(id, { healthy: false }))];
    const { lines, plan } = buildFrame(frameInput(health(accounts, manyLogs(5)), { cols: 80, rows: 10 }));
    expect(plan.accountFold).toBe(true);
    const joined = lines.map(text);
    const fold = joined.find(l => /^ {3}\+\d+ more/.test(l));
    expect(fold).toBe("   +6 more (1 needs a look — Tab, then ↑↓)");
    // What is on screen is the trouble, though most of it is late in the list.
    expect(joined.filter(l => l.includes("ERROR"))).toHaveLength(6);
  });

  it("calls a fold 'all fine' when only healthy accounts were left out", () => {
    const accounts = [...pool(11), account("rigel", { healthy: false })];
    const { lines } = buildFrame(frameInput(health(accounts, manyLogs(5)), { cols: 80, rows: 10 }));
    const joined = lines.map(text);
    expect(joined.some(l => l.includes("rigel"))).toBe(true);
    expect(joined.find(l => /^ {3}\+\d+ more/.test(l))).toMatch(/all fine/);
  });

  it("draws the log in what the accounts leave, newest first, with the selection marked", () => {
    const { lines, plan } = buildFrame(frameInput(health(pool(5), manyLogs(40)), { cols: 100, rows: 27, selectedLogIndex: 2 }));
    const at = lines.findIndex(l => text(l).includes("RECENT ACTIVITY"));
    expect(at).toBeGreaterThan(0);
    const rows = lines.slice(at + 1, lines.length - 1);
    expect(rows).toHaveLength(Math.min(LOG_VISIBLE, plan.regionBody));
    expect(text(rows[2]!)).toContain("▶");
    expect(rows[2]![0]).toMatchObject({ text: "▶ " });
    expect(text(rows[0]!)).not.toContain("▶");
  });

  it("keeps an error row's reason when the line has to be cut", () => {
    const errorRow = log({
      type: "error", statusCode: 429, durationMs: 9, accountId: "rigel",
      details: "rate limited (5-hour limit) — cooldown 18000s",
    });
    const line = text(logLine(errorRow, false, { width: "normal", fit: 79 }));
    expect(line).toContain("429");
    expect(line).toContain("rate limited (5-hour limit)");
    expect(line).not.toContain("↑");     // the cache figure went first
    expect(cellWidth(line)).toBeLessThanOrEqual(79);
  });

  it("opens details on request, at a fixed height, and says when the pane cannot", () => {
    const data = health(pool(5), manyLogs(30));
    const closed = buildFrame(frameInput(data, { cols: 100, rows: 30 }));
    expect(closed.lines.map(text).join("\n")).not.toContain("DETAILS");
    const open = buildFrame(frameInput(data, { cols: 100, rows: 30, detailsOpen: true }));
    const at = open.lines.findIndex(l => text(l).includes("DETAILS"));
    expect(at).toBeGreaterThan(0);
    expect(open.lines.slice(at, at + DETAILS_LINES)).toHaveLength(DETAILS_LINES);
    expect(open.lines.length).toBeLessThanOrEqual(29);

    const tooSmall = buildFrame(frameInput(data, { cols: 80, rows: 14, detailsOpen: true }));
    expect(tooSmall.lines.map(text).join("\n")).not.toContain("DETAILS");
    expect(text(tooSmall.lines.at(-1)!)).toContain("too short for details");
  });

  it("lays details out in full when the pane is wide enough", () => {
    const lines = detailLines(log({ details: "all Anthropic accounts exhausted" }), 140).map(text);
    expect(lines).toHaveLength(DETAILS_LINES);
    expect(lines[0]).toMatch(/DETAILS.*Account: lyra/);
    expect(lines[1]).toContain("Method: POST");
    expect(lines[2]).toContain("Session: fb61c7c5");
    expect(lines[3]).toContain("Status: 200 OK");
    expect(lines[4]).toContain("Details: all Anthropic accounts exhausted");
    expect(lines[5]).toMatch(/Cache hit: 532\.3k \(99\.5%\).*total: 535\.3k/);
  });

  it("shows the models list in place of the log, bounded by the pane", () => {
    const models = Array.from({ length: 40 }, (_, i) => ({ id: `anthropic/model-${i}` }));
    const { lines, plan } = buildFrame(frameInput(health(pool(5), manyLogs(10)), {
      cols: 80, rows: 20, focus: "models", modelsStatus: { routing: { anthropicDefaultModel: "model-3" }, models }, selectedModelIndex: 30,
    }));
    const joined = lines.map(text).join("\n");
    expect(joined).toContain("MODELS");
    expect(joined).not.toContain("RECENT ACTIVITY");
    expect(joined).toContain("model-30");
    expect(lines.length).toBeLessThanOrEqual(plan.budget);
  });

  it("takes the footer for a prompt or a message, and the keys otherwise", () => {
    const data = health(pool(2), manyLogs(5));
    const hint = text(buildFrame(frameInput(data, { focus: "accounts" })).lines.at(-1)!);
    expect(hint).toContain("q quit");
    expect(hint).toContain("e on/off");
    expect(text(buildFrame(frameInput(data, { mode: "editSession", editBuffer: "85" })).lines.at(-1)!)).toContain("Set 5h cap for lyra (0–100%): 85");
    expect(text(buildFrame(frameInput(data, { mode: "confirmDelete" })).lines.at(-1)!)).toContain('Delete "lyra"?');
    expect(text(buildFrame(frameInput(data, { banner: { text: "lyra → disabled", color: "yellow" } })).lines.at(-1)!)).toContain("lyra → disabled");
  });

  it("agrees with the router's own verdict, and computes one when an older router sends none", () => {
    const accounts = [account("lyra", { rateLimits: limits(0.9) }), account("rigel", { coolingUntil: NOW + 4 * MIN })];
    const data = health(accounts, manyLogs(6));
    const own = buildFrame(frameInput(data));
    const sent = buildFrame(frameInput(data, { severity: computeSeverity(accounts, data.recentLogs, NOW) }));
    expect(own.lines.map(text)).toEqual(sent.lines.map(text));
  });

  it("shows the verdict alone in a pane too small for anything else", () => {
    const { lines } = buildFrame(frameInput(health(pool(5)), { cols: 20, rows: 3 }));
    expect(lines).toHaveLength(1);
    expect(segsWidth(lines[0]!)).toBeLessThanOrEqual(19);
  });

  it("states the strip's right side only when there is room for it", () => {
    const sev = computeSeverity(pool(2), [], NOW);
    const data = health(pool(2));
    expect(text(stripLine(sev, data, 3, 99))).toMatch(/up 2h 5m · 3s ago\s*$/);
    expect(text(stripLine(sev, data, 3, 40))).not.toContain("up ");
  });
});
