/** The plugin's window loaded from ui.html in happy-dom, with what it sends to the Figma side and a way to answer. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { PlanSummary, ToPlugin } from "../../figma-plugin/src/messages.js";

// Tests run from the repo root; under happy-dom a module's own URL isn't a file path.
const page = readFileSync(path.join(process.cwd(), "figma-plugin/src/ui.html"), "utf8");

export const summary: PlanSummary = {
  create: ["color/ink"],
  update: [],
  restore: [],
  rename: [],
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

/** The plugin window, freshly loaded, with what it sends to the Figma side. */
export async function openWindow() {
  document.body.innerHTML = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("<script>"));
  const sent: ToPlugin[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((data: { pluginMessage: ToPlugin }) => {
    sent.push(data.pluginMessage);
  });
  vi.resetModules();
  await import("../../figma-plugin/src/ui.js");
  // What the window sends as it opens, set apart so each test sees only what it does.
  const opening = sent.splice(0);
  const file = document.getElementById("file") as HTMLInputElement;
  const result = document.getElementById("result") as HTMLDivElement;
  const apply = document.getElementById("apply") as HTMLButtonElement;
  return {
    opening,
    sent,
    file,
    result,
    apply,
    /** Picks a file and returns the id the window gave its plan. */
    async pick(json: string): Promise<number> {
      const before = sent.length;
      Object.defineProperty(file, "files", {
        value: [{ name: "tokens.json", text: async () => json }],
        configurable: true,
      });
      // A browser shows the picked file's name; happy-dom leaves it empty, so set one to see it cleared.
      Object.defineProperty(file, "value", {
        value: "C:\\fakepath\\tokens.json",
        writable: true,
        configurable: true,
      });
      file.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(sent).toHaveLength(before + 1));
      const message = sent.at(-1);
      if (message?.type !== "plan") throw new Error("the window sent no plan");
      return message.id;
    },
    /** Picks a file the window can't read. */
    async pickUnreadable() {
      const unreadable = { name: "tokens.json", text: async () => Promise.reject(new Error("unreadable")) };
      Object.defineProperty(file, "files", { value: [unreadable], configurable: true });
      file.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(result.textContent).not.toBe("Reading tokens.json…"));
    },
    /** A message as the Figma side sends it. */
    receive(pluginMessage: unknown) {
      window.dispatchEvent(new MessageEvent("message", { data: { pluginMessage } }));
    },
  };
}
