import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OllamaDailyBudget,
  dayString,
  resolveOllamaDailyBudgetConfig,
  type OllamaBudgetBalance,
} from "../providers/ollama/daily-budget.js";

// 2026-10-27 03:00 KST = 2026-10-26T18:00:00Z
const NOW = Date.parse("2026-10-26T18:00:00Z");
const bal = (includedUsd: number, resetsAtDays = 24): OllamaBudgetBalance => ({
  includedUsd, resetsAt: NOW + resetsAtDays * 86_400_000, checkedAt: NOW,
});
const mk = (config = { monthlyUsd: 300 }, opts: { now?: () => number; statePath?: string } = {}) =>
  new OllamaDailyBudget({ config: { monthlyUsd: config.monthlyUsd, tz: undefined, reserveUsd: 0 }, statePath: opts.statePath, now: opts.now ?? (() => NOW) });

describe("resolveOllamaDailyBudgetConfig", () => {
  it("is off unless enabled, and enabled without a figure is off, not free", () => {
    expect(resolveOllamaDailyBudgetConfig(undefined)).toBeNull();
    expect(resolveOllamaDailyBudgetConfig({ enabled: false, monthlyUsd: 300 })).toBeNull();
    expect(resolveOllamaDailyBudgetConfig({ enabled: true })).toBeNull();
    expect(resolveOllamaDailyBudgetConfig({ enabled: true, monthlyUsd: 0 })).toBeNull();
    expect(resolveOllamaDailyBudgetConfig({ enabled: true, monthlyUsd: 300 })?.monthlyUsd).toBe(300);
  });

  it("keeps a negative monthly, a bad zone and a negative reserve from becoming a free pass", () => {
    expect(resolveOllamaDailyBudgetConfig({ enabled: true, monthlyUsd: -5 })).toBeNull();
    expect(resolveOllamaDailyBudgetConfig({ enabled: true, monthlyUsd: 300, tz: "not/a-zone" })?.tz).toBeUndefined();
    expect(resolveOllamaDailyBudgetConfig({ enabled: true, monthlyUsd: 300, reserveUsd: -1 })?.reserveUsd).toBe(0);
  });
});

describe("OllamaDailyBudget", () => {
  it("splits the remaining credit over the budget days left in the period", () => {
    // $300 left with 24 days remaining → $12.50/day.
    expect(mk().verdict(bal(300)).budgetUsd).toBe(12.5);
    expect(mk().verdict(bal(150)).budgetUsd).toBe(6.25);
  });

  it("refuses once today's allowance is spent, and resets the next day", () => {
    const b = mk();
    b.observe(bal(300));
    // Today's budget is $12.50. Spend it all via one balance drop.
    b.observe(bal(300 - 12.5));
    expect(b.verdict(bal(287.5)).allow).toBe(false);
    expect(b.verdict(bal(287.5))).toMatchObject({ reason: "budget-exhausted", spentUsd: 12.5 });
    // Next day: fresh allowance against the same remaining balance.
    const tomorrow = new OllamaDailyBudget({ config: { monthlyUsd: 300, tz: undefined, reserveUsd: 0 }, now: () => NOW + 86_400_000 });
    expect(tomorrow.verdict(bal(287.5, 23)).allow).toBe(true);
  });

  it("counts an account-sharing drop as if it were ours", () => {
    const b = mk();
    b.observe(bal(300));
    b.observe(bal(200)); // $100 spent elsewhere shows up as a drop
    expect(b.verdict(bal(200)).spentUsd).toBe(100);
  });

  it("ignores a refill or a new period — the balance rising is never spend", () => {
    const b = mk();
    b.observe(bal(100));
    b.observe(bal(150)); // refill
    expect(b.verdict(bal(150)).spentUsd).toBe(0);
    // Same balance, a new period: resetsAt changed, so no delta is attributed.
    const next = { ...bal(150), resetsAt: NOW + 55 * 86_400_000 };
    b.observe(next);
    expect(b.verdict(next).spentUsd).toBe(0);
  });

  it("stops at the reserve floor even while today's allowance has room", () => {
    const b = new OllamaDailyBudget({ config: { monthlyUsd: 300, tz: undefined, reserveUsd: 5 }, now: () => NOW });
    const v = b.verdict(bal(5));
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("reserve-exhausted");
  });

  it("refuses while the balance is unknown rather than serving blind", () => {
    const v = mk().verdict(null);
    expect(v).toMatchObject({ allow: false, reason: "balance-unknown", budgetUsd: null });
  });

  it("survives a restart: today's spend is read back from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-budget-"));
    const path = join(dir, "ollama-budget.json");
    const b = new OllamaDailyBudget({ config: { monthlyUsd: 300, tz: undefined, reserveUsd: 0 }, statePath: path, now: () => NOW });
    b.observe(bal(300));
    b.observe(bal(288));
    const again = new OllamaDailyBudget({ config: { monthlyUsd: 300, tz: undefined, reserveUsd: 0 }, statePath: path, now: () => NOW });
    expect(again.verdict(bal(288)).spentUsd).toBe(12);
  });

  it("yesterday's file never opens the new day mid-spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-budget-"));
    const path = join(dir, "ollama-budget.json");
    writeFileSync(path, JSON.stringify({ version: 1, day: "2026-10-26", spentUsd: 9 }));
    const b = new OllamaDailyBudget({ config: { monthlyUsd: 300, tz: undefined, reserveUsd: 0 }, statePath: path, now: () => NOW + 86_400_000 });
    expect(b.verdict(bal(300, 23)).spentUsd).toBe(0);
  });

  it("names days in the configured zone", () => {
    // 2026-10-26T18:00Z: Seoul has rolled to Oct 27, UTC has not.
    expect(dayString(NOW, "Asia/Seoul")).toBe("2026-10-27");
    expect(dayString(NOW, "UTC")).toBe("2026-10-26");
  });
});
