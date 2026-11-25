/** What every command shares: where it prints, a mistake in how it was run, and Designlane's version. */

import { readFile } from "node:fs/promises";

export interface Output {
  out: (text: string) => void;
  error: (text: string) => void;
}

/** A mistake in how the command was run: its message, and the exit code it ends with. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** The version of Designlane running, from its package.json. */
export async function packageVersion(): Promise<string> {
  const manifest = new URL("../../package.json", import.meta.url);
  return JSON.parse(await readFile(manifest, "utf8")).version;
}
