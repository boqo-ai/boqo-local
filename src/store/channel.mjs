// boqo-channel daily runs: <home>/boqo-channel/runs/<YYYYMMDD-HHMM>/plan.json, an array of
// { clip, title, hook, video, start, end, channel, accountIds, handles, when:{date,time},
//   posted?, skipped? } (contract: boqo-channel p0b, lib/plan.mjs). Each video's clips live
// in <run>/<video id>/ laid out like a boqo-clips run.
import path from "node:path";
import { readJson, statSafe, listDirs } from "../home.mjs";
import { mediaRel } from "../security.mjs";
import { stampDate } from "./clips.mjs";

export function channelDir(home) { return path.join(home, "boqo-channel"); }

function thumbFor(home, runDir, item) {
  if (!item.video || item.clip == null) return null;
  const n = String(item.clip).padStart(2, "0");
  const f = path.join(runDir, String(item.video), "out", `clip-${n}.jpg`);
  return statSafe(f) ? mediaRel(home, f) : null;
}

export function readPlan(home, name) {
  const dir = path.join(channelDir(home), "runs", name);
  const plan = readJson(path.join(dir, "plan.json"));
  if (!Array.isArray(plan)) return null;
  const items = plan.map((it) => ({
    date: it.when?.date ?? null,
    time: it.when?.time ?? null,
    title: it.title ?? "",
    handles: Array.isArray(it.handles) ? it.handles : [],
    channel: it.channel ?? null,
    state: it.posted ? "posted" : it.skipped ? "skipped" : "planned",
    thumb: thumbFor(home, dir, it),
  })).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const videos = new Set(plan.map((p) => p.video).filter(Boolean)).size;
  const channels = [...new Set(plan.map((p) => p.channel).filter(Boolean))];
  const config = readJson(path.join(channelDir(home), "config.json"));
  return {
    kind: "plan",
    id: name,
    startedAt: (stampDate(name) ?? new Date()).toISOString(),
    items,
    videos,
    channels,
    posting: typeof config?.posting === "string" ? config.posting : config?.posting?.auto != null ? "auto" : "ask",
    waiting: items.some((i) => i.state === "planned"),
    locked: !!statSafe(path.join(channelDir(home), "lock")) || !!statSafe(path.join(dir, "lock")),
  };
}

export function listPlans(home) {
  return listDirs(path.join(channelDir(home), "runs")).map((n) => readPlan(home, n)).filter(Boolean);
}
