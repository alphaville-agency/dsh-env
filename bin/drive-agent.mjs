import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [id, secret] = readFileSync(process.env.HOME + "/.dsh/access", "utf8").split("\n");
const prompt = readFileSync(process.argv[2], "utf8");

// THE SAME HEAD THE MCP SERVER WRITES. One file, one name, whoever is driving.
const HEAD = process.env.ALPHAVILLE_HEAD ?? process.env.DSH_LIVE_LOG ?? "/tmp/alphaville-loop-head.log";
const live = (text, err = false) => {
  const stamp = new Date().toISOString().slice(11, 19);
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { appendFileSync(HEAD, `[${stamp}] ${err ? "· " : ""}${line}\n`); } catch { /* unwritable is not fatal */ }
  }
};
const t = Date.now(); const el = () => ((Date.now() - t) / 1000).toFixed(0) + "s";
const ws = new WebSocket("wss://dsh.alphaville.space/agent", {
  headers: { "CF-Access-Client-Id": id.trim(), "CF-Access-Client-Secret": secret.trim() },
});
let done = false;
const finish = (m) => { if (done) return; done = true; console.log(`\n[${m} @ ${el()}]`); try{ws.close()}catch{}; setTimeout(()=>process.exit(0),150); };
ws.onopen = () => { console.log(`[open ${el()}]`); ws.send(JSON.stringify({ prompt })); };
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "started") return console.log(`[started ${el()}]`);
  if (m.type === "stderr") { live(m.text, true); return process.stderr.write(`[${el()}] ${m.text}`); }
  if (m.type === "exit") { console.log(`\n[exit ${el()}] code=${m.exitCode}`); if (m.stderr) console.log("STDERR TAIL:\n" + m.stderr); return finish("exit"); }
  if (m.type === "error") { console.log(`[error ${el()}] ${m.message}`); return finish("error"); }
  if (m.type === "frame") { try { const f = JSON.parse(m.raw); if (f.type === "chunk") { live(f.text); process.stdout.write(f.text); } else console.log("\n" + m.raw); } catch { console.log("[raw] " + m.raw); } }
};
ws.onerror = () => finish("socket error");
ws.onclose = (e) => finish("closed " + e.code);
setTimeout(() => finish("timeout 1500s"), 1500000);
