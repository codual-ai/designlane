/// <reference lib="dom.iterable" />
/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ComponentInfo } from "../../src/catalog/components.js";
import { escapeHtml, toCatalogHtml } from "../../src/output/catalog-html.js";
import type { ScanResult } from "../../src/scan/types.js";

const component = (over: Partial<ComponentInfo>): ComponentInfo => ({
  id: `swiftui:App/${over.name}.swift#${over.name}`,
  name: "Row",
  framework: "swiftui",
  file: `App/${over.name ?? "Row"}.swift`,
  line: 3,
  designSystem: false,
  kind: "component",
  category: "list",
  uses: 0,
  usedIn: [],
  sharedUses: 0,
  params: [],
  colors: [],
  typeStyles: [],
  source: "",
  ...over,
});

const scan: ScanResult = {
  root: "/apps/Shop",
  filesScanned: 3,
  truncated: false,
  unreadable: [],
  frameworks: [
    {
      framework: "swiftui",
      platforms: ["ios"],
      screens: [],
      tokens: {
        colors: [
          {
            name: "brand",
            light: "#3366e6",
            dark: "#99aaff",
            source: "App/Theme.swift",
            kind: "code",
            uses: 4,
            reference: "Theme.brand",
          },
          {
            name: "bad",
            light: 'red"><script>x()</script>',
            source: "App/Theme.swift",
            kind: "code",
            uses: 1,
            reference: "Theme.bad",
          },
        ],
        themes: [
          {
            name: "Desert",
            colors: [
              {
                name: "brand",
                light: "#df915e",
                source: "App/Desert.swift",
                kind: "code",
                uses: 0,
                reference: "Desert.brand",
              },
            ],
          },
        ],
        systemColors: [],
        typeStyles: [
          {
            name: "brandTitle",
            kind: "app",
            family: "Inter;background:url(//x)",
            size: 28,
            weight: "bold",
            reference: "Font.brandTitle",
            uses: 2,
          },
        ],
        fonts: ["Inter"],
        spacing: [16, 8],
        radii: [12],
      },
    },
  ],
};

const components = [
  component({
    name: "PlanRow",
    uses: 3,
    usedIn: ["App/Paywall.swift"],
    sharedUses: 2,
    params: ["title: String"],
    colors: ["brand"],
    typeStyles: ["brandTitle"],
    source: "struct PlanRow: View {\n  let title: String\n}",
  }),
  component({ name: "BuyButton", category: "button", source: "struct BuyButton {}" }),
  component({ name: "<img src=x onerror=alert(1)>", category: "other" }),
  component({ name: "Paywall", kind: "screen", category: "screen" }),
];

/** The page's body in the test's document, with its search running. */
function render(html: string) {
  document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("<script>"));
  new Function(html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>")))();
  return document;
}

describe("catalog.html", () => {
  const html = toCatalogHtml(
    scan,
    components,
    new Map([[components[0]?.id ?? "", { html: '<b class="x">$4</b>', stale: true }]]),
  );

  it("shows the app's colours light and dark, its themes, text styles, spacing and corner radii", () => {
    expect(html).toContain(
      '<span style="background:#3366e6" title="Light #3366e6"></span><span style="background:#99aaff" title="Dark #99aaff"></span>',
    );
    expect(html).toContain("<b>brand</b>");
    expect(html).toContain("Theme: Desert (1 colour)");
    expect(html).toContain("#df915e");
    expect(html).toContain("brandTitle");
    expect(html).toContain("space-8 · 8");
    expect(html).toContain("radius-12 · 12");
  });

  it("escapes everything read from the code, and writes no value that could reach out", () => {
    expect(html).not.toContain("<script>x()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<span style="background:transparent"');
    expect(html).not.toMatch(/style="[^"]*url\(/);
    expect(html).not.toMatch(/https?:\/\/|<script src|<link/);
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("shows each component's category, file, uses, parameters, colours and text styles, and screens apart", () => {
    const page = render(html);
    const card = [...page.querySelectorAll(".card")].find(
      (c) => c.querySelector(".name")?.textContent === "PlanRow",
    );
    expect(card?.querySelector(".kind")?.textContent).toBe("Rows and list items");
    expect(card?.textContent).toContain("App/PlanRow.swift:3");
    expect(card?.textContent).toContain("used 3× in 1 file, and 2× that may be another PlanRow");
    expect([...(card?.querySelectorAll(".tag") ?? [])].map((t) => t.textContent)).toEqual([
      "title: String",
      "brand",
      "brandTitle",
    ]);
    expect(card?.querySelector(".tag i")?.getAttribute("style")).toBe("background:#3366e6");
    expect(page.querySelector("#screens")?.textContent).toBe("Screens (1)");
  });

  it("shows a saved picture in a sandbox with nothing allowed, and says when it's out of date", () => {
    const frame = render(html).querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain('<b class="x">$4</b>');
    expect(frame?.getAttribute("srcdoc")).toContain("--color-brand: #3366e6;");
    expect(html).toContain("The code changed after this picture was drawn.");
    const left = toCatalogHtml(
      scan,
      components,
      new Map([[components[0]?.id ?? "", { problem: "Remove scripts." }]]),
    );
    expect(left).toContain("Picture left out: Remove scripts.");
    expect(left).not.toContain("<iframe");
  });

  it("searches by words and filters by kind, keeping screens to the words alone", () => {
    const page = render(html);
    const visible = () =>
      [...page.querySelectorAll<HTMLElement>(".card")]
        .filter((c) => !c.hidden)
        .map((c) => c.querySelector(".name")?.textContent);
    const search = page.querySelector<HTMLInputElement>("#search");
    if (!search) throw new Error("no search");
    search.value = "plan title";
    search.dispatchEvent(new Event("input"));
    expect(visible()).toEqual(["PlanRow"]);
    expect(page.querySelector("#shown")?.textContent).toBe("1 of 4 shown");
    search.value = "";
    search.dispatchEvent(new Event("input"));
    page.querySelector<HTMLButtonElement>('[data-category-filter="button"]')?.click();
    expect(visible()).toEqual(["BuyButton", "Paywall"]);
  });

  it("works in light and dark, and says when only part of the app was read", () => {
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).not.toContain("Only part of the app was read");
    expect(toCatalogHtml({ ...scan, truncated: true }, components)).toContain(
      "Only part of the app was read",
    );
  });
});
