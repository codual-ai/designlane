import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { scanRepo } from "../../src/index.js";
import {
  type DesignTokensSchema,
  type FrameworkScanSchema,
  ScanResultSchema,
  type ScreenLinkSchema,
  type ScreenRefSchema,
} from "../../src/read/index.js";
import type { DesignTokens, FrameworkScan, ScanResult, ScreenLink, ScreenRef } from "../../src/scan/types.js";
import { swift } from "../helpers/catalog.js";
import { appIn, COMPOSE_APP, RN_APP, SHOP } from "../helpers/read-apps.js";

const LINKED = {
  "App/Home.swift": swift(
    "struct Home: View { var body: some View { NavigationStack { NavigationLink(destination: Detail()) { Text(t) } } } }",
  ),
  "App/Detail.swift": swift(
    "struct Detail: View { var body: some View { Text(t).foregroundStyle(Color.brand) } }",
  ),
  "App/Theme.swift": swift("extension Color { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }"),
};

describe("scan result schemas", () => {
  it("type exactly what the scan's types say", () => {
    expectTypeOf<z.infer<typeof ScanResultSchema>>().toEqualTypeOf<ScanResult>();
    expectTypeOf<z.infer<typeof FrameworkScanSchema>>().toEqualTypeOf<FrameworkScan>();
    expectTypeOf<z.infer<typeof DesignTokensSchema>>().toEqualTypeOf<DesignTokens>();
    expectTypeOf<z.infer<typeof ScreenRefSchema>>().toEqualTypeOf<ScreenRef>();
    expectTypeOf<z.infer<typeof ScreenLinkSchema>>().toEqualTypeOf<ScreenLink>();
  });

  it("read every framework's scan back whole: no field is dropped", async () => {
    const roots = [SHOP, await appIn(LINKED), await appIn(COMPOSE_APP), await appIn(RN_APP)];
    for (const root of roots) {
      const scan = await scanRepo(root);
      expect(scan.frameworks.length).toBeGreaterThan(0);
      expect(ScanResultSchema.parse(JSON.parse(JSON.stringify(scan)))).toEqual(scan);
    }
    const linked = await scanRepo(roots[1] as string);
    expect(linked.frameworks[0]?.links?.length).toBe(1);
  });

  it("refuses a scan whose values aren't ones the scan makes", async () => {
    const scan = await scanRepo(SHOP);
    const [framework] = scan.frameworks;
    const screen = framework?.screens[0];
    const broken = { ...scan, frameworks: [{ ...framework, screens: [{ ...screen, kind: "page" }] }] };
    expect(ScanResultSchema.safeParse(broken).success).toBe(false);
    expect(ScanResultSchema.safeParse({ ...scan, nativeAlongside: ["flutter"] }).success).toBe(false);
  });
});
