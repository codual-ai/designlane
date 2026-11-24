// pnpm pattern <case folder>: writes the case's expected.txt from what designlane doctor prints for it today.
// pnpm pattern --all: rewrites every passing case's, after a change that improves what Designlane reads.
import { spawnSync } from "node:child_process";
import path from "node:path";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("usage: pnpm pattern <case folder> | --all");
  process.exit(2);
}
const write = target === "--all" ? "all" : path.resolve(target);
const vitest = path.join("node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "tests/unit/patterns.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, DESIGNLANE_PATTERN_WRITE: write },
});
if (result.status === 0)
  console.log(
    write === "all"
      ? "Wrote every case's expected.txt."
      : `Wrote ${path.join(target, "expected.txt")}: fix what's wrong in it.`,
  );
process.exit(result.status ?? 1);
