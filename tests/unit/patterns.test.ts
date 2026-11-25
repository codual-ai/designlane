/**
 * Pattern cases: a folder of code and what `designlane doctor --screen` should print for it, in `expected.txt`.
 * Each case in `tests/fixtures/patterns/<framework>/` must read as it says; each in `needs-fix/<framework>/` is a
 * known bug, which reads differently until someone fixes it. `pnpm pattern <folder>` writes a case's
 * `expected.txt` from what Designlane prints today; see CONTRIBUTING.md.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { run } from "../../src/cli/run.js";
import { LayoutIssuesSchema } from "../../src/read/index.js";
import { caseOfIssue, FRAMEWORKS, type Framework, IMPORT_NEEDED } from "../helpers/issue-case.js";
import { tempDir } from "../helpers/temp.js";

const ROOT = path.join(process.cwd(), "tests", "fixtures", "patterns");
const NEEDS_FIX = "needs-fix";
const EXPECTED = "expected.txt";

/** What `pnpm pattern` asks for: write the expected output of this case folder, or of every passing case. */
const WRITE = process.env.DESIGNLANE_PATTERN_WRITE;
/** What `pnpm pattern --issue` asks for: a case of the issue it saved to this file, as `{ number, body }`. */
const ISSUE = process.env.DESIGNLANE_PATTERN_ISSUE;
/** A case made from an issue is named for it, so whoever fixes it can say which issue the fix closes. */
const FROM_ISSUE = /^issue-(\d+)$/;

interface Case {
  dir: string;
  framework: Framework;
  needsFix: boolean;
  name: string;
}

/** Every case folder, passing ones and those that need a fix. */
function cases(): Case[] {
  const out: Case[] = [];
  // A framework with no cases has no folder; any other error reading them fails the run, so no case goes unchecked.
  const folders = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names.filter((f) => statSync(path.join(dir, f)).isDirectory());
  };
  for (const needsFix of [false, true])
    for (const framework of FRAMEWORKS) {
      const base = needsFix ? path.join(ROOT, NEEDS_FIX, framework) : path.join(ROOT, framework);
      for (const name of folders(base)) out.push({ dir: path.join(base, name), framework, needsFix, name });
    }
  return out;
}

/** The case's code, copied to an app folder of its own: a React Native case gets the `package.json` that says what
 * it is, unless it has one. */
async function appOf(c: Case): Promise<string> {
  const files: Record<string, string> = {};
  const copy = (dir: string, rel = "") => {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f);
      const name = rel ? `${rel}/${f}` : f;
      if (statSync(full).isDirectory()) copy(full, name);
      else if (name !== EXPECTED) files[name] = readFileSync(full, "utf8");
    }
  };
  copy(c.dir);
  if (c.framework === "react-native" && !files["package.json"])
    files["package.json"] = '{ "dependencies": { "react-native": "0.76.0" } }';
  return tempDir(files);
}

/** The first line of `designlane doctor --screen`'s output: the view's name, and the file and line it's declared on. */
const HEADING = /^(\S+) \([^,]+, (.+):\d+\)/;

/** What `designlane doctor` prints for the case's view: the one `expected.txt`'s first line names, by name and file,
 * else the case's only one. */
async function doctorOf(c: Case, expected: string | undefined): Promise<string> {
  const app = await appOf(c);
  const doctor = async (...args: string[]) => {
    const out: string[] = [];
    const error: string[] = [];
    const code = await run(["doctor", app, ...args], {
      out: (t) => out.push(t),
      error: (t) => error.push(t),
    });
    if (code !== 0) throw new Error(`designlane doctor ${args.join(" ")} failed: ${error.join("\n")}`);
    return out.join("\n");
  };
  const views = z.array(LayoutIssuesSchema).parse(JSON.parse(await doctor("--json")));
  const heading = expected === undefined ? undefined : HEADING.exec(expected);
  const meant = heading ? views.filter((v) => v.screen.endsWith(`:${heading[2]}#${heading[1]}`)) : views;
  const [view, ...others] = meant;
  if (!view || others.length > 0)
    throw new Error(
      heading
        ? `the case should declare ${heading[1]} once, in ${heading[2]}; it declares it ${meant.length} times there`
        : `the case should declare one screen or component; it has ${views.length}`,
    );
  const output = `${await doctor("--screen", view.screen)}\n`;
  // A case whose code Designlane can't read at all checks nothing else, unless that's what it's about.
  if (output.includes(UNREADABLE) && !expected?.includes(UNREADABLE))
    throw new Error(`Designlane can't read the case's code, so it checks nothing: fix the code\n${output}`);
  return output;
}

