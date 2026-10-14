import { createRequire } from "module";

export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version: string };
  return pkg.version;
}
