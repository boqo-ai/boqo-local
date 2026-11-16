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

function clipsFor(home, folder, momentName) {
  const dir = path.join(sniperDir(home), "clips", folder, momentName);
  const rec = readJson(path.join(dir, "clips.json"));
  if (!rec?.clips?.length) return [];
  return rec.clips.map((r, i) => clipRow(home, dir, r, i)).filter((c) => c.rendered).map(({ file, judgmentRaw, ...c }) => c);
}

function readMoments(home, folder, sessionDir) {
  const mdir = path.join(sessionDir, "moments");
  return listDirs(mdir).sort().reverse().map((name) => {
    const meta = readJson(path.join(mdir, name, "meta.json"));
    if (!meta) return null;
    const clips = clipsFor(home, folder, name);
    const taken = !!statSafe(path.join(mdir, name, ".taken"));
    const best = clips[0] ?? null;
    return {
      id: name,
      at: meta.peakIso ?? null,
      signal: meta.signalLine ?? meta.signal ?? "",
      score: typeof meta.score === "number" ? Math.round(meta.score) : null,
      band: typeof meta.score === "number" ? band(meta.score) : null,
      title: best?.title ?? meta.title ?? null,
      // clipped: a rendered clip exists; picking: the agent took it and hasn't finished; listed: waiting
      state: best ? "clipped" : taken ? "picking" : "listed",
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
  const moments = readMoments(home, folder, dir);
  const state = liveState(status);
  return {
    kind: "watch",
    id: `${folder}/${session}`,
    channel: status.channel ?? folder,
    platform: status.platform ?? folder.split("-")[0],
    state,
    live: state === "live" || state === "waiting",
    since: status.since ?? utcStamp(session)?.toISOString() ?? null,
    startedAt: (utcStamp(session) ?? new Date(status.since ?? Date.now())).toISOString(),
    updatedAt: status.updatedAt ?? null,
    chatPerSec: typeof status.chatPerSec === "number" ? status.chatPerSec : null,
    momentsCount: status.moments ?? moments.length,
    clipped: moments.filter((m) => m.state === "clipped").length,
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
