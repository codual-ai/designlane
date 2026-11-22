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
 * Why a file explains a screen:
 * - `declaration`: it declares the screen.
 * - `child-view`: it declares a view the screen places, at any depth.
 * - `state`: it declares a type the screen's code names that holds its state (`CartViewModel`, `CartStore`,
 *   `CartState`).
 * - `import`: it's one of the project's files a React Native screen's code imports.
 * - `tokens`: it declares a color or text style the screen's code uses.
 */
export const SCREEN_FILE_REASONS = ["declaration", "child-view", "state", "import", "tokens"] as const;

export const ScreenFileSchema = z.object({ file: z.string(), why: z.enum(SCREEN_FILE_REASONS) });
export type ScreenFile = z.infer<typeof ScreenFileSchema>;

/** A piece of text a file shows people, and exactly where it's written (a string's contents, without its quotes; a
 * translated string's key). `literal` is written in the code. `localized` is a translated string named by `key`,
 * with its text in the app's default language, or null when no strings file of the app has one. */
export const StringUseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), text: z.string(), span: CodeSpanSchema }),
  z.object({
    kind: z.literal("localized"),
    key: z.string(),
    text: z.string().nullable(),
    span: CodeSpanSchema,
  }),
]);
export type StringUse = z.infer<typeof StringUseSchema>;

/** What a node of a screen's layout is: a container laying out its children, a decision or a loop over them, a view
 * of the app placed there, or an element shown. `other` is an element none of these name, or a branch or item of
 * several. */
export const LAYOUT_KINDS = [
  "stack-v",
  "stack-h",
  "stack-z",
  "grid",
  "list",
  "lazy-list",
  "lazy-grid",
  "scroll",
  "tabs",
  "nav",
  "form",
  "section",
  "toolbar",
  "repeat",
  "conditional",
  "view-ref",
  "text",
  "button",
  "image",
  "input",
  "spacer",
  "other",
] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

/** A node of a screen's layout, and the nodes inside it, in the order written. */
export interface LayoutNode {
  /** Its path from the screen, by kind: `stack-v/list/text.1` is the second text of the list of the screen's stack.
   * It stays the same when other kinds of nodes are added or removed around it. */
  id: string;
  kind: LayoutKind;
  span: z.infer<typeof CodeSpanSchema>;
  /** For a view-ref, the id of the view placed. */
  ref?: string | undefined;
  children: LayoutNode[];
}

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.enum(LAYOUT_KINDS),
    span: CodeSpanSchema,
    ref: z.string().optional(),
    children: z.array(LayoutNodeSchema),
  }),
);

/** One of a screen's main parts, as a person picks it to change: its node's `id` in the layout of `view` (the screen,
 * or the view it's all placed in), a name to show for it, where its code is, and, for a view placed, that view's id. */
export const ScreenPartSchema = z.object({
  id: z.string(),
  view: z.string(),
  label: z.string(),
  span: CodeSpanSchema,
  ref: z.string().exactOptional(),
});
export type ScreenPart = z.infer<typeof ScreenPartSchema>;

/**
 * Why a layout couldn't be read whole. These values stay the same from release to release, so a tool can map each to
 * its own words:
 * - `no-declaration`: the view isn't declared where the scan found it.
 * - `no-body`: it declares no body (`var body`, a composable's block, a component's return).
 * - `unbalanced`: a bracket in its code is left open, or closes one it didn't open.
 * - `open-extension`: an extension of a SwiftUI view in its file is left open.
 * - `parse-error`: TypeScript's parser found an error in its code.
 * - `too-deep`: its code nests past the reader's limit.
 * - `too-much-inlined`: its view properties place each other past the reader's limit.
 */
export const UNREADABLE_REASONS = [
  "no-declaration",
  "no-body",
  "unbalanced",
  "open-extension",
  "parse-error",
  "too-deep",
  "too-much-inlined",
] as const;
export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/**
 * What may be wrong in a layout that was read. These values stay the same from release to release too:
 * - `ambiguous-view`: a name places one of several views of the app, and nothing tells which (the name is its
 *   `detail`).
 * - `unknown-element`: an element no framework table names, so it's `other` (its name is the issue's `detail`).
 * - `if-as-written`: a SwiftUI `#if` around more than one block holds, so both its sides are read as shown.
 * - `self-placed`: a view places itself.
 * - `unnamed-part`: one of the screen's parts is labelled by its kind, the code naming it nothing (the label is its
 *   `detail`).
 * - `no-parts`: a screen whose layout was read has no parts.
 */
export const LAYOUT_ISSUE_KINDS = [
  "ambiguous-view",
  "unknown-element",
  "if-as-written",
  "self-placed",
  "unnamed-part",
  "no-parts",
] as const;
export type LayoutIssueKind = (typeof LAYOUT_ISSUE_KINDS)[number];

/** Where Designlane falls short on a screen: why its layout couldn't be read whole, if it couldn't (the screen's, or
 * that of a view its parts are found in), and what may be wrong in one that was, each where it's written. */
export const LayoutIssuesSchema = z.object({
  screen: z.string(),
  unreadable: z
    .object({ reason: z.enum(UNREADABLE_REASONS), view: z.string(), span: CodeSpanSchema })
    .exactOptional(),
  issues: z.array(
    z.object({ kind: z.enum(LAYOUT_ISSUE_KINDS), span: CodeSpanSchema, detail: z.string().exactOptional() }),
  ),
});
export type LayoutIssues = z.infer<typeof LayoutIssuesSchema>;
