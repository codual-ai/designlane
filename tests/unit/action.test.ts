import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
