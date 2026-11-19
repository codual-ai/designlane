/** The shapes `designlane/read` answers with, as zod schemas; the types are inferred from them, so they can't drift. */

import { z } from "zod";
import { CodeSpanSchema, FrameworkIdSchema } from "../scan/schema.js";
import { PLATFORMS } from "../scan/types.js";

/** A named token, keyed as tokens.json keys it: `brand`, or within a theme, `surface` of `Desert`. */
export const TokenRefSchema = z.object({
  key: z.string(),
  /** How the code refers to it: `Theme.brand`, `Color("Brand")`. */
  reference: z.string().optional(),
  /** The theme it's from, for an app with several; missing for the default theme's. */
  theme: z.string().optional(),
});

export const TypeValueSchema = z.object({
  family: z.string().optional(),
  /** In points (sp on Android). */
  size: z.number().optional(),
  /** 100 to 900. */
  weight: z.number().optional(),
});

/** One place a file uses a value: the named token it names, if it names one, the value, and where it's written. */
const useOf = <V extends z.ZodType>(value: V) =>
  z.object({ token: TokenRefSchema.optional(), value, span: CodeSpanSchema });

/** A colour as lowercase `#rrggbb`, or `#rrggbbaa` when it isn't fully opaque: one colour is always written one way. */
const COLOR_VALUE = /^#[0-9a-f]{6}(?:(?!ff)[0-9a-f]{2})?$/;

export const ColorUseSchema = useOf(z.string().regex(COLOR_VALUE));
export const TypeStyleUseSchema = useOf(TypeValueSchema);
export const FontUseSchema = useOf(z.string());
export const DimensionUseSchema = useOf(z.number());

/** Every value one file uses, each list in the order it's written. New kinds of value come as new fields. */
export const FileTokensSchema = z.object({
  framework: FrameworkIdSchema,
  /** `#rrggbb` or `#rrggbbaa`; a named colour's is its default (light) value. */
  colors: z.array(ColorUseSchema),
  typeStyles: z.array(TypeStyleUseSchema),
  /** Custom font families, by name. */
  fonts: z.array(FontUseSchema),
  /** In points (dp on Android). */
  spacing: z.array(DimensionUseSchema),
  radii: z.array(DimensionUseSchema),
});

export const FoundFrameworkSchema = z.object({
  framework: FrameworkIdSchema,
  platforms: z.array(z.enum(PLATFORMS)),
  /** The folders its code is in, relative to the app's; `""` for the app's own. */
  roots: z.array(z.string()),
});

export type TokenRef = z.infer<typeof TokenRefSchema>;
export type TypeValue = z.infer<typeof TypeValueSchema>;
/** One use, with its value's type: a colour's `string`, a text style's `TypeValue`. */
export type TokenUse<V> = Omit<z.infer<typeof FontUseSchema>, "value"> & { value: V };
export type FileTokens = z.infer<typeof FileTokensSchema>;
export type FoundFramework = z.infer<typeof FoundFrameworkSchema>;
