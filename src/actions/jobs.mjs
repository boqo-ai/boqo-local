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
import { readRunFull } from "../store/clips.mjs";
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
    readRunFull(home, job.runId); // notes each clip's render and judgment now, so a re-render shows afterwards
    log(`render ${job.runId} n=${job.ns.join(",")}${job.style ? ` style=${job.style}` : ""}`);
    runner(args, { cwd: job.tools.root, env }, (code, stdout, stderr) => {
      const { error, errors } = outcome(job.ns, code, stdout, stderr);
      finish(job, error, scratch, errors);
    });
  }

  function finish(job, error, scratch, errors = {}) {
    const failedAny = !!error || Object.keys(errors).length > 0;
    job.state = failedAny ? "failed" : "done";
    job.error = error ?? Object.values(errors)[0] ?? null;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    bus.emit({ type: "job", job: { id: job.id, runId: job.runId, ns: job.ns, state: job.state, error, errors } });
    bus.emit({ type: "changed" });
    current = null;
    bus.emit({ type: "jobs", jobs: list() });
    pump();
  }

  return { add, list, busy: () => !!current };
}

/**
 * What the engine said. tools/render.mjs reports on stdout (read at boqo-clips p0b):
 * a refusal is {"error": "..."} with exit 1, and a run is {"rendered": [...], "failed": [{n, error}]},
 * exit 0 even when some clips failed. stderr is only a fallback for crashes.
 */
export function outcome(ns, code, stdout, stderr) {
  const report = lastJson(stdout);
  if (report?.error) return { error: explain(report.error), errors: {} };
  const errors = {};
  for (const f of report?.failed ?? []) if (ns.includes(Number(f.n))) errors[Number(f.n)] = explain(f.error);
  if (report) return { error: null, errors };
  if (code === 0) return { error: null, errors };
  return { error: explain(lastLine(stderr)) || `The render stopped (exit ${code}).`, errors: {} };
}

/** The engine's errors are written for the agent; the ones a person can act on get plain words. */
export function explain(msg) {
  const m = String(msg ?? "").trim();
  if (!m) return "";
  if (/no sections\.json|no section in sections\.json holds clip|fetch its section|re-fetch sections/i.test(m)) {
    return "The part of the video this clip needs isn’t on this computer any more. Ask your agent to render it; it can download that part again.";
  }
  if (/an interrupted order is pending/i.test(m)) return "The run’s clips are being reordered. Try again once your agent finishes.";
  return m.split("\n")[0].slice(0, 200);
}

function lastJson(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* not one object */ }
  for (const line of t.split("\n").reverse()) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { return JSON.parse(l); } catch { /* keep looking */ }
  }
  return null;
}
const lastLine = (t) => String(t ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l) && !/^node:/.test(l)).at(-1) ?? "";

function spawnNode(args, opts, done) {
  const child = spawn(process.execPath, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out = (out + d).slice(-200_000); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
  child.on("close", (code) => done(code, out, err));
  child.on("error", (e) => done(-1, "", e.message));
}
