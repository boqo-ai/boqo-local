// The local server: 127.0.0.1 only, one per computer, serves the page, the readers'
// JSON, allowlisted media, a Server-Sent Events stream, and two write endpoints
// (the chat, local render jobs), each behind the session token.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDir as localDirOf, ensureDir, readJson, writeJson } from "./home.mjs";
import { newToken, hostAllowed, originAllowed, tokenMatches, SECURITY_HEADERS, resolveMedia } from "./security.mjs";
import { createBus, watchHome } from "./events.mjs";
import { createRelay, detectAgent } from "./agent/relay.mjs";
import { createJobs } from "./actions/jobs.mjs";
import * as store from "./store/index.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = { "/app.js": "text/javascript", "/app.css": "text/css", "/morph.js": "text/javascript", "/icon.svg": "image/svg+xml" };
export const PORTS = [4177, 4178, 4179, 4180, 4181, 4182, 4183, 4184, 4185, 4186];
const IDLE_MS = 30 * 60 * 1000;

const MAX_BODY = 64_000;
const DEFAULT_SETTINGS = {
  // What Claude Code may do without asking, since nobody is there to click Allow:
  // read files, run the skills' node tools and ffmpeg/yt-dlp, and boqo's MCP tools.
  allowedTools: ["Read", "Glob", "Grep", "Bash(node:*)", "Bash(ffmpeg:*)", "Bash(ffprobe:*)", "Bash(yt-dlp:*)", "Bash(mkdir:*)", "Bash(ls:*)", "Bash(date:*)", "mcp__boqo"],
};

export async function startServer({ home, ports = PORTS, log = console.log, idleExit = true } = {}) {
  const local = ensureDir(localDirOf(home));
  const token = newToken();
  const bus = createBus();
  const settingsFile = path.join(local, "settings.json");
  const agent = detectAgent();
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(readJson(settingsFile) ?? {}) });

  const relay = createRelay({ home, localDir: local, bus, settings, log });
  const jobs = createJobs({ home, bus, log });
  let lastSeen = Date.now();

  const send = (res, code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };
  /** The JSON body, null when it isn't JSON, or TOO_BIG; it always settles, even when the client goes away. */
  const TOO_BIG = Symbol("too big");
  const readBody = (req) => new Promise((resolve) => {
    let b = "", done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    req.setEncoding("utf8");
    req.on("data", (c) => { b += c; if (b.length > MAX_BODY) { settle(TOO_BIG); req.pause(); } });
    req.on("end", () => { try { settle(JSON.parse(b || "{}")); } catch { settle(null); } });
    req.on("error", () => settle(null));
    req.on("close", () => settle(null));
  });

  let port = 0;
  const server = http.createServer(async (req, res) => {
    lastSeen = Date.now();
    if (!hostAllowed(req.headers.host, port)) return send(res, 403, { error: "host" });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    if (req.method === "POST") {
      if (!originAllowed(req.headers.origin, port) || !tokenMatches(req.headers["x-boqo-token"], token)) return send(res, 403, { error: "token" });
      const body = await readBody(req);
      if (body === TOO_BIG) { res.setHeader("Connection", "close"); return send(res, 413, { error: "too big" }); }
      if (!body) return send(res, 400, { error: "json" });
      try {
        let m;
        if ((m = p.match(/^\/api\/thread\/([\w-]+)$/))) {
          if (typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: "text" });
          const r = relay.send(m[1], body.text.trim().slice(0, 4000), store.chatContext(home, body.context));
          return send(res, r.error ? 409 : 200, r);
        }
        if (p === "/api/thread-stop") return send(res, 200, { stopped: relay.stop() });
        if (p === "/api/job") {
          const r = jobs.add(store.resolveJob(home, body));
          return send(res, r.error ? 400 : 200, r);
        }
      } catch (err) {
        log(`POST ${p} failed: ${err.message}`);
        return send(res, 500, { error: "server" });
      }
      return send(res, 404, { error: "not found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method" });

    try {
      if (p === "/" || /^\/(r|w|p)\//.test(p) || p === "/brands") return sendIndex(res, token);
      if (STATIC[p]) return send(res, 200, fs.readFileSync(path.join(PUBLIC, p.slice(1))), STATIC[p]);
      if (p === "/api/events") return bus.attach(req, res);
      if (p === "/api/feed") return send(res, 200, store.feed(home));
      if (p.startsWith("/api/run/")) { const r = store.run(home, decodeURIComponent(p.slice(9))); return send(res, r ? 200 : 404, r ?? { error: "not found" }); }
      if (p.startsWith("/api/watch/")) { const r = store.watch(home, decodeURIComponent(p.slice(11))); return send(res, r ? 200 : 404, r ?? { error: "not found" }); }
      if (p === "/api/brands") return send(res, 200, store.brands(home));
      if (p.startsWith("/api/thread/")) { const t = relay.readThread(p.slice(12)); return send(res, t ? 200 : 400, t ?? { error: "bad thread" }); }
      if (p === "/api/state") return send(res, 200, { home, settings: publicSettings(), jobs: jobs.list(), busy: relay.busyInfo() });
      if (p === "/media") return sendMedia(req, res, home, url.searchParams.get("p"));
    } catch (err) {
      log(`GET ${p} failed: ${err.message}`);
      return send(res, 500, { error: "server" });
    }
    return send(res, 404, { error: "not found" });
  });

  function publicSettings() {
    return { agent };
  }

  port = await listenOnFirstFree(server, ports);
  const url = `http://127.0.0.1:${port}`;
  const stopWatch = watchHome(home, () => bus.emit({ type: "changed" }));
  writeJson(path.join(local, "server.json"), { port, pid: process.pid, url, startedAt: new Date().toISOString() });

  let idleTimer = null;
  if (idleExit) {
    idleTimer = setInterval(() => {
      const idle = bus.clients.size === 0 && !relay.busy() && !jobs.busy() && Date.now() - lastSeen > IDLE_MS;
      if (idle) { log("idle for 30 minutes, stopping"); close().then(() => process.exit(0)); }
    }, 60_000);
  }

  async function close() {
    clearInterval(idleTimer);
    stopWatch();
    relay.stop();
    for (const c of bus.clients) c.end();
    try { const sj = readJson(path.join(local, "server.json")); if (sj?.pid === process.pid) fs.rmSync(path.join(local, "server.json")); } catch { /* fine */ }
    await new Promise((r) => server.close(r));
  }

  return { url, port, token, close, bus };
}

