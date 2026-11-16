/** What `designlane prompt` prints: the instructions a coding agent follows to read an app's design system into the
 * file `designlane --from-agent` takes. */
export const AGENT_FILE = "designlane/agent.json";

export const AGENT_PROMPT = `Read this app's code and write its design system to ${AGENT_FILE}, without changing anything else.

- Every value must come from the app's own code; never add a platform or library default.
- Name each token the way the code refers to it, as a developer would type it (\`Theme.surface\`, \`colors.primary\`, \`R.color.accent\`, \`typography.body\`).
- If ${AGENT_FILE} already exists, it was right for the code as it was: keep each entry's name and value unless the code now says otherwise, add only what the code newly defines, and drop only what it no longer has.
- List only values the code names in its design system (theme objects, palettes, colour constants and resources, typography styles and font helpers), not a value written once inside a screen.
- Write exactly this JSON and nothing else:
{
  "colors": { "<how the code refers to it>": { "light": "#rrggbb", "dark": "#rrggbb, only when the code gives one" } },
  "textStyles": { "<how the code refers to it>": { "family": "...", "size": 17, "weight": "thin|ultraLight|light|regular|medium|semibold|bold|heavy|black" } }
}`;
