import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHome } from "./helpers/home.mjs";
import * as store from "../src/store/index.mjs";
import { readRun, runSteps } from "../src/store/clips.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "boqo-local-test-"));

test("My Work lists every request, newest first", () => {
  const home = tmp();
  makeHome(home);
  const { items } = store.feed(home);
  assert.deepEqual(items.map((i) => i.kind).sort(), ["clips", "clips", "plan", "watch"]);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].startedAt >= items[i].startedAt);
});

test("a finished run: clips in order, band computed, the best five as stills, posts counted from runs.md", () => {
  const home = tmp();
  const { doneName } = makeHome(home);
  const r = readRun(home, doneName);
  assert.equal(r.done, true);
  assert.equal(r.total, 14);
  assert.equal(r.rendered, 10);
  assert.equal(r.posted, 3);
  assert.equal(r.title, "Opening a Bakery With No Money");
  assert.deepEqual(r.top.map((c) => c.score), [91, 88, 86, 85, 84]);
  assert.equal(r.top[0].band, "Exceptional");
  assert.match(r.top[0].thumb, /^boqo-clips\/runs\/.+\/out\/clip-01\.jpg$/);
});

test("a run in progress: the step is read from its files", () => {
  const home = tmp();
  const { workName } = makeHome(home);
  const r = readRun(home, workName);
  assert.equal(r.done, false);
  const now = r.steps.find((s) => s.state === "now");
  assert.equal(now.key, "pick");
  assert.equal(now.who, "agent");
  assert.equal(now.detail, "reading the transcript");
  assert.equal(r.title, "Knife Skills in Ten Minutes");
});

test("rendering: the render step is current with its progress, then judging", () => {
  const home = tmp();
  const { done } = makeHome(home, { rendered: 4 });
  const rec = JSON.parse(fs.readFileSync(path.join(done, "clips.json"), "utf8"));
  let { steps } = runSteps(done, rec, rec.clips.map((c) => ({ rendered: c.rendered, judgment: c.judgment?.overall ?? null })));
  const render = steps.find((s) => s.key === "render");
  assert.equal(render.state, "now");
  assert.equal(render.detail, "4 of 10");
  assert.equal(render.progress, 0.4);
  // all rendered, two not judged yet
  const rows = rec.clips.map((c, i) => ({ rendered: i < 10, judgment: i < 8 ? 3 : null }));
  ({ steps } = runSteps(done, rec, rows));
  assert.equal(steps.find((s) => s.state === "now").key, "judge");
});

test("the run page never carries absolute file paths of clips, only media paths under the home", () => {
  const home = tmp();
  const { doneName } = makeHome(home);
  const r = store.run(home, doneName);
  assert.equal(r.clips.length, 14);
  for (const c of r.clips) {
    assert.equal(c.file, undefined);
    if (c.video) assert.ok(!path.isAbsolute(c.video));
  }
  assert.deepEqual(r.clips[0].grades, ["A", "B", "A", "B"]);
  assert.equal(r.clips[10].rendered, false);
  assert.equal(r.clips[10].judgment, null);
});

test("a live watch, and one whose watcher stopped answering", () => {
  const home = tmp();
  const { watchId, sess } = makeHome(home);
  let w = store.watch(home, watchId);
  assert.equal(w.live, true);
  assert.equal(w.channel, "nova_plays");
  assert.equal(w.clipped, 2);
  assert.equal(w.moments[0].title, "Three missed jumps in a row"); // newest first
  assert.equal(w.moments.find((m) => m.id === "m2").state, "below"); // 54, under the default auto-clip bar of 80
  const st = JSON.parse(fs.readFileSync(path.join(sess, "status.json"), "utf8"));
  st.updatedAt = new Date(Date.now() - 10 * 60000).toISOString();
  fs.writeFileSync(path.join(sess, "status.json"), JSON.stringify(st));
  w = store.watch(home, watchId);
  assert.equal(w.live, false);
  assert.equal(w.state, "lost");
});

test("the channel plan, sorted by time, posted ones marked", () => {
  const home = tmp();
  makeHome(home);
  const plan = store.feed(home).items.find((i) => i.kind === "plan");
  assert.equal(plan.items.length, 4);
  assert.equal(plan.items[0].state, "posted");
  assert.equal(plan.waiting, true);
  assert.equal(plan.posting, "ask");
  assert.deepEqual(plan.channels.sort(), ["@kitchenhours", "@longtablepod"]);
});

test("brand kits: v2 fields and the default", () => {
  const home = tmp();
  makeHome(home);
  const { kits, defaultKit } = store.brands(home);
  assert.equal(defaultKit, "longtable");
  assert.equal(kits[0].style, "punch");
  assert.equal(kits[0].accent, "#FF8A3D");
  assert.equal(kits[0].isDefault, true);
});

test("chat context and render jobs are built from ids, never from paths the page sends", () => {
  const home = tmp();
  const { doneName } = makeHome(home);
  const ctx = store.chatContext(home, { run: doneName, clip: 2 });
  assert.equal(ctx.clip.title, "The oven that almost sank us");
  assert.ok(ctx.runDir.startsWith(home));
  assert.equal(store.chatContext(home, { run: "../../etc" }), null);
  assert.equal(store.resolveJob(home, { run: "../x", n: [1] }).error, "run");
  assert.equal(store.resolveJob(home, { run: doneName, n: [99] }).error, "clips");
  assert.equal(store.resolveJob(home, { run: doneName, n: [1], style: "rm -rf" }).error, "style");
  const job = store.resolveJob(home, { run: doneName, n: [11, 12], style: "neon" });
  assert.deepEqual(job.ns, [11, 12]);
  assert.equal(job.kit, "longtable");
  assert.equal(job.style, "neon");
});

