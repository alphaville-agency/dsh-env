#!/usr/bin/env node
// dsh-ctl — drive a running dsh session over its own JSON-RPC surface.
//
// WHY THIS EXISTS. Nurturing the remote session meant opening its PTY and scraping ANSI out of it,
// and that failed in a specific way: the TUI echoes whatever is typed, so my own input came back to
// me looking like the model's answer, and a reply was indistinguishable from an echo. Several rounds
// went into that with nothing to show for it. This plugin is the surface the harness already ships
// for exactly this job - newline-delimited JSON-RPC on stdout, one agent per sessionId, prompts
// queued with `session/prompt`, every fact streamed back as `session.event`.
//
//   node bin/dsh-ctl.mjs prompt  "do this thing"
//   node bin/dsh-ctl.mjs watch    [sessionId]      stream events until idle
//   node bin/dsh-ctl.mjs hello                     handshake only, proves the surface works
//
// It is a CLIENT of the remote session: the control profile mounts the server inside the container,
// and this process connects to it. It never owns the model route - the profile does - so the
// session this drives is the same one the TUI shows.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.DSH_CONTROL_PROFILE ?? "control";
const SESSION = process.env.DSH_CONTROL_SESSION ?? "agency";

/** Everything the runtime says, in order, so a failure shows the sequence and not just the tail. */
const seen = [];

function start() {
  // The control profile boots the harness with the jsonrpc plugin mounted. Stdout is the protocol,
  // which is why nothing is ever written to it here: one stray log line and every frame after it is
  // unparseable. Diagnostics go to stderr, mirroring the plugin's own rule.
  const args = ["--profile", PROFILE];
  const child = spawn("dsh", args, { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    // Frames are newline-delimited JSON. A chunk may hold a partial frame, so the buffer stays
    // whole until a delimiter arrives rather than parsing what may be half a message.
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line), child);
      } catch {
        seen.push({ kind: "unparseable", line: line.slice(0, 200) });
      }
    }
  });
  return child;
}

let nextId = 1;
const pending = new Map();

function request(child, method, params = {}) {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  child.stdin.write(frame);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    // The handshake is the runtime-readiness boundary. A prompt sent before it completes is
    // rejected outright by the server, so waiting has to be patient rather than instant.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 120_000);
  });
}

function onMessage(msg, child) {
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message ?? "error"} (${msg.error.code ?? ""})`));
    else resolve(msg.result);
    return;
  }
  // Server notifications: session.event, session.status, session/created.
  seen.push(msg);
  if (msg.method === "session.event") {
    const p = msg.params ?? {};
    const text = p.message?.text ?? p.delta ?? p.text ?? "";
    if (text) process.stderr.write(String(text));
    if (p.type === "turn/end" || p.type === "agent/status") process.stderr.write("\n");
  }
  if (msg.method === "session.status") {
    process.stderr.write(`\n[status ${JSON.stringify(msg.params)}]\n`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const child = start();

  const hello = await request(child, "initialize", {
    sessionId: SESSION,
    protocolVersion: 1,
    clientInfo: { name: "dsh-ctl", version: "0.1.0" },
  }).catch(async (e) => {
    process.stderr.write(`\n[initialize failed: ${e.message}]\n`);
    // Some builds want the params shape without sessionId; retry once rather than dying on a guess.
    return request(child, "initialize", {});
  });
  seen.push({ kind: "initialize", hello });
  process.stderr.write(`[initialized ${SESSION}]\n`);

  if (cmd === "hello") {
    console.log(JSON.stringify({ ok: true, session: SESSION }, null, 2));
    child.kill(0);
    return;
  }

  if (cmd === "prompt") {
    const text = rest.join(" ");
    if (!text) throw new Error("prompt needs text");
    const { messageId } = await request(child, "session/prompt", { sessionId: SESSION, text });
    process.stderr.write(`\n[queued ${messageId}]\n`);
    // Then drain: the plugin does not assign an assistant message to a prompt, so completion is
    // observed through events. Wait for the run to go quiet, then report what happened.
    await drain(90_000);
    report();
    child.kill(0);
    return;
  }

  if (cmd === "watch") {
    await drain(Number(rest[0]) || 120_000);
    report();
    child.kill(0);
    return;
  }

  throw new Error("usage: dsh-ctl.mjs <prompt <text>|watch [ms]|hello>");
}

/** Wait until no event has arrived for `quiet` ms — an idle session, not a fixed sleep. */
function drain(quiet = 90_000) {
  return new Promise((resolve) => {
    let last = Date.now();
    const mark = () => { last = Date.now(); };
    seen.push({ kind: "drain-start", at: new Date().toISOString() });
    const timer = setInterval(() => {
      if (Date.now() - last > quiet || Date.now() - last > 600_000) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
    // mark events as they land
    const orig = onMessage;
    void orig;
    const watcher = setInterval(() => {
      if (seen.length > 0) mark();
    }, 500);
    setTimeout(() => clearInterval(watcher), 600_000);
  });
}

function report() {
  const events = seen.filter((m) => m?.method === "session.event");
  const statuses = seen.filter((m) => m?.method === "session.status");
  console.log(JSON.stringify({
    frames: seen.length,
    events: events.length,
    statuses: statuses.slice(-5),
    tail: seen.slice(-3).map((m) => m?.method ?? m?.kind ?? "?"),
  }, null, 2));
}

main().catch((e) => {
  console.error(`dsh-ctl: ${e.message}`);
  process.exit(1);
});
