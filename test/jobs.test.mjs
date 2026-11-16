import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHome } from "./helpers/home.mjs";
import { createJobs } from "../src/actions/jobs.mjs";
import { resolveJob } from "../src/store/index.mjs";

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-jobs-"));
  const ids = makeHome(home);
  const calls = [];
  const emitted = [];
  const jobs = createJobs({
    home,
    bus: { emit: (m) => emitted.push(m) },
    tools: () => ({ root: "/opt/boqo-clips", render: "/opt/boqo-clips/tools/render.mjs" }),
    runner: (args, opts, done) => {
      // what the engine would see, including the kit in the scratch home for a style change
      const kitDir = opts.env.BOQO_HOME !== home ? path.join(opts.env.BOQO_HOME, "brands", args.at(-1)) : null;
      calls.push({ args, home: opts.env.BOQO_HOME, kit: kitDir ? JSON.parse(fs.readFileSync(path.join(kitDir, "brand.json"), "utf8")) : null, logo: kitDir ? fs.existsSync(path.join(kitDir, "logo.png")) : null });
      setImmediate(() => done(0, ""));
    },
  });
  return { home, ids, jobs, calls, emitted };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

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
  // the person's own kit is untouched
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

test("without the skill installed, the page is told to ask the agent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-jobs-"));
  const ids = makeHome(home);
  const jobs = createJobs({ home, bus: { emit() {} }, tools: () => null });
  assert.match(jobs.add(resolveJob(home, { run: ids.doneName, n: [11] })).error, /ask your agent/);
});
