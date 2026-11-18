// boqo-sniper watches: <home>/boqo-sniper/watch/<platform>-<slug>/<UTC stamp>/ holds
// status.json and moments/<stamp>/meta.json; finished clips are in
// <home>/boqo-sniper/clips/<folder>/<moment>/ (contract: boqo-sniper p0b, tools/watch.mjs
// and lib/moment-run.mjs). The skill keeps no chat-rate history, so the server samples
// chatPerSec while it runs (see sampleLive).
import path from "node:path";
import { readJson, statSafe, listDirs } from "../home.mjs";
import { mediaRel } from "../security.mjs";
import { band, clipRow } from "./clips.mjs";

const DEAD_MS = 240 * 1000; // the skill's own rule: a status older than this means the watcher died

/**
 * boqo-sniper v0.2.2's rules for a moment, read from its source (lib/settings.mjs isAutoMoment and its defaults,
 * lib/buffer.mjs LISTED_KEEP_SEC, tools/next.mjs): a hand-made moment, or one at or above autoClipMinScore while
 * autoClip is on, goes to the agent on its own and is claimed with `.taken`; anything else is "below the bar" and
 * waits for "clip it". Once `next` has told the agent of it, it carries `.listed`, and the watcher keeps it at least
 * LISTED_KEEP_MS after that telling, then may drop it to make room (status.json `dropped` counts those).
 */
// The watcher's own BOQO_SNIPER_LISTED_KEEP_MS can change this (tools/watch.mjs); the dashboard can't see that
// environment, so it says the default.
export const LISTED_KEEP_MS = 15 * 60 * 1000;
const SETTINGS_DEFAULT = { autoClip: true, autoClipMinScore: 80 };

function sessionSettings(sessionDir) {
  const s = readJson(path.join(sessionDir, "settings.json"));
  return {
    autoClip: typeof s?.autoClip === "boolean" ? s.autoClip : SETTINGS_DEFAULT.autoClip,
    autoClipMinScore: typeof s?.autoClipMinScore === "number" ? s.autoClipMinScore : SETTINGS_DEFAULT.autoClipMinScore,
  };
}

function isAutoMoment(meta, settings) {
  if (meta?.signal === "manual") return true;
  return settings.autoClip && Number(meta?.score) >= settings.autoClipMinScore;
}

export function sniperDir(home) { return path.join(home, "boqo-sniper"); }

