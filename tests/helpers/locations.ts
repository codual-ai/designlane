import { scanRepo } from "../../src/scan/index.js";
import type { CodeSpan, DesignTokens, FrameworkId, ValueLocation } from "../../src/scan/types.js";
import { tempDir } from "./temp.js";

/** A scan of `files`, with what's written at a location: its text, and each name on the way to it first. */
export async function scanned(files: Record<string, string>) {
  const scan = await scanRepo(await tempDir(files));
  const text = (span: CodeSpan) => files[span.file]?.slice(span.start, span.end);
  /** Each name on the way to the value, then the value, as written. */
  const written = (location: ValueLocation | undefined) =>
    location && [...(location.via ?? []), location].map(text);
  const tokens = (framework: FrameworkId): DesignTokens => {
    const found = scan.frameworks.find((f) => f.framework === framework);
    if (!found) throw new Error(`no ${framework} found`);
    return found.tokens;
  };
  return { scan, written, tokens };
}

/** The one of `items` the code reaches by `reference`; throws, listing the references found, when there's none. */
export function byReference<T extends { reference?: string }>(items: T[], reference: string): T {
  const found = items.find((item) => item.reference === reference);
  if (!found) throw new Error(`no ${reference}: ${items.map((item) => item.reference).join(", ")}`);
  return found;
}

/** An asset catalog colour set's `Contents.json`, with an entry per colour, each for any appearance or dark. */
export const colorset = (...entries: { components: Record<string, string>; dark?: boolean }[]) =>
  JSON.stringify(
    {
      colors: entries.map(({ components, dark }) => ({
        color: { "color-space": "srgb", components },
        idiom: "universal",
        ...(dark ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
      })),
    },
    null,
    2,
  );
