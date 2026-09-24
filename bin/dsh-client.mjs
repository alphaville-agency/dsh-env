#!/usr/bin/env node
// Attach a terminal on your laptop to the dsh workspace in the cloud.
//
// The transport is the Sandbox terminal WebSocket. Binary frames carry terminal I/O; JSON text
// frames carry control, and a resize is a control frame. This is the protocol the SDK's own
// `@cloudflare/sandbox/xterm` addon speaks, so a mismatch here would be a mismatch with the platform
// rather than with a convention of ours.
//
// AUTHENTICATION IS CLOUDFLARE ACCESS, and these two headers are the whole of it.
//
// The hostname sits behind an Access application with a service-token policy, so the edge refuses
// anything that does not present a token and this client never sees an unauthenticated request get
// through. That is why there is no bearer token here any more: the Worker used to compare one of its
// own, which Cloudflare will not let anyone read back, so `dsh.sh` had to WRITE it on every session
// with an authenticated `wrangler` - a dependency that failed the first time it met a wrangler that
// was not v4. A service token is a credential the client can simply hold.
//
// Node's built-in WebSocket takes a headers option (verified: the upgrade request carries them).
//
// THE SHELL IS NOT CHOSEN HERE. The session's shell is fixed server-side, because the session is
// stable and shared: letting a client pick one means the first client to connect decides for
// everyone, which is how a probe left a bash session where the TUI should have been.
//
// There is no input lease and no read-only mode. Those existed to arbitrate between several attached
// clients, and they went with the lease Durable Object they depended on: the workspace is a singleton
// and a new session rotates the token instead. The names below mirror src/names.ts; they are spelled
// out rather than imported because this file runs on the laptop, where nothing from src/ exists.

const TERMINAL_URL = process.env.DSH_TERMINAL_URL ?? "wss://dsh.alphaville.space/ws/terminal";
const ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID ?? "";
const ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? "";

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
if (ACCESS_CLIENT_ID === "" || ACCESS_CLIENT_SECRET === "") {
  console.error(
    "the Cloudflare Access service token is not set. Run this through dsh.sh, which reads it from " +
      "the environment and stops here if it is missing.",
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

// Sent as headers, never in the URL, where a credential would land in request logs.
const socket = new WebSocket(target, {
  headers: {
    "CF-Access-Client-Id": ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": ACCESS_CLIENT_SECRET,
  },
});
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
      "[a 403 here means the Access service token is missing, expired or not in the policy]\n",
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