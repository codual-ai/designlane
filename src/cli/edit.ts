/** `designmap edit`: makes a change to a token in the app's code, in the code's own notation. */

import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { editDiff } from "../edit/diff.js";
import { COLOR_PROPERTIES, type EditProperty, TYPE_PROPERTIES } from "../edit/edit-tokens.js";
import { applyEdit, planEdit, type ReadSource } from "../edit/plan.js";
import { APP_TOKENS_FILES, OUTPUT_DIR, TOKENS_FILE } from "../output/write.js";
import { isFolder, readText } from "../scan/files.js";
import { type Output, UsageError } from "./command.js";

export const EDIT_USAGE = `  designmap edit <token> <property> <value> [--dir <app>] [--dry-run] [--tokens <file>]
                    Change a token in the code where tokens.json says its value is written, written the way the
                    code writes it, and print the diff. <token> is its key or how the code refers to it;
                    <property> is light, dark, family, size or weight; <value> is #rrggbb, a number or a name.
                    --dry-run prints the diff and writes nothing; --tokens names the tokens file of an app in a
                    repo with two`;

const PROPERTIES: readonly EditProperty[] = [...COLOR_PROPERTIES, ...TYPE_PROPERTIES];
const isProperty = (word: string): word is EditProperty => PROPERTIES.some((property) => property === word);

/** Runs `designmap edit` with `argv` (the words after `edit`), and returns the exit code. */
export async function edit(argv: string[], { out, error }: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [token, property, value] = positionals;
  if (positionals.length !== 3 || !token || !property || value === undefined) {
    throw new UsageError(`expected a token, a property and a value\n\n${EDIT_USAGE}`, 2);
  }
  if (!isProperty(property)) {
    throw new UsageError(`${property} isn't a property: use ${PROPERTIES.join(", ")}`, 2);
  }
  const root = path.resolve(values.dir ?? ".");
  if (!(await isFolder(root))) throw new UsageError(`not a folder: ${root}`, 1);
  const tokens = await readTokens(values.tokens ? path.resolve(values.tokens) : await tokensFileIn(root));
  const read: ReadSource = async (file) => {
    const real = await realPathInside(root, file);
    return real && readText(real);
  };
  const plan = await planEdit(tokens, read, { token, property, value }).catch((e: unknown) => {
    throw new UsageError(messageOf(e), 1);
  });
  if (!plan.ok) {
    error(`designmap: ${plan.reason}`);
    return 1;
  }
  const real = await realPathInside(root, plan.edit.file);
  const text = real && (await readText(real));
  if (!real || text === undefined)
    throw new UsageError(`${plan.edit.file} changed while it was being edited`, 1);
  out(editDiff(text, plan.edit));
  if (values["dry-run"]) return 0;
  await writeFile(real, applyEdit(text, plan.edit));
  return 0;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: { dir: { type: "string" }, "dry-run": { type: "boolean" }, tokens: { type: "string" } },
    });
  } catch (e) {
    throw new UsageError(`${messageOf(e)}\n\n${EDIT_USAGE}`, 2);
  }
}

/** The app's one tokens file in designmap/: tokens.json, or the one app's file of a repo that had two. */
async function tokensFileIn(root: string): Promise<string> {
  const folder = path.join(root, OUTPUT_DIR);
  const names = [TOKENS_FILE, ...Object.values(APP_TOKENS_FILES)];
  const present = [];
  for (const name of names) if ((await readText(path.join(folder, name))) !== undefined) present.push(name);
  const [only] = present;
  if (present.length === 1 && only) return path.join(folder, only);
  if (present.length === 0) {
    throw new UsageError(`no ${OUTPUT_DIR}/${TOKENS_FILE} in ${root}: run designmap there first`, 1);
  }
  throw new UsageError(`${OUTPUT_DIR}/ has ${present.join(" and ")}: name the app's with --tokens`, 2);
}

async function readTokens(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new UsageError(`couldn't read ${file}: ${messageOf(e)}`, 1);
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The real path of `file` in the app, or undefined when it's missing or outside it, through a symlink or otherwise.
 * Edits are read and written at this path, so what's written is what was checked. */
async function realPathInside(root: string, file: string): Promise<string | undefined> {
  const [real, realRoot] = await Promise.all([realpath(path.resolve(root, file)), realpath(root)]).catch(
    () => [],
  );
  if (!real || !realRoot) return undefined;
  const rel = path.relative(realRoot, real);
  return !rel || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel) ? undefined : real;
}
