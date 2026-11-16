import { MAX_FILE_BYTES } from "../scan/file-limits.js";

/** A file's text by its path relative to the app's root: undefined when there's no such file, or why it can't be
 * read (`it's over 512 KB`). */
export type ReadSource = (file: string) => Promise<string | { unreadable: string } | undefined>;

/** Why a file too large to be hand-written source isn't read. */
export const TOO_LARGE = {
  unreadable: `it's over ${MAX_FILE_BYTES / 1024} KB, more than it reads as source`,
};

/** The text of `file`, or why there's none to edit. */
export async function sourceOf(
  read: ReadSource,
  file: string,
): Promise<{ source: string } | { reason: string }> {
  const got = await read(file);
  if (got === undefined) return { reason: `${file} isn't in the app any more.` };
  if (typeof got !== "string") return { reason: `Designlane can't read ${file}: ${got.unreadable}.` };
  return { source: got };
}

/** `read` reading each file once: the checks read the same files many times, and the Figma plugin reads over the
 * network. */
export function readingOnce(read: ReadSource): ReadSource {
  const files = new Map<string, ReturnType<ReadSource>>();
  return (file) => {
    let got = files.get(file);
    if (!got) {
      got = read(file);
      files.set(file, got);
    }
    return got;
  };
}

export const textOf = (got: string | { unreadable: string } | undefined) =>
  typeof got === "string" ? got : undefined;
