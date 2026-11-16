import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readText } from "../scan/files.js";
import type { ScanResult } from "../scan/types.js";
import { toDesignMd } from "./design-md.js";
import { OLD_OUTPUT_DIR, withCurrentNames } from "./old-names.js";
import { APP_TOKENS_FILES, OUTPUT_DIR, TOKENS_FILE } from "./output-files.js";
import { writeReports } from "./reports.js";
import { toDesignTokens } from "./tokens-json.js";

/**
 * Writes the tokens, DESIGN.md, catalog.html and drift.md into `outDir` (by default the app's `outputDir`) and
 * returns their paths: one tokens.json, or for a repo with more than one app a file for each (`tokens.ios.json`)
 * beside one of each of the others. A tokens
 * file Designlane wrote before in the other layout is removed and returned once the new ones are written, so a Figma
 * file still connected to it fails plainly rather than syncing values the code no longer has; a scan that couldn't
 * read the whole app removes nothing, since an app it missed isn't an app removed.
 */
export async function writeOutputs(scan: ScanResult, outDir?: string) {
  return writeInto(scan, outDir ?? (await outputDir(scan.root)));
}

/** Every name a tokens file of Designlane's has: alone in its repo, or one of several apps'. */
const TOKENS_FILE_NAMES = [TOKENS_FILE, ...Object.values(APP_TOKENS_FILES)];

/** The app's output folder: `designlane/`, or the `designmap/` whose tokens file an app set up before the rename has,
 * while `designlane/` has none (only the agent's file, say). */
export async function outputDir(root: string): Promise<string> {
  const current = path.join(root, OUTPUT_DIR);
  const old = path.join(root, OLD_OUTPUT_DIR);
  const isOld = (await tokensFilesIn(current)).length === 0 && (await tokensFilesIn(old)).length > 0;
  return isOld ? old : current;
}

/** The names of the tokens files in `folder`; none when there's no such folder. */
export async function tokensFilesIn(folder: string): Promise<string[]> {
  const present = [];
  for (const name of TOKENS_FILE_NAMES) {
    if ((await readText(path.join(folder, name))) !== undefined) present.push(name);
  }
  return present;
}

async function writeInto(scan: ScanResult, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const several = scan.frameworks.length > 1;
  const files = several
    ? scan.frameworks.map((f) => ({
        file: path.join(outDir, APP_TOKENS_FILES[f.framework]),
        tokens: toDesignTokens(scan, f.framework),
      }))
    : [{ file: path.join(outDir, TOKENS_FILE), tokens: toDesignTokens(scan) }];
  for (const { file, tokens } of files) await writeFile(file, `${JSON.stringify(tokens, null, 2)}\n`);
  const design = path.join(outDir, "DESIGN.md");
  await writeFile(design, toDesignMd(scan));
  const tokens = files.map((f) => f.file);
  const partial = scan.truncated || scan.unreadable.length > 0;
  const others = TOKENS_FILE_NAMES.map((name) => path.join(outDir, name)).filter(
    (file) => !tokens.includes(file),
  );
  const removed: string[] = [];
  for (const file of partial ? [] : others) {
    if (!(await writtenByDesignlane(file))) continue;
    await rm(file);
    removed.push(file);
  }
  return { tokens, design, ...(await writeReports(scan, outDir)), removed };
}

/** What every tokens file Designlane writes carries, and a file of anyone else's doesn't. */
const OWN_TOKENS = z.object({ $extensions: z.object({ designlane: z.object({ app: z.string() }) }) });

/** Whether `file` is a tokens file Designlane wrote; false when there's none. */
async function writtenByDesignlane(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
  try {
    return OWN_TOKENS.safeParse(withCurrentNames(JSON.parse(text))).success;
  } catch {
    return false;
  }
}
