#!/usr/bin/env node
// The remote dsh environment, exposed to a local harness as MCP tools.
//
// WHY THIS IS AN MCP SERVER AND NOT A SUBAGENT. The harness ships three ways to drive another agent,
// and this environment ruled two of them out by measurement, not by taste:
//
//   * `dsh-sdk-jsonrpc-server` gates the provider through `hasAdapterFor()` and rejects our pi-ai route
//     (`no adapter registered for provider "cf-ai-gateway"`), and its Config has no provider override.
//   * ACP (`dsh-acp`) accepts the provider, but inside the container `session/new` is accepted and then
//     emits no frame for minutes, while the TUI over the same settings answers normally.
//   * `dsh-mcp-client` is just a tool bridge: it connects to any MCP server and registers what it
//     advertises as `mcp__<server>__<tool>`. Nothing about the remote side has to be a harness feature.
//
// So the remote environment presents itself as an MCP server, and the local harness gets a native tool
// for it. `POST /agent` and the WebSocket beside it are already the bounded surface - one fixed
// program, a prompt as data, no command field - so this file is only a translator.
//
// AUTHENTICATION IS THE CLOUDFLARE ACCESS SERVICE TOKEN, read from the same two-line file `dsh.sh`
// uses. It is passed as headers, never as a URL parameter, so it does not land in request logs.
//
//   node remote-mcp.mjs          serve MCP over stdio
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// THE SDK IS RESOLVED FROM THE PROFILE, NOT FROM THIS DIRECTORY.
//
// This file lives in the repository, but `@modelcontextprotocol/sdk` and `zod` are installed by the
// harness into a profile - so a plain `import` fails with ERR_MODULE_NOT_FOUND, and NODE_PATH does not
// help because ESM ignores it. `createRequire` anchored at the profile resolves them the way the
// harness itself does, and it means this server adds no dependency to the repository.
const PROFILE_DIR = process.env.DSH_MCP_PROFILE ?? `${homedir()}/.dsh/profiles/dsh-tui`;
const requireFromProfile = createRequire(`${PROFILE_DIR}/`);
const { McpServer } = requireFromProfile("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = requireFromProfile("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = requireFromProfile("zod");

const BASE = process.env.DSH_URL ?? "https://dsh.alphaville.space";
const ACCESS_FILE = process.env.DSH_ACCESS_FILE ?? `${homedir()}/.dsh/access`;

/**
 * The Access service token, as headers.
 *
 * A missing file is reported as a tool-level failure rather than a crash: an MCP server that exits at
 * startup disappears from the harness with no explanation, and "the tools are gone" is a far worse
 * diagnostic than "the token file is not there".
 */
function accessHeaders() {
  try {
    const [id, secret] = readFileSync(ACCESS_FILE, "utf8").split("\n");
    if (!id?.trim() || !secret?.trim()) throw new Error("file has fewer than two non-empty lines");
    return { "CF-Access-Client-Id": id.trim(), "CF-Access-Client-Secret": secret.trim() };
  } catch (error) {
    throw new Error(
      `cannot read the Cloudflare Access service token from ${ACCESS_FILE}: ${error.message}`,
    );
  }
}

/** One prompt, one reply, over the streaming surface so a long turn is visible while it runs. */
function askRemote(prompt, onProgress) {
  const { WebSocket } = globalThis;
  return new Promise((resolve, reject) => {
    let headers;
    try {
      headers = accessHeaders();
    } catch (error) {
      reject(error);
      return;
    }

    const url = BASE.replace(/^http/, "ws") + "/agent";
    const socket = new WebSocket(url, { headers });
    let reply = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      fn(value);
    };

    socket.addEventListener("open", () => socket.send(JSON.stringify({ prompt })));

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "frame") {
        let frame;
        try {
          frame = JSON.parse(message.raw);
        } catch {
          return;
        }
        if (frame.type === "chunk") {
          reply += frame.text;
          onProgress?.(frame.text);
        } else if (frame.type === "error") {
          finish(reject, new Error(frame.message));
        }
        return;
      }
      if (message.type === "stderr") {
        // Reasoning and diagnostics. Forwarded as progress, never concatenated into the reply.
        onProgress?.(message.text, true);
        return;
      }
      if (message.type === "error") {
        finish(reject, new Error(message.message));
        return;
      }
      if (message.type === "exit") {
        const text = reply.trim();
        if (message.exitCode === 0 && text) finish(resolve, text);
        else {
          finish(
            reject,
            new Error(
              `the remote turn exited ${message.exitCode} without a reply` +
                (message.stderr ? `: ${message.stderr.slice(-400)}` : ""),
            ),
          );
        }
      }
    });

    socket.addEventListener("error", () => finish(reject, new Error(`could not reach ${url}`)));
    socket.addEventListener("close", (event) => {
      // A close without an exit frame means the socket died mid-turn; the reply so far is a prefix,
      // and returning a prefix as an answer is worse than reporting the loss.
      finish(reject, new Error(`the socket closed before the turn finished (code ${event.code})`));
    });
  });
}

const server = new McpServer({ name: "remote-dsh", version: "1.0.0" });

server.registerTool(
  "ask",
  {
    title: "Ask the remote dsh environment",
    description:
      "Send one prompt to the remote dsh environment and return its reply. The environment is a " +
      "persistent workspace with bash, git and a model; it is where development happens. One prompt " +
      "per call, and the reply is the assistant's final message. A turn that edits a repository, " +
      "runs tests and pushes can take several minutes.",
    inputSchema: { prompt: z.string().min(1).describe("The instruction for the remote session.") },
  },
  async ({ prompt }) => {
    try {
      const text = await askRemote(prompt);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `remote dsh: ${error.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "status",
  {
    title: "Remote dsh status",
    description:
      "Report the remote environment's routes and liveness. Use it to check the environment is " +
      "reachable before sending work; /healthz deliberately does not start the container.",
    inputSchema: {},
  },
  async () => {
    try {
      const headers = accessHeaders();
      const [health, routes] = await Promise.all([
        fetch(`${BASE}/healthz`, { headers, signal: AbortSignal.timeout(20_000) }),
        fetch(`${BASE}/`, { headers, signal: AbortSignal.timeout(20_000) }),
      ]);
      return {
        content: [
          {
            type: "text",
            text:
              `healthz: HTTP ${health.status} ${(await health.text()).slice(0, 200)}\n` +
              `routes:  HTTP ${routes.status} ${(await routes.text()).slice(0, 600)}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `remote dsh: ${error.message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
