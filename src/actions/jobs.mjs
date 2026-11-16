// Local render jobs: the clips the page asks for, rendered by the installed boqo-clips
// engine (tools/render.mjs --run <run> --n <list> [--brand <kit>]). No model and no network
// are involved; one job runs at a time, as the engine itself expects.
//
// The engine takes the caption style only from a brand kit. For "this clip in another
// style" the job writes a one-off kit into a scratch home and points BOQO_HOME at it, the
// same trick the skill's own onboarding uses to render samples (onboarding.md:53-62).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statSafe, writeJson } from "../home.mjs";
import { rawKit, brandsDir } from "../store/brands.mjs";

/** Where boqo-clips' code is installed (INSTALL.md clones it to ~/.boqo-clips). */
export function clipsTools(env = process.env) {
  const root = env.BOQO_CLIPS_DIR || path.join(os.homedir(), ".boqo-clips");
  const tool = path.join(root, "tools", "render.mjs");
  return statSafe(tool) ? { root, render: tool } : null;
}

export function createJobs({ home, bus, log = () => {}, tools = clipsTools, runner = spawnNode }) {
  const queue = [];
  let current = null;
  let seq = 0;

  function list() {
    return [current, ...queue].filter(Boolean).map(({ id, runId, ns, style, kit, state, error }) => ({ id, runId, ns, style, kit, state, error }));
  }

  function add(spec) {
    if (spec?.error) return spec;
    const t = tools();
    if (!t) return { error: "The boqo-clips skill isn't installed here, so ask your agent to render instead." };
    const dup = [current, ...queue].find((j) => j && j.runId === spec.runId && j.ns.join() === spec.ns.join() && j.style === spec.style && j.kit === spec.kit);
    if (dup) return { ok: true, id: dup.id };
    const job = { id: `job-${++seq}`, ...spec, state: "queued", error: null, tools: t };
    queue.push(job);
    bus.emit({ type: "jobs", jobs: list() });
    pump();
    return { ok: true, id: job.id };
  }

  function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    current.state = "running";
    bus.emit({ type: "jobs", jobs: list() });
    const job = current;
    let env = { ...process.env, BOQO_HOME: home };
    let brand = job.kit;
    let scratch = null;
    try {
      if (job.style) {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-local-style-"));
        const base = (job.kit && rawKit(home, job.kit)) || { version: 2, name: "boqo Default" };
        const name = `style-${job.style}`;
        const kitDir = path.join(scratch, "brands", name);
        fs.mkdirSync(kitDir, { recursive: true });
        writeJson(path.join(kitDir, "brand.json"), { ...base, name, captions: { ...(base.captions ?? {}), style: job.style } }, 0o644);
        for (const f of ["logo.png", "logo.jpg", "logo.jpeg"]) {
          const src = job.kit ? path.join(brandsDir(home), job.kit, f) : null;
          if (src && statSafe(src)) fs.copyFileSync(src, path.join(kitDir, f));
        }
        fs.writeFileSync(path.join(scratch, "brands", "default.txt"), name);
        env = { ...env, BOQO_HOME: scratch };
        brand = name;
      }
    } catch (err) {
      return finish(job, `Couldn't prepare the caption style: ${err.message}`, scratch);
    }
    const args = [job.tools.render, "--run", job.runDir, "--n", job.ns.join(",")];
    if (brand) args.push("--brand", brand);
    log(`render ${job.runId} n=${job.ns.join(",")}${job.style ? ` style=${job.style}` : ""}`);
    runner(args, { cwd: job.tools.root, env }, (code, tail) => {
      finish(job, code === 0 ? null : explain(tail) || `The render stopped (exit ${code}).`, scratch);
    });
  }

  function finish(job, error, scratch) {
    job.state = error ? "failed" : "done";
    job.error = error;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    bus.emit({ type: "job", job: { id: job.id, runId: job.runId, ns: job.ns, state: job.state, error } });
    bus.emit({ type: "changed" });
    current = null;
    bus.emit({ type: "jobs", jobs: list() });
    pump();
  }

  return { add, list, busy: () => !!current };
}

/** The engine's own errors are written for the agent; keep the last plain line. */
function explain(tail) {
  const lines = String(tail).split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.reverse().find((l) => !/^\s*at\s/.test(l) && !/^node:/.test(l));
  if (!line) return "";
  if (/sections?\.json|no source|source/i.test(line)) return "The source video isn’t on this computer any more. Ask your agent to render it; it can download the part again.";
  if (/journal/i.test(line)) return "The run is being reordered. Try again in a moment.";
  return line.slice(0, 200);
}

function spawnNode(args, opts, done) {
  const child = spawn(process.execPath, args, { ...opts, stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { tail = (tail + d).slice(-4000); });
  child.on("close", (code) => done(code, tail));
  child.on("error", (err) => done(-1, err.message));
}
