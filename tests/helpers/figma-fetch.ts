/** Figma's `fetch` for the plugin under test, sending what it asks of GitHub's API to a local server over HTTP. */

import { request } from "node:http";
import { vi } from "vitest";
import { API, type GitHubServer } from "./github-server.js";

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Received {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
}

function sent(url: string, { method = "GET", headers = {}, body }: FetchInit): Promise<Received> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = Object.fromEntries(
          Object.entries(incoming.headers).map(([name, value]) => [name, String(value)]),
        );
        resolve({
          status: incoming.statusCode ?? 0,
          statusText: incoming.statusMessage ?? "",
          headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** Installs Figma's `fetch`, which answers with `headersObject` rather than `Headers`, its requests to GitHub's API
 * going to `server` instead. */
export function useGitHubServer(server: GitHubServer) {
  const figmaFetch = vi.fn(async (url: string, init: FetchInit = {}) => {
    if (!url.startsWith(`${API}/`)) throw new Error(`a request outside GitHub's API: ${url}`);
    const { status, statusText, headers, text } = await sent(server.origin + url.slice(API.length), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headersObject: headers,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
  vi.stubGlobal("fetch", figmaFetch);
}
