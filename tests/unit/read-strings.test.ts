import { describe, expect, it } from "vitest";
import { readApp, StringUseSchema } from "../../src/read/index.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn, SWIFT_APP } from "../helpers/read-apps.js";

/** Each use as its kind, the text its span covers, its key if it has one, and its text. */
function uses(
  text: string,
  list:
    | ({ kind: string; text: string | null; key?: string; span: { start: number; end: number } } & object)[]
    | undefined,
) {
  expect(list?.every((u) => StringUseSchema.safeParse(u).success)).toBe(true);
  return (list ?? []).map((u) => [u.kind, text.slice(u.span.start, u.span.end), u.key ?? null, u.text]);
}

describe("stringsIn: SwiftUI", () => {
  it("lists the text views, controls and titles show, and looks a literal up as a key when the app has it", async () => {
    const app = await readApp(
      await appIn({
        ...SWIFT_APP,
        "App/en.lproj/Localizable.strings": '"cart.checkout" = "Check out";\n"Your cart" = "Your basket";',
        "App/de.lproj/Localizable.strings": '"promo.banner" = "Angebot";',
      }),
    );
    const text = swift(
      "struct Cart: View {",
      '  var body: some View { VStack { Text("Your cart"); Button("cart.checkout") {}; Text(verbatim: "cart.checkout") }',
      '    .navigationTitle("Hi \\"you\\" \\(name)")',
      '    .alert("Removed", isPresented: $on) {}',
      '    let a = NSLocalizedString("promo.banner", comment: "")',
      '    let b = String(localized: "missing.key")',
      '    // Text("in a comment")',
      '    let c = Image("Logo"); print("log line") }',
      "}",
    );
    expect(uses(text, app.stringsIn("App/Cart.swift", text))).toEqual([
      ["localized", "Your cart", "Your cart", "Your basket"],
      ["localized", "cart.checkout", "cart.checkout", "Check out"],
      ["literal", "cart.checkout", null, "cart.checkout"],
      ["literal", 'Hi \\"you\\" \\(name)', null, 'Hi "you" \\(name)'],
      ["literal", "Removed", null, "Removed"],
      ["localized", "promo.banner", "promo.banner", null],
      ["localized", "missing.key", "missing.key", null],
    ]);
  });

  it("reads a string catalog's text in its own language, and its key when it has none", async () => {
    const catalog = JSON.stringify({
      sourceLanguage: "en",
      strings: {
        "plans.title": { localizations: { en: { stringUnit: { value: "Choose a plan" } } } },
        "Restore purchases": {},
      },
    });
    const app = await readApp(await appIn({ ...SWIFT_APP, "App/Localizable.xcstrings": catalog }));
    const text = swift('let v = VStack { Text("plans.title"); Button("Restore purchases") {} }');
    expect(uses(text, app.stringsIn("App/X.swift", text)).map((u) => u[3])).toEqual([
      "Choose a plan",
      "Restore purchases",
    ]);
  });
});

/** A Kotlin string template, which stays as written. */
const TOTAL = ["Total $", "{total.amount}"].join("");

describe("stringsIn: Compose", () => {
  it("lists Text's literals and the string resources it names, with their default text", async () => {
    const rel = "app/src/main/java/a/Cart.kt";
    const text = kotlin(
      "@Composable fun Cart() {",
      '  Text("Your cart")',
      `  Text(text = "${TOTAL}")`,
      "  Button(onClick = {}) { Text(stringResource(R.string.checkout)) }",
      "  Text(stringResource(id = R.string.promo))",
      '  Log.d("tag", "not shown") // Text("in a comment")',
      "}",
    );
    const app = await readApp(
      await appIn({
        [rel]: text,
        "app/src/main/res/values/strings.xml":
          '<resources><string name="checkout">Check out &amp; pay</string><string name="unused">x</string></resources>',
        "app/src/main/res/values-de/strings.xml":
          '<resources><string name="promo">Angebot</string></resources>',
      }),
    );
    expect(uses(text, app.stringsIn(rel))).toEqual([
      ["literal", "Your cart", null, "Your cart"],
      ["literal", TOTAL, null, TOTAL],
      ["localized", "checkout", "checkout", "Check out & pay"],
      ["localized", "promo", "promo", null],
    ]);
  });
});

