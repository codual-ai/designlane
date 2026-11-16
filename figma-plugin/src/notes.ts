/** The notes a sync leaves for the designer: what it left out of the file, and why. */

/** An error's words, to show the designer. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The note for something a sync left out, and why. */
export const leftOut = (name: string, reason: string) => `${name} was left out: ${reason}.`;

/** The note for a text style left out because this file doesn't have `font`. */
export const missingFont = (name: string, font: string) => leftOut(name, `this file doesn't have ${font}`);

/** Where a plan's tokens.json came from, which decides how the designer plans again. */
export type Origin = "repo" | "file";

const planAgain = (origin: Origin) => (origin === "repo" ? "Press Check again" : "Pick tokens.json again");

/** The note for a Dark mode a sync added with no dark values yet to write. */
export const darkModeAdded = (origin: Origin) =>
  `Dark mode added. ${planAgain(origin)} to fill in the dark values.`;

export const stoppedPartway = (origin: Origin, reason: string) =>
  `The sync stopped partway. ${planAgain(origin)} to see what is left. (${reason})`;

export const invalidJson = (origin: Origin) =>
  origin === "repo"
    ? "The repo's tokens.json isn't valid JSON. Let CI write it again, then press Check again."
    : "This file isn't valid JSON. Pick the tokens.json Designlane wrote, or run designlane again.";

/** The note for a sync that worked but couldn't redraw its design system page. */
export const pageNotRedrawn = (reason: string) =>
  `The variables and text styles are synced, but the design system page couldn't be redrawn. (${reason})`;

/** The note for the values Apply left as a designer changed them in Figma, by how the designer knows each. */
export const keptAsChanged = (labels: readonly string[]) =>
  `Kept as you changed ${labels.length === 1 ? "it" : "them"} in Figma, until the code has ${labels.length === 1 ? "it" : "them"}: ${labels.join(", ")}.`;
