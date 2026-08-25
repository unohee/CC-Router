import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { semverDiff } from "../utils/self-update.js";

describe("semverDiff", () => {
  it("reports how far ahead the registry is", () => {
    expect(semverDiff("0.6.2", "1.0.0")).toBe("major");
    expect(semverDiff("0.6.2", "0.7.0")).toBe("minor");
    expect(semverDiff("0.6.2", "0.6.3")).toBe("patch");
    expect(semverDiff("0.6.2", "0.6.2")).toBeNull();
  });

  it("never reads an older registry version as an update", () => {
    // The exact case that downgraded a local 0.7.0 dev build to the published
    // 0.6.2: per-digit fall-through saw 2 > 0 in the patch slot.
    expect(semverDiff("0.7.0", "0.6.2")).toBeNull();
    expect(semverDiff("1.0.0", "0.9.9")).toBeNull();
    expect(semverDiff("0.6.3", "0.6.2")).toBeNull();
  });

  it("a higher major wins even when lower positions are behind", () => {
    expect(semverDiff("0.9.9", "1.0.0")).toBe("major");
    expect(semverDiff("0.6.9", "0.7.0")).toBe("minor");
  });
});

describe("isLinkedInstall", () => {
  const argv1 = process.argv[1];
  let roots: string[] = [];

  afterEach(() => {
    process.argv[1] = argv1;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * A package root laid out the way the real thing is: a manifest at the top
   * and the compiled entry point under `dist/cli`.
   */
  function makeRoot(opts: { insideNodeModules?: boolean; git?: boolean; name?: string }): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "linked-")));
    roots.push(base);
    const root = opts.insideNodeModules
      ? join(base, "lib", "node_modules", "ai-cc-router")
      : join(base, "checkout");
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: opts.name ?? "ai-cc-router", version: "0.7.0" }));
    writeFileSync(join(root, "dist", "cli", "index.js"), "// entry\n");
    if (opts.git) mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }

  async function detectFrom(root: string): Promise<boolean> {
    process.argv[1] = join(root, "dist", "cli", "index.js");
    vi.resetModules();   // the answer is memoised per module instance
    const { isLinkedInstall } = await import("../utils/self-update.js");
    return isLinkedInstall();
  }

  it("calls a checkout outside node_modules a linked install", async () => {
    // This is what `npm link` leaves behind: the global path is a symlink and
    // the code actually runs from somebody's working tree.
    expect(await detectFrom(makeRoot({ git: true }))).toBe(true);
  });

  it("recognises a checkout even without a .git directory", async () => {
    // A worktree, an export, a tarball unpacked somewhere — still not a package
    // npm installed, so still not ours to overwrite.
    expect(await detectFrom(makeRoot({ git: false }))).toBe(true);
  });

  it("does not claim an ordinary global install", async () => {
    // The case that must keep updating normally.
    expect(await detectFrom(makeRoot({ insideNodeModules: true }))).toBe(false);
  });

  it("calls a git checkout inside node_modules linked too", async () => {
    // `npm link` into a nested project puts a symlink under node_modules that
    // resolves to a checkout. The path shape alone would miss it.
    expect(await detectFrom(makeRoot({ insideNodeModules: true, git: true }))).toBe(true);
  });

  it("refuses when it cannot identify the package at all", async () => {
    // Deliberately INSIDE node_modules with a foreign name. That is the only
    // shape where the name check is observable: with it, no manifest matches,
    // the root is unknown, and the fail-closed branch answers true; without
    // it, the foreign manifest is accepted and the path-shape branch answers
    // false. Outside node_modules both answers are true and the check is
    // unpinned.
    expect(await detectFrom(makeRoot({ insideNodeModules: true, name: "something-else" }))).toBe(true);
  });

  it("refuses when the manifest cannot be parsed", async () => {
    // An unresolved merge conflict in package.json is a state only a working
    // tree gets into, and it is the state where guessing is worst.
    const root = makeRoot({ insideNodeModules: true });
    writeFileSync(join(root, "package.json"), "{ <<<<<<< HEAD");
    expect(await detectFrom(root)).toBe(true);
  });

  it("refuses when there is no script path to reason from", async () => {
    process.argv[1] = "";
    vi.resetModules();
    const { isLinkedInstall } = await import("../utils/self-update.js");
    expect(isLinkedInstall()).toBe(true);
  });
});

describe("performUpdate", () => {
  const argv1 = process.argv[1];
  afterEach(() => { process.argv[1] = argv1; vi.resetModules(); vi.restoreAllMocks(); });

  it("refuses to install over a linked checkout, and spawns nothing", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "linked-perform-")));
    try {
      const root = join(base, "checkout");
      mkdirSync(join(root, "dist", "cli"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ai-cc-router", version: "0.7.0" }));
      writeFileSync(join(root, "dist", "cli", "index.js"), "// entry\n");
      process.argv[1] = join(root, "dist", "cli", "index.js");

      const spawn = vi.fn();
      vi.resetModules();
      vi.doMock("child_process", async () => ({
        ...(await vi.importActual<typeof import("child_process")>("child_process")),
        spawn,
      }));
      const { performUpdate } = await import("../utils/self-update.js");

      await expect(performUpdate("9.9.9")).resolves.toBe(false);
      // The refusal has to happen before npm is reached — a spawn that failed
      // for some other reason would look the same from the return value.
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("child_process");
      rmSync(base, { recursive: true, force: true });
    }
  });
});
