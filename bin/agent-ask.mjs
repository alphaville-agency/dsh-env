#!/usr/bin/env node
// One prompt in, one reply out — the bounded thing the Worker's agent route runs.
//
// WHY HEADLESS AND NOT ACP, WHICH IS WHAT THIS USED TO BE. `dsh --profile acp` was chosen because its
// provider is an ordinary config row rather than a gated adapter, and it did serve sessions from this
// laptop. In the container it does not: `session/new` is accepted and then no frame arrives for
// minutes, while the TUI over the same settings, provider and session store answers normally. The TUI
// answering is the evidence that matters — the model route and agent creation both work inside this
// container, so the stall is the ACP application's, and chasing it is not what this surface is for.
//
// `dsh --profile headless "task"` is the harness's own one-shot: it answers one task, streams its
// reasoning to STDERR, prints the final assistant message to STDOUT and exits. There is no protocol
// to speak and no client to keep alive, which is exactly the shape of a control surface that must not
// be able to hang on a handshake.
//
// THE PROMPT NEVER TOUCHES A SHELL. It is read from `AGENT_PROMPT_FILE` and passed to `dsh` as a
// single argv element, so a prompt containing `$(...)`, backticks or quotes is data and not code. The
// previous version was handed to the Worker as a JSON string interpolated into a shell command line,
// where `$(...)` inside double quotes is command substitution — an injection on a route that exists
// precisely so that no request field can reach argv.
//
//   AGENT_PROMPT_FILE=/tmp/p.txt node agent-ask.mjs
//
// With `AGENT_ASK_STREAM=1` stdout becomes newline-delimited JSON frames instead of a bare reply, so
// the WebSocket route can forward progress; the two modes never mix.
//
// Exits 0 with the reply, non-zero with the reason on stderr. No retry loop: a failed call is a
// result to report.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PROMPT_FILE = process.env.AGENT_PROMPT_FILE ?? "";
// The argv form is kept for local use and for tests; the Worker always uses the file, so no request
// data is ever placed on a command line.
const prompt = (
  PROMPT_FILE ? (() => {
    try {
      return readFileSync(PROMPT_FILE, "utf8");
    } catch {
      return "";
    }
  })() : process.argv.slice(2).join(" ")
).trim();

if (!prompt) {
  process.stderr.write("usage: AGENT_PROMPT_FILE=<file> node agent-ask.mjs  (or pass the prompt as argv)\n");
  process.exit(2);
}

const STREAMING = process.env.AGENT_ASK_STREAM === "1";
const PROFILE = process.env.AGENT_PROFILE ?? "headless";
const cwd = process.env.AGENT_CWD ?? process.cwd();

// Named `emit`, not `frame`, because the stdout reader below binds a local `frame` and would shadow it.
const emit = (value) => {
  if (STREAMING) process.stdout.write(JSON.stringify(value) + "\n");
};

// Bounded, because this runs inside a request that already has a deadline.
// Inactivity, not duration: a turn that is still printing is still working. The Worker passes its own
// budget minus a margin, so the script gives up just before the route's own timeout does.
const DEADLINE_MS = Number(process.env.AGENT_ASK_TIMEOUT_MS ?? 240_000);

const child = spawn("dsh", ["--profile", PROFILE, prompt], {
  cwd,
  // stderr is PIPED rather than inherited, for the reason below.
  stdio: ["ignore", "pipe", "pipe"],
});

let reply = "";
let lastOutputAt = Date.now();

child.stdout.on("data", (chunk) => {
  lastOutputAt = Date.now();
  const text = chunk.toString();
  reply += text;
  emit({ type: "chunk", text });
});

// STDERR IS ACTIVITY, AND TREATING IT AS SILENCE COST A WHOLE TURN.
//
// The watchdog used to watch stdout only, and `dsh --profile headless` prints the reply to stdout but
// streams its REASONING AND EVERY TOOL CALL to stderr. A working turn therefore looked like a dead one:
// measured on the first real goal turn, the session was 35 reasoning lines deep, reading the
// repository and checking credentials, and was killed at 110s with
// `[no output for 110000ms, giving up]` - nothing wrong with the turn, only with what was being
// watched. stderr is forwarded to our own stderr so it stays a diagnostic rather than becoming part
// of the reply, and it now counts as the process being alive.
child.stderr.on("data", (chunk) => {
  lastOutputAt = Date.now();
  process.stderr.write(chunk);
});

let done = false;
let lastError = null;

function finish(code) {
  if (done) return;
  done = true;
  const text = reply.trim();
  if (STREAMING) {
    // `done` repeats the whole reply so a consumer that joined late still ends with the full answer.
    emit(
      code === 0 && text
        ? { type: "done", stopReason: "end_turn", text }
        : { type: "error", message: lastError ?? `no reply (exit ${code})` },
    );
  } else if (code === 0 && text) {
    process.stdout.write(text + "\n");
  }
  process.exit(code);
}

child.on("error", (error) => {
  lastError = `spawn: ${error.message}`;
  process.stderr.write(`[spawn: ${error.message}]\n`);
  finish(1);
});

child.on("exit", (code) => {
  if (code === 0 && reply.trim()) {
    finish(0);
    return;
  }
  if (!lastError) lastError = `dsh --profile ${PROFILE} exited ${code} without a reply`;
  finish(code === 0 ? 1 : code ?? 1);
});

const watchdog = setInterval(() => {
  if (Date.now() - lastOutputAt > DEADLINE_MS) {
    process.stderr.write(`[no output for ${DEADLINE_MS}ms, giving up]\n`);
    lastError = `no output for ${DEADLINE_MS}ms`;
    child.kill("SIGKILL");
    clearInterval(watchdog);
    finish(1);
  }
}, 2000);
