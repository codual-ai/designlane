/** `designlane doctor`: where Designlane falls short on an app, screen by screen, for a person to read or report. */

import path from "node:path";
import { parseArgs } from "node:util";
import { readApp } from "../read/app.js";
import type { LayoutIssueKind, LayoutIssues, LayoutNode, UnreadableReason } from "../read/schema.js";
import { plural } from "../scan/counting.js";
import { isFolder, readGaps } from "../scan/files.js";
import type { ScreenRef } from "../scan/types.js";
import { FRAMEWORK_NAMES } from "../scan/types.js";
import { type Output, packageVersion, UsageError } from "./command.js";

export const DOCTOR_USAGE = `  designlane doctor [dir] [--json] [--all] [--screen <name>] [--report]
                    List the screens whose layout Designlane can't read, with where, and sum up what it may read
                    wrong. --all lists every issue where it is; --screen shows one screen's issues, parts and
                    layout; --json prints the issues as JSON, of every screen or of --screen's; --report adds a link
                    to a GitHub issue with them filled in, which you check before you send it`;

const ISSUES_URL = "https://github.com/codual-ai/designlane/issues";

/** Each reason, as the person running the command reads it: what Designlane couldn't do, as the code usually builds
 * and the shortfall is Designlane's. */
const REASONS: Record<UnreadableReason, string> = {
  "no-declaration": "Designlane can't find its declaration here",
  "no-body": "Designlane can't find its body",
  unbalanced: "Designlane can't match a bracket here",
  "open-extension": "Designlane can't match the brackets of an extension of it",
  "parse-error": "TypeScript's parser can't read the code here",
  "too-deep": "its code nests deeper than Designlane reads",
  "too-much-inlined": "its view properties place each other more than Designlane reads",
};

/** Each kind of issue, as a heading for one of it and for several. */
const KINDS: Record<LayoutIssueKind, [one: string, many: string]> = {
  "unknown-element": ['unknown element, shown as "other"', 'unknown elements, shown as "other"'],
  "ambiguous-view": [
    "name several views have, so one was picked",
    "names several views have, so one was picked",
  ],
  "if-as-written": ["#if read as if both sides are shown", "#ifs read as if both sides are shown"],
  "self-placed": ["view placing itself", "views placing themselves"],
  "unnamed-part": ["part labelled by its kind only", "parts labelled by their kind only"],
  "no-parts": ["screen with no parts", "screens with no parts"],
};

/** Kinds that are summed up unless `--all`: many, and each a small matter. */
const SUMMED = new Set<LayoutIssueKind>(["unnamed-part", "no-parts"]);

/** Kinds whose `detail` names what they're about (`Gauge`), so they're listed by it. */
const NAMED = new Set<LayoutIssueKind>(["unknown-element", "ambiguous-view"]);

/** How many examples a kind lists, views that can't be read are listed, and screens each stops, unless `--all`. */
const EXAMPLES = 5;
const UNREADABLE_LISTED = 20;
const STOPPED_LISTED = 3;

type Issue = LayoutIssues["issues"][number];

/** Runs `designlane doctor` with `argv` (the words after `doctor`), and returns the exit code: 0 for a report, which
 * checks nothing; 1 or 2 for a folder or screen that isn't there, or arguments it doesn't take. */
export async function doctor(argv: string[], { out, error }: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    out(DOCTOR_USAGE);
    return 0;
  }
  if (positionals.length > 1)
    throw new UsageError(`expected one folder, got ${positionals.length}\n\n${DOCTOR_USAGE}`, 2);
  const root = path.resolve(positionals[0] ?? ".");
  if (!(await isFolder(root))) throw new UsageError(`not a folder: ${root}`, 1);
  const app = await readApp(root);
  const gaps = readGaps({ truncated: app.skipped.truncated, unreadable: [...app.skipped.unreadable] });
  if (gaps) error(`designlane: ${gaps}`);
  let screens = app.screens();
  if (values.screen !== undefined) {
    const name = values.screen;
    screens = screens.filter((s) => s.name === name || s.id === name);
    if (screens.length === 0) throw new UsageError(`no screen or component named ${name}`, 1);
  }
  const all = screens.map((s) => ({ screen: s, issues: app.layoutIssues(s.id) }));
  if (values.json && values.report)
    throw new UsageError(`--report goes with the report, not --json\n\n${DOCTOR_USAGE}`, 2);
  if (values.json)
    out(
      JSON.stringify(
        all.map((a) => a.issues),
        null,
        2,
      ),
    );
  else {
    const text =
      values.screen !== undefined
        ? all
            .map((a) => detail(a.screen, a.issues, app.layoutOf(a.screen.id), app.screenParts(a.screen.id)))
            .join("\n\n")
        : report(all, { everything: values.all === true, askToReport: values.report !== true });
    out(text);
    if (values.report) {
      const frameworks = [...new Set(screens.map((s) => s.framework))];
      const link = issueLink(text, {
        version: await packageVersion(),
        ...(frameworks.length === 1 && frameworks[0] && { framework: FRAMEWORK_NAMES[frameworks[0]] }),
        ...(values.screen !== undefined && { screen: values.screen }),
      });
      out(
        "\nTo report it, open this link. Designlane sends nothing itself; the link gives GitHub the lines above, file and screen names included, filled into a new issue. Check them, add the code it reads wrong, and submit it to publish it:",
      );
      out(link);
    }
  }
  return 0;
}

