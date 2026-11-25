// pnpm pattern <case folder>: writes the case's expected.txt from what designlane doctor prints for it today.
// pnpm pattern --all: rewrites every passing case's, after a change that improves what Designlane reads.
// pnpm pattern --issue <number>: makes a needs-fix case of an issue filed with the "reads wrong" form.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ISSUES = "https://api.github.com/repos/codual-ai/designlane/issues";
const USAGE = "usage: pnpm pattern <case folder> | --all | --issue <number>";

const [target, issueNumber] = process.argv.slice(2);
if (!target) fail(USAGE);
if (target === "--issue") await caseOfIssue(issueNumber);
else writeExpected(target);

/** Writes one case's expected.txt, or every passing case's. */
function writeExpected(target) {
  const write = target === "--all" ? "all" : path.resolve(target);
  const status = runPatternTests({ DESIGNLANE_PATTERN_WRITE: write });
  if (status === 0)
    console.log(
      write === "all"
        ? "Wrote every case's expected.txt."
        : `Wrote ${path.join(target, "expected.txt")}: fix what's wrong in it.`,
    );
  process.exit(status);
}

/** Fetches the issue from GitHub and hands it to the pattern tests, which make its case folder. */
async function caseOfIssue(number) {
  if (!/^\d+$/.test(number ?? "")) fail(USAGE);
  const response = await fetch(`${ISSUES}/${number}`);
  if (!response.ok)
    fail(`Couldn't get issue #${number} from GitHub: ${response.status} ${response.statusText}`);
  const issue = await response.json();
  if (issue.pull_request) fail(`#${number} is a pull request, not an issue.`);
  const dir = mkdtempSync(path.join(tmpdir(), "designlane-issue-"));
  const saved = path.join(dir, "issue.json");
  writeFileSync(saved, JSON.stringify({ number: issue.number, body: issue.body ?? "" }));
  const status = runPatternTests({ DESIGNLANE_PATTERN_ISSUE: saved }, "makes a case of an issue");
  rmSync(dir, { recursive: true, force: true });
  if (status === 0) {
    const folder = ["swiftui", "compose", "react-native"]
      .map((framework) =>
        path.join("tests", "fixtures", "patterns", "needs-fix", framework, `issue-${number}`),
      )
      .find((each) => existsSync(each));
    console.log(`Made ${folder}: fix what's wrong in its expected.txt, and open a pull request.`);
  }
  process.exit(status);
}

/** Runs the pattern tests, or only those named, with what they're asked to write. */
function runPatternTests(env, only) {
  const vitest = path.join("node_modules", "vitest", "vitest.mjs");
  const args = [vitest, "run", "tests/unit/patterns.test.ts", ...(only ? ["-t", only] : [])];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  return result.status ?? 1;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
