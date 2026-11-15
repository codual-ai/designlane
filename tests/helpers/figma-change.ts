/** A change a designer made in Figma, as the plugin's window and its Figma side pass it: the brand colour's light
 * value, for tests that start from one and vary it. */

import type { FigmaChange } from "../../figma-plugin/src/messages.js";

export const brandChange: FigmaChange = {
  id: "V:1 light",
  name: "color/brand",
  token: "brand",
  property: "light",
  from: "#ff1a2e",
  to: "#de2413",
  inCodeToo: false,
};
