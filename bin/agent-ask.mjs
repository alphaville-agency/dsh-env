#!/usr/bin/env node
// One prompt over ACP, one reply on stdout — the bounded thing POST /agent runs.
//
// WHY RESUME AND NOT `session/new`. Each call boots its own `dsh --profile acp` process, so the
// handshake is cheap but a fresh session pays full composition on every request; measured cold, that
// was a client-side 150 s timeout before a single token moved. A session that is already persisted
// RESUMES instead: measured on this machine, `session/resume` answers in 708 ms against a
// `session/new` that could not be timed at all, because resume skips composition and restores the
// log rather than rebuilding it. The reply then arrives in a normal model turn — 5.4 s for a
// one-line answer. So the sessionId is kept on disk (one file, the whole argument) and reused until
// the server says it is gone, at which point falling back to `session/new` is the correct thing
// rather than a failure.
//
// WHY NOT A FLAG ON `dsh --profile acp`. That profile SERVES until the client disconnects; there is
// no --ask, and there cannot be one, because the protocol is a conversation: initialize, then
// resume-or-new, then session/prompt, each answering before the next makes sense. So the calls live
// here, in the shape the ACP README documents, and this script ends on `end_turn`.
//
// STDOUT IS ONLY THE REPLY. The Worker parses this line and nothing else, so a stray log on stdout
// would be read as an answer — which is why everything diagnostic goes to stderr.
//
//   node agent-ask.mjs "the prompt"
//
// WITH `AGENT_ASK_STREAM=1` STDOUT BECOMES NEWLINE-DELIMITED JSON INSTEAD. The reply is the last
// thing to exist in the buffered form, which made a streaming consumer wait for the whole turn to
// see anything at all. In stream mode each frame is one line - `session`, then one `chunk` per
// assistant text delta as ACP delivers it, then `done` or `error` - so a WebSocket can forward
// progress while the turn is still running. The two modes never mix: the Worker picks one and parses
// accordingly, because a stream of NDJSON read as a reply would return framing as an answer.
//
// Exits 0 with the reply, non-zero with the reason on stderr. No retry loop: a failed call is a
// result to report, not something to paper over by asking twice. The one exception is a stale
// sessionId — resuming a session the server no longer has is not a failure of the prompt, so that
// single case falls back to a fresh session, once.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  process.stderr.write("usage: agent-ask.mjs <prompt>\n");
  process.exit(2);
}
// Bounded, because this runs inside an HTTP request that already has a deadline.
const DEADLINE_MS = Number(process.env.AGENT_ASK_TIMEOUT_MS ?? 110_000);
const cwd = process.env.AGENT_CWD ?? process.cwd();
const STREAMING = process.env.AGENT_ASK_STREAM === "1";
// One file is the whole of the client-side state: the id of the session to resume next time. It
// lives beside the sessions it names so it is on the same store, and a container whose disk was
// cleared simply finds nothing there and makes a new session — which is the intended reset.
const SESSION_FILE = process.env.AGENT_SESSION_FILE ?? `${cwd}/.acp-agent-session`;

/**
 * One newline-delimited JSON frame on stdout, in stream mode only.
 *
 * NAMED `emit`, NOT `frame`, ON PURPOSE. The stdout reader below binds the parsed JSON of each line to
 * a local `frame`, and a `let frame` in that block shadows an outer `frame` for the whole block — so
 * calling the helper from inside the reader threw `TypeError: frame is not a function` on the first
 * assistant chunk, which is to say it failed at the exact moment there was a reply to stream.
 */
const emit = (value) => {
  if (STREAMING) process.stdout.write(JSON.stringify(value) + "\n");
};

const readSavedSession = () => {
  try { return readFileSync(SESSION_FILE, "utf8").trim() || null; } catch { return null; }
};
const saveSession = (id) => {
  try { writeFileSync(SESSION_FILE, id + "\n"); } catch { /* unwritable is not fatal: next call makes a new session */ }
};
const forgetSession = () => {
  try { unlinkSync(SESSION_FILE); } catch { /* absent is the state we wanted */ }
};

const child = spawn("dsh", ["--profile", process.env.AGENT_PROFILE ?? "acp"], {
  cwd,
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
      emit({ type: "chunk", text: update.content.text });
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
let lastError = null;
function finish(code) {
  if (done) return;
  done = true;
  if (STREAMING) {
    // `done` repeats the whole reply even though `chunk` frames already carried it, so a consumer
    // that joined late or missed a frame still ends with the complete answer rather than a prefix.
    emit(
      code === 0 && reply
        ? { type: "done", stopReason, text: reply.trim() }
        : { type: "error", message: lastError ?? `no reply (stopReason ${stopReason ?? "unknown"})` },
    );
  } else if (code === 0 && reply) {
    process.stdout.write(reply.trim() + "\n");
  }
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

/**
 * Resume the saved session, or make one.
 *
 * A resume that is rejected — the session was deleted, or its cwd moved — is a stale id, not a
 * broken prompt, so the id is dropped and a fresh session takes its place. Everything else is left
 * alone: a resume refused for any other reason is reported, because guessing would hide it.
 */
async function openSession() {
  const saved = readSavedSession();
  if (saved) {
    try {
      await send("session/resume", { sessionId: saved, cwd, mcpServers: [] });
      process.stderr.write(`[resumed ${saved}]\n`);
      emit({ type: "session", sessionId: saved, resumed: true });
      return saved;
    } catch (e) {
      process.stderr.write(`[resume of ${saved} refused: ${e.message}; making a new session]\n`);
      forgetSession();
    }
  }
  const created = await send("session/new", { cwd, mcpServers: [] });
  saveSession(created.sessionId);
  process.stderr.write(`[session ${created.sessionId}]\n`);
  emit({ type: "session", sessionId: created.sessionId, resumed: false });
  return created.sessionId;
}

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  sessionId = await openSession();
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
  lastError = e.message;
  process.stderr.write(`[error: ${e.message}]\n`);
  clearInterval(watchdog);
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  finish(1);
}
