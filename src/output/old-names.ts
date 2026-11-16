/** Designlane was called Designmap before 0.3.0. What it wrote into apps under that name is still read: the output
 * folder, and the key it kept its own data under in each `$extensions` of tokens.json. */

/** The output folder of an app set up before the rename, which it keeps. */
export const OLD_OUTPUT_DIR = "designmap";

const EXTENSION = "designlane";
const OLD_EXTENSION = "designmap";
/** How deep tokens.json nests what carries `$extensions`: the file, `theme`, a theme, its `color`, a colour. */
const EXTENSIONS_DEPTH = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `node` with its `$extensions.designmap` as `$extensions.designlane`; as it is when it has neither, or both. */
function withRenamedExtension(node: Record<string, unknown>): Record<string, unknown> {
  const extensions = node.$extensions;
  if (!isRecord(extensions) || !(OLD_EXTENSION in extensions) || EXTENSION in extensions) return node;
  const { [OLD_EXTENSION]: own, ...others } = extensions;
  return { ...node, $extensions: { ...others, [EXTENSION]: own } };
}

function renamedFrom(node: unknown, depth: number): unknown {
  if (!isRecord(node)) return node;
  const renamed = withRenamedExtension(node);
  if (depth === EXTENSIONS_DEPTH) return renamed;
  return Object.fromEntries(
    Object.entries(renamed).map(([key, value]) => [
      key,
      key === "$extensions" ? value : renamedFrom(value, depth + 1),
    ]),
  );
}

/** The parsed tokens.json `json`, with the data a file written before the rename keeps under `$extensions.designmap`
 * read as written now, under `$extensions.designlane`. */
export const withCurrentNames = (json: unknown): unknown => renamedFrom(json, 0);
