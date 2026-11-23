import { describe, expect, it } from "vitest";
import { AGENT_PROMPT, CHECK_FILE } from "../../src/cli/agent-prompt.js";
import { checkSummary } from "../../src/cli/agent-summary.js";
import { AgentMapSchema } from "../../src/scan/agent-map.js";

const entry = (reference: string, why: string) => ({
  reference,
  at: "App/Theme.swift:3",
  kind: "other-value",
  why,
});

describe("the Action's summary of an agent map's check", () => {
  it("says how many entries match, and lists each that doesn't, safely in a table", () => {
    const summary = checkSummary({
      confirmed: 3,
      unconfirmed: [
        entry("Theme.accent", "the code there writes #3366cc | not #000000"),
        entry("Theme.b", "x"),
      ],
    });
    expect(summary).toContain("3 of 5 entries match the code.");
    expect(summary).toContain("These don't: the code may have moved on.");
    expect(summary).toContain(
      "| `Theme.accent` | `App/Theme.swift:3` | the code there writes #3366cc \\| not #000000 |",
    );
  });

  it("says one in the singular, none when all match, and how many more past fifty", () => {
    expect(checkSummary({ confirmed: 1, unconfirmed: [entry("a", "x")] })).toContain("This one doesn't:");
    expect(checkSummary({ confirmed: 4, unconfirmed: [] })).toBe(
      "### Designlane: the agent's map\n\n4 of 4 entries match the code.\n",
    );
    const many = Array.from({ length: 53 }, (_, i) => entry(`T.c${i}`, "x"));
    const summary = checkSummary({ confirmed: 0, unconfirmed: many });
    expect(summary.split("\n").filter((l) => l.startsWith("| `"))).toHaveLength(50);
    expect(summary).toContain("And 3 more.");
  });

  it("refuses a check file of another shape", () => {
    expect(() => checkSummary({ confirmed: "x" })).toThrow();
  });
});

describe("designlane prompt", () => {
  it("asks for the map's version 1 shape, each section the checker reads, and its check file", () => {
    const json = AGENT_PROMPT.slice(AGENT_PROMPT.indexOf("{\n"));
    for (const section of ["version", "colors", "themes", "textStyles", "spacing", "radii", "components"])
      expect(json).toContain(`"${section}"`);
    expect(AGENT_PROMPT).toContain(`designlane/${CHECK_FILE}`);
    // Its example, filled in, is a map the checker reads.
    const filled = json
      .replaceAll('"file:line"', '"App/Theme.swift:3"')
      .replaceAll('"#rrggbb"', '"#3366cc"')
      .replace(/"thin\|[^"]*"/, '"bold"')
      .replace(/"button\|[^"]*"/, '"button"');
    expect(AgentMapSchema.safeParse(JSON.parse(filled)).success).toBe(true);
  });
});
