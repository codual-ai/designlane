/**
 * Designlane's reading of an app's code, as a library: which frameworks it's built with, its screens, and the values
 * each file uses, each with where it's written. Offline and deterministic: no AI, no network, and the same answer for
 * the same files. Loads none of the command line, the MCP server or the Figma sync.
 */

export {
  CodeSpanSchema,
  DesignTokensSchema,
  FrameworkIdSchema,
  FrameworkScanSchema,
  ScanResultSchema,
  ScreenLinkSchema,
  ScreenRefSchema,
} from "../scan/schema.js";
export { isTestPath } from "../scan/test-paths.js";
export type {
  FrameworkId,
  FrameworkScan,
  Platform,
  ScanResult,
  ScreenLink,
  ScreenRef,
} from "../scan/types.js";
export { type App, type AppView, readApp } from "./app.js";
export { findFrameworks } from "./find-frameworks.js";
export {
  ColorUseSchema,
  DimensionUseSchema,
  type FileTokens,
  FileTokensSchema,
  FontUseSchema,
  type FoundFramework,
  FoundFrameworkSchema,
  SCREEN_FILE_REASONS,
  type ScreenFile,
  ScreenFileSchema,
  type TokenRef,
  TokenRefSchema,
  type TokenUse,
  TypeStyleUseSchema,
  type TypeValue,
  TypeValueSchema,
} from "./schema.js";
