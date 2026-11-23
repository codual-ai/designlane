import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const action = readFileSync(path.join(process.cwd(), "action.yml"), "utf8");

/** The script and environment of the action's step named `name`, as a runner would see them. */
function step(name: string): { script: string; env: Record<string, string> } {
  const start = action.indexOf(`- name: ${name}`);
  const next = action.indexOf("\n    - ", start + 1);
  const text = action.slice(start, next === -1 ? undefined : next);
  const env = Object.fromEntries(
    [...text.matchAll(/^ {8}(GIT_[A-Z_]+): (.+)$/gm)].map(([, key, value]) => [key ?? "", value ?? ""]),
  );
  const script = text.slice(text.indexOf("run: |") + "run: |".length).replace(/^ {8}/gm, "");
  return { script, env };
}

/** Runs `script` in bash, with no git identity of the machine's own, as on a fresh runner. */
function bash(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync("bash", ["-e", "-c", script], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The action runs on GitHub's Linux runners; its steps are bash.
describe.skipIf(process.platform === "win32")("the GitHub Action", () => {
  it("runs only on a push to a branch", () => {
    dir = mkdtempSync(path.join(tmpdir(), "designlane-action-"));
    const { script } = step("Check it's a push to a branch");
    const run = (event: string, refType: string) =>
      bash(script, dir, { GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: refType }).status;
    expect([run("push", "branch"), run("pull_request", "branch"), run("push", "tag")]).toEqual([0, 1, 1]);
  });

  it("writes to designlane/, or the designmap/ with a tokens file of a repo set up before the rename, or the folder it's given", () => {
    dir = mkdtempSync(path.join(tmpdir(), "designlane-action-"));
    const { script } = step("Choose the output folder");
    const chosen = (out = "") => {
      const output = path.join(dir, "output");
      writeFileSync(output, "");
      expect(bash(script, dir, { OUT: out, GITHUB_OUTPUT: output }).status).toBe(0);
      return readFileSync(output, "utf8");
    };
    expect(chosen()).toBe("out=designlane\n");
    mkdirSync(path.join(dir, "designmap"));
    expect(chosen()).toBe("out=designlane\n");
    writeFileSync(path.join(dir, "designmap", "tokens.ios.json"), "{}\n");
    mkdirSync(path.join(dir, "designlane"));
    writeFileSync(path.join(dir, "designlane", "agent.json"), "{}\n");
    expect([chosen(), chosen("tokens")]).toEqual(["out=designmap\n", "out=tokens\n"]);
    writeFileSync(path.join(dir, "designlane", "tokens.json"), "{}\n");
    expect(chosen()).toBe("out=designlane\n");
  });

  it("commits only the tokens, only when they changed, onto a push that landed meanwhile", () => {
    dir = mkdtempSync(path.join(tmpdir(), "designlane-action-"));
    const remote = path.join(dir, "remote.git");
    const app = path.join(dir, "app");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, app], { stdio: "ignore" });
    writeFileSync(path.join(app, "README.md"), "app\n");
    git(app, "add", "README.md");
    git(app, "commit", "-qm", "app");
    git(app, "push", "-q", "origin", "HEAD:main");
    mkdirSync(path.join(app, "designlane"));
    writeFileSync(path.join(app, "designlane", "tokens.json"), "{}\n");
    writeFileSync(path.join(app, "unrelated.txt"), "staged by an earlier step\n");
    git(app, "add", "unrelated.txt");
    const other = path.join(dir, "other");
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
    writeFileSync(path.join(other, "other.txt"), "x\n");
    git(other, "add", "other.txt");
    git(other, "commit", "-qm", "someone else");
    git(other, "push", "-q");

    const { script, env } = step("Commit them if they changed");
    const commit = () => bash(script, app, { ...env, OUT: "designlane", GITHUB_REF_NAME: "main" });
    expect(commit().status).toBe(0);
    const log = git(remote, "log", "--format=%s", "main").trim().split("\n");
    const files = git(remote, "show", "--name-only", "--format=", "main").trim();
    expect([log, files]).toEqual([
      ["Update design tokens [skip ci]", "someone else", "app"],
      "designlane/tokens.json",
    ]);
    expect(commit().stdout).toContain("The design tokens haven't changed.");
  });

  it("checks an agent's map of version 1 into a summary, and an older map's into none, nor a stale one", () => {
    dir = mkdtempSync(path.join(tmpdir(), "designlane-action-"));
    const app = path.join(dir, "app");
    mkdirSync(path.join(app, "App"), { recursive: true });
    mkdirSync(path.join(app, "designlane"));
    writeFileSync(
      path.join(app, "App", "Theme.swift"),
      'import SwiftUI\nenum Theme {\n  static let surface = Color.white\n}\nstruct S: View { var body: some View { Text("a").foregroundStyle(Theme.surface) } }\n',
    );
    const agent = path.join(app, "designlane", "agent.json");
    const check = path.join(app, "designlane", "agent-check.json");
    const summary = path.join(dir, "summary.md");
    // Designlane built as the Action builds it, into a folder of its own: the step runs what's built, not a dist/ an
    // earlier build left.
    const designlane = path.join(dir, "designlane-build");
    const tsc = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    execFileSync(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--outDir", path.join(designlane, "dist")],
      {
        cwd: process.cwd(),
        stdio: "ignore",
      },
    );
    writeFileSync(
      path.join(designlane, "package.json"),
      readFileSync(path.join(process.cwd(), "package.json")),
    );
    symlinkSync(path.join(process.cwd(), "node_modules"), path.join(designlane, "node_modules"), "dir");
    const { script } = step("Write the design tokens");
    const run = () => {
      writeFileSync(summary, "");
      const result = bash(script, app, {
        DESIGNLANE: designlane,
        APP: ".",
        OUT: "designlane",
        GITHUB_STEP_SUMMARY: summary,
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(summary, "utf8");
    };
    writeFileSync(
      agent,
      JSON.stringify({
        version: 1,
        colors: {
          "Theme.surface": { light: { value: "#ffffff", at: "App/Theme.swift:3" } },
          "Theme.gone": { light: { value: "#000000", at: "App/Theme.swift:40" } },
        },
      }),
    );
    expect(run()).toContain("1 of 2 entries match the code.");
    // An older, unversioned map writes no check file: the one before it isn't summed up again.
    writeFileSync(agent, JSON.stringify({ colors: { "Theme.surface": { light: "#ffffff" } } }));
    expect(run()).toBe("");
    expect(() => readFileSync(check)).toThrow();
  }, 120000);
});