describe("stringsIn: React Native", () => {
  it("keeps JSX text's spaces as React shows them, each where it's written", async () => {
    const text = tsx(
      "export function Price() {",
      "  return (",
      "    <View>",
      "      <Text>{price} / {period}</Text>",
      "      <Text>{price}/ {period}</Text>",
      "      <Text>Total: {total}</Text>",
      "      <Text>{count} items</Text>",
      "      <Text>{a} {b}</Text>",
      "      <Text>",
      "        Many words",
      "        over   two lines",
      "      </Text>",
      "      <Text>Ends a line ",
      "        {name}</Text>",
      "      <Text>\tTabbed</Text>",
      "      <Text>",
      "        \u00a0Kept\u00a0",
      "        {name}</Text>",
      "      <Text>A&#9;B{name}</Text>",
      "    </View>",
      "  );",
      "}",
    );
    const app = await readApp(await appIn({ ...RN_MANIFEST, "src/Price.tsx": text }));
    expect(uses(text, app.stringsIn("src/Price.tsx"))).toEqual([
      ["literal", " / ", null, " / "],
      ["literal", "/ ", null, "/ "],
      ["literal", "Total: ", null, "Total: "],
      ["literal", " items", null, " items"],
      // Written over two lines, shown as one; a space before a line break isn't shown.
      ["literal", "Many words\n        over   two lines", null, "Many words over   two lines"],
      ["literal", "Ends a line", null, "Ends a line"],
      ["literal", "\tTabbed", null, " Tabbed"],
      // A non-breaking space isn't a space JSX leaves out; a tab written as an entity is one.
      ["literal", "\u00a0Kept\u00a0", null, "\u00a0Kept\u00a0"],
      ["literal", "A&#9;B", null, "A B"],
    ]);
  });

  it("lists JSX text, shown props and screen titles, and the keys translation calls name", async () => {
    const text = tsx(
      'import { Trans } from "react-i18next";',
      "export function Cart() {",
      "  return (",
      '    <Stack.Screen options={{ title: "Cart", gestureEnabled: true }}>',
      "      <Text>  Your   cart </Text>",
      '      <Text>{"Total"}</Text>',
      '      <Button title="Pay" testID="pay-button" onPress={() => log("pressed")} />',
      '      <TextInput placeholder={t("cart.search")} />',
      '      <Trans i18nKey="cart.terms">By paying you agree</Trans>',
      '      <Text>{i18n.t("common:save")}</Text>',
      '      <Text>{intl.formatMessage({ id: "missing" })}</Text>',
      "    </Stack.Screen>",
      "  );",
      "}",
    );
    const app = await readApp(
      await appIn({
        ...RN_MANIFEST,
        "src/Cart.tsx": text,
        "src/locales/en/cart.json": JSON.stringify({ search: "Search the cart", terms: "Terms apply" }),
        "src/locales/en/common.json": JSON.stringify({ save: "Save" }),
      }),
    );
    expect(uses(text, app.stringsIn("src/Cart.tsx"))).toEqual([
      ["literal", "Cart", null, "Cart"],
      ["literal", "  Your   cart ", null, "  Your   cart "],
      ["literal", "Total", null, "Total"],
      ["literal", "Pay", null, "Pay"],
      ["localized", "cart.search", "cart.search", null],
      ["localized", "cart.terms", "cart.terms", null],
      ["localized", "common:save", "common:save", "Save"],
      ["localized", "missing", "missing", null],
    ]);
  });

  it("reads a locale file's nested keys by their dotted path", async () => {
    const text = tsx('export const A = () => <Text>{t("cart.title")}</Text>;');
    const app = await readApp(
      await appIn({
        ...RN_MANIFEST,
        "src/A.tsx": text,
        "src/i18n/en.json": JSON.stringify({ cart: { title: "Your cart" } }),
        "src/i18n/fr.json": JSON.stringify({ cart: { title: "Votre panier" } }),
      }),
    );
    expect(app.stringsIn("src/A.tsx")?.map((u) => u.text)).toEqual(["Your cart"]);
  });
});

describe("stringsIn and views", () => {
  it("reads text a view gives, and strings files as the view has them, leaving the app as it was", async () => {
    const strings = (value: string) => `"cart.checkout" = "${value}";`;
    const app = await readApp(
      await appIn({ ...SWIFT_APP, "App/en.lproj/Localizable.strings": strings("Check out") }),
    );
    const text = swift('let b = Button("cart.checkout") {}');
    const view = await app.withChanges({ "App/en.lproj/Localizable.strings": strings("Pay now") });
    expect(view.stringsIn("App/X.swift", text)?.map((u) => u.text)).toEqual(["Pay now"]);
    expect(app.stringsIn("App/X.swift", text)?.map((u) => u.text)).toEqual(["Check out"]);
    const added = await app.withChanges({ "App/fr.lproj/Localizable.strings": '"Hello" = "Bonjour";' });
    expect(added.stringsIn("App/X.swift", swift('let t = Text("Hello")'))?.[0]).toMatchObject({
      kind: "localized",
      key: "Hello",
      text: null,
    });
  });

  it("is undefined for a file that isn't code of the app's frameworks", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    expect(app.stringsIn("App/en.lproj/Localizable.strings", '"a" = "b";')).toBeUndefined();
  });

  it("reads no string that doesn't end on its own line, and no React Native string people don't see", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const rn = await readApp(
      await appIn({ ...RN_MANIFEST, "src/A.tsx": tsx("export const A = () => <View />;") }),
    );
    const broken = swift('let a = Text("unfinished', 'let b = Text("next")');
    expect(app.stringsIn("App/X.swift", broken)?.map((u) => u.text)).toEqual(["next"]);
    const js = tsx(
      'const config = { title: "Not shown" };',
      'export const A = () => <View testID={"pay"} accessibilityRole="button"><Text>Shown</Text></View>;',
    );
    expect(rn.stringsIn("src/A.tsx", js)?.map((u) => u.text)).toEqual(["Shown"]);
  });
});
