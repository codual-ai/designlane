import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES } from "./file-limits.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  "DerivedData",
  "Pods",
  "Carthage",
  "vendor",
  "coverage",
  "__snapshots__",
]);

const MAX_FILES = 20_000;

export interface SourceFile {
  /** Relative to the project root, with forward slashes on every platform. */
  rel: string;
  abs: string;
}

export interface FileList {
  files: SourceFile[];
  /** The walk stopped at the file limit. */
  truncated: boolean;
  /** Folders that couldn't be read, relative to the root. */
  unreadable: string[];
}

/** What the read missed, in a sentence, or undefined when it read everything. */
export function readGaps({ truncated, unreadable }: Omit<FileList, "files">): string | undefined {
  const gaps: string[] = [];
  if (truncated) {
    gaps.push(
      `it stopped after ${MAX_FILES.toLocaleString("en")} files (point it at the app's own folder to read fewer)`,
    );
  }
  if (unreadable.length) {
    const some = unreadable.slice(0, 3).join(", ");
    const folders = `${unreadable.length} folder${unreadable.length === 1 ? "" : "s"}`;
    gaps.push(
      `${folders} couldn't be opened (${some}${unreadable.length > 3 ? ", …" : ""}; check their permissions)`,
    );
  }
  return gaps.length ? `Only part of the app was read: ${gaps.join(", and ")}.` : undefined;
}

/** Lists the project's files, skipping hidden folders, dependencies, build output and symlinks. */
export async function listFiles(root: string): Promise<FileList> {
  const list: FileList = { files: [], truncated: false, unreadable: [] };
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      list.unreadable.push(toRel(root, dir));
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (list.files.length >= MAX_FILES) {
        list.truncated = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await walk(abs);
      } else if (entry.isFile()) {
        list.files.push({ abs, rel: toRel(root, abs) });
      }
    }
  };
  await walk(root);
  return list;
}

/** A file's text, or undefined when it's missing, unreadable or too large to be source. */
export async function readText(abs: string): Promise<string | undefined> {
  try {
    if (await isTooLarge(abs)) return undefined;
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether `abs` is a file too large for Designmap to read as source. */
export async function isTooLarge(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).size > MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

export async function isFolder(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}
