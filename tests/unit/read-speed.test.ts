import { describe, expect } from "vitest";
import { readApp } from "../../src/read/index.js";
import { swift } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";
import { speedIt } from "../helpers/speed.js";

/** How fast the reads must be: fast enough to run beside every variant an app generates. */
const BUDGET_MS = { tokensIn: 20, changes: 20, themeChange: 50 };
const LINES = 2000;
/** An app the size of a large one's design system: many colours and screens using them. */
const COLORS = 300;
const SCREENS = 400;

const theme = swift(
  "extension Color {",
  ...Array.from(
    { length: COLORS },
    (_, i) => `  static let c${i} = Color(red: ${(i % 10) / 10}, green: 0.5, blue: 0.5)`,
  ),
  "}",
);
/** A long screen as real ones are written: a value from the design system every few lines, layout code between. */
const USE_EVERY = 4;
const row = (k: number) =>
  k % USE_EVERY === 0
    ? `      Text("Row ${k}").foregroundStyle(Color.c${k % COLORS}).padding(${k % 24}).cornerRadius(8)`
    : `      HStack { Image(systemName: "star"); Text(item${k}.title).lineLimit(2) }`;
const screen = (i: number) =>
  swift(
    `struct Screen${i}: View {`,
    "  var body: some View {",
    "    VStack {",
    ...Array.from({ length: LINES - 6 }, (_, k) => row(k)),
    "    }",
    "  }",
    "}",
  );

async function bigApp() {
  const files: Record<string, string> = { "App/Theme.swift": theme };
  for (let i = 0; i < SCREENS; i++)
    files[`App/Screens/Screen${i}.swift`] =
      i < 5
        ? screen(i)
        : swift(
            `struct S${i}: View { var body: some View { Text("x").foregroundStyle(Color.c${i % COLORS}) } }`,
          );
  return readApp(await appIn(files));
}

/** The fastest of a few runs, so a busy machine's one slow run doesn't count. */
async function fastest(run: () => unknown | Promise<unknown>, times = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    await run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("designlane/read speed", () => {
  speedIt(
    `reads a ${LINES}-line file's values within the budget`,
    async () => {
      const app = await bigApp();
      const text = screen(0);
      expect(app.tokensIn("App/Screens/Screen0.swift", text)?.colors).toHaveLength(
        Math.ceil((LINES - 6) / USE_EVERY),
      );
      expect(await fastest(() => app.tokensIn("App/Screens/Screen0.swift", text))).toBeLessThan(
        BUDGET_MS.tokensIn,
      );
    },
    120_000,
  );

  speedIt(
    "makes a view with five screens changed, or with the theme changed, within the budget",
    async () => {
      const app = await bigApp();
      const five = Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`App/Screens/S${100 + i}.swift`, swift("let a = Color.c1")]),
      );
      expect(await fastest(() => app.withChanges(five))).toBeLessThan(BUDGET_MS.changes);
      const recolored = { "App/Theme.swift": theme.replace("green: 0.5", "green: 0.6") };
      expect(await fastest(() => app.withChanges(recolored))).toBeLessThan(BUDGET_MS.themeChange);
    },
    120_000,
  );
});
