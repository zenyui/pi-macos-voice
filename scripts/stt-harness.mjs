#!/usr/bin/env node
// End-to-end STT socket test: create a unix socket, launch Swyft.app with
// --socket, print received NDJSON, forward "stop" on SIGINT.
//
//   node scripts/stt-harness.mjs        # listens ~30s, speak into the mic
//
// This exercises the exact bridge the pi extension will use.

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "bin/Swyft.app");
const sockPath = `/tmp/swyft-stt-${process.pid}.sock`;

if (existsSync(sockPath)) unlinkSync(sockPath);

let conn = null;

const server = createServer((socket) => {
  conn = socket;
  console.error("[harness] Swyft.app connected");
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        console.log("[stt]", msg);
      } catch {
        console.log("[stt raw]", line);
      }
    }
  });
  socket.on("close", () => console.error("[harness] app disconnected"));
});

server.listen(sockPath, () => {
  console.error(`[harness] listening on ${sockPath}, launching Swyft.app...`);
  const child = spawn("open", ["-n", app, "--args", "stt", "--socket", sockPath], {
    stdio: "inherit",
  });
  child.on("error", (e) => console.error("[harness] open failed:", e.message));
});

function shutdown() {
  console.error("\n[harness] stopping...");
  if (conn) conn.write("stop\n");
  setTimeout(() => {
    try { server.close(); } catch {}
    if (existsSync(sockPath)) unlinkSync(sockPath);
    process.exit(0);
  }, 300);
}

process.on("SIGINT", shutdown);
setTimeout(shutdown, 30_000); // auto-stop after 30s
console.error("[harness] speak into the mic (Ctrl+C or 30s to stop)");
