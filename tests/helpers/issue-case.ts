/**
 * A pattern case from an issue filed with the "reads wrong" form: the framework it names and the code it gives, for
 * `pnpm pattern --issue <number>`.
 */

export const FRAMEWORKS = ["swiftui", "compose", "react-native"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** The form's framework options, and the folder and file each one's case goes in. */
const FORM_FRAMEWORKS = new Map<string, { framework: Framework; file: string }>([
  ["SwiftUI", { framework: "swiftui", file: "Case.swift" }],
  ["Jetpack Compose", { framework: "compose", file: "Case.kt" }],
  ["React Native", { framework: "react-native", file: "Case.tsx" }],
]);

/** What each framework's code needs for Designlane to read it as that framework's. */
export const IMPORT_NEEDED: Record<Framework, string> = {
  swiftui: "import SwiftUI",
  compose: "import androidx.compose.runtime.Composable",
  "react-native": 'an import of the elements it uses from "react-native"',
};

export interface IssueCase {
  framework: Framework;
  file: string;
  code: string;
}

/** The case an issue's form answers give, or an error saying which answer is missing. */
export function caseOfIssue(body: string): IssueCase {
  const text = body.replaceAll("\r\n", "\n");
  const named = FORM_FRAMEWORKS.get(answer(text, "Framework", "The code it reads wrong"));
  if (!named) throw new Error('The issue names no framework: was it filed with the "reads wrong" form?');
  const code = withoutFence(answer(text, "The code it reads wrong", "What Designlane says"));
  if (!code) throw new Error("The issue has no code to make a case of.");
  return { ...named, code: `${code}\n` };
}

/** The answer to one of the form's questions: GitHub writes each question as a `### <question>` heading, so the
 * answer runs to the next question's heading. */
function answer(body: string, question: string, nextQuestion: string): string {
  const heading = `### ${question}\n`;
  const start = body.indexOf(heading);
  const end = body.indexOf(`\n### ${nextQuestion}\n`, start);
  if (start < 0 || end < 0) return "";
  const text = body.slice(start + heading.length, end).trim();
  return text === "_No response_" ? "" : text;
}

/** The code inside the ``` fence GitHub puts around a code answer, or the answer itself when it has none. */
function withoutFence(answer: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(answer);
  return fenced ? (fenced[1] ?? "").trimEnd() : answer;
}
