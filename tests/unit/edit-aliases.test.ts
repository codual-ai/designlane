import { describe, expect, it } from "vitest";
import { applyEdit, type EditPlan } from "../../src/edit/plan.js";
import { type Files, linkAt, outcome, PALETTE, plan, tokensFile } from "../helpers/edits.js";

const edited = (files: Files, planned: EditPlan) => {
  if (!planned.ok) throw new Error(planned.reason);
  return applyEdit(files[planned.edit.file] ?? "", planned.edit);
};

describe("a colour reached through a name", () => {
  it("takes its own value in place of the name, quoted as the value is, so the name's other users keep theirs", async () => {
    const tokens = tokensFile(PALETTE, {
      colors: [
        { key: "link", light: "#bfe1ff", at: { light: linkAt(0) } },
        { key: "surface", light: "#bfe1ff", at: { light: linkAt(1) } },
        {
          key: "blue0",
          light: "#bfe1ff",
          at: { light: { file: "src/colors.ts", text: "#BFE1FF", kind: "literal" } },
        },
      ],
    });
    const planned = await plan(PALETTE, tokens, { token: "link", property: "light", value: "#de2413" });
    expect(edited(PALETTE, planned)).toContain("light: { link: '#DE2413', surface: colors.blue0 }");
  });

  it("refuses a palette colour other tokens take their value from, naming them", async () => {
    const tokens = tokensFile(PALETTE, {
      colors: [
        { key: "link", light: "#bfe1ff", at: { light: linkAt(0) } },
        { key: "surface", light: "#bfe1ff", at: { light: linkAt(1) } },
        {
          key: "blue0",
          light: "#bfe1ff",
          at: { light: { file: "src/colors.ts", text: "#BFE1FF", kind: "literal" } },
        },
      ],
    });
    expect(
      outcome(await plan(PALETTE, tokens, { token: "blue0", property: "light", value: "#de2413" })),
    ).toBe(
      "refused: Changing blue0's colour (src/colors.ts:1) would also change link's colour and surface's colour. Give each its own value in the code first, or change it there by hand.",
    );
  });

  it("refuses a literal in place of a name in another file, or one taking its type from where it's written", async () => {
    const compose: Files = {
      "Color.kt": "val Purple40 = Color(0xFF6650A4)",
      "Theme.kt": "val Light = lightColorScheme(primary = Purple40)",
    };
    const primary = {
      file: "Color.kt",
      text: "Color(0xFF6650A4)",
      kind: "expression" as const,
      via: [{ file: "Theme.kt", text: "Purple40" }],
    };
    const composeTokens = tokensFile(compose, {
      colors: [
        { key: "primary", light: "#6650a4", at: { light: primary } },
        {
          key: "Purple40",
          light: "#6650a4",
          at: { light: { file: "Color.kt", text: "Color(0xFF6650A4)", kind: "expression" } },
        },
      ],
    });
    expect(
      outcome(await plan(compose, composeTokens, { token: "primary", property: "light", value: "#de2413" })),
    ).toBe(
      "refused: primary takes its colour from Purple40 (Theme.kt:1), whose value can't be copied there safely. Change Purple40, or give primary its own value in the code.",
    );
    const swift: Files = {
      "Theme.swift":
        "enum P { static let brand: Color = .init(hex: 0x3366CC) }\nenum T { static let link = P.brand }",
    };
    const link = {
      file: "Theme.swift",
      text: ".init(hex: 0x3366CC)",
      kind: "expression" as const,
      via: [{ file: "Theme.swift", text: "P.brand" }],
    };
    const swiftTokens = tokensFile(swift, {
      colors: [{ key: "link", light: "#3366cc", at: { light: link } }],
    });
    expect(
      outcome(await plan(swift, swiftTokens, { token: "link", property: "light", value: "#de2413" })),
    ).toMatch(/^refused: link takes its colour from `P.brand` \(Theme.swift:2\)/);
  });

  it("refuses a colour reached through a name with opacity after it, since its value isn't the name's", async () => {
    const swift: Files = {
      "Theme.swift":
        "enum P { static let grey = Color(hex: 0xAFAFBA) }\nenum T { static let layer = P.grey.withAlphaComponent(0.6) }",
    };
    const layer = {
      file: "Theme.swift",
      text: "Color(hex: 0xAFAFBA)",
      kind: "expression" as const,
      via: [{ file: "Theme.swift", text: "P.grey.withAlphaComponent(0.6)" }],
    };
    const tokens = tokensFile(swift, {
      colors: [{ key: "layer", light: "#afafba99", at: { light: layer } }],
    });
    expect(outcome(await plan(swift, tokens, { token: "layer", property: "light", value: "#de2413" }))).toBe(
      "refused: layer is `P.grey.withAlphaComponent(0.6)` (Theme.swift:2): another color at its own opacity. Change that color, or give layer its own value in the code.",
    );
  });

  it("refuses a colour reached through a name with its opacity on the next line", async () => {
    const swift: Files = {
      "Theme.swift": "enum P { static let grey = Color(hex: 0xAFAFBA) }\nlet layer = P.grey\n  .opacity(0.5)",
    };
    const layer = {
      file: "Theme.swift",
      text: "Color(hex: 0xAFAFBA)",
      kind: "expression" as const,
      via: [{ file: "Theme.swift", text: "P.grey\n  .opacity(0.5)" }],
    };
    const tokens = tokensFile(swift, {
      colors: [{ key: "layer", light: "#afafba80", at: { light: layer } }],
    });
    expect(
      outcome(await plan(swift, tokens, { token: "layer", property: "light", value: "#de2413" })),
    ).toMatch(
      /^refused: layer is `P.grey\n {2}.opacity\(0.5\)` \(Theme.swift:2\): another color at its own opacity/,
    );
  });

  it("refuses a colour reached through a name built on one with opacity after it, saying so", async () => {
    const swift: Files = {
      "Theme.swift": [
        "enum P { static let grey = Color(hex: 0xAFAFBA) }",
        "enum T { static let layer = P.grey.opacity(0.5) }",
        "enum U { static let card = T.layer }",
      ].join("\n"),
    };
    const card = {
      file: "Theme.swift",
      text: "Color(hex: 0xAFAFBA)",
      kind: "expression" as const,
      via: [
        { file: "Theme.swift", text: "T.layer" },
        { file: "Theme.swift", text: "P.grey.opacity(0.5)" },
      ],
    };
    const tokens = tokensFile(swift, { colors: [{ key: "card", light: "#afafba80", at: { light: card } }] });
    expect(outcome(await plan(swift, tokens, { token: "card", property: "light", value: "#de2413" }))).toBe(
      "refused: card is `P.grey.opacity(0.5)` (Theme.swift:2): another color at its own opacity. Change that color, or give card its own value in the code.",
    );
  });

  it("refuses a literal in place of a name when the literal names something only in scope where it's written", async () => {
    const swift: Files = {
      "Theme.swift": [
        "enum P { static let alpha = 0.5; static let brand = Color(hex: 0x3366CC, opacity: alpha) }",
        "enum T { static let link = P.brand }",
      ].join("\n"),
    };
    const link = {
      file: "Theme.swift",
      text: "Color(hex: 0x3366CC, opacity: alpha)",
      kind: "expression" as const,
      via: [{ file: "Theme.swift", text: "P.brand" }],
    };
    const tokens = tokensFile(swift, { colors: [{ key: "link", light: "#3366cc80", at: { light: link } }] });
    expect(
      outcome(await plan(swift, tokens, { token: "link", property: "light", value: "#de2413" })),
    ).toMatch(
      /^refused: link takes its colour from `P.brand` \(Theme.swift:2\), whose value can't be copied/,
    );
  });

  it("takes a Compose colour in place of the constant a scheme names, and an Android link's", async () => {
    const files: Files = {
      "Color.kt": "val Purple40 = Color(0xFF6650A4)\nval Light = lightColorScheme(primary = Purple40)",
      "res/values/colors.xml":
        '<color name="blue600">#3366CC</color>\n<color name="accent">@color/blue600</color>',
    };
    const tokens = tokensFile(files, {
      colors: [
        {
          key: "primary",
          light: "#6650a4",
          at: {
            light: {
              file: "Color.kt",
              text: "Color(0xFF6650A4)",
              kind: "expression",
              via: [{ file: "Color.kt", text: "Purple40", nth: 1 }],
            },
          },
        },
        {
          key: "accent",
          light: "#3366cc",
          at: {
            light: {
              file: "res/values/colors.xml",
              text: "#3366CC",
              kind: "literal",
              via: [{ file: "res/values/colors.xml", text: "@color/blue600" }],
            },
          },
        },
      ],
    });
    const primary = await plan(files, tokens, { token: "primary", property: "light", value: "#de2413" });
    expect(edited(files, primary)).toContain("lightColorScheme(primary = Color(0xFFDE2413))");
    const accent = await plan(files, tokens, { token: "accent", property: "light", value: "#de2413" });
    expect(edited(files, accent)).toContain('<color name="accent">#DE2413</color>');
  });

  it("refuses a name in another file and language from its value", async () => {
    const files: Files = {
      "res/values/colors.xml": '<color name="accent">#3366CC</color>',
      "Theme.kt": "val Light = lightColorScheme(tertiary = colorResource(R.color.accent))",
    };
    const via = [{ file: "Theme.kt", text: "R.color.accent" }];
    const at = { file: "res/values/colors.xml", text: "#3366CC", kind: "literal" as const, via };
    const tokens = tokensFile(files, { colors: [{ key: "tertiary", light: "#3366cc", at: { light: at } }] });
    expect(
      outcome(await plan(files, tokens, { token: "tertiary", property: "light", value: "#de2413" })),
    ).toMatch(/refused: tertiary takes its colour from `R.color.accent`/);
  });

  it("refuses a text style's value that comes from a style it builds on", async () => {
    const files: Files = {
      "Type.kt": "val Body = TextStyle(fontSize = 14.sp)\nval Large = Body.copy(fontWeight = Bold)",
    };
    const at = {
      file: "Type.kt",
      text: "14.sp",
      kind: "expression" as const,
      via: [{ file: "Type.kt", text: "Body", nth: 1 }],
    };
    const tokens = tokensFile(files, { styles: [{ key: "Large", size: 14, at: { fontSize: at } }] });
    expect(outcome(await plan(files, tokens, { token: "Large", property: "size", value: "16" }))).toMatch(
      /refused: it comes from `Body`/,
    );
  });
});
