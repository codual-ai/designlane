import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readApp } from "../../src/read/index.js";
import { decodeStrings, stringsFile } from "../../src/read/string-table.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn, SWIFT_APP } from "../helpers/read-apps.js";
import { speedIt } from "../helpers/speed.js";

const entries = (rel: string, text: string) => stringsFile(rel, text).entries;

describe("strings files", () => {
  it("reads Android strings, plurals and empty strings, not arrays or commented-out ones", () => {
    const xml = [
      "<resources>",
      '  <string name="empty"/>',
      '  <string-array name="arr"><item>X</item></string-array>',
      '  <string name="a">Tom &amp; Jerry \\u00e9 \\\\ \\"q\\"</string>',
      '  <!-- <string name="old">Old</string> -->',
      '  <plurals name="items"><item quantity="one">One item</item><item quantity="other">%d items</item></plurals>',
      '  <plurals name="once"><item quantity="one">Just one</item></plurals>',
      "</resources>",
    ].join("\n");
    expect(entries("app/src/main/res/values/strings.xml", xml)).toEqual([
      ["empty", ""],
      ["a", 'Tom & Jerry é \\ "q"'],
      ["items", "%d items"],
      ["once", "Just one"],
    ]);
  });

  it("keeps CDATA text as written, and a reference to no character as written", () => {
    const xml =
      '<resources><string name="c"><![CDATA[Use <name> &amp; keep]]> &amp; more</string><string name="bad">&#x110000;</string></resources>';
    expect(entries("app/src/main/res/values/strings.xml", xml)).toEqual([
      ["c", "Use <name> &amp; keep & more"],
      ["bad", "&#x110000;"],
    ]);
  });

  speedIt("reads a plural with thousands of unclosed items quickly", () => {
    const xml = `<resources><plurals name="p">${"<item>".repeat(20_000)}</plurals></resources>`;
    const started = performance.now();
    entries("app/src/main/res/values/strings.xml", xml);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("reads a .strings file's escapes, leaving out entries commented out", () => {
    const strings = [
      '/* "x" = "commented"; */',
      '// "y" = "also";',
      '"a" = "caf\\U00e9\\r";',
      '"url" = "http://x";',
    ];
    expect(entries("App/en.lproj/Localizable.strings", strings.join("\n"))).toEqual([
      ["a", "café\r"],
      ["url", "http://x"],
    ]);
  });

  it("reads files saved as UTF-16 either way round, and JSON after a UTF-8 byte order mark", () => {
    const text = '"greet" = "Hello there";';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const be = Buffer.from(le);
    be.swap16();
    expect(decodeStrings(le)).toBe(text);
    expect(decodeStrings(be)).toBe(text);
    expect(entries("src/locales/en.json", '﻿{"a":"Apple"}')).toEqual([["a", "Apple"]]);
    expect(entries("App/Localizable.xcstrings", '﻿{"strings":{"k":{}}}')).toEqual([["k", "k"]]);
  });

  it("takes a catalog's English text over its source language's, and a plural's other form", () => {
    const catalog = JSON.stringify({
      sourceLanguage: "de",
      strings: {
        hello: {
          localizations: { de: { stringUnit: { value: "Hallo" } }, en: { stringUnit: { value: "Hello" } } },
        },
        only: { localizations: { de: { stringUnit: { value: "Nur" } } } },
        items: {
          localizations: {
            en: {
              variations: {
                plural: {
                  one: { stringUnit: { value: "%lld item" } },
                  other: { stringUnit: { value: "%lld items" } },
                },
              },
            },
          },
        },
        broken: { localizations: { en: { stringUnit: { value: 3 } } } },
      },
    });
    expect(entries("App/Localizable.xcstrings", catalog)).toEqual([
      ["hello", "Hello"],
      ["only", "Nur"],
      ["items", "%lld items"],
      ["broken", "broken"],
    ]);
  });

  it("reads a deeply nested locale file without running out of stack", () => {
    let nested = '"leaf"';
    for (let i = 0; i < 5000; i++) nested = `{"k":${nested}}`;
    expect(() => entries("src/locales/en.json", `{"ok":"Ok","deep":${nested}}`)).not.toThrow();
    expect(entries("src/locales/en.json", `{"ok":"Ok","deep":${nested}}`)).toEqual([["ok", "Ok"]]);
  });

  speedIt("reads Android XML with thousands of unclosed tags quickly", () => {
    const xml = `<resources>${'<string name="a">'.repeat(50_000)}</resources>`;
    const started = performance.now();
    entries("app/src/main/res/values/strings.xml", xml);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("reads a UTF-16 strings file from disk", async () => {
    const root = await appIn(SWIFT_APP);
    const file = path.join(root, "App/en.lproj/Localizable.strings");
    await mkdir(path.dirname(file), { recursive: true });
    const text = '"greet" = "Hello there";';
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const app = await readApp(root);
    expect(app.stringsIn("App/X.swift", swift('let t = Text("greet")'))?.[0]).toMatchObject({
      kind: "localized",
      text: "Hello there",
    });
  });
});

describe("stringsIn: what the reviews found", () => {
  it("reads interpolations holding strings with brackets, and Unicode escapes", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const code = swift('let a = Text("Hi \\(flag ? ")" : "b") end")', 'let b = Text("\\u{1F600} \\r")');
    expect(app.stringsIn("App/X.swift", code)?.map((u) => u.text)).toEqual([
      'Hi \\(flag ? ")" : "b") end',
      "😀 \r",
    ]);
    const rel = "app/src/main/java/a/A.kt";
    const kt = kotlin(
      ['@Composable fun A() { Text("a $', '{if (x) "}" else "b"} c"); Text("\\u00e9 \\$5") }'].join(""),
    );
    const compose = await readApp(await appIn({ [rel]: kt }));
    expect(compose.stringsIn(rel)?.map((u) => u.text)).toEqual([
      ["a $", '{if (x) "}" else "b"} c'].join(""),
      "é $5",
    ]);
  });

  it("reads Compose text named after other arguments, and resources reached through a context", async () => {
    const rel = "app/src/main/java/a/A.kt";
    const kt = kotlin(
      "@Composable fun A() {",
      '  Text(modifier = Modifier.padding(4.dp), text = "Later")',
      "  Text(context.getString(R.string.title))",
      "  Text(pluralStringResource(R.plurals.items, n, n))",
      "}",
    );
    const app = await readApp(
      await appIn({
        [rel]: kt,
        "app/src/main/res/values/strings.xml":
          '<resources><string name="title">Title</string><plurals name="items"><item quantity="other">%d items</item></plurals></resources>',
      }),
    );
    expect(app.stringsIn(rel)?.map((u) => [u.kind, u.text])).toEqual([
      ["literal", "Later"],
      ["localized", "Title"],
      ["localized", "%d items"],
    ]);
  });

  it("reads JSX entities and fragments, skips spaces written as strings, and reads <Trans> without a key", async () => {
    const text = tsx(
      "export const A = () => (",
      '  <><Text>Tom &amp; Jerry{" "}<B /></Text>{"Frag"}<Button title="a &amp; b" label={"x &amp; y"} />',
      "  <Trans>Hello <Text>world</Text></Trans></>",
      ");",
    );
    const app = await readApp(await appIn({ ...RN_MANIFEST, "src/A.tsx": text }));
    expect(app.stringsIn("src/A.tsx")?.map((u) => u.text)).toEqual([
      "Tom & Jerry",
      "Frag",
      "a & b",
      "x &amp; y",
      "Hello",
      "world",
    ]);
  });

  it("reads only a whole literal argument, and only a call's own text argument", async () => {
    const app = await readApp(
      await appIn({ ...SWIFT_APP, "App/en.lproj/Localizable.strings": '"hello" = "Bonjour";' }),
    );
    const code = swift(
      'let a = Text("hello".uppercased())',
      'let b = Text("hello" + name)',
      'let c = Text("hello")',
    );
    expect(app.stringsIn("App/X.swift", code)?.map((u) => u.text)).toEqual(["Bonjour"]);
    const rel = "app/src/main/java/a/A.kt";
    const kt = kotlin(
      "@Composable fun A() {",
      '  Text(modifier = makeModifier(text = "Hidden"), text = "Visible")',
      '  Text(modifier = Modifier.semantics { text = "Hidden" })',
      "}",
    );
    const compose = await readApp(await appIn({ [rel]: kt }));
    expect(compose.stringsIn(rel)?.map((u) => u.text)).toEqual(["Visible"]);
  });
});
