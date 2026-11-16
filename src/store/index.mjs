// What the page reads: My Work (every request, newest first), a run, a watch, the kits.
import path from "node:path";
import { listRuns, readRunFull, readRun, runsDir } from "./clips.mjs";
import { listWatches, readWatch, createSampler } from "./sniper.mjs";
import { listPlans } from "./channel.mjs";
import { listKits, defaultKit, CAPTION_STYLES } from "./brands.mjs";
import { clipsTools } from "../actions/jobs.mjs";

const sampler = createSampler();

export function feed(home) {
  const watches = listWatches(home);
  sampler.sample(watches);
  const items = [
    ...listRuns(home).map(({ dir, ...r }) => r),
    ...watches.map((w) => ({ ...w, moments: w.moments.slice(0, 3), series: w.live ? sampler.get(w.id).slice(-60) : [] })),
    ...listPlans(home),
  ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { items, canRender: !!clipsTools(), defaultKit: defaultKit(home) };
}

export function run(home, id) {
  if (!/^[\w.-]{1,120}$/.test(id) || id.includes("..")) return null;
  const r = readRunFull(home, id);
  if (!r) return null;
  return { ...r, kits: listKits(home), styles: CAPTION_STYLES, defaultKit: defaultKit(home), canRender: !!clipsTools() };
}

export function watch(home, id) {
  const w = readWatch(home, id);
  if (!w) return null;
  sampler.sample([w]);
  return { ...w, series: sampler.get(w.id) };
}

export function brands(home) {
  return { kits: listKits(home), defaultKit: defaultKit(home), styles: CAPTION_STYLES };
}

/** Build the agent's context from ids the page sends; paths are read from disk, never taken from the page. */
export function chatContext(home, ctx) {
  if (!ctx || typeof ctx !== "object") return null;
  if (typeof ctx.run === "string") {
    const r = readRunFull(home, ctx.run);
    if (!r) return null;
    const out = { runDir: path.join(runsDir(home), ctx.run), title: r.title, label: r.title };
    const c = ctx.clip != null ? r.clips.find((x) => x.n === Number(ctx.clip)) : null;
    if (c) {
      out.clip = { rank: c.n, title: c.title, start: c.start, end: c.end, file: c.video ? path.join(home, c.video) : null };
      out.label = `${r.title} · clip ${c.n}`;
    }
    return out;
  }
  if (typeof ctx.watch === "string") {
    const w = readWatch(home, ctx.watch);
    return w ? { watch: `${w.platform} ${w.channel}`, label: w.channel } : null;
  }
  return null;
}

/** Turn a page request into a render job the engine can run, or an error. */
export function resolveJob(home, body) {
  if (!body || typeof body.run !== "string" || !/^[\w.-]{1,120}$/.test(body.run)) return { error: "run" };
  const r = readRun(home, body.run);
  if (!r) return { error: "run" };
  const ns = (Array.isArray(body.n) ? body.n : [body.n]).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= r.total);
  if (!ns.length) return { error: "clips" };
  const kits = listKits(home);
  const kit = body.kit ? kits.find((k) => k.id === body.kit)?.id : null;
  if (body.kit && !kit) return { error: "kit" };
  const style = body.style ? CAPTION_STYLES.find(([k]) => k === body.style)?.[0] : null;
  if (body.style && !style) return { error: "style" };
  const kitName = kit ?? defaultKit(home);
  return { runId: body.run, runDir: r.dir, ns, kit: kitName, style, title: r.title };
}
