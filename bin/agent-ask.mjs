#!/usr/bin/env node
// One prompt over ACP, one reply on stdout — the bounded thing POST /agent runs.
//
// WHY NOT A FLAG ON `dsh --profile acp`. That profile SERVES until the client disconnects; there is
// no --ask, and there cannot be one, because the protocol is a conversation: initialize, then
// session/new, then session/prompt, each answering before the next makes sense. So the three calls
// live here, in the shape the ACP README documents, and this script ends on `end_turn`.
//
// STDOUT IS ONLY THE REPLY. The Worker parses this line and nothing else, so a stray log on stdout
// would be read as an answer — which is why everything diagnostic goes to stderr.
//
//   node agent-ask.mjs "the prompt"
//
// Exits 0 with the reply, non-zero with the reason on stderr. No retry loop: a failed call is a
// result to report, not something to paper over by asking twice.
import { spawn } from "node:child_process";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  process.stderr.write("usage: agent-ask.mjs <prompt>\n");
  process.exit(2);
}
// Bounded, because this runs inside an HTTP request that already has a deadline.
const DEADLINE_MS = Number(process.env.AGENT_ASK_TIMEOUT_MS ?? 110_000);

const child = spawn("dsh", ["--profile", process.env.AGENT_PROFILE ?? "acp"], {
  cwd: process.env.AGENT_CWD ?? process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],   // stderr inherits: diagnostics never touch stdout
});

let buffer = "";
let sessionId = null;
let reply = "";
let stopReason = null;
let id = 1;
const pending = new Map();
let lastFrameAt = Date.now();

const send = (method, params) => {
  const thisId = id++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: thisId, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(thisId, { resolve, reject, method }));
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }   // a non-frame line is not an answer
    lastFrameAt = Date.now();
    if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve, reject, method } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
      else resolve(frame.result);
      continue;
    }
    const update = frame?.params?.update;
    if (!update) continue;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      reply += update.content.text;
    }
    if (update.sessionUpdate === "usage_update") {
      process.stderr.write(`[usage ${update.used}/${update.size}]\n`);
    }
  }
});

child.on("exit", (code) => {
  // EOF or an exit with the reply in hand is the normal end; a bare exit is a failure to report.
  if (reply && !stopReason) { finish(0); return; }
  finish(code === 0 && reply ? 0 : 1);
});
child.on("error", (e) => { process.stderr.write(`[spawn: ${e.message}]\n`); finish(1); });

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  if (code === 0 && reply) process.stdout.write(reply.trim() + "\n");
  process.exit(code);
}

const watchdog = setInterval(() => {
  if (Date.now() - lastFrameAt > DEADLINE_MS) {
    process.stderr.write(`[no frames for ${DEADLINE_MS}ms, giving up]\n`);
    child.kill("SIGKILL");
    clearInterval(watchdog);
    finish(1);
  }
}, 2000);

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const created = await send("session/new", {
    cwd: process.env.AGENT_CWD ?? process.cwd(),
    mcpServers: [],
  });
  sessionId = created.sessionId;
  process.stderr.write(`[session ${sessionId}]\n`);
  const result = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  stopReason = result?.stopReason ?? "unknown";
  process.stderr.write(`[stop ${stopReason}]\n`);
  clearInterval(watchdog);
  // `end_turn` is the model having answered. Anything else — max_tokens, refusal, error — is not a
  // reply, and reporting it as one would let a truncated answer look like a complete one.
  finish(stopReason === "end_turn" && reply ? 0 : 1);
} catch (e) {
  process.stderr.write(`[error: ${e.message}]\n`);
  clearInterval(watchdog);
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  finish(1);
}
