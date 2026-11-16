import type { ViewFacts } from "../scan/classify.js";
import type { SourceFile } from "../scan/files.js";
import type { DesignTokens, FrameworkId, Opening, Platform } from "../scan/types.js";

export interface ScanContext {
  root: string;
  files: SourceFile[];
  /** True when the project had more files than the scan reads. */
  truncated: boolean;
  /** Folders that couldn't be read. */
  unreadable: string[];
  /** Reads a file's text, or undefined when it's missing or too large to be source. */
  read(file: SourceFile): Promise<string | undefined>;
}

/** A view, by where it's declared. */
export interface ViewRef {
  name: string;
  file: string;
  line: number;
}

/** One view's screen opening another's, how it appears, and where the code does it. */
export interface ViewLink {
  from: ViewRef;
  to: ViewRef;
  opening: Opening;
  file: string;
  line: number;
}

/** One view placed inside another, so a link made from a part of a screen (a row) can be credited to the screen. */
export interface ViewPlacement {
  view: ViewRef;
  in: ViewRef;
}

/** What a plugin found in one framework's code. */
export interface FrameworkFindings {
  views: ViewFacts[];
  tokens: DesignTokens;
  /** Navigation libraries the app uses that aren't read, so its links aren't listed. */
  navigationNotRead?: string[];
  /** Screens opening other screens, present (empty when there are none) when the framework's navigation is read. */
  links?: ViewLink[];
  /** The views the app's navigation starts on. */
  starts?: ViewRef[];
  /** Which views are placed inside which, for crediting links made from a part of a screen to the screen. */
  placements?: ViewPlacement[];
  /** Navigation that couldn't be tied to two views. */
  unresolvedLinks?: number;
  /** Theme objects the code reads its design from that are defined outside the project, in a library. */
  themesOutside?: string[];
}

/**
 * One framework Designlane understands. Supporting a new framework means writing one `scan`: the facts about each of
 * its views (the shared classifier decides screens from those) and its design tokens, or nothing when the project
 * doesn't use the framework.
 */
export interface FrameworkPlugin {
  id: FrameworkId;
  platforms: Platform[];
  scan(ctx: ScanContext): Promise<FrameworkFindings | undefined>;
}
