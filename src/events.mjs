// A tiny event bus fanned out to the page over Server-Sent Events, plus a watcher that
// turns file changes in the boqo home into one debounced "changed" event.
import fs from "node:fs";
import path from "node:path";

export function createBus() {
  const clients = new Set();
  return {
    clients,
    emit(msg) {
      const data = `data: ${JSON.stringify(msg)}\n\n`;
      for (const res of clients) res.write(data);
    },
    attach(req, res) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
    },
  };
}

/**
 * Watch the home for changes. fs.watch is recursive on macOS and Windows, and on Linux from
 * Node 20; a slow poll of top-level mtimes backs it up where watching is unavailable.
 * The app's own folder (`local/`) is ignored so chat logs don't wake the page.
 */
export function watchHome(home, onChange, { debounceMs = 400, pollMs = 5000 } = {}) {
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, debounceMs); };
  let watcher = null;
  try {
    watcher = fs.watch(home, { recursive: true }, (_ev, file) => {
      if (!file) return fire();
      const f = String(file).split(path.sep)[0];
      if (f === "local" || String(file).endsWith(".tmp")) return;
      fire();
    });
    watcher.on("error", () => {});
  } catch { /* home missing or no recursive watch: the poll covers it */ }
  // Poll only when watching failed: walking a home with many runs every few seconds is not free.
  let last = "", poll = null;
  if (!watcher) {
    poll = setInterval(() => {
      const sig = signature(home);
      if (last && sig !== last) fire();
      last = sig;
    }, pollMs);
  }
  return () => { if (poll) clearInterval(poll); clearTimeout(timer); watcher?.close(); };
}

function signature(home) {
  const parts = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "local") continue;
      const p = path.join(dir, e.name);
      try { parts.push(`${p}:${fs.statSync(p).mtimeMs}`); } catch { /* gone */ }
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
    }
  };
  walk(home, 0);
  return parts.join("|");
}