test("replayed: 'top N%' computed the way the engine shows it, never top 0%", () => {
  const home = tmp();
  const { doneName, done } = makeHome(home);
  const f = path.join(done, "clips.json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.clips[0].replay = { pct: 0.29, mean: 0.6 }; // a real value from a boqo-clips p0b run: the engine prints "top 71%"
  rec.clips[1].replay = { pct: 1, mean: 1 };
  rec.clips[2].replay = null;
  fs.writeFileSync(f, JSON.stringify(rec));
  const clips = store.run(home, doneName).clips;
  assert.equal(clips[0].replayTop, 71);
  assert.equal(clips[1].replayTop, 1);
  assert.equal(clips[2].replayTop, null);
});

// boqo-sniper v0.2.2 (lib/settings.mjs isAutoMoment, lib/buffer.mjs LISTED_KEEP_SEC, tools/next.mjs).
test("moment states: clipped, picking, waiting for the agent, below the bar (told and untold), and drops", () => {
  const home = tmp();
  const { watchId, sess } = makeHome(home);
  const meta = (id, score, signal = "chat") => {
    fs.mkdirSync(path.join(sess, "moments", id), { recursive: true });
    fs.writeFileSync(path.join(sess, "moments", id, "meta.json"), JSON.stringify({ peakAt: 0, score, signal, signalLine: "x", peakIso: new Date().toISOString() }));
  };
  meta("q1", 85); // at the bar, not yet taken: the agent gets it on its own
  meta("p1", 85); fs.writeFileSync(path.join(sess, "moments", "p1", ".taken"), "");
  meta("h1", 40, "manual"); // hand-made: always the agent's
  meta("b1", 60); // below the bar, not told yet
  meta("b2", 61); const told = path.join(sess, "moments", "b2", ".listed"); fs.writeFileSync(told, "");
  const toldAt = new Date(Date.now() - 5 * 60000); fs.utimesSync(told, toldAt, toldAt);
  const st = JSON.parse(fs.readFileSync(path.join(sess, "status.json"), "utf8"));
  fs.writeFileSync(path.join(sess, "status.json"), JSON.stringify({ ...st, dropped: 2 }));

  let w = store.watch(home, watchId);
  const by = (id) => w.moments.find((m) => m.id === id);
  assert.equal(by("q1").state, "queued");
  assert.equal(by("p1").state, "picking");
  assert.equal(by("h1").state, "queued");
  assert.equal(by("b1").state, "below");
  assert.equal(by("b1").keepUntil, null);
  assert.equal(by("b2").state, "below");
  assert.equal(Date.parse(by("b2").keepUntil) - Date.parse(by("b2").toldAt), 15 * 60000);
  assert.ok(Math.abs(Date.parse(by("b2").toldAt) - toldAt.getTime()) < 2000);
  assert.equal(by("m1").state, "clipped");
  assert.equal(w.dropped, 2);
  assert.equal(w.below, 3); // m2 (54), b1, b2

  // the session's own settings.json decides the bar: auto-clip off sends nothing to the agent on its own
  fs.writeFileSync(path.join(sess, "settings.json"), JSON.stringify({ autoClip: false, autoClipMinScore: 80 }));
  w = store.watch(home, watchId);
  assert.equal(by("q1").state, "below");
  assert.equal(by("h1").state, "queued"); // a hand-made moment still goes
  fs.writeFileSync(path.join(sess, "settings.json"), JSON.stringify({ autoClip: true, autoClipMinScore: 55 }));
  w = store.watch(home, watchId);
  assert.equal(by("b1").state, "queued");
  assert.equal(by("m2").state, "below"); // 54 < 55
});

// boqo-clips v0.2.2: render.json's run notes, and asr.json's "words": 0.
test("a run's own notes are read from render.json, and no speech stops the run without a stall", () => {
  const home = tmp();
  makeHome(home);
  const runs = path.join(home, "boqo-clips", "runs");
  const name = fs.readdirSync(runs).find((n) => fs.existsSync(path.join(runs, n, "words.json")) && !fs.existsSync(path.join(runs, n, "clips.json")));
  assert.ok(name, "the fixture has a run in progress");
  const dir = path.join(runs, name);
  fs.writeFileSync(path.join(dir, "render.json"), JSON.stringify({ rendered: [], failed: [], notes: ["No logo in the brand kit, so none was drawn."] }));
  let r = readRun(home, name);
  assert.deepEqual(r.notes, ["No logo in the brand kit, so none was drawn."]);
  assert.equal(r.noSpeech, false);
  fs.writeFileSync(path.join(dir, "asr.json"), JSON.stringify({ words: 0 }));
  const old = new Date(Date.now() - 3 * 3600000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  fs.utimesSync(dir, old, old);
  r = readRun(home, name);
  assert.equal(r.noSpeech, true);
  assert.equal(r.stalled, false); // a run that stopped on purpose is not "stopped at a step"
});
