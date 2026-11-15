import { describe, expect, it } from "vitest";
import { type DesignFileEntry, planSync, type VariableValue } from "../../src/sync/plan.js";
import { APP, color, firstVariable, syncedFile, tokens, tokensOf } from "../helpers/sync-tokens.js";

describe("planning a sync", () => {
  it("creates everything on a first sync, named from the code", async () => {
    const plan = planSync(await tokensOf(APP), { variables: [], textStyles: [] });
    expect(plan.variables.create.map((v) => v.name)).toEqual(["color/brand", "color/glass", "color/accent"]);
    expect(plan.textStyles.create.map((s) => [s.name, s.reference])).toEqual([
      ["Text/heading", "Font.heading"],
    ]);
  });

  it("names fractional spacing and radii without a dot, which a design file reads as a group", () => {
    const plan = planSync(tokens({ spacing: [1.5], radii: [0.5] }), { variables: [], textStyles: [] });
    expect(plan.variables.create.map((v) => v.name)).toEqual(["spacing/1_5", "radius/0_5"]);
  });

  it("changes nothing when the code hasn't, whatever case or opacity precision the file stores", async () => {
    const code = await tokensOf(APP);
    const file = syncedFile(code);
    for (const v of file.variables) {
      if (typeof v.value === "number") continue;
      const { hex, alpha } = v.value.light;
      v.value = { light: { hex: hex.toUpperCase(), alpha: alpha === 1 ? 1 : 0.50196 } };
    }
    const plan = planSync(code, file);
    expect(plan.variables).toEqual({
      create: [],
      update: [],
      deprecate: [],
      rename: [],
      renamesSkipped: false,
      unchanged: 3,
    });
    expect(plan.textStyles.unchanged).toBe(1);
  });

  it("updates a colour whose opacity really changed", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.glass", "#ffffff")] }));
    const faded = color("color:Theme.glass", "#ffffff", { light: { hex: "#ffffff", alpha: 0.6 } });
    expect(planSync(tokens({ colors: [faded] }), file).variables.update).toHaveLength(1);
  });

  it("updates a colour whose dark value alone changed", () => {
    const withDark = (hex: string) => color("color:Theme.bg", "#ffffff", { dark: { hex, alpha: 1 } });
    const file = syncedFile(tokens({ colors: [withDark("#000000")] }));
    expect(planSync(tokens({ colors: [withDark("#111111")] }), file).variables.update).toHaveLength(1);
  });

  it("updates a changed value in place and keeps the name a designer gave it", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.brand", "#3366e6")] }));
    const brand = firstVariable(file);
    brand.name = "brand/primary";
    const plan = planSync(tokens({ colors: [color("color:Theme.brand", "#112233")] }), file).variables;
    expect(plan.create).toEqual([]);
    expect(plan.update.map((u) => [u.id, u.name, u.restored])).toEqual([[brand.id, "brand/primary", false]]);
  });

  it("deprecates what a full group no longer lists, once", () => {
    const file = syncedFile(tokens({ spacing: [8, 16] }));
    const without8 = tokens({ spacing: [16] });
    expect(planSync(without8, file).variables.deprecate.map((d) => d.name)).toEqual(["spacing/8"]);
    for (const v of file.variables) if (v.identity === "spacing:8") v.deprecated = true;
    expect(planSync(without8, file).variables.deprecate).toEqual([]);
  });

  it("deprecates nothing after a scan that couldn't read the whole app", () => {
    const file = syncedFile(tokens({ spacing: [8, 16] }));
    expect(planSync(tokens({ spacing: [16], complete: false }), file).variables.deprecate).toEqual([]);
  });
  it("restores a deprecated token the code has again", () => {
    const file = syncedFile(tokens({ spacing: [8] }));
    for (const v of file.variables) v.deprecated = true;
    const plan = planSync(tokens({ spacing: [8] }), file).variables;
    expect(plan.update.map((u) => [u.name, u.restored])).toEqual([["spacing/8", true]]);
  });

  it("doesn't count a size the code computes as a change, whatever the file holds", () => {
    const title = { identity: "type:Font.title(_:)", key: "title", value: { family: "SF Pro", weight: 600 } };
    const code = tokens({ textStyles: [title] });
    const file = syncedFile(code);
    for (const s of file.textStyles) s.value = { ...s.value, size: 28 };
    expect(planSync(code, file).textStyles.unchanged).toBe(1);
  });

  it("syncs the first of a duplicated variable and leaves the copy alone", () => {
    const file = syncedFile(tokens({ colors: [color("color:Theme.brand", "#3366e6")] }));
    const original = firstVariable(file);
    file.variables.push({ ...original, id: "copy", name: "brand copy" });
    const changed = planSync(tokens({ colors: [color("color:Theme.brand", "#112233")] }), file).variables;
    expect(changed.update.map((u) => u.id)).toEqual([original.id]);
    const dropped = planSync(tokens({ spacing: [4] }), file).variables;
    expect(dropped.deprecate.map((d) => d.id)).toEqual([original.id]);
  });

  it("leaves what a designer made alone, and doesn't take its name", () => {
    const designer: DesignFileEntry<VariableValue> = {
      id: "d",
      name: "color/brand",
      value: 4,
      deprecated: false,
    };
    const code = tokens({ colors: [color("color:Theme.brand", "#3366e6", { key: "brand" })] });
    const plan = planSync(code, { variables: [designer], textStyles: [] }).variables;
    expect([plan.deprecate, plan.update]).toEqual([[], []]);
    expect(plan.create.map((v) => v.name)).toEqual(["color/brand 2"]);
  });
});
