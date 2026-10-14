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
    it("carries no self-update switch, because there is no self-update", () => {
      // This fork installs by git checkout, not npm, so nothing in the service
      // ever reaches for the registry. The kill switch that used to be pinned
      // here guarded an unattended `npm i -g` that no longer exists.
      readConfig.mockReturnValue({});

      expect(build(false)).not.toContain("AUTO_UPDATE");
    });

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
