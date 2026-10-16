import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lets one test make rename() fail the way a bind-mounted file does. Everything
// else goes straight through to the real fs.
const fsFault = vi.hoisted(() => ({ renameCode: null as string | null }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fsFault.renameCode && String(from).endsWith(".tmp")) {
        const err = new Error("simulated") as NodeJS.ErrnoException;
        err.code = fsFault.renameCode;
        throw err;
      }
      return actual.renameSync(from, to);
    },
  };
});

import { readUsageFile, writeUsageFile, quarantineUsageFile, createUsageFlusher } from "../config/usage-store.js";
import { UsageHistory, type UsageFile } from "../proxy/usage-history.js";

const FILE: UsageFile = { version: 1, since: 1_700_000_000_000, rows: [[1_700_000_000, "anthropic", "m", 1, 2, 3, 4, 1]] };
const mode = (p: string) => statSync(p).mode & 0o777;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cc-router-usage-store-")); fsFault.renameCode = null; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeUsageFile / readUsageFile", () => {
  it("round-trips a file, owner-only, leaving no temp file behind", () => {
    const path = join(dir, "usage.json");
    expect(writeUsageFile(path, FILE)).toEqual({ ok: true });
    expect(readUsageFile(path)).toEqual({ status: "ok", data: FILE });
    expect(mode(path)).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("creates the parent directory, owner-only", () => {
    const path = join(dir, "nested", "deeper", "usage.json");
    expect(writeUsageFile(path, FILE).ok).toBe(true);
    expect(mode(join(dir, "nested"))).toBe(0o700);
  });

  it("tightens permissions even when a stale temp file with looser ones was in the way", () => {
    const path = join(dir, "usage.json");
    writeFileSync(`${path}.tmp`, "stale");
    chmodSync(`${path}.tmp`, 0o644);
    writeUsageFile(path, FILE);
    expect(mode(path)).toBe(0o600);
  });

  it("replaces an existing file whole", () => {
    const path = join(dir, "usage.json");
    writeUsageFile(path, FILE);
    const next: UsageFile = { version: 1, since: null, rows: [] };
    writeUsageFile(path, next);
    expect(readUsageFile(path)).toEqual({ status: "ok", data: next });
  });

  it("reports a missing file as missing", () => {
    expect(readUsageFile(join(dir, "nope.json"))).toEqual({ status: "missing" });
  });

  it("reports a failure instead of throwing", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "x");
    const r = writeUsageFile(join(blocker, "usage.json"), FILE); // parent is a file
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\S/);
  });

  it("writes in place when the file cannot be replaced by rename (a bind-mounted file)", () => {
    const path = join(dir, "usage.json");
    writeFileSync(path, "old");
    fsFault.renameCode = "EBUSY";
    expect(writeUsageFile(path, FILE)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(FILE);
    expect(mode(path)).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("does not paper over a rename failure that is not about the mount", () => {
    fsFault.renameCode = "EACCES";
    expect(writeUsageFile(join(dir, "usage.json"), FILE).ok).toBe(false);
  });
});

describe("a file that is not JSON", () => {
  it("is moved aside, not left to be overwritten by the next save", () => {
    const path = join(dir, "usage.json");
    writeFileSync(path, "{ truncated");
    const r = readUsageFile(path);
    expect(r).toEqual({ status: "corrupt", movedTo: `${path}.corrupt` });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe("{ truncated");
    writeUsageFile(path, FILE);
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe("{ truncated");
  });

  it("keeps one copy: a second corruption replaces the first", () => {
    const path = join(dir, "usage.json");
    writeFileSync(path, "first");
    readUsageFile(path);
    writeFileSync(path, "second");
    readUsageFile(path);
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe("second");
  });

  it("quarantine reports null when there was nothing to move", () => {
    expect(quarantineUsageFile(join(dir, "absent.json"))).toBeNull();
  });
});

describe("createUsageFlusher", () => {
  const NOW = Date.UTC(2026, 9, 16, 12, 30);
  const sample = (h: UsageHistory) => h.record({ ts: NOW, provider: "anthropic", model: "m", input: 1, request: true });
  const fresh = () => new UsageHistory({ now: () => NOW });

  it("writes nothing while nothing has changed", () => {
    const h = fresh();
    const write = vi.fn(() => ({ ok: true as const }));
    createUsageFlusher(h, "p", () => {}, write)();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes once per change and marks clean afterwards", () => {
    const h = fresh();
    const write = vi.fn(() => ({ ok: true as const }));
    const flush = createUsageFlusher(h, "p", () => {}, write);
    sample(h);
    flush();
    flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.dirty).toBe(false);
    sample(h);
    flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("stays dirty after a failed write so the next tick retries it", () => {
    const h = fresh();
    sample(h);
    let ok = false;
    const write = vi.fn(() => (ok ? { ok: true as const } : { ok: false as const, error: "disk full" }));
    const flush = createUsageFlusher(h, "p", () => {}, write);
    flush();
    expect(h.dirty).toBe(true);
    ok = true;
    flush();
    expect(h.dirty).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("warns once for a disk that stays broken, and again only after a success re-armed it", () => {
    const h = fresh();
    sample(h);
    let ok = false;
    const warn = vi.fn();
    const flush = createUsageFlusher(h, "/x/usage.json", warn, () => (ok ? { ok: true } : { ok: false, error: "disk full" }));
    flush(); flush(); flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("/x/usage.json");
    expect(warn.mock.calls[0][0]).toContain("disk full");
    ok = true;
    flush();
    ok = false;
    sample(h);
    flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("saves what the history holds, byte for byte through a real round trip", () => {
    const h = fresh();
    sample(h);
    const path = join(dir, "usage.json");
    createUsageFlusher(h, path, () => {})();
    const back = new UsageHistory({ now: () => NOW });
    const r = readUsageFile(path);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(back.restore(r.data)).toBe(true);
    expect(back.buckets()).toEqual(h.buckets());
    expect(back.since).toBe(h.since);
  });
});
