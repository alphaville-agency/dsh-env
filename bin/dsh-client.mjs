#!/usr/bin/env node
// Attach a terminal on your Mac to the dsh workspace in the cloud.
//
// The transport is the Sandbox terminal WebSocket. Binary frames carry terminal I/O; JSON text
// frames carry control (`ready`, `exit`, `error`), and a resize is a control frame. There is no
// polling anywhere in here: the WebSocket upgrade is an ordinary request to the Worker, so the
// sandbox wakes when this connects and stops `sleepAfter` after it disconnects.

const TERMINAL_URL = process.env.DSH_TERMINAL_URL ?? "wss://dev-dsh.alphaville.space/ws/terminal";

// What the PTY runs once it is attached and correctly sized. `exec` replaces the login shell with
// the TUI, so there is no shell left hanging underneath it. Set DSH_COMMAND to an empty string for
// a bare shell.
const COMMAND = process.env.DSH_COMMAND ?? "exec dsh";

// A TUI drawn at the wrong width is unreadable, so these are only a fallback for a non-TTY stdout.
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

if (typeof WebSocket !== "function") {
  console.error("this client needs Node's built-in WebSocket (Node 22 or newer)");
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

const socket = new WebSocket(TERMINAL_URL);
socket.binaryType = "arraybuffer";

// Keystrokes typed before the server is ready are held, not dropped: the terminal only accepts
// input after `ready`.
let ready = false;
const held = [];

function send(data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

function sendResize() {
  send(JSON.stringify({ type: "resize", ...size() }));
}

socket.addEventListener("open", () => {
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
});

socket.addEventListener("message", (event) => {
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

  if (message.type === "ready") {
    // Order matters: the PTY has to be the real size before the TUI draws, or it renders at 80x24.
    // The socket is ordered, so the resize is handled before the command that follows it.
    sendResize();
    if (COMMAND) send(`${COMMAND}\n`);
    ready = true;
    for (const chunk of held.splice(0)) send(chunk);
  } else if (message.type === "exit") {
    restore();
    process.stderr.write(`\n[workspace terminal exited: ${message.code}]\n`);
    process.exit(typeof message.code === "number" ? message.code : 0);
  } else if (message.type === "error") {
    process.stderr.write(`\n[workspace terminal error: ${message.message}]\n`);
  }
});

socket.addEventListener("close", () => {
  restore();
  process.stderr.write("\n[disconnected - the session is still there, run ./dsh.sh again]\n");
  process.exit(0);
});

socket.addEventListener("error", () => {
  restore();
  process.stderr.write(`\n[could not reach ${TERMINAL_URL}]\n`);
  process.exit(1);
});

stdin.on("data", (chunk) => {
  if (!ready) {
    held.push(chunk);
    return;
  }
  send(chunk);
});

// Node emits `resize` on stdout when the window changes; the PTY has to hear about it or the TUI
// keeps drawing at the old width.
stdout.on("resize", sendResize);