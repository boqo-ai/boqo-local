// boqo-clips runs, read from <home>/boqo-clips/runs/<YYYYMMDD-HHMM>-<slug>/.
// The skill writes no progress file, so a run's step is read from which files exist
// (contract: boqo-clips p0b, SKILL.md steps 2-7 and engine/clips-record.mjs).
import fs from "node:fs";
import path from "node:path";
import { readJson, statSafe, listDirs } from "../home.mjs";
import { noteClips } from "./seen.mjs";
import { mediaRel } from "../security.mjs";

export const RENDER_FIRST = 10;
const STALL_MS = 30 * 60 * 1000;

export const band = (s) => (s >= 85 ? "Exceptional" : s >= 70 ? "Strong" : s >= 60 ? "Decent" : s >= 40 ? "Watchable" : "Weak");
export const grade = (v) => (v >= 90 ? "A" : v >= 80 ? "B" : v >= 70 ? "C" : v >= 60 ? "D" : "F");

export function runsDir(home) { return path.join(home, "boqo-clips", "runs"); }

/** "20261116-0912-lt48-bakery" → a Date in local time, or null. */
export function stampDate(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})?/.exec(name);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

/** Lines of <home>/boqo-clips/runs.md: "<date time> | <url> | <n> clips | <run>/out | posted <m>". */
export function runsLog(home) {
  let text = "";
  try { text = fs.readFileSync(path.join(home, "boqo-clips", "runs.md"), "utf8"); } catch { return new Map(); }
  const out = new Map();
  for (const line of text.split("\n")) {
    const f = line.split("|").map((s) => s.trim());
    if (f.length < 4) continue;
    const runName = path.basename(path.dirname(f[3].replace(/[\\/]+$/, ""))) || path.basename(f[3]);
    const posted = Number((/posted\s+(\d+)/.exec(f[4] ?? "") ?? [])[1] ?? 0);
    out.set(runName, { url: f[1], posted });
  }
  return out;
}

function exists(dir, name) { return !!statSafe(path.join(dir, name)); }
function anyMatch(dir, re) { try { return fs.readdirSync(dir).some((f) => re.test(f)); } catch { return false; } }

/** The source title, from clips.json, else info.json, else the folder slug. */
function sourceTitle(dir, record, name) {
  if (record?.video?.title) return record.video.title;
  const info = readJson(path.join(dir, "info.json"));
  if (info?.title) return info.title;
  return name.replace(/^\d{8}-\d{4,6}-?/, "").replace(/-/g, " ") || name;
}

/** One clips.json row, in the shape the page uses. Paths become media paths under the home. */
export function clipRow(home, dir, r, i) {
  const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.join(dir, p)) : null);
  const file = abs(r.file), thumb = abs(r.thumb);
  // A re-render writes the same file names; the modification time versions the URL so the
  // browser doesn't keep showing the old render from its cache.
  const fileSt = file ? statSafe(file) : null, thumbSt = thumb ? statSafe(thumb) : null;
  const axes = r.axes ?? {};
  return {
    n: r.n ?? i + 1,
    title: r.title ?? `Clip ${i + 1}`,
    hook: r.hook ?? "",
    start: r.window?.start ?? r.start ?? null,
    end: r.window?.end ?? r.end ?? null,
    seconds: r.seconds ?? (r.end != null && r.start != null ? r.end - r.start : null),
    score: typeof r.score === "number" ? Math.round(r.score) : null,
    band: typeof r.score === "number" ? band(r.score) : null,
    axes: ["hook", "flow", "standalone", "value"].map((k) => (typeof axes[k] === "number" ? Math.round(axes[k]) : null)),
    // replay.pct is the clip's place on the most-replayed curve, 0..1, higher = more replayed.
    // Shown the way the engine shows it (engine/boqo/handbook-outcomes.mjs): "top N%", never 0.
    replayTop: typeof r.replay?.pct === "number" ? Math.max(1, Math.round((1 - r.replay.pct) * 100)) : null,
    judgment: r.judgment?.overall ?? null,
    why: r.judgment?.why ?? null,
    standalone: r.standalone?.outcome ?? null,
    rendered: !!r.rendered && !!file,
    video: fileSt ? mediaRel(home, file) : null,
    videoV: fileSt ? Math.round(fileSt.mtimeMs) : null,
    thumb: thumbSt ? mediaRel(home, thumb) : null,
    thumbV: thumbSt ? Math.round(thumbSt.mtimeMs) : null,
    judgmentRaw: r.judgment ?? null,
    file,
    notes: Array.isArray(r.notes) ? r.notes.slice(0, 4) : [],
  };
}

/**
 * The run's steps, read from its files. Each: { key, label, who: "agent"|"local", state, detail }.
 * A step is "now" when the one before it is done and it isn't.
 */
