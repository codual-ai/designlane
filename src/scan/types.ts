export type FrameworkId = "swiftui" | "compose" | "react-native";

/** The platforms an app's code can be for, as tokens.json records them; a React Native app's code is for both iOS
 * and Android, written in JavaScript. */
export const PLATFORMS = ["ios", "android", "react-native"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Each framework as people write it. */
export const FRAMEWORK_NAMES: Record<FrameworkId, string> = {
  swiftui: "SwiftUI",
  compose: "Jetpack Compose",
  "react-native": "React Native",
};

/** `SwiftUI, Jetpack Compose or React Native`, for saying what an app without any of them is missing. */
const names = Object.values(FRAMEWORK_NAMES);
export const SUPPORTED_FRAMEWORKS = `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

export interface ScreenRef {
  /** `<framework>:<path>#<name>`, with `@<line>` added when a file declares the same name twice. */
  id: string;
  framework: FrameworkId;
  name: string;
  /** Relative to the project root, with forward slashes. */
  file: string;
  line: number;
  kind: "screen" | "component";
  /** How strongly the code looks like a whole screen; the scan lists the highest first. */
  score: number;
}

/**
 * How a screen appears when another opens it: `push` onto the navigation stack (with a way back), a `sheet` from the
 * bottom, a `dialog` over the screen, `fullScreen` over everything, a `popover` from a control, a `tab` switched to,
 * `replace` (the stack starts again from it, as after signing in), or a `pane` beside the screen that opened it, on
 * a tablet or an unfolded phone.
 */
export const OPENINGS = [
  "push",
  "sheet",
  "dialog",
  "fullScreen",
  "popover",
  "tab",
  "replace",
  "pane",
] as const;
export type Opening = (typeof OPENINGS)[number];

/** One screen opening another, and where the code does it. */
export interface ScreenLink {
  /** `ScreenRef` ids. */
  from: string;
  to: string;
  opening: Opening;
  /** Where the code opens it. */
  file: string;
  line: number;
  /** The part of the `from` screen (a row, a toolbar) whose code opens it, by id, when it isn't the screen itself. */
  via?: string;
}

/** A stretch of a file: its 1-based line, and its characters as offsets into the file's text in UTF-16 code units,
 * a byte order mark counted (`start` inclusive, `end` exclusive). */
export interface CodeSpan {
  /** Relative to the project root, with forward slashes. */
  file: string;
  line: number;
  start: number;
  end: number;
}

/**
 * What a value's span holds, so a tool changing the value knows what to write in its place. Each span is exactly
 * what is replaced: never a string's quotes, and nothing beside the value.
 * - `literal`: a literal's own text, without its quotes: `#3366CC`, `Inter`, `17`; in resource XML and CSS, the value
 *   as written (`14sp`).
 * - `expression`: the whole expression making the value: `Color(0xFF6650A4)`, `.white`, `.semibold`, `22.sp`.
 * - `family-name`: a font's name, which holds its weight too (`Inter-SemiBold`, `sans-serif-medium`), so changing the
 *   family or the weight rewrites the name.
 * - `identifier`: the name of a font family declared elsewhere (`Inter`, `@font/inter`), not the family's own name.
 * - `components`: an asset catalog colour's whole `components` object.
 */
