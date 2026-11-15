/** A file's text by its path relative to the app's root: undefined when there's no such file, or why it can't be
 * read (`it's over 512 KB`). */
export type ReadSource = (file: string) => Promise<string | { unreadable: string } | undefined>;

/** The text of `file`, or why there's none to edit. */
export async function sourceOf(
  read: ReadSource,
  file: string,
): Promise<{ source: string } | { reason: string }> {
  const got = await read(file);
  if (got === undefined) return { reason: `${file} isn't in the app any more.` };
  if (typeof got !== "string") return { reason: `Designmap can't read ${file}: ${got.unreadable}.` };
  return { source: got };
}

export const textOf = (got: string | { unreadable: string } | undefined) =>
  typeof got === "string" ? got : undefined;
