import { describe, expect, it } from "vitest";
import { type DesignFileEntry, planSync, type VariableValue } from "../../src/sync/plan.js";
import { color, firstVariable, syncedFile, tokens } from "../helpers/sync-tokens.js";

describe("planning a sync: renames", () => {
  it("proposes a rename when one token is gone and one new token in its group has the same value", () => {
    const file = syncedFile(
      tokens({ colors: [color("color:Theme.c3", "#969ca5"), color("color:Theme.ink", "#111111")] }),
    );
    const c3 = firstVariable(file);
    c3.name = "text/secondary";
    const renamed = tokens({
      colors: [color("color:Theme.secondaryText", "#969ca5"), color("color:Theme.ink", "#111111")],
    });
    const plan = planSync(renamed, file).variables;
    expect(plan.rename.map((r) => [r.id, r.name, r.token.identity])).toEqual([
      [c3.id, "text/secondary", "color:Theme.secondaryText"],
    ]);
    expect([plan.create, plan.deprecate]).toEqual([[], []]);
  });

  it("follows a theme the code renamed, though its colours share values, keeping every variable", () => {
    const theme = (owner: string, surface = "#ffffff") =>
      tokens({
        colors: [
          color(`color:${owner}.colors.surface`, surface),
          color(`color:${owner}.colors.background`, "#ffffff"),
          color(`color:${owner}.colors.primary`, "#3366e6"),
        ],
      });
    const file = syncedFile(theme("MainTheme"));
    const plan = planSync(theme("BoltTheme"), file).variables;
    expect(plan.rename.map((r) => [r.name, r.token.identity])).toEqual([
      ["color/MainTheme.colors.surface", "color:BoltTheme.colors.surface"],
      ["color/MainTheme.colors.background", "color:BoltTheme.colors.background"],
      ["color/MainTheme.colors.primary", "color:BoltTheme.colors.primary"],
    ]);
    expect([plan.create, plan.deprecate]).toEqual([[], []]);
    // A member whose value changed too is a different colour: no guess.
    const changed = planSync(theme("BoltTheme", "#000000"), file).variables;
    expect(changed.rename.map((r) => r.token.identity)).not.toContain("color:BoltTheme.colors.surface");
  });

  it("follows no owner rename when two owners have the member", () => {
    const file = syncedFile(
      tokens({
        colors: [color("color:Light.colors.bg", "#ffffff"), color("color:Dark.colors.bg", "#ffffff")],
      }),
    );
    const plan = planSync(tokens({ colors: [color("color:Bolt.colors.bg", "#ffffff")] }), file).variables;
    expect(plan.rename).toEqual([]);
  });

  it("follows owners only in a path: not an asset's dotted name, a file's own constant or a value", () => {
    const pair = (from: string, to: string) => {
      const file = syncedFile(tokens({ colors: [color(from, "#ffffff"), color(`${from}2`, "#ffffff")] }));
      const plan = planSync(tokens({ colors: [color(to, "#ffffff"), color(`${to}2`, "#ffffff")] }), file);
      return plan.variables.rename.length;
    };
    expect(pair("color:Main.bg", "color:Bolt.bg")).toBe(2);
    expect(pair('color:Color("Old.bg', 'color:Color("New.bg')).toBe(0);
    expect(pair("color:bg@Old.swift", "color:bg@New.swift")).toBe(0);
  });

  it("follows a text style's owner by its member and name", () => {
    const style = (identity: string) => ({ identity, key: "body", value: { size: 15 } });
    const file = syncedFile(
      tokens({ textStyles: [style("type:Main.type.body|body"), style("type:Main.type.note|note")] }),
    );
    const plan = planSync(
      tokens({ textStyles: [style("type:Bolt.type.body|body"), style("type:Bolt.type.note|note")] }),
      file,
    );
    expect(plan.textStyles.rename.map((r) => r.token.identity)).toEqual([
      "type:Bolt.type.body|body",
      "type:Bolt.type.note|note",
    ]);
    // One helper called at two sizes is two styles of one member, each told apart by its name.
    const sized = (owner: string) =>
      tokens({
        textStyles: [style(`type:${owner}.font.brand|brand 20`), style(`type:${owner}.font.brand|brand 15`)],
      });
    expect(planSync(sized("Bolt"), syncedFile(sized("Main"))).textStyles.rename).toHaveLength(2);
  });

  it("follows a renamed owner however many colours changed, then guesses the rest within the budget", () => {
    const hex = (i: number) => `#${i.toString(16).padStart(6, "0")}`;
    const theme = (owner: string) =>
      Array.from({ length: 400 }, (_, i) => color(`color:${owner}.c${i}`, hex(i)));
    const file = syncedFile(tokens({ colors: [...theme("Main"), color("color:Theme.c3", "#969ca5")] }));
    const plan = planSync(
      tokens({ colors: [...theme("Bolt"), color("color:Theme.secondaryText", "#969ca5")] }),
      file,
    ).variables;
    expect([plan.renamesSkipped, plan.rename.length, plan.deprecate.length]).toEqual([false, 401, 0]);
  });

  it("gives a token its owner took to no other gone entry of the same value", () => {
    const file = syncedFile(
      tokens({ colors: [color("color:Main.bg", "#ffffff"), color("color:Old.x", "#ffffff")] }),
    );
    const plan = planSync(tokens({ colors: [color("color:Bolt.bg", "#ffffff")] }), file).variables;
    expect(plan.rename.map((r) => r.token.identity)).toEqual(["color:Bolt.bg"]);
    expect(plan.deprecate).toHaveLength(1);
  });

  it("follows no owner rename of an entry a designer duplicated", () => {
    const file = syncedFile(tokens({ colors: [color("color:Main.colors.bg", "#ffffff")] }));
    const [first] = file.variables;
    if (!first) throw new Error("no variable");
    file.variables.push({ ...first, id: "copy", name: "copy" });
    const plan = planSync(tokens({ colors: [color("color:Bolt.colors.bg", "#ffffff")] }), file).variables;
    expect(plan.rename).toEqual([]);
  });

  it("follows no owner rename when two new owners have the member", () => {
    const file = syncedFile(tokens({ colors: [color("color:Main.colors.bg", "#ffffff")] }));
    const two = tokens({
      colors: [color("color:Light.colors.bg", "#ffffff"), color("color:Dark.colors.bg", "#ffffff")],
    });
    expect(planSync(two, file).variables.rename).toEqual([]);
  });

  it("guesses no rename when two gone tokens share the new one's value", () => {
    const file = syncedFile(
      tokens({ colors: [color("color:Theme.a", "#ffffff"), color("color:Theme.b", "#ffffff")] }),
    );
    const plan = planSync(tokens({ colors: [color("color:Theme.white", "#ffffff")] }), file).variables;
    expect(plan.rename).toEqual([]);
    expect(plan.deprecate).toHaveLength(2);
  });

  it("guesses no rename when two new tokens share the gone one's value", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.a", "#ffffff")] }));
    const twoNew = tokens({ colors: [color("color:Theme.x", "#ffffff"), color("color:Theme.y", "#ffffff")] });
    expect(planSync(twoNew, file).variables.rename).toEqual([]);
  });

  it("guesses no rename across kinds: a radius of 8 isn't a renamed spacing of 8", () => {
    const file = syncedFile(tokens({ spacing: [8] }));
    expect(planSync(tokens({ radii: [8] }), file).variables.rename).toEqual([]);
  });

  it("says when too many tokens changed at once to guess renames, rather than skipping them silently", () => {
    const hex = (i: number) => `#${i.toString(16).padStart(6, "0")}`;
    const swap = (count: number) => {
      const old = Array.from({ length: count }, (_, i) => color(`color:Old.c${i}`, hex(i)));
      const fresh = Array.from({ length: count }, (_, i) => color(`color:New.d${i}`, hex(i)));
      return planSync(tokens({ colors: fresh }), syncedFile(tokens({ colors: old }))).variables;
    };
    const small = swap(300);
    expect([small.renamesSkipped, small.rename.length]).toEqual([false, 300]);
    const large = swap(400);
    expect([large.renamesSkipped, large.rename.length, large.deprecate.length]).toEqual([true, 0, 400]);
  });

  it("renames no entry a designer duplicated, so its copy never takes over the old identity", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.c3", "#969ca5")] }));
    const original = firstVariable(file);
    file.variables.push({ ...original, id: "copy", name: "c3 copy" });
    const plan = planSync(
      tokens({ colors: [color("color:Theme.secondaryText", "#969ca5")] }),
      file,
    ).variables;
    expect(plan.rename).toEqual([]);
    expect(plan.deprecate.map((d) => d.id)).toEqual([original.id]);
  });

  it("guesses no rename when a duplicated entry that's also gone matches the new token just as well", () => {
    const file = syncedFile(
      tokens({ colors: [color("color:Theme.a", "#969ca5"), color("color:Theme.b", "#969ca5")] }),
    );
    const b = file.variables.find((v) => v.identity === "color:Theme.b") as DesignFileEntry<VariableValue>;
    file.variables.push({ ...b, id: "b copy", name: "b copy" });
    const plan = planSync(tokens({ colors: [color("color:Theme.c", "#969ca5")] }), file).variables;
    expect(plan.rename).toEqual([]);
  });

  it("gives a new token its plain name when the token that wanted it first turned out to be a rename", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.c3", "#969ca5")] }));
    const renamedAndNew = tokens({
      colors: [
        color("color:Theme.secondaryText", "#969ca5", { key: "surface" }),
        color("color:Other.surface", "#000000", { key: "surface" }),
      ],
    });
    const plan = planSync(renamedAndNew, file).variables;
    expect(plan.rename.map((r) => r.token.identity)).toEqual(["color:Theme.secondaryText"]);
    expect(plan.create.map((c) => c.name)).toEqual(["color/surface"]);
  });

  it("guesses no rename after a partial scan", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.c3", "#969ca5")] }));
    const partial = tokens({ colors: [color("color:Theme.secondaryText", "#969ca5")], complete: false });
    expect(planSync(partial, file).variables.rename).toEqual([]);
  });
});
