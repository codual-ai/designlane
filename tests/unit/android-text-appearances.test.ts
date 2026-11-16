import { describe, expect, it } from "vitest";
import { textAppearances } from "../../src/frameworks/android-text-appearances.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { scanRepo } from "../../src/scan/index.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const STYLES = "app/src/main/res/values/styles.xml";
const resources = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${body}\n</resources>`;
const read = (body: string, code: string[] = [], rel = STYLES) =>
  textAppearances([{ rel, text: resources(body) }], code);
const styleNamed = (body: string, name: string, code: string[] = []) =>
  read(body, code).find((s) => s.name === name);

describe("Android text appearances", () => {
  it("reads a style's size, family and weight, named as the code reaches it", () => {
    const style = styleNamed(
      [
        '<style name="TextAppearance.App.Title">',
        '  <item name="android:textSize">20sp</item>',
        '  <item name="android:fontFamily">@font/work_sans_medium</item>',
        '  <item name="android:textStyle">bold</item>',
        "</style>",
      ].join("\n"),
      "TextAppearance.App.Title",
    );
    expect(style).toEqual({
      name: "TextAppearance.App.Title",
      kind: "app",
      family: "Work Sans",
      size: 20,
      weight: "bold",
      reference: "R.style.TextAppearance_App_Title",
      uses: 0,
      locations: expect.any(Object),
    });
  });

  it("starts from a Material parent's size and weight", () => {
    const body = [
      '<style name="TextAppearance.App.Secondary" parent="TextAppearance.Material3.BodySmall" />',
      '<style name="TextAppearance.App.Header" parent="TextAppearance.Material3.LabelLarge">',
      '  <item name="android:textColor">?android:attr/textColorSecondary</item>',
      "</style>",
      '<style name="TextAppearance.App.Old" parent="@style/TextAppearance.MaterialComponents.Headline6" />',
    ].join("\n");
    expect(styleNamed(body, "TextAppearance.App.Secondary")).toMatchObject({
      family: "System",
      size: 12,
      weight: "regular",
    });
    expect(styleNamed(body, "TextAppearance.App.Header")).toMatchObject({ size: 14, weight: "medium" });
    expect(styleNamed(body, "TextAppearance.App.Old")).toMatchObject({ size: 20, weight: "medium" });
  });

  it("takes what an app parent sets, given or implied by the name, under what the style sets itself", () => {
    const body = [
      '<style name="TextAppearance.App"><item name="android:textSize">16sp</item><item name="android:fontFamily">sans-serif-medium</item></style>',
      '<style name="TextAppearance.App.Small"><item name="android:textSize">12sp</item></style>',
      '<style name="Caption" parent="TextAppearance.App"><item name="android:textFontWeight">300</item></style>',
    ].join("\n");
    expect(styleNamed(body, "TextAppearance.App.Small")).toMatchObject({
      family: "System",
      size: 12,
      weight: "medium",
    });
    expect(styleNamed(body, "Caption")).toMatchObject({ size: 16, weight: "light" });
  });

  it("reads a size held in a dimension resource", () => {
    const body = [
      '<dimen name="text_body">15sp</dimen>',
      '<dimen name="text_default">@dimen/text_body</dimen>',
      '<style name="TextAppearance.App.Body"><item name="android:textSize">@dimen/text_default</item></style>',
    ].join("\n");
    expect(styleNamed(body, "TextAppearance.App.Body")).toMatchObject({ size: 15 });
  });

  it("leaves out styles that aren't text appearances, set no font, or whose parents loop", () => {
    const body = [
      '<style name="Widget.App.Button" parent="Widget.Material3.Button"><item name="android:textSize">14sp</item></style>',
      '<style name="TextAppearance.App.Menu" parent="TextAppearance.AppCompat.Menu"><item name="android:textColor">#ff0000</item></style>',
      '<style name="TextAppearance.A" parent="TextAppearance.B"><item name="android:textStyle">bold</item></style>',
      '<style name="TextAppearance.B" parent="TextAppearance.A"><item name="android:textSize">12sp</item></style>',
    ].join("\n");
    expect(read(body)).toEqual([]);
  });

  it("takes the app's default resources, not a qualified folder's or a build variant's", () => {
    const style = (size: number) =>
      resources(
        `<style name="TextAppearance.App.Body"><item name="android:textSize">${size}sp</item></style>`,
      );
    const found = textAppearances(
      [
        { rel: "app/src/debug/res/values/styles.xml", text: style(30) },
        { rel: "app/src/main/res/values-sw600dp/styles.xml", text: style(20) },
        { rel: STYLES, text: style(16) },
      ],
      [],
    );
    expect(found).toEqual([expect.objectContaining({ size: 16 })]);
  });

  it("drops a parent's size for one the style sets that can't be read, and names generic families", () => {
    const body = [
      '<style name="TextAppearance.App.Body" parent="TextAppearance.Material3.BodyLarge">',
      '  <item name="android:textSize">?attr/customTextSize</item>',
      '  <item name="android:fontFamily">serif</item>',
      "</style>",
    ].join("\n");
    const style = styleNamed(body, "TextAppearance.App.Body");
    expect(style).toMatchObject({ family: "Serif" });
    expect(style).not.toHaveProperty("size");
  });

  it("doesn't read a style that's commented out", () => {
    const body = [
      '<style name="TextAppearance.App.Body"><item name="android:textSize">16sp</item></style>',
      '<!-- <style name="TextAppearance.App.Body"><item name="android:textSize">99sp</item></style> -->',
      '<!-- <style name="TextAppearance.App.Old"><item name="android:textSize">10sp</item></style> -->',
    ].join("\n");
    expect(read(body)).toEqual([expect.objectContaining({ name: "TextAppearance.App.Body", size: 16 })]);
  });

  it("counts the code and resources reaching a style", () => {
    const style = styleNamed(
      [
        '<style name="TextAppearance.App.Body"><item name="android:textSize">14sp</item></style>',
        '<style name="Widget.App.Text"><item name="android:textAppearance">@style/TextAppearance.App.Body</item></style>',
      ].join("\n"),
      "TextAppearance.App.Body",
      ["view.setTextAppearance(R.style.TextAppearance_App_Body)"],
    );
    expect(style?.uses).toBe(2);
  });

  it("are written to tokens.json from a Compose app", async () => {
    const scan = await scanRepo(
      await tempDir({
        "app/src/main/java/Screen.kt":
          'import androidx.compose.runtime.Composable\n@Composable fun S() { Text("a") }',
        [STYLES]: resources(
          '<style name="TextAppearance.App.Body" parent="TextAppearance.Material3.BodyLarge"><item name="android:fontFamily">@font/work_sans_bold</item></style>',
        ),
      }),
    );
    expect(scan.frameworks[0]?.tokens.fonts).toEqual(["Work Sans"]);
    expect(toDesignTokens(scan).typography?.["TextAppearance-App-Body"]).toMatchObject({
      fontSize: { $value: { value: 16 } },
      $extensions: { designlane: { reference: "R.style.TextAppearance_App_Body" } },
    });
  });

  speedIt(
    "reads many style tags that never end in linear time",
    () => {
      textAppearances([{ rel: STYLES, text: "<style ".repeat(40_000) }], []);
      read("<!--".repeat(100_000));
    },
    1000,
  );

  speedIt(
    "reads many styles that never close in linear time",
    () => {
      const open = '<style name="TextAppearance.App.X">'.repeat(50_000);
      read(`${open}${'<item name="android:textSize">12sp</item>'.repeat(1000)}</style>`);
    },
    1000,
  );
});
