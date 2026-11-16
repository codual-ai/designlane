/** What Designlane wrote before its rename from Designmap, for tests that it still reads it. */

const OWN_KEY = /"designlane":/g;

/** The tokens.json `json` as a file written before the rename has it: its data under `$extensions.designmap`. */
export const beforeRename = (json: string) => json.replace(OWN_KEY, '"designmap":');
