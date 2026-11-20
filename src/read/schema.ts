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
  /** Read through a theme the user picks (`theme.tintColor`): its value changes with that theme, and the value given
   * is the default theme's. */
  themed: z.literal(true).optional(),
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
/** A color or text style may come from a theme declared outside the app (in a library): then it's `unresolved`, named
 * as the code writes it, with no value. */
const unresolvedOr = <V extends z.ZodType>(value: V) =>
  z.union([
    useOf(value),
    z.object({ token: TokenRefSchema, value: z.null(), unresolved: z.literal(true), span: CodeSpanSchema }),
  ]);

/** A colour as lowercase `#rrggbb`, or `#rrggbbaa` when it isn't fully opaque: one colour is always written one way. */
const COLOR_VALUE = /^#[0-9a-f]{6}(?:(?!ff)[0-9a-f]{2})?$/;

export const ColorUseSchema = unresolvedOr(z.string().regex(COLOR_VALUE));
export const TypeStyleUseSchema = unresolvedOr(TypeValueSchema);
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
type Span = z.infer<typeof CodeSpanSchema>;
/** One use, with its value's type: a color's `string`, a text style's `TypeValue`. */
export type TokenUse<V> = { token?: TokenRef; value: V; span: Span };
export type FileTokens = z.infer<typeof FileTokensSchema>;
export type FoundFramework = z.infer<typeof FoundFrameworkSchema>;

/**
 * Why a file explains a screen: it declares the screen, declares a view the screen places (at any depth), declares a
 * type the screen's code names that holds its state (`CartViewModel`, `CartStore`), is one of the project's files a
 * React Native screen's code imports, or declares a token the screen's code uses.
 */
export const SCREEN_FILE_REASONS = ["declaration", "child-view", "view-model", "import", "tokens"] as const;

export const ScreenFileSchema = z.object({ file: z.string(), why: z.enum(SCREEN_FILE_REASONS) });
export type ScreenFile = z.infer<typeof ScreenFileSchema>;
