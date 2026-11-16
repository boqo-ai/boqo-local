import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHome } from "./helpers/home.mjs";
import { createJobs, outcome, explain } from "../src/actions/jobs.mjs";
import { resolveJob, run as readRunPage } from "../src/store/index.mjs";

/** A stand-in engine: answers on stdout the way tools/render.mjs does. */
function setup(reply = () => ({ code: 0, stdout: JSON.stringify({ rendered: [], failed: [] }) })) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-jobs-"));
  const ids = makeHome(home);
  const calls = [];
  const emitted = [];
  const jobs = createJobs({
    home,
    bus: { emit: (m) => emitted.push(m) },
    tools: () => ({ root: "/opt/boqo-clips", render: "/opt/boqo-clips/tools/render.mjs" }),
    runner: (args, opts, done) => {
      const kitDir = opts.env.BOQO_HOME !== home ? path.join(opts.env.BOQO_HOME, "brands", args.at(-1)) : null;
      calls.push({ args, home: opts.env.BOQO_HOME, kit: kitDir ? JSON.parse(fs.readFileSync(path.join(kitDir, "brand.json"), "utf8")) : null, logo: kitDir ? fs.existsSync(path.join(kitDir, "logo.png")) : null });
      const r = reply(args);
      // like a real render: the clip files are written again
      const run = args[args.indexOf("--run") + 1];
      for (const n of args[args.indexOf("--n") + 1].split(",")) {
        const file = path.join(run, "out", `clip-${String(n).padStart(2, "0")}.mp4`);
        if (fs.existsSync(file)) { const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t); }
      }
      setImmediate(() => done(r.code, r.stdout ?? "", r.stderr ?? ""));
    },
  });
  return { home, ids, jobs, calls, emitted };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const lastJob = (emitted) => emitted.filter((m) => m.type === "job").at(-1).job;

test("render: the engine gets the run, the clips and the kit", async () => {
  const { home, ids, jobs, calls } = setup();
  const r = jobs.add(resolveJob(home, { run: ids.doneName, n: [11, 12] }));
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(calls[0].args.slice(1), ["--run", path.join(home, "boqo-clips", "runs", ids.doneName), "--n", "11,12", "--brand", "longtable"]);
  assert.equal(calls[0].home, home);
});

test("another caption style goes through a one-off kit in a scratch home, keeping the logo, and the scratch is removed", async () => {
  const { home, ids, jobs, calls } = setup();
  jobs.add(resolveJob(home, { run: ids.doneName, n: [1], style: "neon" }));
  await settle();
  assert.notEqual(calls[0].home, home);
  assert.equal(calls[0].kit.captions.style, "neon");
  assert.deepEqual(calls[0].kit.captions.accentColours, ["#FF8A3D"]);
  assert.equal(calls[0].logo, true);
  assert.equal(fs.existsSync(calls[0].home), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "brands", "longtable", "brand.json"), "utf8")).captions.style, "punch");
});

test("one job at a time, and the same request twice is one job", async () => {
  const { home, ids, jobs, calls } = setup();
  const a = jobs.add(resolveJob(home, { run: ids.doneName, n: [11] }));
  const b = jobs.add(resolveJob(home, { run: ids.doneName, n: [11] }));
  jobs.add(resolveJob(home, { run: ids.doneName, n: [12] }));
  assert.equal(a.id, b.id);
  await settle();
  assert.equal(calls.length, 2);
});

test("a clip the engine lists as failed is reported as failed, even with exit 0 (#7)", async () => {
  const { home, ids, jobs, emitted } = setup(() => ({ code: 0, stdout: JSON.stringify({ rendered: [{ n: 11 }], failed: [{ n: 12, error: "no section in sections.json holds clip 12 (520-560 s): fetch its section" }] }) }));
  jobs.add(resolveJob(home, { run: ids.doneName, n: [11, 12] }));
  await settle();
  const job = lastJob(emitted);
  assert.equal(job.state, "failed");
  assert.equal(job.errors[11], undefined);
  assert.match(job.errors[12], /isn’t on this computer any more/);
});

test("an engine refusal on stdout becomes the job's error in plain words (#7)", async () => {
  const { home, ids, jobs, emitted } = setup(() => ({ code: 1, stdout: JSON.stringify({ error: "an interrupted order is pending: run clips.mjs order first, then render" }) }));
  jobs.add(resolveJob(home, { run: ids.doneName, n: [11] }));
  await settle();
  assert.match(lastJob(emitted).error, /being reordered/);
});

test("other engine errors are shown as they are, not blamed on a missing source (#4)", () => {
  assert.equal(explain("ffmpeg exited 1: Invalid data found when processing input"), "ffmpeg exited 1: Invalid data found when processing input");
  assert.equal(explain("the caption source track is empty"), "the caption source track is empty");
  assert.match(explain("the run has no sections.json and no --src was given: there is no video to read frames from"), /isn’t on this computer/);
  assert.match(explain("sec-03.mp4 holds 12.0 s, too short for clip 4 at 0 s: fetch its section again"), /isn’t on this computer/);
  assert.deepEqual(outcome([1], 0, "", ""), { error: null, errors: {} });
  assert.match(outcome([1], 2, "", "Error: boom\n    at x (y.js:1)").error, /boom/);
});

test("a local re-render marks the old stranger judgment as from before, until the agent judges again (#3)", async () => {
  const { home, ids, jobs } = setup();
  jobs.add(resolveJob(home, { run: ids.doneName, n: [2, 11] })); // 2 was rendered and judged; 11 wasn't rendered
  await settle();
  let page = readRunPage(home, ids.doneName);
  assert.equal(page.clips.find((c) => c.n === 2).judgmentStale, true);
  assert.equal(page.clips.find((c) => c.n === 11).judgmentStale, false);
  assert.equal(page.clips.find((c) => c.n === 1).judgmentStale, false);
  // the agent judges clip 2 again
  const f = path.join(home, "boqo-clips", "runs", ids.doneName, "clips.json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.clips[1].judgment = { overall: 5, why: "Tighter now.", annotation: {} };
  fs.writeFileSync(f, JSON.stringify(rec));
  page = readRunPage(home, ids.doneName);
  assert.equal(page.clips.find((c) => c.n === 2).judgmentStale, false);
});

test("a re-render done outside the page (by the agent, say) also marks the old judgment", () => {
  const { home, ids } = setup();
  assert.equal(readRunPage(home, ids.doneName).clips[3].judgmentStale, false); // the page sees clip 4 as it is
  const file = path.join(home, "boqo-clips", "runs", ids.doneName, "out", "clip-04.mp4");
  const t = new Date(Date.now() + 9000);
  fs.utimesSync(file, t, t); // rendered again; clips.json's judgment untouched
  assert.equal(readRunPage(home, ids.doneName).clips[3].judgmentStale, true);
  assert.equal(readRunPage(home, ids.doneName).clips[3].judgmentStale, true); // and it stays so until judged again
});

test("media URLs carry the file's modification time, so a re-render isn't served from cache (#3)", () => {
  const { home, ids } = setup();
  const before = readRunPage(home, ids.doneName).clips[0];
  assert.ok(before.videoV > 0 && before.thumbV > 0);
  const file = path.join(home, before.video);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(file, later, later);
  assert.notEqual(readRunPage(home, ids.doneName).clips[0].videoV, before.videoV);
});

test("without the skill installed, the page is told to ask the agent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-jobs-"));
  const ids = makeHome(home);
  const jobs = createJobs({ home, bus: { emit() {} }, tools: () => null });
  assert.match(jobs.add(resolveJob(home, { run: ids.doneName, n: [11] })).error, /ask your agent/);
});
