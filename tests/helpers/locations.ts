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
