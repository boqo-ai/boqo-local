import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, lineParser } from "../src/agent/adapters.mjs";
import { createRelay, systemPrompt } from "../src/agent/relay.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "relay");
const events = (name, adapter) => {
  const out = [];
  lineParser((o) => out.push(...adapter.parse(o)))(fs.readFileSync(path.join(FIX, name), "utf8"));
  return out;
};

test("Claude Code: session from init, streamed text, cost from the result", () => {
  const ev = events("claude.jsonl", ADAPTERS.claude);
  assert.equal(ev.filter((e) => e.kind === "session").length, 1);
  assert.equal(ev.filter((e) => e.kind === "delta").map((e) => e.text).join(""), "ok");
  const done = ev.find((e) => e.kind === "done");
  assert.equal(done.text, "ok");
  assert.ok(done.costUsd > 0);
  assert.equal(done.error, null);
});

test("Codex: thread id, the message, the end of the turn", () => {
  const ev = events("codex.jsonl", ADAPTERS.codex);
  assert.equal(ev[0].kind, "session");
  assert.equal(ev.find((e) => e.kind === "text").text, "ok");
  assert.ok(ev.some((e) => e.kind === "done"));
});

test("Cursor: session, text, result", () => {
  const ev = events("cursor.jsonl", ADAPTERS.cursor);
  assert.equal(ev[0].kind, "session");
  assert.equal(ev.find((e) => e.kind === "done").text, "ok");
});

test("args: Claude resumes by id and gets the allowed tools; Codex and Cursor put the context in the first message only", () => {
  const c1 = ADAPTERS.claude.args({ prompt: "hi", sessionId: "s1", resume: false, system: "ctx", allowedTools: ["Read", "Bash(node:*)"] });
  assert.deepEqual(c1.slice(c1.indexOf("--session-id"), c1.indexOf("--session-id") + 2), ["--session-id", "s1"]);
  assert.ok(c1.includes("--append-system-prompt") && c1.includes("Bash(node:*)"));
  const c2 = ADAPTERS.claude.args({ prompt: "hi", sessionId: "s1", resume: true });
  assert.ok(c2.includes("--resume"));
  const x1 = ADAPTERS.codex.args({ prompt: "hi", resume: false, system: "ctx" });
  assert.equal(x1.at(-1), "ctx\n\nhi");
  const x2 = ADAPTERS.codex.args({ prompt: "hi", sessionId: "t1", resume: true, system: "ctx" });
  assert.deepEqual(x2.slice(0, 3), ["exec", "resume", "t1"]);
  assert.equal(x2.at(-1), "hi");
  const u = ADAPTERS.cursor.args({ prompt: "hi", resume: false, force: false });
  assert.ok(u.includes("--trust") && !u.includes("--force"));
});

test("a junk line in the stream is skipped, not fatal", () => {
  const got = [];
  const feed = lineParser((o) => got.push(o));
  feed('{"a":1}\nnot json\n{"b":');
  feed("2}\n");
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});

// The stand-in agent is a POSIX shell script; on Windows the relay refuses script shims by design.
test("the relay runs a turn end to end, keeps the session, and resumes it", { skip: process.platform === "win32" && "needs a POSIX stand-in for the agent" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-relay-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-bin-"));
  // A stand-in for `claude` that prints the recorded stream and the arguments it was given.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" > "${bin}/args.txt"\ncat "${path.join(FIX, "claude.jsonl")}"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const seen = [];
  const relay = createRelay({ home, localDir: path.join(home, "local"), bus: { emit: (m) => seen.push(m) }, settings: () => ({ agent: "claude", allowedTools: ["Read"] }) });
  try {
    const turn = () => new Promise((resolve) => {
      const r = relay.send("run-x", "hello", { runDir: "/home/a/run", title: "T", label: "T" });
      assert.equal(r.ok, true);
      const iv = setInterval(() => { if (!relay.busy()) { clearInterval(iv); resolve(); } }, 20);
    });
    await turn();
    const end = seen.find((m) => m.event?.kind === "end");
    assert.equal(end.event.text, "ok");
    const t = relay.readThread("run-x");
    assert.deepEqual(t.messages.map((m) => m.role), ["you", "agent"]);
    assert.ok(t.sessionId);
    assert.match(fs.readFileSync(path.join(bin, "args.txt"), "utf8"), /--session-id/);
    await turn();
    assert.match(fs.readFileSync(path.join(bin, "args.txt"), "utf8"), /--resume/);
    assert.equal(relay.readThread("run-x").messages.length, 4);
    assert.equal(relay.readThread("../etc"), null);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("the standing instructions name the run and the clip", () => {
  const s = systemPrompt("/h", { runDir: "/h/boqo-clips/runs/r1", title: "Bakery", clip: { rank: 2, title: "Oven", start: 240, end: 282, file: "/h/x.mp4" } });
  assert.match(s, /runs\/r1/);
  assert.match(s, /#2 "Oven"/);
  assert.match(s, /240s to 282s/);
});
