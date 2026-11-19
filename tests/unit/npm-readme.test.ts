import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers/temp.js";

const SCRIPT = path.join(process.cwd(), "scripts/npm-readme.mjs");
const README = [
  "# Designlane",
  "",
  "https://github.com/user-attachments/assets/e6324208-a820-4d70-b27a-24a0337e082c",
  "",
  "![The command line](.github/assets/cli.gif)",
].join("\n");

async function packed(readme: string) {
  const dir = await tempDir({ "README.md": readme });
  await mkdir(path.join(dir, "scripts"));
  await copyFile(SCRIPT, path.join(dir, "scripts/npm-readme.mjs"));
  const run = (step: string) => execFileSync("node", ["scripts/npm-readme.mjs", step], { cwd: dir });
  run("pack");
  const forNpm = await readFile(path.join(dir, "README.md"), "utf8");
  // npm packs every file named README…, so the copy kept for GitHub mustn't be one.
  const readmes = (await readdir(dir)).filter((f) => /^readme/i.test(f));
  run("restore");
  return { forNpm, readmes, after: await readFile(path.join(dir, "README.md"), "utf8") };
}

describe("the README npm shows", () => {
  it("shows the demo as a GIF linking to GitHub, with images by absolute links, and restores the README after", async () => {
    const { forNpm, readmes, after } = await packed(README);
    expect(readmes).toEqual(["README.md"]);
    expect(forNpm).not.toContain("user-attachments");
    expect(forNpm).toContain(
      "(https://raw.githubusercontent.com/codual-ai/designlane/main/.github/assets/figma-sync.gif)](https://github.com/codual-ai/designlane#readme)",
    );
    expect(forNpm).toContain(
      "](https://raw.githubusercontent.com/codual-ai/designlane/main/.github/assets/cli.gif)",
    );
    expect(after).toBe(README);
  });

  it("leaves a README without a video as it is", async () => {
    const { forNpm } = await packed("# Designlane\n\nNo video here.\n");
    expect(forNpm).toBe("# Designlane\n\nNo video here.\n");
  });
});