/** How much of a screen's name the title carries: enough to say which, never so much the link can't fit. */
const MAX_TITLE_NAME = 80;
/** Cut by whole characters, so an emoji or other character of two UTF-16 units is never split. */
const shortened = (name: string) => {
  const chars = [...name];
  return chars.length > MAX_TITLE_NAME ? `${chars.slice(0, MAX_TITLE_NAME).join("")}…` : name;
};

/** The longest link, encoded, that GitHub opens: it refuses a link of much more than eight thousand characters. */
const MAX_LINK = 7000;
const CUT = "… (cut to fit the link)";

/** A link to a new issue, the form for something Designlane reads wrong, with the report, the framework and the
 * version filled in. */
export function issueLink(
  text: string,
  { version, framework, screen }: { version: string; framework?: string; screen?: string },
): string {
  const linkOf = (got: string) =>
    `${ISSUES_URL}/new?${new URLSearchParams({
      template: "reads-wrong.yml",
      title: screen ? `Designlane reads ${shortened(screen)} wrong` : "Designlane reads my app wrong",
      got,
      version,
      ...(framework && { framework }),
    }).toString()}`;
  const whole = linkOf(text);
  if (whole.length <= MAX_LINK) return whole;
  // The most lines that fit, encoded: text in any script, which encodes to a few times its length or more.
  const lines = text.split("\n");
  let fits = 0;
  let over = lines.length;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (linkOf([...lines.slice(0, mid), CUT].join("\n")).length <= MAX_LINK) fits = mid;
    else over = mid;
  }
  return linkOf([...lines.slice(0, fits), CUT].join("\n"));
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        all: { type: "boolean" },
        screen: { type: "string" },
        report: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n\n${DOCTOR_USAGE}`, 2);
  }
}

const at = (span: { file: string; line: number }) => `${span.file}:${span.line}`;
const nameOf = (id: string) => id.slice(id.lastIndexOf("#") + 1);
const counted = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
/** Places in order: by file, then by line. */
const byPlace = (a: { file: string; line: number }, b: { file: string; line: number }) =>
  a.file.localeCompare(b.file) || a.line - b.line;

/** The app's issues, for a person: what can't be read, then what may be read wrong, kind by kind, and, unless a link
 * to report them follows, how to. A view's issues are counted once, though every screen it's placed in has them. */
function report(
  all: { screen: ScreenRef; issues: LayoutIssues }[],
  { everything, askToReport }: { everything: boolean; askToReport: boolean },
): string {
  const own = all.filter((a) => a.issues.unreadable?.view === a.screen.id).length;
  const stopped = all.filter((a) => a.issues.unreadable && a.issues.unreadable.view !== a.screen.id).length;
  const lines = [
    `Read ${plural(all.length, "screen and component", "screens and components")}: ` +
      `${all.length - own - stopped} whole, ${own} can't be read` +
      (stopped > 0 ? `, ${stopped} place a view that can't be.` : "."),
  ];
  lines.push(...unreadable(all, everything));
  const byKind = new Map<LayoutIssueKind, Issue[]>();
  const seen = new Set<string>();
  for (const { issues } of all)
    for (const issue of issues.issues) {
      const key = `${issue.kind} ${issue.span.file} ${issue.span.start} ${issue.span.end} ${issue.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = byKind.get(issue.kind) ?? [];
      found.push(issue);
      byKind.set(issue.kind, found);
    }
  const wrong = [...byKind].filter(([kind]) => everything || !SUMMED.has(kind));
  if (wrong.length > 0) {
    lines.push("", "May be read wrong");
    for (const [kind, found] of wrong)
      if (everything) lines.push(`  ${counted(found.length, KINDS[kind])}`, ...listed(kind, found));
      else lines.push(`  ${counted(found.length, KINDS[kind])}: ${examples(kind, found)}`);
  }
  const summed = [...byKind].filter(([kind]) => !everything && SUMMED.has(kind));
  if (summed.length > 0)
    lines.push(
      "",
      `${summed.map(([kind, found]) => counted(found.length, KINDS[kind])).join(", ")} (--all lists them)`,
    );
  // With --report, the link that follows asks instead.
  if (lines.length > 1 && askToReport)
    lines.push(
      "",
      `Found something Designlane should read better? designlane doctor --report gives a link to an issue with the lines above: ${ISSUES_URL}`,
    );
  return lines.join("\n");
}

/** The views that can't be read, each once with where and why, and the screens placing it it stops: those stopping
 * the most first. */
function unreadable(all: { screen: ScreenRef; issues: LayoutIssues }[], everything: boolean): string[] {
  const byView = new Map<
    string,
    { span: { file: string; line: number }; reason: UnreadableReason; stops: Map<string, string> }
  >();
  for (const { screen, issues } of all) {
    const why = issues.unreadable;
    if (!why) continue;
    const entry = byView.get(why.view) ?? {
      span: why.span,
      reason: why.reason,
      stops: new Map<string, string>(),
    };
    if (why.view !== screen.id) entry.stops.set(screen.id, screen.name);
    byView.set(why.view, entry);
  }
  if (byView.size === 0) return [];
  const sorted = [...byView].sort(([, a], [, b]) => b.stops.size - a.stops.size || byPlace(a.span, b.span));
  const shown = everything ? sorted : sorted.slice(0, UNREADABLE_LISTED);
  let width = 0;
  for (const [, e] of shown) width = Math.max(width, at(e.span).length);
  const lines = ["", "Can't be read"];
  for (const [view, e] of shown) {
    const stops = [...e.stops.values()];
    const named = everything ? stops : stops.slice(0, STOPPED_LISTED);
    const more = stops.length > named.length ? `, and ${stops.length - named.length} more` : "";
    const placed = stops.length > 0 ? `, placed in ${named.join(", ")}${more}` : "";
    lines.push(`  ${at(e.span).padEnd(width)}  ${REASONS[e.reason]}: ${nameOf(view)}${placed}`);
  }
  if (shown.length < sorted.length)
    lines.push(`  and ${sorted.length - shown.length} more (--all lists them)`);
  return lines;
}

/** A kind's issues in a line: the commonest names (`ProgressView ×9`) for a named kind, else where they are. */
function examples(kind: LayoutIssueKind, found: Issue[]): string {
  const listed = NAMED.has(kind)
    ? [...counts(found)]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    : [...found].sort((a, b) => byPlace(a.span, b.span)).map((issue) => at(issue.span));
  const more = listed.length > EXAMPLES ? `, and ${listed.length - EXAMPLES} more` : "";
  return listed.slice(0, EXAMPLES).join(", ") + more;
}

/** Every issue of a kind, a line each with where it is. */
function listed(kind: LayoutIssueKind, found: Issue[]): string[] {
  return [...found]
    .sort((a, b) => byPlace(a.span, b.span))
    .map(
      (issue) =>
        `    ${at(issue.span)}${NAMED.has(kind) || kind === "unnamed-part" ? `  ${issue.detail ?? ""}` : ""}`,
    );
}

function counts(found: Issue[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const issue of found)
    if (issue.detail !== undefined) out.set(issue.detail, (out.get(issue.detail) ?? 0) + 1);
  return out;
}

/** One screen in full: why it can't be read, or its issues, its parts and its layout. */
function detail(
  screen: ScreenRef,
  issues: LayoutIssues,
  layout: LayoutNode | undefined,
  parts: { label: string }[] | undefined,
): string {
  // Places in the screen's own file go by their line; others by their file too.
  const place = (span: { file: string; line: number }) =>
    span.file === screen.file ? `line ${span.line}` : at(span);
  const lines = [`${screen.name} (${screen.kind}, ${screen.file}:${screen.line})`];
  if (issues.unreadable)
    lines.push(
      `  Can't be read: ${REASONS[issues.unreadable.reason]} at ${place(issues.unreadable.span)}` +
        (issues.unreadable.view === screen.id ? "" : ` (${nameOf(issues.unreadable.view)})`),
    );
  for (const issue of issues.issues)
    lines.push(`  ${KINDS[issue.kind][0]}: ${issue.detail ? `${issue.detail} ` : ""}at ${place(issue.span)}`);
  if (parts) lines.push(`  Parts: ${parts.length > 0 ? parts.map((p) => p.label).join(" | ") : "none"}`);
  if (layout) lines.push("  Layout:", ...outline(layout, 2, place));
  return lines.join("\n");
}

/** The layout as indented lines of `kind`, with the view a view-ref places. */
function outline(node: LayoutNode, depth: number, place: (span: LayoutNode["span"]) => string): string[] {
  const own = `${"  ".repeat(depth)}${node.kind}${node.ref ? ` ${nameOf(node.ref)}` : ""}  ${place(node.span)}`;
  return [own, ...node.children.flatMap((c) => outline(c, depth + 1, place))];
}
