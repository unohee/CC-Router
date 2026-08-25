import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The start path is where an update actually gets performed, and where it once
 * threw out of startup. These drive `maybeUpdate` with the surrounding calls
 * mocked, so a regression shows up as `performUpdate` being reached.
 */
describe("maybeUpdate", () => {
  const isTTY = process.stdin.isTTY;
  const performUpdate = vi.fn(async () => false);
  const confirm = vi.fn(async () => true);
  const checkForUpdate = vi.fn(async () => ({
    current: "0.7.0", latest: "0.8.0", diff: "minor" as const, updateAvailable: true,
  }));
  let linked = false;

  beforeEach(() => {
    vi.resetModules();
    linked = false;
    performUpdate.mockClear();
    confirm.mockClear();
    checkForUpdate.mockClear();
    vi.doMock("../utils/self-update.js", () => ({
      checkForUpdate, performUpdate,
      isLinkedInstall: () => linked,
      explainLinkedInstall: () => {},
    }));
    vi.doMock("@inquirer/prompts", () => ({ confirm }));
    vi.doMock("../config/manager.js", async () => ({
      ...(await vi.importActual<typeof import("../config/manager.js")>("../config/manager.js")),
      readConfig: () => ({}),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    vi.doUnmock("../utils/self-update.js");
    vi.doUnmock("@inquirer/prompts");
    vi.doUnmock("../config/manager.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const setTTY = (v: boolean) =>
    Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });

  it("never reaches the registry when the install is a linked checkout", async () => {
    linked = true;
    setTTY(true);
    const { maybeUpdate } = await import("../cli/cmd-start.js");
    await maybeUpdate();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(performUpdate).not.toHaveBeenCalled();
  });

  it("does not prompt when there is no stdin to answer with", async () => {
    // Background and service launches spawn with stdio "ignore". Asking here
    // threw ExitPromptError out of startup, while the previous process was
    // still writing its session assignments.
    setTTY(false);
    const { maybeUpdate } = await import("../cli/cmd-start.js");
    await maybeUpdate();
    expect(checkForUpdate).toHaveBeenCalled();   // reporting is fine
    expect(confirm).not.toHaveBeenCalled();      // asking is not
    expect(performUpdate).not.toHaveBeenCalled();
  });

  it("asks before installing when someone is there to answer", async () => {
    setTTY(true);
    const { maybeUpdate } = await import("../cli/cmd-start.js");
    await maybeUpdate();
    expect(confirm).toHaveBeenCalled();
    // Enter must not be the answer that replaces the installed package.
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ default: false });
    expect(performUpdate).toHaveBeenCalledWith("0.8.0");
  });
});

/**
 * The advisory paths. None of these execute an install, but each one prints
 * instructions, and on a linked install the instruction that still "works" is
 * the one that replaces the checkout.
 */
describe("update advice on a linked install", () => {
  const log = vi.fn();
  let linked = true;

  beforeEach(() => {
    vi.resetModules();
    linked = true;
    log.mockClear();
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { log(a.join(" ")); });
  });
  afterEach(() => {
    vi.doUnmock("../utils/self-update.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("the exit banner offers no install command", async () => {
    const { printUpdateBanner, resetLinkedInstallCache } = await import("../utils/self-update.js");
    resetLinkedInstallCache();
    const argv1 = process.argv[1];
    process.argv[1] = "";   // unidentifiable → linked (fail closed)
    try {
      printUpdateBanner({ current: "0.7.0", latest: "0.8.0", diff: "minor", updateAvailable: true });
    } finally { process.argv[1] = argv1; resetLinkedInstallCache(); }

    const out = log.mock.calls.map(c => String(c[0])).join("\n");
    // This banner fires on every `cc-router <anything>`. Naming the destructive
    // command here undoes every guard on the executing paths.
    expect(out).not.toMatch(/npm i -g|npm install -g/);
    expect(out).toMatch(/unlink/);
  });

  it("`cc-router update` never falls through to the manual-install advice", async () => {
    const performUpdate = vi.fn(async () => false);
    vi.doMock("../utils/self-update.js", async () => ({
      ...(await vi.importActual<typeof import("../utils/self-update.js")>("../utils/self-update.js")),
      performUpdate,
      isLinkedInstall: () => linked,
      // A major bump is the branch that printed `npm i -g` before reaching
      // performUpdate's refusal at all.
      checkForUpdate: async () => ({ current: "0.7.0", latest: "1.0.0", diff: "major", updateAvailable: true }),
      getCurrentVersion: () => "0.7.0",
    }));
    const { Command } = await import("commander");
    const { registerUpdate } = await import("../cli/cmd-update.js");
    const program = new Command();
    program.exitOverride();
    registerUpdate(program);
    await program.parseAsync(["node", "cc-router", "update"]);

    const out = log.mock.calls.map(c => String(c[0])).join("\n");
    expect(performUpdate).not.toHaveBeenCalled();
    expect(out).not.toMatch(/npm i -g|Install manually/);
  });
});
