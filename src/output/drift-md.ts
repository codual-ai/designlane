/** drift.md: where the UI code skips the app's own design system, what to use instead when the code has it, and
 * every place it happens. */

import { type DriftReport, type Location, SCALE_RULES, type TokenName } from "../drift/drift.js";
import { DUPLICATE_SIMILARITY } from "../drift/duplicates.js";
import { plural } from "../scan/counting.js";
import { FRAMEWORK_NAMES, type FrameworkId, type ScanResult } from "../scan/types.js";

/** How many places a row lists before counting the rest. */
const MAX_PLACES = 3;
const UNITS: Record<FrameworkId, string> = { swiftui: "pt", compose: "dp", "react-native": "" };

/** A table cell can't hold a `|` or a line break. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
const code = (text: string) => `\`${cell(text).replace(/`/g, "'")}\``;

function places(uses: Location[]): string {
  const listed = uses.slice(0, MAX_PLACES).map((u) => code(`${u.file}:${u.line}`));
  return `${listed.join(", ")}${uses.length > MAX_PLACES ? ` and ${uses.length - MAX_PLACES} more` : ""}`;
}

const tokenCell = (token: TokenName) =>
  `${code(token.key)}${token.reference ? ` (${code(token.reference)})` : ""}`;

/** A framework column, only for a repo with more than one app. */
function frameworkColumn(scan: ScanResult) {
  const several = scan.frameworks.length > 1;
  return {
    head: several ? " Framework |" : "",
    rule: several ? " --- |" : "",
    of: (framework: FrameworkId) => (several ? ` ${FRAMEWORK_NAMES[framework]} |` : ""),
  };
}

function colorSection(report: DriftReport, column: ReturnType<typeof frameworkColumn>): string[] {
  if (!report.colors.length) return [];
  return [
    "## Colours written as values",
    "",
    "A colour written as a value doesn't follow dark mode or a change to the design system. One with the same value as a named colour is a one-line fix.",
    "",
    `| Colour |${column.head} Uses | Use instead | Where |`,
    `| --- |${column.rule} --- | --- | --- |`,
    ...report.colors.map(
      (c) =>
        `| ${code(c.value)} |${column.of(c.framework)} ${c.uses.length} | ${c.token ? tokenCell(c.token) : "no named colour has this value"} | ${places(c.uses)} |`,
    ),
    "",
  ];
}

function scaleSection(report: DriftReport, column: ReturnType<typeof frameworkColumn>): string[] {
  if (!report.scale.length) return [];
  const value = (n: number, framework: FrameworkId) => `${n}${UNITS[framework]}`;
  return [
    "## Spacing and corners off the scale the code uses",
    "",
    "Each value is used once or twice, right beside a value the code uses often, so it may be meant as that one. Designlane reads the values the code writes, not named spacing tokens, so it names the value on the scale, not a token.",
    "",
    `| Value | Kind |${column.head} Uses | On the scale nearby | Where |`,
    `| --- | --- |${column.rule} --- | --- | --- |`,
    ...report.scale.map(
      (s) =>
        `| ${value(s.value, s.framework)} | ${s.kind === "spacing" ? "spacing" : "corner radius"} |${column.of(s.framework)} ${s.uses.length} | ${value(s.nearest, s.framework)}, used ${s.nearestUses}× | ${places(s.uses)} |`,
    ),
    "",
  ];
}

function typeSection(report: DriftReport, column: ReturnType<typeof frameworkColumn>): string[] {
  if (!report.typeStyles.length) return [];
  return [
    "## Text styles written in place",
    "",
    "Each has the same font, size and weight as a text style the code names, so it could use that style and change with it. Designlane counts these rather than locating them: search the code for the font it writes.",
    "",
    `| Written |${column.head} Uses | Use instead |`,
    `| --- |${column.rule} --- | --- |`,
    ...report.typeStyles.map(
      (t) => `| ${cell(t.name)} |${column.of(t.framework)} ${t.uses} | ${tokenCell(t.token)} |`,
    ),
    "",
  ];
}

function duplicateSection(report: DriftReport): string[] {
  if (!report.duplicates.length) return [];
  const view = (v: DriftReport["duplicates"][number]["first"]) =>
    `${code(v.name)} (${code(`${v.file}:${v.line}`)})`;
  return [
    "## Near-duplicate components",
    "",
    "Components whose code is mostly the same. Merging a pair, with a parameter for what differs, leaves one place to fix and restyle.",
    "",
    "| Component | Component | Same code | Uses |",
    "| --- | --- | --- | --- |",
    ...report.duplicates.map(
      (d) =>
        `| ${view(d.first)} | ${view(d.second)} | ${Math.round(d.similarity * 100)}% | ${d.first.uses} / ${d.second.uses} |`,
    ),
    "",
  ];
}

export function toDriftMd(scan: ScanResult, report: DriftReport): string {
  const column = frameworkColumn(scan);
  const matching = report.colors.filter((c) => c.token).length;
  const sections = [
    ...colorSection(report, column),
    ...scaleSection(report, column),
    ...typeSection(report, column),
    ...duplicateSection(report),
  ];
  return [
    "# Design drift",
    "",
    "Where the UI code skips the app's own design system, read from the code by Designlane. Each item says where it is.",
    "",
    `- ${plural(report.colors.length, "colour")} written as values${matching ? `, ${matching} the same as a named colour` : ""}`,
    `- ${plural(report.scale.length, "spacing or corner value")} off the scale the code uses`,
    `- ${plural(report.typeStyles.length, "text style")} written in place that a named style matches`,
    `- ${plural(report.duplicates.length, "pair")} of near-duplicate components`,
    "",
    ...(sections.length ? sections : ["No drift found.", ""]),
    "## How this is decided",
    "",
    "- Only UI code counts: theme, token, colour and test files are where values belong.",
    `- A spacing or corner value is on the scale the code uses when it's used at least ${SCALE_RULES.onScaleUses} times. One used at most ${SCALE_RULES.rareUses} times, within ${SCALE_RULES.maxDistance} of a value on the scale and not on the ${SCALE_RULES.grid}-point grid, is listed.`,
    `- Near-duplicates are components sharing at least ${Math.round(DUPLICATE_SIMILARITY * 100)}% of their code's words, leaving out their names.`,
    "",
  ].join("\n");
}
