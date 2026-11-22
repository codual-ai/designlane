import { describe, expect } from "vitest";
import { readApp } from "../../src/read/index.js";
import { swift } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";
import { speedIt } from "../helpers/speed.js";

/** How fast the reads must be: fast enough to run beside every variant an app generates, with room for a slower CI
 * machine (a long file reads in about 15 ms on a laptop and 25 ms in CI). */
const BUDGET_MS = {
  tokensIn: 50,
  changes: 20,
  themeChange: 50,
  filesFor: 50,
  stringsIn: 50,
  layoutOf: 50,
  screenParts: 50,
  layoutIssues: 300,
};
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
    "lists a screen's files within the budget, once the app's files are parsed, and again in a view",
    async () => {
      const app = await bigApp();
      const id = "swiftui:App/Screens/Screen0.swift#Screen0";
      const started = performance.now();
      expect(app.filesFor(id).map((f) => f.file)).toEqual(["App/Screens/Screen0.swift", "App/Theme.swift"]);
      const first = performance.now() - started;
      expect(await fastest(() => app.filesFor(id))).toBeLessThan(BUDGET_MS.filesFor);
      // A view parses only the file it changed, and shares the rest with the app.
      const views = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          app.withChanges({ "App/Screens/S100.swift": swift(`let a${i} = 1`) }),
        ),
      );
      let view = 0;
      expect(await fastest(() => views[view++]?.filesFor(id))).toBeLessThan(first / 2);
    },
    120_000,
  );

  speedIt(
    `reads a ${LINES}-line screen's layout within the budget, and again in a view`,
    async () => {
      const app = await bigApp();
      const id = "swiftui:App/Screens/Screen0.swift#Screen0";
      const stack = app.layoutOf(id)?.children[0];
      expect(stack?.children).toHaveLength(LINES - 6);
      expect(await fastest(() => app.layoutOf(id))).toBeLessThan(BUDGET_MS.layoutOf);
      const views = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          app.withChanges({ "App/Screens/S100.swift": swift(`let a${i} = 1`) }),
        ),
      );
      let view = 0;
      expect(await fastest(() => views[view++]?.layoutOf(id))).toBeLessThan(BUDGET_MS.layoutOf * 4);
    },
    120_000,
  );

  speedIt(
    `finds a ${LINES}-line screen's parts within the budget`,
    async () => {
      const app = await bigApp();
      const id = "swiftui:App/Screens/Screen0.swift#Screen0";
      expect(app.screenParts(id)).toHaveLength(LINES - 6);
      expect(await fastest(() => app.screenParts(id))).toBeLessThan(BUDGET_MS.screenParts);
    },
    120_000,
  );

  speedIt(
    "finds the layout issues of a screen with a doubt on each of thousands of rows within the budget",
    async () => {
      const ROWS = 8000;
      const app = await readApp(
        await appIn({
          "App/Gauges.swift": swift(
            "struct Gauges: View {",
            "  var body: some View {",
            "    VStack {",
            ...Array.from({ length: ROWS }, (_, k) => `      Meter(value: ${k})`),
            "    }",
            "  }",
            "}",
          ),
        }),
      );
      const id = "swiftui:App/Gauges.swift#Gauges";
      expect(app.layoutIssues(id).issues.length).toBeGreaterThanOrEqual(ROWS);
      expect(await fastest(() => app.layoutIssues(id))).toBeLessThan(BUDGET_MS.layoutIssues);
    },
    120_000,
  );

  speedIt(
    "finds the layout issues of every view of a long file within the budget",
    async () => {
      const VIEWS = 800;
      const app = await readApp(
        await appIn({
          "App/V.swift": swift(
            ...Array.from(
              { length: VIEWS },
              (_, i) => `struct V${i}: View { var body: some View { VStack { Text("a"); Text("b") } } }`,
            ),
          ),
        }),
      );
      const ids = app.screens().map((s) => s.id);
      expect(ids).toHaveLength(VIEWS);
      expect(await fastest(() => ids.map((id) => app.layoutIssues(id)), 3)).toBeLessThan(
        BUDGET_MS.layoutIssues * 2,
      );
    },
    120_000,
  );

  speedIt(
    "finds the parts of a screen placing many views of one long file within the budget",
    async () => {
      const VIEWS = 400;
      const app = await readApp(
        await appIn({
          "App/Rows.swift": swift(
            `struct Rows: View { var body: some View { VStack { ${Array.from({ length: VIEWS }, (_, i) => `R${i}()`).join("; ")} } } }`,
            ...Array.from(
              { length: VIEWS },
              (_, i) =>
                `struct R${i}: View { var body: some View { HStack { Text("Row ${i}"); Spacer() } } }`,
            ),
          ),
        }),
      );
      const id = "swiftui:App/Rows.swift#Rows";
      expect(app.screenParts(id)).toHaveLength(VIEWS);
      expect(await fastest(() => app.screenParts(id))).toBeLessThan(BUDGET_MS.screenParts);
    },
    120_000,
  );

  speedIt(
    `lists a ${LINES}-line file's text within the budget`,
    async () => {
      const app = await bigApp();
      const text = screen(0);
      expect(app.stringsIn("App/Screens/Screen0.swift", text)).toHaveLength(
        Math.ceil((LINES - 6) / USE_EVERY),
      );
      expect(await fastest(() => app.stringsIn("App/Screens/Screen0.swift", text))).toBeLessThan(
        BUDGET_MS.stringsIn,
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
