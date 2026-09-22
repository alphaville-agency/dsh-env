#!/usr/bin/env node
// Attach a terminal on your Mac to the dsh workspace in the cloud.
//
// The transport is the Sandbox terminal WebSocket. Binary frames carry terminal I/O; JSON text
// frames carry control, and a resize is a control frame. There is no polling anywhere in here: the
// WebSocket upgrade is an ordinary request to the Worker, so the sandbox wakes when this connects
// and stops `sleepAfter` after it disconnects.
//
// One client holds the input lease; every other attached client is live and read-only. That decision
// is made server-side (src/lease-do.ts), and this file's whole job is to make the resulting state
// impossible to misread: a read-only window says so, loudly, and every keystroke in it is answered
// rather than silently dropped.
//
// The names below mirror src/names.ts. They are spelled out rather than imported because this file
// is fetched and run on the operator's machine, where nothing from src/ exists.

import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL_URL = process.env.DSH_TERMINAL_URL ?? "wss://dsh.alphaville.space/ws/terminal";

// What the PTY runs once it is attached and correctly sized. `exec` replaces the login shell with
// the TUI, so there is no shell left hanging underneath it. Set DSH_COMMAND to an empty string for
// a bare shell. It is sent once per *fresh* terminal, never into one that is already running.
const COMMAND = process.env.DSH_COMMAND ?? "exec dsh";

const CLIENT_PARAM = "client";
const TAKEOVER_PARAM = "takeover";
const TAKEOVER_SET = "1";
const ENV_TAKEOVER = "DSH_TAKEOVER";
const TAKEOVER_FLAG = "--takeover";
const CLIENT_ID_FILE = ".dsh-client-id";

const MSG_READY = "ready";
const MSG_READONLY = "readonly";
const MSG_LOST = "lost";
const MSG_RESIZE = "resize";
const MSG_COMMAND = "command";
const MSG_EXIT = "exit";
const MSG_ERROR = "error";

const TYPE_FIELD = "type";
const DATA_FIELD = "data";
const HOLDER_FIELD = "holder";
const HINT_FIELD = "hint";
const FRESH_FIELD = "fresh";

const ETX = "\u0003";
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;
const NAG_INTERVAL_MS = 5000;
const RULE = "─".repeat(74);

if (typeof WebSocket !== "function") {
  console.error("this client needs Node's built-in WebSocket (Node 22 or newer)");
  process.exit(1);
}

const stdin = process.stdin;
const stdout = process.stdout;

// Where this file was fetched to. The identity is persisted beside `dsh.sh` in that directory, so a
// reconnect from the same install is recognisable as the same client.
const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ID_FILE = join(CLIENT_DIR, CLIENT_ID_FILE);
const TAKEOVER_COMMAND = `${ENV_TAKEOVER}=1 sh '${join(CLIENT_DIR, "dsh.sh")}'`;

function persistedId() {
  try {
    const stored = readFileSync(ID_FILE, "utf8").trim();
    if (stored) return stored;
  } catch {
    // No identity yet: this is the first run from this directory.
  }
  const minted = randomBytes(8).toString("hex");
  try {
    writeFileSync(ID_FILE, `${minted}\n`, { mode: 0o600 });
  } catch {
    // A read-only install directory just means a per-run identity; the lease still works.
  }
  return minted;
}

/**
 * One identity per terminal, not per machine: /dev/fd/0 names the tty, so two windows are two
 * clients and a reconnect from one window is the same client. Without this, opening a second window
 * would look like the first one reconnecting and silently take the lease instead of being read-only.
 */
function terminalName() {
  try {
    return basename(readlinkSync("/dev/fd/0"));
  } catch {
    return "unknown";
  }
}

const CLIENT_ID = process.env.DSH_CLIENT_ID || `${persistedId()}-${terminalName()}`;
const TAKEOVER =
  process.env[ENV_TAKEOVER] === TAKEOVER_SET || process.argv.includes(TAKEOVER_FLAG);

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

// A notice about the lease, drawn above whatever the TUI is doing. It goes to stderr so it is never
// mistaken for terminal output.
function notice(lines) {
  process.stderr.write(`\n${RULE}\n${lines.map((line) => `  ${line}`).join("\n")}\n${RULE}\n\n`);
}

// Printed once, while the container is being prepared, and only if the terminal has not come up
// within a couple of seconds. A warm container never sees it; a first run does, and it is the
// difference between "this is installing" and "this is hung".
const FIRST_RUN_HINT_MS = 2500;

function firstRunNotice() {
  const timer = setTimeout(() => {
    if (ready) return;
    process.stderr.write(
      "\r\n[waking the workspace: mounting state, then installing the harness CLI and the TUI\r\n" +
        " profile into it if this is the first run. One time only; a warm start skips it.]\r\n",
    );
  }, FIRST_RUN_HINT_MS);
  timer.unref?.();
}

const target = new URL(TERMINAL_URL);
target.searchParams.set(CLIENT_PARAM, CLIENT_ID);
if (TAKEOVER) target.searchParams.set(TAKEOVER_PARAM, TAKEOVER_SET);

