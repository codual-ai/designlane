import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";
import { LayoutIssuesSchema } from "../../src/read/index.js";
import { swift } from "../helpers/catalog.js";
import { tempDir } from "../helpers/temp.js";

async function designlane(...argv: string[]) {
  const out: string[] = [];
  const error: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), error: (t) => error.push(t) });
  return { code, out: out.join("\n"), error: error.join("\n") };
}

/** A component every screen places: one unknown element and two parts named by their kind, wherever it's placed. */
const CARD = swift(
  'struct Card: View { var body: some View { VStack { Text("a"); Meter(value: 1); HStack { Image("x") } } } }',
);
const BROKEN = swift("struct Feed: View {", "  var body: some View {", '    VStack { Text("a"', "  }", "}");

const APP = {
  "App/Home.swift": swift(
    "struct Home: View {",
    "  var body: some View {",
    "    VStack {",
    '      Text("Welcome")',
    "      Meter(value: 1)",
    "      Meter(value: 2)",
    "      Feed()",
    "    }",
    "  }",
    "}",
  ),
  "App/Feed.swift": BROKEN,
  "App/Settings.swift": swift("struct Settings: View { var body: some View { NavigationStack { Feed() } } }"),
};

describe("designlane doctor", () => {
  it("lists a view that can't be read once, with the screens placing it, and what may be read wrong", async () => {
    const { code, out } = await designlane("doctor", await tempDir(APP));
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      "Read 3 screens and components: 1 whole, 1 can't be read, 1 place a view that can't be.",
      "",
      "Can't be read",
      "  App/Feed.swift:4  Designlane can't match a bracket here: Feed, placed in Settings",
      "",
      "May be read wrong",
      '  2 unknown elements, shown as "other": Meter ×2',
      "",
      "2 parts labelled by their kind only (--all lists them)",
      "",
      "Found something Designlane should read better? Open an issue with the lines above: https://github.com/codual-ai/designlane/issues",
    ]);
  });

  it("counts a view's issues once, however many screens place it, in the singular for one", async () => {
    const { out } = await designlane(
      "doctor",
      await tempDir({
        "App/Card.swift": CARD,
        "App/A.swift": swift("struct A: View { var body: some View { NavigationStack { Card() } } }"),
        "App/B.swift": swift("struct B: View { var body: some View { NavigationStack { Card() } } }"),
      }),
    );
    expect(out).toContain('1 unknown element, shown as "other": Meter\n');
    expect(out).toContain("2 parts labelled by their kind only (--all lists them)");
  });

  it("lists every issue where it is with --all", async () => {
    const { out } = await designlane("doctor", await tempDir(APP), "--all");
    expect(out).toContain(
      [
        '  2 unknown elements, shown as "other"',
        "    App/Home.swift:6  Meter",
        "    App/Home.swift:7  Meter",
        "  2 parts labelled by their kind only",
        "    App/Home.swift:6  Element",
        "    App/Home.swift:7  Element 2",
      ].join("\n"),
    );
  });

  it("orders views that can't be read by the screens they stop, then file and line, and lists twenty", async () => {
    const files: Record<string, string> = {
      "App/V.swift": swift(
        ...Array.from({ length: 12 }, (_, i) =>
          i === 7 || i === 11
            ? `struct V${i}: View { var body: some View { VStack { Text("a" } } }`
            : `// ${i}`,
        ),
      ),
    };
    for (let i = 0; i < 21; i++) files[`App/W/W${i}.swift`] = BROKEN.replace("Feed", `W${i}`);
    // Sorted last, so not listed: the column isn't as wide as its place.
    files["App/Z/A/Very/Long/Path/To/One/More.swift"] = BROKEN.replace("Feed", "More");
    for (const placer of ["P1", "P2", "P3", "P4", "P5"])
      files[`App/${placer}.swift`] = swift(
        `struct ${placer}: View { var body: some View { NavigationStack { W9() } } }`,
      );
    const lines = (await designlane("doctor", await tempDir(files))).out.split("\n");
    const start = lines.indexOf("Can't be read") + 1;
    const listed = lines.slice(start, start + 21);
    expect(listed[0]).toMatch(
      /W9\.swift:4 +Designlane can't match a bracket here: W9, placed in P1, P2, P3, and 2 more$/,
    );
    expect(listed.at(-1)).toBe("  and 4 more (--all lists them)");
    expect(listed.join("\n")).not.toContain("More.swift");
    const v = listed.filter((l) => l.includes("App/V.swift"));
    expect(v.map((l) => l.trim().split(" ")[0])).toEqual(["App/V.swift:9", "App/V.swift:13"]);
    // The column is as wide as the places listed.
    const columns = new Set(listed.slice(0, -1).map((l) => l.indexOf("Designlane")));
    expect(columns).toEqual(new Set(["  App/W/W10.swift:4  ".length]));
  });

  it("says when nothing is wrong, without asking for an issue", async () => {
    const { out } = await designlane(
      "doctor",
      await tempDir({
        "App/A.swift": swift('struct A: View { var body: some View { VStack { Text("a"); Text("b") } } }'),
      }),
    );
    expect(out).toBe("Read 1 screen and component: 1 whole, 0 can't be read.");
  });

  it("shows one screen's issues, parts and layout with --screen, as JSON with --json too", async () => {
    const root = await tempDir(APP);
    const { out } = await designlane("doctor", root, "--screen", "Home");
    expect(out.split("\n")).toEqual([
      "Home (component, App/Home.swift:2)",
      '  unknown element, shown as "other": Meter at line 6',
      '  unknown element, shown as "other": Meter at line 7',
      "  part labelled by its kind only: Element at line 6",
      "  part labelled by its kind only: Element 2 at line 7",
      "  Parts: Welcome | Element | Element 2 | Feed",
      "  Layout:",
      "    view-ref Home  line 2",
      "      stack-v  line 4",
      "        text  line 5",
      "        other  line 6",
      "        other  line 7",
      "        view-ref Feed  line 8",
    ]);
    const unread = (await designlane("doctor", root, "--screen", "Settings")).out;
    expect(unread).toContain(
      "Can't be read: Designlane can't match a bracket here at App/Feed.swift:4 (Feed)",
    );
    const json = JSON.parse(
      (await designlane("doctor", root, "--screen", "Home", "--json")).out,
    ) as unknown[];
    expect(json).toHaveLength(1);
    expect(LayoutIssuesSchema.safeParse(json[0]).success).toBe(true);
  });

  it("prints every screen's issues as JSON with --json", async () => {
    const issues = JSON.parse((await designlane("doctor", await tempDir(APP), "--json")).out) as unknown[];
    expect(issues).toHaveLength(3);
    expect(issues.every((i) => LayoutIssuesSchema.safeParse(i).success)).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says which folders it couldn't open",
    async () => {
      const root = await tempDir(APP);
      const locked = path.join(root, "Locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      try {
        const { error } = await designlane("doctor", root);
        expect(error).toContain("couldn't be opened (Locked");
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it("prints its help, and refuses a folder that isn't one, two folders, and an unknown screen", async () => {
    const help = await designlane("doctor", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("designlane doctor [dir]");
    expect((await designlane("doctor", "/no/such/folder")).code).toBe(1);
    expect((await designlane("doctor", "a", "b")).code).toBe(2);
    const missing = await designlane("doctor", await tempDir(APP), "--screen", "Nope");
    expect(missing.code).toBe(1);
    expect(missing.error).toContain("no screen or component named Nope");
    expect((await designlane("--help")).out).toContain("designlane doctor [dir]");
  });
});