export const VALUE_KINDS = ["literal", "expression", "family-name", "identifier", "components"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** Where a value is written, and, when the token names another value instead (`link: colors.blue0`), `via`, each
 * name on the way to it, the token's own first. A value reached through a name may be another token's too. */
export interface ValueLocation extends CodeSpan {
  kind: ValueKind;
  via?: CodeSpan[];
}

/** Where a colour's values are written: `light` is the one it shows by default, `dark` one written for dark mode. */
export interface ColorLocations {
  light?: ValueLocation;
  dark?: ValueLocation;
}

/** Where a text style's family, size and weight are written. */
export interface TypeLocations {
  fontFamily?: ValueLocation;
  fontSize?: ValueLocation;
  fontWeight?: ValueLocation;
}

export interface ColorToken {
  /** The app's name for it, or its hex value when the code never names it. */
  name: string;
  /** `#rrggbb` or `#rrggbbaa`. */
  light: string;
  dark?: string;
  /** The file it was defined in, or first found in. */
  source: string;
  /** How the code refers to it (`Theme.surface`, `Color("Brand")`); missing for a value written without a name. */
  reference?: string;
  /** The line it's declared on, for a colour declared in code. */
  line?: number;
  /** An asset catalog entry, a named constant in code, or a value pasted into the code without a name. */
  kind: "asset" | "code" | "inline";
  /** How many places in the code use it, not counting its definition; pasted copies of its value count. */
  uses: number;
  /** Where its values are written, for a value written as it is or reached through names; missing for one worked
   * out from another (`Brand.copy(alpha = 0.5f)`). */
  locations?: ColorLocations;
}

/** A platform colour the app uses (`.red`, `.systemBackground`), which adapts to the platform's own palette. */
export interface SystemColor {
  name: string;
  uses: number;
}

/** A text style the app uses, however it was written. */
export interface TypeStyle {
  /** A platform text style (`headline`), the app's own helper (`scaledBody`), or a description (`Inter 17 bold`). */
  name: string;
  kind: "text-style" | "system" | "custom" | "app";
  /** `System` for the platform font; empty when the family can't be read (a helper mixing several, or a constant). */
  family: string;
  /** In points; text styles at the default text size. Missing when the code computes it. */
  size?: number;
  weight: string;
  /** The app's own helper the code calls for it (`Font.brandTitle`); missing for a font written in place. */
  reference?: string;
  uses: number;
  /** Where a named style's values are written, each one the style sets in one place. */
  locations?: TypeLocations;
}

/** One of the app's themes beside its default one (`Desert` beside `Ocean`): the same colours, each with its own
 * Light and Dark value. */
export interface ColorTheme {
  name: string;
  colors: ColorToken[];
}

/** A spacing or corner radius the code names as one step of a scale: `AppSpacing.large`, `spacing.md`. */
export interface ScaleStep {
  /** Its name in the scale: `large`, `md`. */
  name: string;
  /** In points (dp on Android). */
  value: number;
  /** How the code refers to it, which a sync knows it by: `AppSpacing.large`, `theme.spacing.md`. */
  reference: string;
  /** The file it's declared in. */
  source: string;
  line: number;
  /** How many places in the code use it by name. */
  uses: number;
  /** Where its value is written. */
  location: ValueLocation;
}

/** The spacing and corner radius scales the code names, each smallest first. */
export interface NamedScales {
  spacing: ScaleStep[];
  radii: ScaleStep[];
}

export interface DesignTokens {
  /** Every colour, most used first; for an app with several themes, its default theme's. */
  colors: ColorToken[];
  /** The app's other themes, in the order the code declares them; present only when it has some. */
  themes?: ColorTheme[];
  /** Most used first. */
  systemColors: SystemColor[];
  /** Every text style, most used first. */
  typeStyles: TypeStyle[];
  /** Custom font families: those used, most used first, then those written only in the app's own helpers. */
  fonts: string[];
  /** Every spacing value, most common first. */
  spacing: number[];
  /** Every corner radius, most common first. */
  radii: number[];
  /** The spacing and radius scales the code names; present only when it names one. */
  scales?: NamedScales;
}

export interface FrameworkScan {
  framework: FrameworkId;
  platforms: Platform[];
  screens: ScreenRef[];
  tokens: DesignTokens;
  /** Navigation libraries the app uses that Designlane doesn't read (`Appyx`), so its links aren't listed. */
  navigationNotRead?: string[];
  /** Screens opening other screens, by id, in a stable order; present, even empty, only for the frameworks whose
   * navigation is read. */
  links?: ScreenLink[];
  /** The screens the app's navigation starts on, by id. */
  starts?: string[];
  /** Navigation the code does that couldn't be tied to two screens (a destination in a library, or drawn without one
   * of the app's views), so the links may be incomplete. */
  unresolvedLinks?: number;
  /** Theme objects the code reads its design from that are defined outside the project (`ElementTheme`), so their
   * tokens are in the library's own code. */
  themesOutside?: string[];
}

export interface ScanResult {
  root: string;
  frameworks: FrameworkScan[];
  filesScanned: number;
  /** The project had more files than the scan reads. */
  truncated: boolean;
  /** Folders that couldn't be read. */
  unreadable: string[];
  /** Native frameworks a React Native app has code in, in its own `ios/` and `android/` folders (its widgets,
   * extensions), not read as apps of their own. */
  nativeAlongside?: FrameworkId[];
}
