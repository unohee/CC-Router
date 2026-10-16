import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";

// paths.ts reads the environment once, at import, so each case sets the
// environment first and imports a fresh copy.
async function loadPaths(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, ""); else vi.stubEnv(k, v);
    if (v === undefined) delete process.env[k];
  }
  return import("../config/paths.js");
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("USAGE_PATH", () => {
  it("defaults to sit beside accounts.json, wherever that is pointed", async () => {
    const p = await loadPaths({ ACCOUNTS_PATH: "/data/cfg/accounts.json", USAGE_PATH: undefined });
    expect(p.USAGE_PATH).toBe(join("/data/cfg", "usage.json"));
  });

  it("can be set explicitly", async () => {
    const p = await loadPaths({ ACCOUNTS_PATH: "/data/cfg/accounts.json", USAGE_PATH: "/elsewhere/u.json" });
    expect(p.USAGE_PATH).toBe("/elsewhere/u.json");
  });

  it("treats an empty value as unset, instead of saving to a file called ''", async () => {
    const p = await loadPaths({ ACCOUNTS_PATH: "/data/cfg/accounts.json", USAGE_PATH: "" });
    expect(p.USAGE_PATH).toBe(join("/data/cfg", "usage.json"));
  });
});