export function runSteps(dir, record, rows) {
  const hasTranscript = exists(dir, "words.json") || exists(dir, "asr.json") || exists(dir, "transcript.md");
  const picked = !!record;
  const asked = exists(dir, "select-request.md") || exists(dir, "selection.json");
  const downloaded = exists(dir, "sections.json") || anyMatch(dir, /^(sec-\d+|whole)\./) || rows.some((r) => r.rendered);
  const target = Math.min(RENDER_FIRST, rows.length || RENDER_FIRST);
  const rendered = rows.filter((r) => r.rendered).length;
  const rendering = anyMatch(path.join(dir, "render"), /^clip-\d+/);
  const judged = rows.filter((r) => r.rendered && r.judgment != null).length;
  const renderDone = picked && rows.length > 0 && rendered >= target;
  const judgeDone = renderDone && judged >= rendered;

  const steps = [
    { key: "transcript", label: "Read the captions", who: "local", done: hasTranscript, detail: hasTranscript ? "" : "" },
    { key: "pick", label: "Your agent picks and scores", who: "agent", done: picked, detail: picked ? `${rows.length} clips` : asked ? "reading the transcript" : "" },
    { key: "download", label: "Download the picked parts", who: "local", done: downloaded, detail: "" },
    { key: "render", label: `Render the best ${target}`, who: "local", done: renderDone, detail: `${rendered} of ${target}`, progress: target ? rendered / target : 0, active: rendering },
    { key: "judge", label: "Your agent watches each clip", who: "agent", done: judgeDone, detail: `${judged} of ${rendered || target}`, progress: rendered ? judged / rendered : 0 },
  ];
  let seenNow = false;
  for (const s of steps) {
    if (s.done) s.state = "done";
    else if (!seenNow) { s.state = "now"; seenNow = true; }
    else s.state = "wait";
  }
  return { steps, done: judgeDone, rendered, target, judged };
}

/** A summary for My Work. */
export function readRun(home, name, log = runsLog(home)) {
  const dir = path.join(runsDir(home), name);
  const st = statSafe(dir);
  if (!st?.isDirectory()) return null;
  const record = readJson(path.join(dir, "clips.json"));
  const rows = (record?.clips ?? []).map((r, i) => clipRow(home, dir, r, i));
  const { steps, done, rendered, target, judged } = runSteps(dir, record, rows);
  const renderLog = readJson(path.join(dir, "render.json"));
  const failed = (renderLog?.failed ?? []).map((f) => ({ n: f.n, error: String(f.error ?? "").slice(0, 200) }));
  const lastChange = latestMtime(dir);
  const stalled = !done && Date.now() - lastChange > STALL_MS;
  const started = stampDate(name) ?? st.birthtime ?? st.mtime;
  const logLine = log.get(name);
  return {
    kind: "clips",
    id: name,
    title: sourceTitle(dir, record, name),
    sourceUrl: logLine?.url ?? null,
    duration: record?.video?.duration ?? null,
    startedAt: started.toISOString(),
    updatedAt: new Date(lastChange).toISOString(),
    steps,
    done,
    stalled,
    failed,
    total: rows.length,
    rendered,
    target,
    judged,
    posted: logLine?.posted ?? 0,
    top: rows.filter((r) => r.rendered).slice(0, 5).map(({ n, title, score, band, thumb, thumbV }) => ({ n, title, score, band, thumb, thumbV })),
    dir,
  };
}

/** The run with every clip, for the run page. */
export function readRunFull(home, name) {
  const summary = readRun(home, name);
  if (!summary) return null;
  const record = readJson(path.join(summary.dir, "clips.json"));
  const rows = (record?.clips ?? []).map((r, i) => clipRow(home, summary.dir, r, i));
  const stale = noteClips(home, name, rows.filter((r) => r.rendered).map((r) => ({ n: r.n, videoV: r.videoV, judgment: r.judgmentRaw })));
  const clips = rows.map((row) => {
    row.grades = row.axes.map((v) => (v == null ? null : grade(v)));
    row.judgmentStale = stale.has(row.n);
    delete row.file;
    delete row.judgmentRaw;
    return row;
  });
  const { dir, ...rest } = summary;
  return { ...rest, clips, runDir: dir };
}

export function listRuns(home) {
  const log = runsLog(home);
  return listDirs(runsDir(home)).map((n) => readRun(home, n, log)).filter(Boolean);
}

function latestMtime(dir) {
  let t = 0;
  const visit = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const s = statSafe(p);
      if (s && s.mtimeMs > t) t = s.mtimeMs;
      if (e.isDirectory() && depth < 1) visit(p, depth + 1);
    }
  };
  visit(dir, 0);
  return t || Date.now();
}
