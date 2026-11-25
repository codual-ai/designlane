import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { issueLink } from "../../src/cli/doctor.js";
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

// GitHub refuses longer links.
const MAX_LINK = 7000;

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
      "Found something Designlane should read better? designlane doctor --report gives a link to an issue with the lines above: https://github.com/codual-ai/designlane/issues",
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

  it("gives a link to an issue with the report, the framework and the version filled in, with --report", async () => {
    const { code, out } = await designlane("doctor", await tempDir(APP), "--screen", "Home", "--report");
    expect(code).toBe(0);
    const link = out.split("\n").at(-1) ?? "";
    expect(out).toContain("Designlane sends nothing itself");
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/codual-ai/designlane/issues/new");
    expect(url.searchParams.get("template")).toBe("reads-wrong.yml");
    expect(url.searchParams.get("title")).toBe("Designlane reads Home wrong");
    expect(url.searchParams.get("framework")).toBe("SwiftUI");
    expect(url.searchParams.get("version")).toMatch(/^\d+\.\d+\.\d+/);
    // The report, and none of what --report adds after it.
    expect(url.searchParams.get("got")).toBe(out.slice(0, out.indexOf("\n\nFirst check")));
    // A search for issues already reporting what it found; one screen's report needs no pointer to one.
    const search = new URL(
      out
        .split("\n")
        .find((l) => l.startsWith("First check"))
        ?.split(": ")[1] ?? "",
    );
    expect(search.searchParams.get("q")).toBe('is:issue "Meter"');
    expect(out).not.toContain("--screen Home --report");
  });

  it("titles a whole app's report for the app, and points it at its screen with most issues", async () => {
    const root = await tempDir(APP);
    const { out } = await designlane("doctor", root, "--report");
    expect(linkField(out.split("\n").at(-1) ?? "", "title")).toBe("Designlane reads my app wrong");
    expect(suggestedCommand(out)).toContain(path.basename(root));
    expect(suggestedCommand(out)).toMatch(/^designlane doctor .+ --screen Home --report$/);
  });

  it("names a suggested screen by its id when another view shares its name", async () => {
    const root = await tempDir({
      "App/A/Home.swift": swift("struct Home: View { var body: some View { VStack { Meter(); Meter() } } }"),
      "App/B/Home.swift": swift('struct Home: View { var body: some View { Text("b") } }'),
    });
    const { out } = await designlane("doctor", root, "--report");
    expect(suggestedCommand(out)).toMatch(/ --screen 'swiftui:App\/A\/Home\.swift#Home' --report$/);
  });

  it("suggests no search or screen for an app with nothing wrong", async () => {
    const root = await tempDir({
      "App/A.swift": swift('struct A: View { var body: some View { VStack { Text("a") } } }'),
    });
    const { out } = await designlane("doctor", root, "--report");
    expect(out).not.toContain("First check");
    expect(out).not.toContain("A screen's report");
  });

  // The command a report suggests for one screen. The folder in it is quoted where the shell needs it,
  // as on Windows, so tests look for the folder's name rather than its exact spelling.
  function suggestedCommand(out: string): string {
    const prefix = "A screen's report, with where each issue is, is easier to act on: ";
    const line = out.split("\n").find((each) => each.startsWith(prefix));
    return line?.slice(prefix.length) ?? "";
  }

  it("leaves the framework for the person to choose in an app of two, and drops the footer", async () => {
    const root = await tempDir({
      ...APP,
      "app/src/main/java/a/S.kt":
        'import androidx.compose.runtime.Composable\n@Composable fun S() { Text("a") }',
    });
    const { out } = await designlane("doctor", root, "--report");
    expect(new URL(out.split("\n").at(-1) ?? "").searchParams.has("framework")).toBe(false);
    expect(out).not.toContain("Found something");
  });

  it("refuses --report with --json", async () => {
    expect((await designlane("doctor", await tempDir(APP), "--json", "--report")).code).toBe(2);
  });

  it("cuts a long report by whole lines to fit a link, saying so", () => {
    const report = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const link = issueLink(report, { version: "0.6.0" });
    expect(link.length).toBeLessThanOrEqual(MAX_LINK);
    const lines = linkField(link, "got").split("\n");
    expect(lines.at(-1)).toBe("… (cut to fit the link)");
    expect(lines.slice(0, -1).every((line) => /^line \d+$/.test(line))).toBe(true);
  });

  it("measures a report by its encoded length, so one of wide characters still fits", () => {
    const report = Array.from({ length: 400 }, () => "界".repeat(40)).join("\n");
    const link = issueLink(report, { version: "0.6.0" });
    expect(link.length).toBeLessThanOrEqual(MAX_LINK);
    expect(linkField(link, "got").split("\n").length).toBeGreaterThan(5);
  });

  it("keeps a report's title short when the screen is named by a long id", () => {
    const screen = "swiftui:App/Features/Onboarding/Steps/Welcome/WelcomeStepView.swift#WelcomeStepView";
    const title = linkField(issueLink("a", { version: "0.6.0", screen }), "title");
    expect(title).toBe(`Designlane reads ${screen.slice(0, 80)}… wrong`);
  });

  function linkField(link: string, name: string): string {
    return new URL(link).searchParams.get(name) ?? "";
  }

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
