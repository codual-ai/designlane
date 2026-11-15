/**
 * A coding agent's reading of an app's design system (the file `designmap prompt` asks it to write), checked against
 * the code and added to what Designmap read itself, so an app whose setup its rules don't cover still syncs.
 */

import { z } from "zod";
import { colorOf } from "../frameworks/css-color.js";
import { OUTPUT_DIR } from "../output/output-files.js";
import { listFiles, readText } from "./files.js";
import type { ColorToken, FrameworkScan, ScanResult } from "./types.js";

const AgentFile = z.object({
  colors: z
    .record(
      z.string(),
      z.object({ light: z.string(), dark: z.string().optional(), code: z.string().optional() }),
    )
    .default({}),
  textStyles: z
    .record(
      z.string(),
      z.object({
        family: z.string().optional(),
        size: z.number().positive().optional(),
        weight: z.string().optional(),
        code: z.string().optional(),
      }),
    )
    .default({}),
});

export interface AgentMerge {
  scan: ScanResult;
  added: number;
  /** How the code refers to each token the code doesn't bear out: a value it doesn't write, or a name it never uses. */
  dropped: string[];
}

const WEIGHTS = new Set([
  "thin",
  "ultraLight",
  "light",
  "regular",
  "medium",
  "semibold",
  "bold",
  "heavy",
  "black",
]);
const CODE_FILES = /\.(swift|kt|kts|xml|java|ts|tsx|js|jsx|json|css|scss)$/i;
/** A hex colour literal: `#3366e6`, `#36e`, `#3366e6cc`, `0x3366E6`, `0xFF3366E6` (Android's alpha first). */
const HEX = /(#|0x)([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/gi;
const NUMBER = String.raw`(\d+(?:\.\d+)?)(?:\s*\/\s*255(?:\.0+)?)?`;
/** Three channels in one call: `Color(red: 0.2, green: 0.4, blue: 0.9)`, `rgb(51, 102, 230)`, `.init(red: 51 / 255, …`. */
const CHANNELS = new RegExp(
  String.raw`\(\s*(?:\w+:\s*)?${NUMBER}\s*,\s*(?:\w+:\s*)?${NUMBER}\s*,\s*(?:\w+:\s*)?${NUMBER}`,
  "g",
);
/** Names the code uses: identifiers, and keys written as strings (`colors["brand-blue"]`). */
const WORD = /[A-Za-z_$][\w$-]*/g;

/** What the code writes, read once: each colour by `#rrggbb` (or `#rrggbbaa`) with the file it's first in, and every
 * name it uses. */
interface CodeIndex {
  colors: Map<string, string>;
  names: Set<string>;
}

/** The scan with the agent's tokens added that the code bears out and Designmap didn't already have. */
export async function mergeAgentTokens(scan: ScanResult, json: unknown): Promise<AgentMerge> {
  const parsed = AgentFile.safeParse(json);
  if (!parsed.success)
    throw new Error(`the agent's file isn't in the expected shape: ${z.prettifyError(parsed.error)}`);
  const [framework, ...others] = scan.frameworks;
  if (!framework) throw new Error("no app code to add the agent's tokens to");
  if (others.length)
    throw new Error("this repo has more than one app: run designmap and the agent in one app's folder");
  const code = await indexCode(scan.root);
  const dropped: string[] = [];
  const colors = [...framework.tokens.colors];
  const known = [...colors, ...(framework.tokens.themes ?? []).flatMap((t) => t.colors)];
  const styles = [...framework.tokens.typeStyles];
  let added = 0;
  for (const [key, c] of Object.entries(parsed.data.colors)) {
    const reference = c.code ?? key;
    const light = colorOf(c.light);
    const dark = c.dark === undefined ? undefined : colorOf(c.dark);
    const source = light && code.colors.get(light);
    const bornOut =
      source && named(code, reference) && (c.dark === undefined || (dark && code.colors.has(dark)));
    if (!light || !source || !bornOut) {
      dropped.push(reference);
      continue;
    }
    const same = (t: ColorToken) =>
      t.reference === reference || (t.kind !== "inline" && t.light === light && t.dark === dark);
    if (known.some(same)) continue;
    const token: ColorToken = {
      name: nameOf(reference),
      light,
      ...(dark ? { dark } : {}),
      source,
      reference,
      kind: "code",
      uses: 0,
    };
    colors.push(token);
    known.push(token);
    added++;
  }
  for (const [key, s] of Object.entries(parsed.data.textStyles)) {
    const reference = s.code ?? key;
    if (!named(code, reference) || (s.size === undefined && !s.family)) {
      dropped.push(reference);
      continue;
    }
    if (styles.some((t) => t.reference === reference)) continue;
    const weight = s.weight && WEIGHTS.has(s.weight) ? s.weight : "regular";
    styles.push({
      name: nameOf(reference),
      kind: "app",
      family: s.family ?? "",
      ...(s.size ? { size: s.size } : {}),
      weight,
      reference,
      uses: 0,
    });
    added++;
  }
  const merged: FrameworkScan = { ...framework, tokens: { ...framework.tokens, colors, typeStyles: styles } };
  return { scan: { ...scan, frameworks: [merged] }, added, dropped };
}

/** The last name in a reference: `surface` in `Theme.surface`, `brand-blue` in `colors["brand-blue"]`, `gray` in
 * `colors.gray[100]`. */
const nameOf = (reference: string) => reference.match(WORD)?.at(-1) ?? reference;

const named = (code: CodeIndex, reference: string) => code.names.has(nameOf(reference));

async function indexCode(root: string): Promise<CodeIndex> {
  const { files } = await listFiles(root);
  const index: CodeIndex = { colors: new Map(), names: new Set() };
  // Designmap's own output, the agent's file among it, would bear out anything the agent wrote: an app's own and a
  // nested app's alike.
  const own = (rel: string) => rel.startsWith(`${OUTPUT_DIR}/`) || rel.includes(`/${OUTPUT_DIR}/`);
  for (const file of files.filter((f) => CODE_FILES.test(f.rel) && !own(f.rel))) {
    const text = await readText(file.abs);
    if (text === undefined) continue;
    const add = (hex: string | undefined) => {
      if (hex && !index.colors.has(hex)) index.colors.set(hex, file.rel);
    };
    for (const [, prefix, digits = ""] of text.matchAll(HEX))
      add(
        colorOf(`#${prefix === "#" || digits.length !== 8 ? digits : digits.slice(2) + digits.slice(0, 2)}`),
      );
    for (const m of text.matchAll(CHANNELS)) add(fromChannels(m.slice(1, 4), m[0]));
    for (const [word] of text.matchAll(WORD)) index.names.add(word);
  }
  return index;
}

/** `#rrggbb` from three channels, all 0-255 or all fractions of 1 (`/ 255` read as written). */
function fromChannels(raw: (string | undefined)[], text: string): string | undefined {
  const values = raw.map(Number);
  if (values.some((v) => Number.isNaN(v))) return undefined;
  const scaled = text.includes("/")
    ? values
    : values.every((v) => v <= 1)
      ? values.map((v) => v * 255)
      : values;
  if (scaled.some((v) => v > 255)) return undefined;
  return `#${scaled.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}
