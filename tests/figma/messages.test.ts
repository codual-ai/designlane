import { describe, expect, it } from "vitest";
import { toWindow } from "../../figma-plugin/src/messages.js";

const summary = {
  create: ["color/ink"],
  update: [],
  restore: [],
  rename: [{ from: "color/old", to: "Theme.new" }],
  deprecate: [],
  missingFonts: [],
  unchanged: 0,
  partial: false,
  renamesSkipped: false,
  darkLeftOut: false,
  applicable: true,
  figmaChanges: [],
  pullRequestsUnlisted: false,
};

describe("messages to the plugin window", () => {
  it("takes a plan the Figma side sends", () => {
    expect(toWindow({ type: "plan", id: 1, summary })).toEqual({ type: "plan", id: 1, summary });
  });

  it("refuses a message with a malformed entry, which would otherwise break the window", () => {
    expect(toWindow({ type: "plan", id: 1, summary: { ...summary, rename: [null] } })).toBeUndefined();
    expect(toWindow({ type: "applied", notes: [1] })).toBeUndefined();
  });
});