function sendIndex(res, token) {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8").replace("__TOKEN__", token);
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

/** Media with Range support, so <video> can seek. */
function sendMedia(req, res, home, rel) {
  const m = resolveMedia(home, rel);
  if (!m) { res.writeHead(404, SECURITY_HEADERS); return res.end(); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const head = { ...SECURITY_HEADERS, "Content-Type": m.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60" };
  if (range) {
    let start = range[1] ? Number(range[1]) : m.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : m.size - 1;
    if (!(start >= 0 && end < m.size && start <= end)) { res.writeHead(416, { ...head, "Content-Range": `bytes */${m.size}` }); return res.end(); }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${m.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return stream(m.file, res, { start, end });
  }
  res.writeHead(200, { ...head, "Content-Length": m.size });
  if (req.method === "HEAD") return res.end();
  stream(m.file, res);
}

/**
 * Pipe a file, surviving a read error: the file can vanish or be replaced between the check
 * and the read (the skill's cleanup, a re-render). An unhandled stream error would stop the
 * whole server.
 */
function stream(file, res, range) {
  const rs = fs.createReadStream(file, range);
  rs.on("error", () => res.destroy());
  res.on("close", () => rs.destroy());
  rs.pipe(res);
}

function listenOnFirstFree(server, ports) {
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= ports.length) return reject(new Error(`ports ${ports[0]}–${ports.at(-1)} are all busy`));
      server.once("error", (err) => (err.code === "EADDRINUSE" ? tryAt(i + 1) : reject(err)));
      server.listen(ports[i], "127.0.0.1", () => resolve(server.address().port));
    };
    tryAt(0);
  });
}
