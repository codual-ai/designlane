import { describe, expect, it } from "vitest";
import { recolored, restyled } from "../helpers/edits.js";

const literal = (text: string) => ({ text, kind: "literal" as const });
const expression = (text: string) => ({ text, kind: "expression" as const });

describe("a colour written as hex digits", () => {
  it("keeps the literal's case", async () => {
    expect(
      await recolored("colors.ts", 'const a = "#3366CC";', literal("#3366CC"), "#3366cc", "#de2413"),
    ).toBe("#DE2413");
    expect(
      await recolored("colors.ts", 'const a = "#3366cc";', literal("#3366cc"), "#3366cc", "#DE2413"),
    ).toBe("#de2413");
  });

  it("takes the case most of the file's digits use when the literal has no letters", async () => {
    const lower = 'const a = "#000000"; const b = "#abcdef"; const c = "#aabb00";';
    expect(await recolored("colors.ts", lower, literal("#000000"), "#000000", "#DE2413")).toBe("#de2413");
    const upper = 'const a = "#000000"; const b = "#ABCDEF";';
    expect(await recolored("colors.ts", upper, literal("#000000"), "#000000", "#de2413")).toBe("#DE2413");
  });

  it("keeps a short form when the new colour has one, and writes it out in full when not", async () => {
    const code = 'const a = "#f00";';
    expect(await recolored("colors.ts", code, literal("#f00"), "#ff0000", "#00ff00")).toBe("#0f0");
    expect(await recolored("colors.ts", code, literal("#f00"), "#ff0000", "#de2413")).toBe("#de2413");
  });

  it("keeps the opacity last in CSS and first in Android resources, or sets it when asked", async () => {
    const css = ":root { --brand: #11223380; }";
    expect(await recolored("theme.css", css, literal("#11223380"), "#11223380", "#de2413")).toBe("#DE241380");
    expect(await recolored("theme.css", css, literal("#11223380"), "#11223380", "#de2413ff")).toBe(
      "#DE2413FF",
    );
    const xml = '<resources><color name="brand">#80112233</color></resources>';
    expect(await recolored("res/values/colors.xml", xml, literal("#80112233"), "#11223380", "#DE2413")).toBe(
      "#80DE2413",
    );
  });

  it("rewrites the number in Compose's ARGB colour and Swift's hex helpers", async () => {
    const compose = "val Brand = Color(0xFF6650A4)";
    expect(await recolored("Color.kt", compose, expression("Color(0xFF6650A4)"), "#6650a4", "#de2413")).toBe(
      "Color(0xFFDE2413)",
    );
    const swift = "static let brand: Color = .init(hex: 0x112233)";
    expect(
      await recolored("Theme.swift", swift, expression(".init(hex: 0x112233)"), "#112233", "#DE2413"),
    ).toBe(".init(hex: 0xDE2413)");
    const string = 'static let brand = UIColor(hex: "#112233", alpha: 0.5)';
    const call = expression('UIColor(hex: "#112233", alpha: 0.5)');
    expect(await recolored("Theme.swift", string, call, "#11223380", "#de2413")).toBe(
      'UIColor(hex: "#DE2413", alpha: 0.5)',
    );
  });

  it("reads eight digits in a Swift helper the way that gives the value tokens.json has", async () => {
    const code = "static let brand = Color(hex: 0x11223380)";
    const call = expression("Color(hex: 0x11223380)");
    expect(await recolored("Theme.swift", code, call, "#11223380", "#de2413")).toBe("Color(hex: 0xDE241380)");
    expect(await recolored("Theme.swift", code, call, "#22338011", "#de2413")).toBe("Color(hex: 0x11DE2413)");
  });

  it("refuses eight digits that read as the old value both ways", async () => {
    const code = "static let brand = Color(hex: 0xFFFFFFFF)";
    expect(
      await recolored("Theme.swift", code, expression("Color(hex: 0xFFFFFFFF)"), "#ffffff", "#de2413"),
    ).toMatch(/refused: .*more than one way/);
  });
});

