#!/usr/bin/env node
// Attach a terminal on your laptop to the dsh workspace in the cloud.
//
// The transport is the Sandbox terminal WebSocket. Binary frames carry terminal I/O; JSON text
// frames carry control, and a resize is a control frame. This is the protocol the SDK's own
// `@cloudflare/sandbox/xterm` addon speaks, so a mismatch here would be a mismatch with the platform
// rather than with a convention of ours.
//
// THE TOKEN IS REQUIRED AND IS SENT AS A HEADER. `wrangler secret` cannot read a value back, so
// `dsh.sh` mints one, writes it to the Worker with `wrangler secret put`, and exports it here as
// DSH_TOKEN. Node's built-in WebSocket takes a headers option (verified: the upgrade request carries
// it), so the token travels as `Authorization: Bearer ...` and never in a query string, where it
// would land in request logs.
//
// There is no input lease and no read-only mode. Those existed to arbitrate between several attached
// clients, and they went with the lease Durable Object they depended on: the workspace is a singleton
// and a new session rotates the token instead. The names below mirror src/names.ts; they are spelled
// out rather than imported because this file runs on the laptop, where nothing from src/ exists.

const TERMINAL_URL = process.env.DSH_TERMINAL_URL ?? "wss://dsh.alphaville.space/ws/terminal";
const TOKEN = process.env.DSH_TOKEN ?? "";
const SHELL = process.env.DSH_SHELL ?? "";
const SHELL_PARAM = "shell";

const MSG_READY = "ready";
const MSG_RESIZE = "resize";
const MSG_EXIT = "exit";
const MSG_ERROR = "error";
const TYPE_FIELD = "type";

const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;
const WAKE_HINT_MS = 2500;

if (typeof WebSocket !== "function") {
  console.error("this client needs Node's built-in WebSocket (Node 22 or newer)");
  process.exit(1);
}
if (TOKEN === "") {
  console.error(
    "DSH_TOKEN is not set. Run this through dsh.sh, which mints a token and writes it to the Worker.",
  );
  process.exit(1);
}

const stdin = process.stdin;
const stdout = process.stdout;

// A terminal left in raw mode is a bricked shell, so restoring it is the one thing that must happen
// on every way out: normal exit, any signal, and a crash.
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    // A terminal that has already gone away cannot be restored, and that is not an error.
  }
  try {
    stdin.pause();
  } catch {
    // Same.
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(0);
  });
}
process.on("uncaughtException", (error) => {
  restore();
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  restore();
  console.error(error);
  process.exit(1);
});
process.on("exit", restore);

const size = () => ({
  cols: stdout.columns || FALLBACK_COLS,
  rows: stdout.rows || FALLBACK_ROWS,
});

const target = new URL(TERMINAL_URL);
if (SHELL !== "") target.searchParams.set(SHELL_PARAM, SHELL);

// The token goes in a header, not the URL.
const socket = new WebSocket(target, { headers: { Authorization: `Bearer ${TOKEN}` } });
socket.binaryType = "arraybuffer";

let ready = false;

// Printed once if the terminal has not come up quickly. A cold container is a real wait - the
// platform is starting an instance - and a blank window that looks hung is the difference between
// "this is starting" and "this is broken".
function wakeNotice() {
  const timer = setTimeout(() => {
    if (ready) return;
    process.stderr.write(
      "\r\n[waking the workspace: the container is starting, and it sleeps when nobody is\r\n" +
        " connected. This takes a few seconds cold, and is instant while it is warm.]\r\n",
    );
  }, WAKE_HINT_MS);
  timer.unref?.();
}

socket.addEventListener("open", () => {
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  wakeNotice();
});

socket.addEventListener("message", (event) => {
  // Binary frames are terminal output, including ANSI escapes. Write them through untouched.
  if (typeof event.data !== "string") {
    stdout.write(Buffer.from(event.data));
    return;
  }

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message[TYPE_FIELD] === MSG_READY) {
    // The PTY must be the real size before the TUI draws, or it renders at 80x24.
    send(JSON.stringify({ [TYPE_FIELD]: MSG_RESIZE, ...size() }));
    ready = true;
    return;
  }

  if (message[TYPE_FIELD] === MSG_EXIT) {
    restore();
    process.stderr.write(`\n[the workspace terminal exited: ${message.code}]\n`);
    process.exit(typeof message.code === "number" ? message.code : 0);
  }

  if (message[TYPE_FIELD] === MSG_ERROR) {
    process.stderr.write(`\n[workspace terminal error: ${message.message}]\n`);
  }
});

socket.addEventListener("close", () => {
  restore();
  process.stderr.write("\n[disconnected - the session is still there; run ./dsh.sh again]\n");
  process.exit(0);
});

socket.addEventListener("error", () => {
  restore();
  process.stderr.write(
    `\n[could not reach ${TERMINAL_URL}]\n` +
      "[a 401 here means the token the Worker holds has rotated; run ./dsh.sh to mint a new one]\n",
  );
  process.exit(1);
});

function send(data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

stdin.on("data", (chunk) => {
  if (!ready) {
    // Keystrokes before the PTY is ready would be delivered out of order with the initial resize,
    // and the resize is what makes the TUI render correctly. Dropping a few early keystrokes is
    // better than corrupting the first frame; the window is milliseconds.
    return;
  }
  send(chunk);
});

// Node emits `resize` on stdout when the window changes; the PTY has to hear about it or the TUI
// keeps drawing at the old width.
stdout.on("resize", () => {
  send(JSON.stringify({ [TYPE_FIELD]: MSG_RESIZE, ...size() }));
});