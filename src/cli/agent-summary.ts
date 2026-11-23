/** The GitHub Action's summary of an agent map's check: how many entries the code bears out, and each it no longer
 * does, so a push that leaves the map behind the code says so where the run is read. */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UNCONFIRMED_KINDS } from "../scan/agent-map.js";

/** How many entries the summary lists; the check file has them all. */
const MAX_ROWS = 50;

const CheckSchema = z.object({
  confirmed: z.number(),
  unconfirmed: z.array(
    z.object({
      reference: z.string(),
      at: z.string(),
      kind: z.enum(Object.keys(UNCONFIRMED_KINDS) as [keyof typeof UNCONFIRMED_KINDS]),
      why: z.string(),
    }),
  ),
});

/** A table cell's text: no line break or `|` to end the row. */
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The summary, in Markdown, of a check file's contents. */
export function checkSummary(json: unknown): string {
  const check = CheckSchema.parse(json);
  const total = check.confirmed + check.unconfirmed.length;
  const heading = `### Designlane: the agent's map\n\n${check.confirmed} of ${total} entries match the code.`;
  if (check.unconfirmed.length === 0) return `${heading}\n`;
  const rows = check.unconfirmed
    .slice(0, MAX_ROWS)
    .map((u) => `| \`${cell(u.reference)}\` | \`${cell(u.at)}\` | ${cell(u.why)} |`);
  const more =
    check.unconfirmed.length > MAX_ROWS ? `\nAnd ${check.unconfirmed.length - MAX_ROWS} more.\n` : "";
  return [
    heading,
    "",
    `${check.unconfirmed.length === 1 ? "This one doesn't" : "These don't"}: the code may have moved on. Run your coding agent with \`designlane prompt\` again, which fixes the map from \`designlane/agent-check.json\`.`,
    "",
    "| Entry | Where | Why |",
    "| --- | --- | --- |",
    ...rows,
    more,
  ].join("\n");
}

/** Prints the summary of the check file at `file`: `node agent-summary.js <file>`. */
export async function printSummary(file: string, out: (text: string) => void): Promise<void> {
  out(checkSummary(JSON.parse(await readFile(file, "utf8"))));
}