describe("a colour written channel by channel", () => {
  it("keeps a fraction's decimals where they hold the new colour, adding what it needs, and Kotlin's suffix", async () => {
    const swift = "static let brand = Color(red: 0.2, green: 0.4, blue: 0.9)";
    const call = expression("Color(red: 0.2, green: 0.4, blue: 0.9)");
    expect(await recolored("Theme.swift", swift, call, "#3366e6", "#de2413")).toBe(
      "Color(red: 0.87, green: 0.14, blue: 0.075)",
    );
    const kotlin = "val Brand = Color(0.20f, 0.40f, 0.90f)";
    expect(
      await recolored("Color.kt", kotlin, expression("Color(0.20f, 0.40f, 0.90f)"), "#3366e6", "#de2413"),
    ).toBe("Color(0.87f, 0.14f, 0.075f)");
  });

  it("writes the `/ 255` form, and a Swift 0 beside it the same way", async () => {
    const code = "static let brand = Color(red: 0, green: 154 / 255, blue: 199.0 / 255.0)";
    const call = expression("Color(red: 0, green: 154 / 255, blue: 199.0 / 255.0)");
    expect(await recolored("Theme.swift", code, call, "#009ac7", "#2383f8")).toBe(
      "Color(red: 35 / 255, green: 131 / 255, blue: 248.0 / 255.0)",
    );
  });

  it("writes hex channels and whole numbers 0–255, leaving the opacity as it is", async () => {
    const swift = "static var brand: Color { srgb(0x23, 0x83, 0xf8, opacity: 1) }";
    const call = expression("srgb(0x23, 0x83, 0xf8, opacity: 1)");
    expect(await recolored("Theme.swift", swift, call, "#2383f8", "#de2413")).toBe(
      "srgb(0xde, 0x24, 0x13, opacity: 1)",
    );
    const kotlin = "val Brand = Color(red = 34, green = 131, blue = 248, alpha = 255)";
    const named = expression("Color(red = 34, green = 131, blue = 248, alpha = 255)");
    expect(await recolored("Color.kt", kotlin, named, "#2283f8", "#de2413")).toBe(
      "Color(red = 222, green = 36, blue = 19, alpha = 255)",
    );
    const js = 'const overlay = "rgba(34, 131, 248, 0.5)";';
    expect(await recolored("colors.ts", js, literal("rgba(34, 131, 248, 0.5)"), "#2283f880", "#de2413")).toBe(
      "rgba(222, 36, 19, 0.5)",
    );
  });

  it("rewrites an asset's components as floats, hex or whole numbers, and its alpha when asked", async () => {
    const asset = (red: string, green: string, blue: string) =>
      `{\n  "alpha" : "1.000",\n  "blue" : "${blue}",\n  "green" : "${green}",\n  "red" : "${red}"\n}`;
    const rel = "Assets.xcassets/Brand.colorset/Contents.json";
    const at = (text: string) => ({ text, kind: "components" as const });
    const floats = asset("0.075", "0.855", "0.137");
    expect(await recolored(rel, floats, at(floats), "#13da23", "#de2413")).toBe(
      asset("0.871", "0.141", "0.075"),
    );
    const hex = asset("0x1C", "0x1B", "0x1B");
    expect(await recolored(rel, hex, at(hex), "#1c1b1b", "#3f044c")).toBe(asset("0x3F", "0x04", "0x4C"));
    const whole = asset("17", "17", "17");
    expect(await recolored(rel, whole, at(whole), "#111111", "#34fa42")).toBe(asset("52", "250", "66"));
    expect(await recolored(rel, whole, at(whole), "#111111", "#34fa4280")).toBe(
      asset("52", "250", "66").replace('"1.000"', '"0.502"'),
    );
  });
});

