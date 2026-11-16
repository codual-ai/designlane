#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2), {
  out: (text) => console.log(text),
  error: (text) => console.error(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`designlane: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
