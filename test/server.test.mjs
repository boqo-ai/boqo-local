import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeHome } from "./helpers/home.mjs";
import { startServer } from "../src/server.mjs";
import { resolveMedia } from "../src/security.mjs";

let home, srv, ids;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-local-srv-"));
  ids = makeHome(home);
  srv = await startServer({ home, ports: [0], log: () => {}, idleExit: false });
});
after(async () => { await srv.close(); });

/** A raw request, so the Host and Origin headers are exactly what a hostile page could send. */
function req(method, p, { host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, method, path: p, headers: { Host: host ?? `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test("the page carries the token and strict headers", async () => {
  const r = await req("GET", "/");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(srv.token));
  assert.match(r.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("another host name is refused (DNS rebinding)", async () => {
  assert.equal((await req("GET", "/api/feed", { host: `evil.example:${srv.port}` })).status, 403);
  assert.equal((await req("GET", "/", { host: "127.0.0.1:1" })).status, 403);
  assert.equal((await req("GET", "/api/feed", { host: `localhost:${srv.port}` })).status, 200);
});

test("writes need the token and this server's own origin", async () => {
  const body = { run: ids.doneName, n: [11] };
  assert.equal((await req("POST", "/api/job", { body, headers: { "Content-Type": "application/json" } })).status, 403);
  assert.equal((await req("POST", "/api/job", { body, headers: { "X-Boqo-Token": "wrong", "Content-Type": "application/json" } })).status, 403);
  assert.equal((await req("POST", "/api/job", { body, headers: { "X-Boqo-Token": srv.token, Origin: "https://evil.example" } })).status, 403);
  const ok = await req("POST", "/api/thread-stop", { body: {}, headers: { "X-Boqo-Token": srv.token, Origin: `http://127.0.0.1:${srv.port}` } });
  assert.equal(ok.status, 200);
});

test("media: clips and stills only, never JSON with signed URLs, never outside the home", async () => {
  const run = `boqo-clips/runs/${ids.doneName}`;
  assert.equal((await req("GET", `/media?p=${encodeURIComponent(`${run}/out/clip-01.jpg`)}`)).status, 200);
  for (const bad of [`${run}/upload-01.json`, `${run}/info.json`, `${run}/clips.json`, "../../etc/passwd", `${run}/../../../../etc/hosts.jpg`, "/etc/hosts", ".ssh/id.jpg"]) {
    assert.equal((await req("GET", `/media?p=${encodeURIComponent(bad)}`)).status, 404, bad);
  }
});

test("media refuses a symlink that leads out of the home", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-outside-"));
  fs.writeFileSync(path.join(outside, "secret.jpg"), "x");
  try {
    fs.symlinkSync(path.join(outside, "secret.jpg"), path.join(home, "link.jpg"));
  } catch (err) {
    if (err.code === "EPERM") return t.skip("this Windows account can't create symlinks");
    throw err;
  }
  assert.equal(resolveMedia(home, "link.jpg"), null);
});

test("video seeks: a Range request gets 206", async () => {
  const p = encodeURIComponent(`boqo-clips/runs/${ids.doneName}/out/clip-01.mp4`);
  const r = await req("GET", `/media?p=${p}`, { headers: { Range: "bytes=0-1" } });
  assert.equal(r.status, 206);
  assert.match(r.headers["content-range"], /^bytes 0-1\/\d+$/);
});

test("the JSON the page reads", async () => {
  const feed = JSON.parse((await req("GET", "/api/feed")).body);
  assert.equal(feed.items.length, 4);
  const run = JSON.parse((await req("GET", `/api/run/${encodeURIComponent(ids.doneName)}`)).body);
  assert.equal(run.clips.length, 14);
  assert.ok(!JSON.stringify(run).includes("SECRET"));
  assert.ok(!JSON.stringify(feed).includes("SECRET"));
  assert.equal((await req("GET", "/api/run/..%2F..%2Fetc")).status, 404);
  const watch = JSON.parse((await req("GET", `/api/watch/${ids.watchId}`)).body);
  assert.equal(watch.channel, "nova_plays");
});

test("an oversized body gets 413 and the request ends (#2)", async () => {
  const big = { text: "x".repeat(70_000) };
  const r = await req("POST", "/api/thread/home", { body: big, headers: { "X-Boqo-Token": srv.token, "Content-Type": "application/json" } }).catch((e) => ({ status: e.code }));
  assert.ok(r.status === 413 || r.status === "ECONNRESET" || r.status === "EPIPE", String(r.status));
  assert.equal((await req("GET", "/api/feed")).status, 200);
});

// A regression here crashes the server inside the test process; the timeout makes that a failure, not a hang.
test("a media file that can't be read doesn't stop the server (#2)", { timeout: 10_000, skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const rel = `boqo-clips/runs/${ids.doneName}/out/clip-03.mp4`;
  fs.chmodSync(path.join(home, rel), 0o000); // passes the check, then fails to open
  try {
    await req("GET", `/media?p=${encodeURIComponent(rel)}`).catch(() => null);
    assert.equal((await req("GET", "/api/feed")).status, 200);
  } finally {
    fs.chmodSync(path.join(home, rel), 0o644);
  }
});

test("server.json records where it runs, without the token", () => {
  const sj = JSON.parse(fs.readFileSync(path.join(home, "local", "server.json"), "utf8"));
  assert.equal(sj.port, srv.port);
  assert.equal(sj.token, undefined);
  assert.ok(!fs.readFileSync(path.join(home, "local", "server.json"), "utf8").includes(srv.token));
});
