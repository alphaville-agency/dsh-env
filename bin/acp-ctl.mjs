#!/usr/bin/env node
// acp-ctl — drive a dsh session over the Agent Client Protocol, on our own gateway route.
//
// WHY ACP AND NOT THE OTHER TWO. Three control surfaces exist in the harness and each was tested
// before this one was written:
//
//   * `dsh-sdk-jsonrpc-server`  mounts and answers `initialize`, but gates the provider through
//     hasAdapterFor(), which accepts only registered adapters plus `deepseek-official`. Our pi-ai
//     route `cf-ai-gateway` is rejected outright: "no adapter registered for provider". Its Config
//     has one field (maxTokensAsSuccess) and no provider override, so nothing in configuration can
//     get past it. That is a hard limit of the plugin, not a misconfiguration.
//   * the TTY                  works — typing while the TUI runs reaches the model — but reading a
//     reply means scraping ANSI out of a screen that redraws constantly, and my own input came back
//     looking like the model's answer. Several rounds went into telling the two apart.
//   * ACP (`dsh-acp`)           is an ordinary insert entry with provider/model in its config, so it
//     patches to our route like any other row, and it speaks JSON-RPC on stdout. It streams
//     `session/update` frames with the assistant's text and reports `stopReason`. This is the one.
//
//   node acp-ctl.mjs ask "reply with exactly: ok"     one prompt, print the reply, exit
//   node acp-ctl.mjs shell                            long-lived: prompt on stdin, stream updates
//
// The session profile is `acp` (built from dsh-tui plus the acp-app bundle), so this is the same
// model route, the same settings, and the same persistence root the TUI uses — not a parallel
// agent that would diverge from what an operator sees.
import { spawn } from "node:child_process";

const PROFILE = process.env.DSH_ACP_PROFILE ?? "acp";

/** Start the ACP server and complete the `initialize` handshake. */
function connect({ cwd = process.cwd() } = {}) {
  const child = spawn("dsh", ["--profile", PROFILE], { cwd, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  const listeners = [];
  const pending = new Map();
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    // Frames are newline-delimited JSON and a chunk may split one, so the buffer stays whole until
    // a delimiter arrives — parsing a half frame would silently drop the first reply.
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id !== undefined && pending.has(frame.id)) {
        const { resolve, reject } = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) reject(new Error(`${frame.error.message} ${JSON.stringify(frame.error.data ?? {})}`));
        else resolve(frame.result);
      } else {
        for (const fn of listeners) fn(frame);
      }
    }
  });

  const on = (fn) => listeners.push(fn);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 180_000);
  });

  return { child, on, request };
}

/**
 * Run one prompt to completion, collecting the assistant's text.
 *
 * ACP streams the answer as `agent_message_chunk` updates and finishes with a `stopReason` on the
 * prompt response. Waiting for `end_turn` (or any stop) is what makes this a completion rather than
 * a fire-and-forget: a reply that arrives after we stop reading is a reply nobody saw.
 */
async function ask(text, { cwd, onUpdate } = {}) {
  const { child, on, request } = connect({ cwd });
  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const { sessionId } = await request("session/new", { cwd: cwd ?? process.cwd(), mcpServers: [] });

    let reply = "";
    let stopped = null;
    on((frame) => {
      const u = frame?.params?.update;
      if (!u) return;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        reply += u.content.text;
        onUpdate?.(u.content.text);
      }
      if (u.sessionUpdate === "usage_update") onUpdate?.(`\n[usage ${u.used}/${u.size}]\n`);
    });

    const result = await request("session/prompt", {
      sessionId,
      // ACP prompt is a BLOCK ARRAY, not a string. Sending a string is rejected with
      // "Invalid input: expected array" — the shape is part of the protocol, not a convenience.
      prompt: [{ type: "text", text }],
    });
    return { sessionId, reply, stopReason: result?.stopReason ?? null };
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "ask") {
    const out = await ask(rest.join(" "));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === "shell") {
    process.stderr.write(`[acp: profile ${PROFILE}, type a prompt and press enter]\n`);
    const { child, on, request } = connect({ cwd: process.cwd() });
    await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const { sessionId } = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
    process.stderr.write(`[session ${sessionId}]\n`);
    on((f) => { const u = f?.params?.update; if (u?.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content?.text ?? ""); if (u?.sessionUpdate === "turn_end") process.stdout.write("\n---\n"); });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", async (line) => {
      const text = line.trim();
      if (!text) return;
      try { await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }); }
      catch (e) { process.stderr.write(`\n[prompt failed: ${e.message}]\n`); }
    });
    return;
  }
  throw new Error("usage: acp-ctl.mjs <ask <text> | shell>");
}

if (process.argv[1]) {
  main().catch((e) => { console.error(`acp-ctl: ${e.message}`); process.exit(1); });
}

export { ask, connect };