/** A folder as the person running the tests would type it. */
const shown = (folder: string) => path.relative(process.cwd(), folder);

/** What doctor says of a view it can't read. */
const UNREADABLE = "Can't be read";

/** Whether two folders are one: Windows ignores case in paths. */
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Line endings and trailing spaces aside: a case reads the same on Windows. */
const normal = (text: string) =>
  text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

describe("pattern cases", () => {
  const all = cases();
  it("has cases, each with its expected output, and writes only one that's there", () => {
    if (WRITE && WRITE !== "all") {
      const target = path.resolve(WRITE);
      expect(
        all.filter((c) => same(c.dir, target)),
        `no case folder at ${WRITE}`,
      ).toHaveLength(1);
    }
    expect(all.length).toBeGreaterThan(0);
    if (!WRITE)
      for (const c of all)
        expect(read(path.join(c.dir, EXPECTED)), `${c.dir} has no ${EXPECTED}`).toBeDefined();
  });

  for (const c of all) {
    const label = `${c.needsFix ? `${NEEDS_FIX}/` : ""}${c.framework}/${c.name}`;
    it(label, async () => {
      const file = path.join(c.dir, EXPECTED);
      const expected = read(file);
      const target = WRITE && WRITE !== "all" ? path.resolve(WRITE) : undefined;
      const writing = WRITE === "all" ? !c.needsFix : target !== undefined && same(target, c.dir);
      if (writing) {
        writeFileSync(file, await doctorOf(c, expected));
        return;
      }
      if (WRITE || expected === undefined) return;
      const actual = normal(await doctorOf(c, expected));
      if (!c.needsFix) {
        expect(actual).toBe(normal(expected));
        return;
      }
      // A known bug: it reads differently until it's fixed, and once it reads as expected, it moves out.
      if (actual === normal(expected)) {
        const issue = FROM_ISSUE.exec(c.name)?.[1];
        throw new Error(
          `${label} now reads as its ${EXPECTED} says: the bug is fixed. Move the folder to tests/fixtures/patterns/${c.framework}/` +
            (issue ? `, and put "Fixes #${issue}" in the pull request.` : "."),
        );
      }
    });
  }

  it.runIf(ISSUE)("makes a case of an issue", async () => {
    const { number, body } = z
      .object({ number: z.number(), body: z.string() })
      .parse(JSON.parse(readFileSync(ISSUE!, "utf8")));
    const { framework, file, code } = caseOfIssue(body);
    const name = `issue-${number}`;
    const dir = path.join(ROOT, NEEDS_FIX, framework, name);
    const existing = [dir, path.join(ROOT, framework, name)].find((each) => existsSync(each));
    if (existing) throw new Error(`There's a case of issue #${number} already: ${shown(existing)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, file), code);
    try {
      writeFileSync(
        path.join(dir, EXPECTED),
        await doctorOf({ dir, framework, needsFix: true, name }, undefined),
      );
    } catch (e) {
      throw new Error(
        `${(e as Error).message}\nThe issue's code is in ${shown(path.join(dir, file))}. Fix it there (it may need ` +
          `${IMPORT_NEEDED[framework]}), then run pnpm pattern ${shown(dir)}`,
      );
    }
  });
});
