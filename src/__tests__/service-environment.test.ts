import { describe, expect, it, vi, beforeEach } from "vitest";

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("../config/manager.js", () => ({ readConfig }));

const { buildEnvironment, buildSystemdUnit, buildWindowsRunCommand } =
  await import("../daemon/service.js");

const PLATFORMS: Array<[string, (serverMode: boolean) => string]> = [
  ["macOS plist", buildEnvironment],
  ["systemd unit", buildSystemdUnit],
  ["Windows Run key", buildWindowsRunCommand],
];

describe("managed service environment", () => {
  beforeEach(() => readConfig.mockReset());

  describe.each(PLATFORMS)("%s", (_name, build) => {
    it("pins the auto-update kill switch when config has it turned off", () => {
      // The config flag alone is lost the moment anything rewrites config.json,
      // and the service manager would then restart with updates re-armed —
      // replacing a linked development checkout with the published build.
      readConfig.mockReturnValue({ autoUpdate: false });

      expect(build(false)).toContain("CC_ROUTER_NO_AUTO_UPDATE");
    });

    it.each([{ autoUpdate: true }, { autoUpdate: undefined }, {}])(
      "leaves the switch out for config %j",
      (config) => {
        readConfig.mockReturnValue(config);

        expect(build(false)).not.toContain("CC_ROUTER_NO_AUTO_UPDATE");
      },
    );

    it("binds all interfaces only in server mode", () => {
      readConfig.mockReturnValue({});

      expect(build(true)).toContain("0.0.0.0");
      expect(build(false)).not.toContain("0.0.0.0");
    });
  });

  it("escapes plist values that would otherwise corrupt the XML", () => {
    // A PATH entry containing & or < breaks the document, and launchd then
    // refuses to load the agent at all.
    readConfig.mockReturnValue({});
    const original = process.env["PATH"];
    process.env["PATH"] = "/opt/a&b:/opt/<c>";
    try {
      const xml = buildEnvironment(false);
      expect(xml).toContain("/opt/a&amp;b:/opt/&lt;c&gt;");
      expect(xml).not.toContain("a&b");
    } finally {
      process.env["PATH"] = original;
    }
  });

  it("keeps the ambient PATH on Windows instead of pinning a snapshot", () => {
    readConfig.mockReturnValue({});

    expect(buildWindowsRunCommand(false)).not.toContain("set PATH=");
  });
});
