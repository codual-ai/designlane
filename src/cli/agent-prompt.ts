/** What `designlane prompt` prints: the instructions a coding agent follows to map an app's design system into the
 * file `designlane --from-agent` checks. */
export const AGENT_FILE = "designlane/agent.json";
/** The file beside the map that `designlane --from-agent` lists each entry the code doesn't bear out in, for the
 * agent to fix its map by. */
export const CHECK_FILE = "agent-check.json";
const AGENT_CHECK_FILE = `designlane/${CHECK_FILE}`;

export const AGENT_PROMPT = `Read this app's code and write its design system map to ${AGENT_FILE}, without changing anything else.

Designlane checks every entry against the code at the place you give, and keeps only what the code bears out.

- Every value must come from the app's own code; never add a platform or library default.
- Name each entry the way the code refers to it, as a developer would type it (\`Theme.surface\`, \`colors.primary\`, \`MaterialTheme.colorScheme.primary\`, \`AppSpacing.md\`).
- List only what the code names in its design system: theme objects, palettes, color constants and assets, text styles and font helpers, spacing and corner radius constants, and the reusable components built on them (buttons, cards, rows, inputs used across screens, not screens). Not a value written once inside a screen.
- \`at\` is where the value is written, as \`file:line\`: the file from the app's folder, and the 1-based line its value, or the statement holding it, starts on. For an asset catalog color, the line of its \`"components"\` in Contents.json. For a component, the line its declaration starts on.
- Colors are \`#rrggbb\`, or \`#rrggbbaa\` when not fully opaque. Sizes are numbers, in points (dp on Android).
- \`dark\` is only for a color the code gives a dark value; \`themes\` only for named themes beside the default one. Any section can be \`{}\`.
- If ${AGENT_FILE} already exists, it was right for the code as it was: keep each entry unless the code now says otherwise, add what the code newly defines, and drop what it no longer has.
- If ${AGENT_CHECK_FILE} exists, it lists each entry Designlane couldn't confirm, with where and why: fix those entries, or drop the ones the code doesn't name.
- Write exactly this JSON and nothing else:
{
  "version": 1,
  "colors": { "<reference>": { "light": { "value": "#rrggbb", "at": "file:line" }, "dark": { "value": "#rrggbb", "at": "file:line" } } },
  "themes": { "<theme name>": { "<reference>": { "light": { "value": "#rrggbb", "at": "file:line" } } } },
  "textStyles": { "<reference>": { "family": "...", "size": 17, "weight": "thin|ultraLight|light|regular|medium|semibold|bold|heavy|black", "at": "file:line" } },
  "spacing": { "<reference>": { "value": 16, "at": "file:line" } },
  "radii": { "<reference>": { "value": 12, "at": "file:line" } },
  "components": { "<name>": { "category": "button|list|card|header|input|label|media|other", "parameters": ["..."], "at": "file:line" } }
}`;
