/** The files Designlane writes into an app, by name; kept apart from writing them so the Figma plugin can find them. */

import type { FrameworkId } from "../scan/types.js";

/** Where the outputs go inside the app, unless told otherwise. */
export const OUTPUT_DIR = "designlane";

/** The tokens file of an app that's alone in its repo. */
export const TOKENS_FILE = "tokens.json";

/** Each app's tokens file when a repo holds more than one (an iPhone and an Android app), so each Figma file connects
 * to its own. Files beside each other rather than folders, which `--out .` would mix up with the apps' own. */
export const APP_TOKENS_FILES: Record<FrameworkId, string> = {
  swiftui: "tokens.ios.json",
  compose: "tokens.android.json",
  "react-native": "tokens.react-native.json",
};
