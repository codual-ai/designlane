// The README as npm shows it, which can't play video: before packing (`pack`), the demo video's link becomes a GIF
// of it linking to the README on GitHub, and images in the repo get absolute links; after packing (`restore`), the
// README is put back as GitHub shows it.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

const README = "README.md";
// Not named README: npm packs every file whose name starts with that.
const KEPT = ".npm-readme-backup.md";
const REPO = "https://github.com/codual-ai/designlane";
const RAW = "https://raw.githubusercontent.com/codual-ai/designlane/main";
/** A video uploaded to GitHub, on a line of its own, which only GitHub's page can play. */
const VIDEO = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/m;
const GIF = `[![Designlane syncing an app's colors and text styles into Figma](${RAW}/.github/assets/figma-sync.gif)](${REPO}#readme)`;
/** An image kept in the repo, linked from the README by its path. */
const REPO_IMAGE = /\]\((\.github\/assets\/[^)\s]+)\)/g;

if (process.argv[2] === "pack") {
  const text = await readFile(README, "utf8");
  await writeFile(KEPT, text);
  await writeFile(README, text.replace(VIDEO, GIF).replace(REPO_IMAGE, `](${RAW}/$1)`));
} else if (process.argv[2] === "restore") {
  if (existsSync(KEPT)) await rename(KEPT, README);
} else {
  throw new Error("Usage: node scripts/npm-readme.mjs <pack|restore>");
}
