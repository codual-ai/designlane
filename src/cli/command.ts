/** What every command shares: where it prints, and a mistake in how it was run. */

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
