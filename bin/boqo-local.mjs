#!/usr/bin/env node
// boqo-local start | stop | status | open
//   start [--foreground] [--no-open]   start the dashboard (once per computer) and open it
//   stop                               stop it
//   status                             print its address, or "not running"
//   open                               open it in the browser, starting it if needed
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boqoHome, localDir, readJson } from "../src/home.mjs";

const args = process.argv.slice(2);
const cmd = args[0] ?? "start";
const flag = (f) => args.includes(f);
const home = boqoHome();
const serverFile = path.join(localDir(home), "server.json");

function running() {
  const s = readJson(serverFile);
  if (!s?.pid) return null;
  try { process.kill(s.pid, 0); return s; } catch { return null; }
}

function openBrowser(url) {
  const [bin, a] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(bin, a, { stdio: "ignore", detached: true }).unref(); } catch { /* print the address instead */ }
}

async function waitForServer(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = running();
    if (s?.url) return s;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function start({ open }) {
  const already = running();
  if (already) { console.log(`boqo is already running at ${already.url}`); if (open) openBrowser(already.url); return; }
  if (flag("--foreground")) {
    const { startServer } = await import("../src/server.mjs");
    const s = await startServer({ home, log: (m) => console.log(`[boqo] ${m}`) });
    console.log(`boqo is running at ${s.url} (reading ${home})`);
    if (open) openBrowser(s.url);
    const quit = () => s.close().then(() => process.exit(0));
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
    return;
  }
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, "start", "--foreground", "--no-open"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const s = await waitForServer();
  if (!s) { console.error("boqo didn't start. Run `boqo-local start --foreground` to see why."); process.exit(1); }
  console.log(`boqo is running at ${s.url}`);
  if (open) openBrowser(s.url);
}

if (cmd === "start") await start({ open: !flag("--no-open") });
else if (cmd === "open") await start({ open: true });
else if (cmd === "status") { const s = running(); console.log(s ? `running at ${s.url} (pid ${s.pid})` : "not running"); }
else if (cmd === "stop") {
  const s = running();
  if (!s) console.log("not running");
  else { process.kill(s.pid, "SIGTERM"); console.log("stopped"); }
} else {
  console.log("usage: boqo-local start|stop|status|open [--foreground] [--no-open]");
  process.exit(2);
}
