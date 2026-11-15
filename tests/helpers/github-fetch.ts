/** GitHub as the plugin's `fetch` sees it, stubbed with one answer, and the connection the tests make to it. */

import { vi } from "vitest";
import type { plugin } from "./figma-plugin.js";

export const repo = { repo: "octo/app", branch: "main", path: "designmap/tokens.json" };
export const connection = { ...repo, token: "github_pat_secret" };

/** GitHub as the plugin's `fetch` sees it: answering every request with `status`, and `body` when it's found. */
export function github(status: number, body = "", headers: Record<string, string> = {}) {
  const fetch = vi.fn(async (_url: string, _init?: FetchOptions) => ({
    ok: status === 200,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headersObject: headers,
    text: async () => body,
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The requests for a file's contents, apart from the listing of open pull requests each check makes too. */
export const contentsReads = (fetch: ReturnType<typeof github>) =>
  fetch.mock.calls.filter(([url]) => url.includes("/contents/"));

export const lastError = (app: ReturnType<typeof plugin>) => {
  const message = app.last();
  return message?.type === "error" ? message.message : `no error: ${JSON.stringify(message)}`;
};
