/** Zod schemas for what `scanRepo` returns, for a tool reading a scan it didn't make (saved, or sent from another
 * process). Each one's type is the matching type in `types.ts`, which a test checks. */

import { z } from "zod";
import { OPENINGS, PLATFORMS, VALUE_KINDS } from "./types.js";

export const FrameworkIdSchema = z.enum(["swiftui", "compose", "react-native"]);

export const ScreenRefSchema = z.object({
  id: z.string(),
  framework: FrameworkIdSchema,
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
  kind: z.enum(["screen", "component"]),
  score: z.number(),
});

export const ScreenLinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  opening: z.enum(OPENINGS),
  file: z.string(),
  line: z.number().int(),
  via: z.string().exactOptional(),
});

/** A stretch of a file: its 1-based line, and offsets into its text in UTF-16 code units, `end` exclusive. */
export const CodeSpanSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

const ValueLocationSchema = CodeSpanSchema.extend({
  kind: z.enum(VALUE_KINDS),
  via: z.array(CodeSpanSchema).exactOptional(),
});

const ColorLocationsSchema = z.object({
  light: ValueLocationSchema.exactOptional(),
  dark: ValueLocationSchema.exactOptional(),
});

const TypeLocationsSchema = z.object({
  fontFamily: ValueLocationSchema.exactOptional(),
  fontSize: ValueLocationSchema.exactOptional(),
  fontWeight: ValueLocationSchema.exactOptional(),
});

const ColorTokenSchema = z.object({
  name: z.string(),
  light: z.string(),
  dark: z.string().exactOptional(),
  source: z.string(),
  reference: z.string().exactOptional(),
  line: z.number().int().exactOptional(),
  kind: z.enum(["asset", "code", "inline"]),
  uses: z.number().int(),
  locations: ColorLocationsSchema.exactOptional(),
});

const TypeStyleSchema = z.object({
  name: z.string(),
  kind: z.enum(["text-style", "system", "custom", "app"]),
  family: z.string(),
  size: z.number().exactOptional(),
  weight: z.string(),
  reference: z.string().exactOptional(),
  uses: z.number().int(),
  locations: TypeLocationsSchema.exactOptional(),
});

export const DesignTokensSchema = z.object({
  colors: z.array(ColorTokenSchema),
  themes: z.array(z.object({ name: z.string(), colors: z.array(ColorTokenSchema) })).exactOptional(),
  systemColors: z.array(z.object({ name: z.string(), uses: z.number().int() })),
  typeStyles: z.array(TypeStyleSchema),
  fonts: z.array(z.string()),
  spacing: z.array(z.number()),
  radii: z.array(z.number()),
});

export const FrameworkScanSchema = z.object({
  framework: FrameworkIdSchema,
  platforms: z.array(z.enum(PLATFORMS)),
  screens: z.array(ScreenRefSchema),
  tokens: DesignTokensSchema,
  navigationNotRead: z.array(z.string()).exactOptional(),
  links: z.array(ScreenLinkSchema).exactOptional(),
  starts: z.array(z.string()).exactOptional(),
  unresolvedLinks: z.number().int().exactOptional(),
  themesOutside: z.array(z.string()).exactOptional(),
});

export const ScanResultSchema = z.object({
  root: z.string(),
  frameworks: z.array(FrameworkScanSchema),
  filesScanned: z.number().int(),
  truncated: z.boolean(),
  unreadable: z.array(z.string()),
  nativeAlongside: z.array(FrameworkIdSchema).exactOptional(),
});
