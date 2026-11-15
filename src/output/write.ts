import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ScanResult } from "../scan/types.js";
import { toDesignMd } from "./design-md.js";
import { APP_TOKENS_FILES, OUTPUT_DIR, TOKENS_FILE } from "./output-files.js";
import { writeReports } from "./reports.js";
import { toDesignTokens } from "./tokens-json.js";

/**
 * Writes the tokens, DESIGN.md, catalog.html and drift.md into `outDir` (by default `designmap/` in the app) and
 * returns their paths: one tokens.json, or for a repo with more than one app a file for each (`tokens.ios.json`)
 * beside one of each of the others. A tokens
 * file Designmap wrote before in the other layout is removed and returned once the new ones are written, so a Figma
 * file still connected to it fails plainly rather than syncing values the code no longer has; a scan that couldn't
 * read the whole app removes nothing, since an app it missed isn't an app removed.
 */
export async function writeOutputs(scan: ScanResult, outDir = path.join(scan.root, OUTPUT_DIR)) {
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
  const others = [TOKENS_FILE, ...Object.values(APP_TOKENS_FILES)]
    .map((name) => path.join(outDir, name))
    .filter((file) => !tokens.includes(file));
  const removed: string[] = [];
  for (const file of partial ? [] : others) {
    if (!(await writtenByDesignmap(file))) continue;
    await rm(file);
    removed.push(file);
  }
  return { tokens, design, ...(await writeReports(scan, outDir)), removed };
}

/** What every tokens file Designmap writes carries, and a file of anyone else's doesn't. */
const OWN_TOKENS = z.object({ $extensions: z.object({ designmap: z.object({ app: z.string() }) }) });

/** Whether `file` is a tokens file Designmap wrote; false when there's none. */
async function writtenByDesignmap(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
  try {
    return OWN_TOKENS.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}