/** UTC "20261116-204100" → Date. */
function utcStamp(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

function liveState(status) {
  if (!status) return "unknown";
  const age = Date.now() - Date.parse(status.updatedAt ?? 0);
  if ((status.state === "live" || status.state === "waiting") && age > DEAD_MS) return "lost";
  return status.state ?? "unknown";
}

/** The moment's run folder: boqo-sniper lib/moment-run.mjs writes clips.json and, when it finishes, done.json here. */
function momentRunDir(home, folder, momentName) { return path.join(sniperDir(home), "clips", folder, momentName); }

function clipsFor(home, folder, momentName) {
  const dir = momentRunDir(home, folder, momentName);
  const rec = readJson(path.join(dir, "clips.json"));
  if (!rec?.clips?.length) return [];
  return rec.clips.map((r, i) => clipRow(home, dir, r, i)).filter((c) => c.rendered).map(({ file, judgmentRaw, ...c }) => c);
}

function readMoments(home, folder, sessionDir) {
  const mdir = path.join(sessionDir, "moments");
  const settings = sessionSettings(sessionDir);
  return listDirs(mdir).sort().reverse().map((name) => {
    const meta = readJson(path.join(mdir, name, "meta.json"));
    if (!meta) return null;
    const clips = clipsFor(home, folder, name);
    const taken = !!statSafe(path.join(mdir, name, ".taken"));
    const listed = statSafe(path.join(mdir, name, ".listed"));
    const best = clips[0] ?? null;
    const runDir = momentRunDir(home, folder, name);
    // done.json (moment-run.mjs finish) is written when the agent is through with the moment, with `clips: []` when
    // nothing was kept or every render failed. A dropped moment whose folder could not be moved keeps `.taken` and
    // loses video.mp4 (lib/session.mjs dropMoment), and never gets a run folder.
    const finished = !!statSafe(path.join(runDir, "done.json"));
    const droppedHere = taken && !finished && !statSafe(path.join(mdir, name, "video.mp4")) && !statSafe(runDir);
    // clipped: a rendered clip exists; noclip: finished with none kept; dropped: dropped to make room; picking: the
    // agent took it and hasn't finished; queued: it goes to the agent on its own and waits its turn; below: below
    // the bar, waiting for "clip it"
    const state = best ? "clipped" : finished ? "noclip" : droppedHere ? "dropped" : taken ? "picking" : isAutoMoment(meta, settings) ? "queued" : "below";
    return {
      id: name,
      at: meta.peakIso ?? null,
      signal: meta.signalLine ?? meta.signal ?? "",
      score: typeof meta.score === "number" ? Math.round(meta.score) : null,
      band: typeof meta.score === "number" ? band(meta.score) : null,
      title: best?.title ?? meta.title ?? null,
      state,
      toldAt: state === "below" && listed ? new Date(listed.mtimeMs).toISOString() : null,
      keepUntil: state === "below" && listed ? new Date(listed.mtimeMs + LISTED_KEEP_MS).toISOString() : null,
      thumb: best?.thumb ?? null,
      thumbV: best?.thumbV ?? null,
      video: best?.video ?? null,
      clips,
    };
  }).filter(Boolean);
}

export function readWatch(home, id) {
  const [folder, session] = String(id).split("/");
  if (!folder || !session || folder.includes("..") || session.includes("..")) return null;
  const dir = path.join(sniperDir(home), "watch", folder, session);
  const status = readJson(path.join(dir, "status.json"));
  if (!status) return null;
  const state = liveState(status);
  const live = state === "live" || state === "waiting";
  // An ended watch drops nothing more, so "kept until at least" is only said while it runs.
  const moments = readMoments(home, folder, dir).map((m) => (live ? m : { ...m, keepUntil: null }));
  return {
    kind: "watch",
    id: `${folder}/${session}`,
    channel: status.channel ?? folder,
    platform: status.platform ?? folder.split("-")[0],
    state,
    live,
    since: status.since ?? utcStamp(session)?.toISOString() ?? null,
    startedAt: (utcStamp(session) ?? new Date(status.since ?? Date.now())).toISOString(),
    updatedAt: status.updatedAt ?? null,
    chatPerSec: typeof status.chatPerSec === "number" ? status.chatPerSec : null,
    momentsCount: Number.isInteger(status.moments) ? status.moments : moments.length,
    clipped: moments.filter((m) => m.state === "clipped").length,
    below: moments.filter((m) => m.state === "below").length,
    dropped: typeof status.dropped === "number" ? status.dropped : 0,
    error: status.error ? String(status.error).slice(0, 200) : null,
    moments,
  };
}

export function listWatches(home) {
  const out = [];
  for (const folder of listDirs(path.join(sniperDir(home), "watch"))) {
    for (const session of listDirs(path.join(sniperDir(home), "watch", folder))) {
      const w = readWatch(home, `${folder}/${session}`);
      if (w) out.push(w);
    }
  }
  return out;
}

/** Chat-per-second samples per live watch, kept in memory while the server runs. */
export function createSampler() {
  const series = new Map(); // id → [{t, v}]
  return {
    sample(watches) {
      const now = Date.now();
      for (const w of watches) {
        if (!w.live || w.chatPerSec == null) continue;
        const s = series.get(w.id) ?? [];
        if (!s.length || now - s.at(-1).t >= 2000) s.push({ t: now, v: w.chatPerSec });
        while (s.length > 600) s.shift(); // ~20 minutes at one sample every 2 s
        series.set(w.id, s);
      }
    },
    get: (id) => series.get(id) ?? [],
  };
}
