import { describe, expect, it } from "vitest";
import { caseOfIssue } from "../helpers/issue-case.js";

/** An issue's body as GitHub sends the "reads wrong" form's answers, with Windows line endings. */
function formBody({ framework, code }: { framework: string; code: string }): string {
  return [
    "### Framework",
    "",
    framework,
    "",
    "### The code it reads wrong",
    "",
    code,
    "",
    "### What Designlane says",
    "",
    "_No response_",
  ].join("\r\n");
}

describe("a case from an issue", () => {
  it("takes the framework and the code out of its fence, keeping the code's indent", () => {
    const body = formBody({
      framework: "Jetpack Compose",
      code: "```text\n  @Composable\n  fun Bar() { Row { } }\n```",
    });
    expect(caseOfIssue(body)).toEqual({
      framework: "compose",
      file: "Case.kt",
      code: "  @Composable\n  fun Bar() { Row { } }\n",
    });
  });

  it("keeps a line of the code that looks like one of the form's headings", () => {
    const code = "const notes = `\n### Heading\n`;";
    const body = formBody({ framework: "React Native", code: `\`\`\`text\n${code}\n\`\`\`` });
    expect(caseOfIssue(body).code).toBe(`${code}\n`);
  });

  it("refuses an issue that wasn't filed with the form", () => {
    expect(() => caseOfIssue("Designlane doesn't know this button.")).toThrow("names no framework");
  });

  it("refuses an issue with no code", () => {
    expect(() => caseOfIssue(formBody({ framework: "SwiftUI", code: "_No response_" }))).toThrow("no code");
  });
});
