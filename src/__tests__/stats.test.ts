import { describe, expect, it } from "vitest";
import { ProxyStats } from "../proxy/stats.js";

function add(stats: ProxyStats, accountId: string, ts: number) {
  stats.addLog({ ts, accountId, model: "-", type: "route" });
}

describe("ProxyStats.getRecentLogs", () => {
  it("returns newest entries first when every account is represented", () => {
    const stats = new ProxyStats();
    add(stats, "a", 1); add(stats, "b", 2); add(stats, "a", 3);

    expect(stats.getRecentLogs(3).map(e => e.ts)).toEqual([3, 2, 1]);
  });

  it("preserves the newest entry for a quiet account outside the plain last-N window", () => {
    const stats = new ProxyStats();
    add(stats, "codex", 1);
    for (let i = 2; i <= 100; i++) add(stats, i % 2 ? "intrect" : "kyte", i);

    const visible = stats.getRecentLogs(10);

    expect(visible).toHaveLength(10);
    expect(visible.some(e => e.accountId === "codex")).toBe(true);
    expect(visible.some(e => e.accountId === "intrect")).toBe(true);
    expect(visible.some(e => e.accountId === "kyte")).toBe(true);
    expect(visible.map(e => e.ts)).toEqual([...visible.map(e => e.ts)].sort((a, b) => b - a));
  });

  it("keeps only the newest event for the quiet account", () => {
    const stats = new ProxyStats();
    add(stats, "codex", 1); add(stats, "codex", 2);
    for (let i = 3; i <= 20; i++) add(stats, "intrect", i);

    const visible = stats.getRecentLogs(5);
    expect(visible.find(e => e.accountId === "codex")?.ts).toBe(2);
  });

  it("handles zero and a limit smaller than the number of accounts", () => {
    const stats = new ProxyStats();
    add(stats, "a", 1); add(stats, "b", 2); add(stats, "c", 3);

    expect(stats.getRecentLogs(0)).toEqual([]);
    expect(stats.getRecentLogs(2)).toHaveLength(2);
    expect(stats.getRecentLogs(2).map(e => e.accountId)).toEqual(["c", "b"]);
  });
});
