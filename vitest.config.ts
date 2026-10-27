import { defineConfig } from "vitest/config";
import { ROUTER_BOOT_MS } from "./src/__tests__/helpers/router-process.js";

/** These files spawn a real router per test, so their time is set by process boot on a busy host. */
const PROCESS_TESTS = "src/__tests__/**/*-http.test.ts";

export default defineConfig({
  test: {
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    globals: true,
    environment: "node",
    // No root `include`: with `extends: true` a project's include is merged with
    // the root one, not replaced, which ran every process test in both projects.
    projects: [
      // Pure code keeps the default 5 s: a slow unit test is a finding, not noise.
      { extends: true, test: { name: "unit", include: ["src/__tests__/**/*.test.ts"], exclude: [PROCESS_TESTS] } },
      // One shared budget instead of per-test numbers that drifted (12–40 s).
      // The longest test boots three routers in sequence, plus its own waits.
      { extends: true, test: { name: "process", include: [PROCESS_TESTS], testTimeout: 4 * ROUTER_BOOT_MS, hookTimeout: 4 * ROUTER_BOOT_MS } },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/proxy/**/*.ts",
        "src/config/**/*.ts",
        "src/utils/**/*.ts",
      ],
      exclude: [
        "src/cli/**",
        "src/ui/**",
        "src/__tests__/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