const socket = new WebSocket(target);
socket.binaryType = "arraybuffer";

// `ready` means "you hold the input lease". `readonly` means "you are attached and live, and nothing
// you type is sent". They arrive once the server has the upstream terminal, and again if it drops
// and comes back, so both handlers are written to be repeatable.
let ready = false;
let readOnly = false;
let holder = null;
let lastNag = 0;
// What has already been announced, so a repeated role frame (the server re-announces after the
// terminal drops and comes back) does not reprint the banner, but a *changed* one always does.
let announced = null;
const held = [];

function send(data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

function sendResize() {
  send(JSON.stringify({ [TYPE_FIELD]: MSG_RESIZE, ...size() }));
}

function nag() {
  const now = Date.now();
  if (now - lastNag < NAG_INTERVAL_MS) return;
  lastNag = now;
  process.stderr.write(
    holder
      ? `\r\n[read-only: ${holder} holds the input lease; nothing you type is sent]\r\n`
      : `\r\n[read-only: nobody holds the input lease; reconnect to take it]\r\n`,
  );
}

socket.addEventListener("open", () => {
  // Raw mode is kept on even while read-only. Cooked mode would echo keystrokes locally and hold
  // them in the line discipline, which is exactly the silent discard this feature must never do -
  // and it would deliver them all at once if the lease were ever granted. Instead every keypress in
  // read-only mode gets an answer (see nag()), and Ctrl-C is handled here rather than forwarded.
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  if (TAKEOVER) process.stderr.write("[taking over the input lease]\n");
  // A fresh container prepares itself before the terminal opens (mount, install, clone), and on the
  // very first run that is a real one-time install. Say so once, instead of leaving a blank window
  // that looks hung; stderr because it is commentary, not terminal output.
  firstRunNotice();
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

  if (message[TYPE_FIELD] === MSG_READY) {
    const taking = announced === "readonly";
    readOnly = false;
    holder = CLIENT_ID;
    announced = "ready";
    // Order matters: the PTY has to be the real size before the TUI draws, or it renders at 80x24.
    // The socket is ordered, so the resize is handled before the command that follows it.
    sendResize();
    // The command only ever goes into a terminal this connection created. Sent into one that is
    // already running it would be typed into the TUI as input, which is worse than a bare shell.
    if (message[FRESH_FIELD] === true) send(`${COMMAND}\n`);
    if (taking) notice(["input is yours now - this window may type."]);
    ready = true;
    for (const chunk of held.splice(0)) send(chunk);
    return;
  }

  if (message[TYPE_FIELD] === MSG_READONLY) {
    const next = message[HOLDER_FIELD] ?? null;
    const changed = announced !== "readonly" || holder !== next;
    readOnly = true;
    holder = next;
    announced = "readonly";
    // Anything held from before the role was known is dropped, not sent later: keystrokes typed at
    // a read-only window must never be delivered if that window is granted the lease afterwards.
    held.length = 0;
    ready = true;
    if (!changed) return;
    notice(
      holder
        ? [
            "READ-ONLY. Another client holds the input lease:",
            `  ${holder}`,
            "",
            "You are watching live output. Nothing you type is sent.",
            "To take over - and drop the other client to read-only - run:",
            "",
            `  ${TAKEOVER_COMMAND}`,
          ]
        : [
            "READ-ONLY. Nobody holds the input lease right now.",
            "To take it, run:",
            "",
            `  ${TAKEOVER_COMMAND}`,
          ],
    );
    return;
  }

  if (message[TYPE_FIELD] === MSG_LOST) {
    // Immediately, on the socket that is still open: the old holder must never be left typing.
    readOnly = true;
    holder = message[HOLDER_FIELD] ?? null;
    announced = "lost";
    held.length = 0;
    notice([
      "YOU LOST THE INPUT LEASE. Another client took over:",
      `  ${holder ?? "another client"}`,
      "",
      "This window is read-only now. Nothing you type is sent.",
      `Take it back with:  ${TAKEOVER_COMMAND}`,
    ]);
    return;
  }

  if (message[TYPE_FIELD] === MSG_EXIT) {
    restore();
    process.stderr.write(`\n[workspace terminal exited: ${message.code}]\n`);
    process.exit(typeof message.code === "number" ? message.code : 0);
  } else if (message[TYPE_FIELD] === MSG_ERROR) {
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
  if (readOnly) {
    // Ctrl-C is the way out of a read-only window: raw mode means the terminal will not do it for
    // us, and there is no remote shell to receive it.
    if (chunk.toString() === ETX) {
      restore();
      process.stderr.write(`\n[read-only; left the session]\n`);
      process.exit(0);
    }
    nag();
    return;
  }
  if (!ready) {
    held.push(chunk);
    return;
  }
  send(chunk);
});

// Node emits `resize` on stdout when the window changes; the PTY has to hear about it or the TUI
// keeps drawing at the old width. An observer stays quiet: the PTY is shared, so its size belongs
// to whoever holds the lease.
stdout.on("resize", () => {
  if (!readOnly) sendResize();
});