describe("a text style's values", () => {
  it("writes a size with the code's unit and decimals", async () => {
    expect(await restyled("size", "Theme.swift", "Font.system(size: 22)", literal("22"), 22, "24")).toBe(
      "24",
    );
    expect(
      await restyled("size", "Type.kt", "TextStyle(fontSize = 22.sp)", expression("22.sp"), 22, "24"),
    ).toBe("24.sp");
    const xml = '<item name="android:textSize">15sp</item>';
    expect(await restyled("size", "res/values/styles.xml", xml, literal("15sp"), 15, "15.5")).toBe("15.5sp");
    expect(
      await restyled("size", "Type.kt", "TextStyle(fontSize = 20.0.sp)", expression("20.0.sp"), 20, "21"),
    ).toBe("21.0.sp");
  });

  it("writes Swift's weights with the code's qualifier", async () => {
    const code = "Font.system(size: 17, weight: .semibold)";
    expect(await restyled("weight", "Theme.swift", code, expression(".semibold"), 600, "700")).toBe(".bold");
    const qualified = "UIFont.systemFont(ofSize: 17, weight: UIFont.Weight.medium)";
    expect(
      await restyled("weight", "Theme.swift", qualified, expression("UIFont.Weight.medium"), 500, "200"),
    ).toBe("UIFont.Weight.ultraLight");
  });

  it("writes Compose's weights in the form the code uses", async () => {
    const at = (text: string) =>
      restyled("weight", "Type.kt", `TextStyle(fontWeight = ${text})`, expression(text), 600, "800");
    expect(await at("FontWeight.SemiBold")).toBe("FontWeight.ExtraBold");
    expect(await at("FontWeight.W600")).toBe("FontWeight.W800");
    expect(await at("FontWeight(600)")).toBe("FontWeight(800)");
  });

  it("writes React Native's weights as numbers, or as its words for 400 and 700", async () => {
    const code = (weight: string) => `const title = { fontWeight: "${weight}" };`;
    expect(await restyled("weight", "theme.ts", code("600"), literal("600"), 600, "700")).toBe("700");
    expect(await restyled("weight", "theme.ts", code("bold"), literal("bold"), 700, "600")).toBe("600");
    expect(await restyled("weight", "theme.ts", code("bold"), literal("bold"), 700, "400")).toBe("normal");
  });

  it("writes a family's own name", async () => {
    const code = 'const title = { fontFamily: "Inter" };';
    expect(await restyled("family", "theme.ts", code, literal("Inter"), "Inter", "Roboto Flex")).toBe(
      "Roboto Flex",
    );
  });

  it("refuses a family's name that would need escaping", async () => {
    const code = 'const title = { fontFamily: "Inter" };';
    expect(await restyled("family", "theme.ts", code, literal("Inter"), "Inter", 'Inter"; x')).toMatch(
      /refused: .*can't hold/,
    );
  });
});

describe("hex digits it won't misread", () => {
  it("reads Compose's colour as ARGB only, so white isn't ambiguous", async () => {
    const code = "val Paper = Color(0xFFFFFFFF)";
    expect(await recolored("Color.kt", code, expression("Color(0xFFFFFFFF)"), "#ffffff", "#de2413")).toBe(
      "Color(0xFFDE2413)",
    );
  });

  it("refuses a call with two colours, a short number, and an opacity six digits can't hold", async () => {
    const pair = "static let ink = Color(light: 0x111111, dark: 0x222222)";
    const call = expression("Color(light: 0x111111, dark: 0x222222)");
    expect(await recolored("Theme.swift", pair, call, "#111111", "#de2413")).toMatch(/can't safely rewrite/);
    const short = "static let ink = Color(hex: 0xFFF)";
    expect(
      await recolored("Theme.swift", short, expression("Color(hex: 0xFFF)"), "#ffffff", "#de2413"),
    ).toMatch(/can't safely rewrite/);
    const six = 'const a = "#3366CC";';
    expect(await recolored("colors.ts", six, literal("#3366CC"), "#3366cc", "#de241380")).toMatch(
      /refused: .*can't hold #de241380/,
    );
  });

  it("refuses a call naming another colour space, and an asset giving a channel twice", async () => {
    const p3 = "static let ink = Color(red: 0.2, green: 0.4, blue: 0.9, colorSpace: .displayP3)";
    const call = expression("Color(red: 0.2, green: 0.4, blue: 0.9, colorSpace: .displayP3)");
    expect(await recolored("Theme.swift", p3, call, "#3366e6", "#de2413")).toMatch(/can't safely rewrite/);
    const twice = '{ "red" : "0.2", "green" : "0.4", "blue" : "0.9", "red" : "0.5" }';
    const rel = "Assets.xcassets/Ink.colorset/Contents.json";
    expect(await recolored(rel, twice, { text: twice, kind: "components" }, "#3366e6", "#de2413")).toMatch(
      /can't safely rewrite/,
    );
  });
});
