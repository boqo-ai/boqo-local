// boqo local: My Work, a run, a live watch, and a chat with the person's own agent.
// No framework: views are strings, patched into the page by morph() so animations,
// playing videos and typing survive live updates.
import { morph } from "/morph.js";

const TOKEN = document.querySelector('meta[name="boqo-token"]').content;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = {
  feed: null, run: null, watch: null, state: null, jobs: [], jobErrors: {},
  open: {}, // run id → open clip n
  threads: {}, // thread id → { messages, busy }
  live: {}, // thread id → the reply streaming in
  loading: false,
};

/* ---------- icons ---------- */
const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>', chev: '<path d="M9 6l6 6-6 6"/>', chevL: '<path d="M15 6l-6 6 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>', stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

/* ---------- formatting ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const mmss = (s) => (s == null ? "" : `${Math.floor(s / 60)}:${pad2(Math.round(s % 60))}`);
const hms = (s) => (s == null ? "" : s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(Math.round(s % 60))}` : mmss(s));
function dayLabel(iso) {
  const d = new Date(iso), t = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(t) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff === -1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
const media = (p, v) => `/media?p=${encodeURIComponent(p)}${v ? `&v=${v}` : ""}`;

/* ---------- server ---------- */
async function api(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Boqo-Token": TOKEN }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

/* ---------- routing ---------- */
function route() {
  const p = location.pathname;
  let m;
  if ((m = p.match(/^\/r\/([^/]+)$/))) return { view: "run", id: decodeURIComponent(m[1]) };
  if ((m = p.match(/^\/w\/([^/]+)\/([^/]+)$/))) return { view: "watch", id: `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` };
  return { view: "feed" };
}
function go(href) { history.pushState(null, "", href); load(true); }
addEventListener("popstate", () => load(true));

/* the chat thread for what's on screen */
function threadFor(r = route()) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 70);
  if (r.view === "run") return `run-${clean(r.id)}`;
  if (r.view === "watch") return `watch-${clean(r.id)}`;
  return "home";
}
function chatContext(r = route()) {
  if (r.view === "run") return { run: r.id, clip: S.open[r.id] ?? null };
  if (r.view === "watch") return { watch: r.id };
  return null;
}

/* ---------- load and render ---------- */
let loadSeq = 0;
async function load(navigated) {
  const r = route(), seq = ++loadSeq;
  try {
    const [data, state] = await Promise.all([
      r.view === "run" ? api(`/api/run/${encodeURIComponent(r.id)}`) : r.view === "watch" ? api(`/api/watch/${r.id.split("/").map(encodeURIComponent).join("/")}`) : api("/api/feed"),
      api("/api/state"),
    ]);
    if (seq !== loadSeq) return;
    S.state = state; S.jobs = state.jobs;
    if (r.view === "run") S.run = data; else if (r.view === "watch") S.watch = data; else S.feed = data;
  } catch {
    if (seq !== loadSeq) return;
    if (r.view === "run") S.run = { missing: true }; else if (r.view === "watch") S.watch = { missing: true };
  }
  const tid = threadFor(r);
  if (!S.threads[tid] || navigated) {
    try { const t = await api(`/api/thread/${tid}`); S.threads[tid] = { messages: t.messages, busy: t.busy }; } catch { S.threads[tid] = { messages: [], busy: false }; }
  }
  render();
  if (navigated) { $("#main").scrollTop = 0; scrollChat(true); }
}

/**
 * Progress bars carry their value in data-v; the width is set here through the CSSOM. Measured in Chromium against
 * this page's CSP (style-src 'self', src/security.mjs), 2026-11-18: a `style="--v:40%"` cloned in by morph() on the
 * first render applies, but morph()'s later `setAttribute("style", "--v:70%")` is refused (--v stays 40%), so a bar
 * froze at the value it first drew while its text kept counting. `el.style.setProperty` is allowed (--v became 90%).
 */
function setBars(root) {
  for (const el of root.querySelectorAll("[data-v]")) el.style.setProperty("--v", `${Number(el.dataset.v) || 0}%`);
}

function render() {
  const r = route();
  const html = r.view === "run" ? viewRun(S.run) : r.view === "watch" ? viewWatch(S.watch) : viewFeed(S.feed);
  morph($("#main"), html);
  setBars($("#main"));
  renderChat();
  document.title = r.view === "run" && S.run?.title ? `${S.run.title} · boqo` : r.view === "watch" && S.watch?.channel ? `${S.watch.channel} · boqo` : "boqo";
}

/* ---------- shared pieces ---------- */
function steps(list) {
  return `<div class="sl">${list.map((s) => {
    const icon = s.state === "done" ? ic("check") : s.state === "now" ? '<span class="spin"></span>' : '<span class="o"></span>';
    const right = s.state === "now" ? esc(s.detail) : "";
    const bar = s.state === "now" && s.progress != null && s.progress > 0 ? `<div class="sl-bar"><i data-v="${Math.round(s.progress * 100)}"></i></div>` : "";
    return `<div class="sl-r ${s.state} ${s.who}" data-key="${s.key}"><span class="sl-i">${icon}</span><span class="n">${esc(s.label)}</span><span class="v">${right}</span></div>${bar}`;
  }).join("")}</div>`;
}
const still = (thumb, alt = "", v) => (thumb ? `<img class="still" src="${media(thumb, v)}" alt="${esc(alt)}" loading="lazy">` : '<span class="still none"></span>');
const strip = (top) => `<div class="strip">${top.map((c) => `<div class="sc">${still(c.thumb, c.title, c.thumbV)}<b>${c.score ?? ""}</b><span>${esc(c.title)}</span></div>`).join("")}</div>`;
function spark(series, w = 400, h = 36) {
  if (!series?.length || series.length < 2) return "";
  const vals = series.map((p) => p.v), max = Math.max(10, ...vals), st = w / (vals.length - 1);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${(i * st).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h + 2}" preserveAspectRatio="none" aria-label="Chat per second"><path d="${d}" fill="none" stroke="var(--chart)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
const header = (title) => `<div class="top"><span class="mark" aria-hidden="true">bq</span><h1>${esc(title)}</h1></div>`;
const backLink = () => `<div class="top"><a class="back" href="/" data-nav>${ic("chevL")}My Work</a></div>`;

/* ---------- My Work ---------- */
function viewFeed(f) {
  if (!f) return `<div class="page">${header("My Work")}</div>`;
  if (!f.items.length) {
    return `<div class="page">${header("My Work")}<div class="empty"><b>Nothing here yet</b>
      <span>Ask your agent for clips, here or in your terminal. Each request shows up here while it runs and after.</span>
      <code>clip &lt;a YouTube link&gt;</code></div></div>`;
  }
  let lastDay = "", out = "";
  for (const it of f.items) {
    const d = dayLabel(it.startedAt);
    if (d !== lastDay) { out += `<div class="day">${esc(d)}</div>`; lastDay = d; }
    out += it.kind === "clips" ? feedRun(it) : it.kind === "watch" ? feedWatch(it) : feedPlan(it);
  }
  return `<div class="page">${header("My Work")}${out}</div>`;
}

function runMeta(r) {
  const bits = [];
  if (r.duration) bits.push(hms(r.duration));
  if (r.done) bits.push(`${r.total} clips, the best ${r.rendered} rendered`);
  if (r.posted) bits.push(`${r.posted} posted`);
  if (r.failed?.length) bits.push(`<span class="err">${r.failed.length} didn’t render</span>`);
  if (r.noSpeech) bits.push("No speech heard in this video, so there was nothing to clip");
  for (const n of r.notes ?? []) bits.push(esc(n));
  if (r.stalled) bits.push(`Stopped at “${esc(r.steps.find((s) => s.state === "now")?.label ?? "")}”`);
  return bits.join(" · ");
}

function feedRun(r) {
  return `<a class="it" href="/r/${encodeURIComponent(r.id)}" data-nav data-key="run-${esc(r.id)}"><time>${clock(r.startedAt)}</time><div class="it-b">
    <h2><span class="t">${esc(r.title)}</span><span class="go">${ic("chev")}</span></h2>
    <p class="meta">${runMeta(r)}</p>
    ${r.done && r.top.length ? strip(r.top) : r.stalled || r.noSpeech ? "" : steps(r.steps)}
  </div></a>`;
}

function watchMeta(w) {
  const where = w.platform ? `${w.platform[0].toUpperCase()}${w.platform.slice(1)}` : "";
  const state = w.live ? "watching on this computer" : w.state === "lost" ? "the watcher stopped answering" : w.state === "failed" ? `<span class="err">stopped: ${esc(w.error ?? "failed")}</span>` : "ended";
  const dropped = w.dropped ? `${w.dropped} below the bar dropped to make room` : "";
  return [where, state, dropped].filter(Boolean).join(" · ");
}
/** What a moment's row says beside its title (boqo-sniper v0.2.2's moment states; store/sniper.mjs). */
function momentNote(m) {
  if (m.state === "clipped") return m.signal ?? "";
  if (m.state === "noclip") return "no clip kept";
  if (m.state === "dropped") return "dropped to make room";
  if (m.state === "queued") return "waiting for your agent";
  if (m.state === "below") return m.keepUntil ? `below the bar · say “clip it” · kept until at least ${clock(m.keepUntil)}` : "below the bar";
  return "";
}
const momentRows = (ms) => `<div class="ls">${ms.map((m) => `<div class="ls-r${m.state === "picking" ? " agent" : ["below", "noclip", "dropped"].includes(m.state) ? " muted" : ""}" data-key="m-${esc(m.id)}"><span class="t">${clock(m.at)}</span><span class="x">${m.state === "picking" ? "Your agent is picking the clip…" : esc(m.title ?? m.signal)}<small>${esc(momentNote(m))}</small></span><span class="r">${m.score ?? ""}</span></div>`).join("")}</div>`;

function feedWatch(w) {
  return `<a class="it" href="/w/${w.id.split("/").map(encodeURIComponent).join("/")}" data-nav data-key="w-${esc(w.id)}"><time>${clock(w.startedAt)}</time><div class="it-b">
    <h2>${w.live ? '<span class="live-dot" aria-hidden="true"></span>' : ""}<span class="t">${esc(w.channel)}</span><span class="go">${ic("chev")}</span></h2>
    <p class="meta">${watchMeta(w)}</p>
    <div class="nums">${w.live && w.chatPerSec != null ? `<span><b>${w.chatPerSec.toFixed(1)}</b>chat/s</span>` : ""}<span><b>${w.momentsCount}</b>moments</span><span><b>${w.clipped}</b>clipped</span></div>
    ${w.live ? spark(w.series) : ""}
    ${w.moments.length ? momentRows(w.moments) : ""}
  </div></a>`;
}

function feedPlan(p) {
  const planned = p.items.filter((i) => i.state === "planned").length;
  const day = p.items[0]?.date ? dayLabel(`${p.items[0].date}T12:00:00`) : "";
  const meta = [p.channels.join(", "), `${p.items.length} posts from ${p.videos} new video${p.videos === 1 ? "" : "s"}`, planned && p.posting === "ask" ? "waiting for your yes" : ""].filter(Boolean).join(" · ");
  return `<article class="it" data-key="p-${esc(p.id)}"><time>${clock(p.startedAt)}</time><div class="it-b">
    <h2><span class="t">Posts for ${esc(day.toLowerCase() === "today" || day.toLowerCase() === "tomorrow" ? day.toLowerCase() : day)}</span></h2>
    <p class="meta">${esc(meta)}</p>
    <div class="ls">${p.items.map((i) => `<div class="ls-r${i.state === "posted" ? " done" : i.state === "skipped" ? " muted" : ""}"><span class="t">${esc(i.time ?? "")}</span><span class="x">${esc(i.title)}<small>${esc(i.handles.join(", "))}</small></span><span class="r">${i.state === "posted" ? "Posted" : i.state === "skipped" ? "Skipped" : ""}</span></div>`).join("")}</div>
    ${planned && p.posting === "ask" ? `<div class="acts"><button class="btn btn-q" data-say="Post today's channel plan.">Ask your agent to post the plan</button></div>` : ""}
  </div></article>`;
}

/* ---------- a run ---------- */
const jobFor = (runId, n) => S.jobs.find((j) => j.runId === runId && j.ns.includes(n) && (j.state === "running" || j.state === "queued"));

function clipRow(r, c) {
  const open = S.open[r.id] === c.n, job = jobFor(r.id, c.n);
  const keeps = c.judgment == null ? "" : c.judgmentStale ? `keeps watching ${c.judgment}/5 before the re-render` : `keeps watching ${c.judgment}/5`;
  const meta = [c.band, c.replayTop != null ? `replayed top ${c.replayTop}%` : "", keeps, c.seconds ? mmss(c.seconds) : ""].filter(Boolean).join(" · ");
  return `<button type="button" class="cl${c.rendered ? "" : " pending"}" data-clip="${c.n}" aria-expanded="${open}" data-key="c-${c.n}">
      <span class="rk">${c.n}</span>${still(c.thumb, "", c.thumbV)}
      <span class="mn0"><span class="t">${esc(c.title)}</span><span class="m">${esc(meta)}</span></span>
      <span class="s">${job ? '<span class="spin" aria-label="Rendering"></span>' : ""}${c.score ?? ""}</span>
    </button>${open ? clipOpen(r, c, job) : ""}`;
}

function clipOpen(r, c, job) {
  const err = S.jobErrors[`${r.id}:${c.n}`];
  const ctx = { stands: "Opens on its own", bridged: "Opens on its own, with a bridge line", context: "Needs the episode", fails: "Doesn’t stand alone" }[c.standalone] ?? "";
  const player = c.video
    ? `<video data-keep data-key="v-${c.n}-${c.videoV}" src="${media(c.video, c.videoV)}" ${c.thumb ? `poster="${media(c.thumb, c.thumbV)}"` : ""} controls playsinline preload="metadata"></video>`
    : still(c.thumb, "", c.thumbV);
  const styleOptions = (r.styles ?? []).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  const local = !r.canRender ? `<p class="note">Rendering here needs the boqo-clips skill on this computer. Ask your agent instead.</p>`
    : c.rendered
      ? `<div class="row-acts"><label class="sr" for="st-${c.n}">Caption style</label><select class="sel" id="st-${c.n}" data-style-for="${c.n}"><option value="">Same captions</option>${styleOptions}</select>
         <button class="btn" data-render="${c.n}" ${job ? "disabled" : ""}>${job ? (job.phase === "fetch" ? "Downloading the part…" : "Rendering…") : "Re-render"}</button></div>`
      : `<div class="row-acts"><button class="btn btn-p" data-render="${c.n}" ${job ? "disabled" : ""}>${job ? (job.phase === "fetch" ? "Downloading the part…" : "Rendering…") : "Render This Clip"}</button><span class="note">On this computer, no credits. If the part of the video is gone, it’s downloaded again first.</span></div>`;
  return `<div class="open" data-key="o-${c.n}">${player}<div class="open-b">
      ${c.why ? `<p class="quote">${c.judgmentStale ? "Before the re-render: " : ""}“${esc(c.why)}”</p>` : ""}
      <dl class="kv">${["Hook", "Flow", "Stands alone", "Value"].map((a, k) => (c.axes[k] != null ? `<dt>${a}</dt><dd>${c.axes[k]}</dd>` : "")).join("")}${ctx ? `<dt>Context</dt><dd>${ctx}</dd>` : ""}${c.start != null ? `<dt>From the source</dt><dd>${hms(c.start)} to ${hms(c.end)}</dd>` : ""}</dl>
      ${local}
      ${err ? `<p class="note err">${esc(err)}</p>` : ""}
      <div class="acts"><button class="btn btn-q" data-focus-chat>Ask your agent about this clip</button></div>
    </div></div>`;
}

function viewRun(r) {
  if (!r) return `<div class="page">${backLink()}</div>`;
  if (r.missing) return `<div class="page">${backLink()}<div class="empty"><b>This run isn’t here</b><span>It may have been moved or deleted from ~/.boqo.</span></div></div>`;
  const rendered = r.clips.filter((c) => c.rendered), pending = r.clips.filter((c) => !c.rendered);
  const src = r.sourceUrl ? r.sourceUrl.replace(/^https?:\/\/(www\.)?/, "") : "";
  const meta = [r.duration ? hms(r.duration) : "", esc(src), r.posted ? `${r.posted} posted` : ""].filter(Boolean).join(" · ");
  const said = [r.noSpeech ? "No speech heard in this video, so there was nothing to clip." : "", ...(r.notes ?? []).map(esc)].filter(Boolean);
  return `<div class="page">${backLink()}
    <div class="dt"><h1>${esc(r.title)}</h1>${meta ? `<p class="meta">${meta}</p>` : ""}
      ${said.map((s) => `<p class="note">${s}</p>`).join("")}
      ${r.done || r.noSpeech ? "" : steps(r.steps)}
      <div class="acts"><button class="btn btn-q" data-copy="${esc(r.runDir)}">${ic("copy")}Copy folder path</button>
        ${pending.length && r.canRender ? `<button class="btn btn-q" data-render-all>Render ${pending.length} more</button>` : ""}</div></div>
    ${rendered.length ? `<div class="day">In boqo’s order</div>${rendered.map((c) => clipRow(r, c)).join("")}` : r.clips.length || r.noSpeech ? "" : `<div class="empty"><span>Clips show up here as your agent picks them.</span></div>`}
    ${pending.length ? `<div class="day">Picked, not rendered</div>${pending.map((c) => clipRow(r, c)).join("")}` : ""}
  </div>`;
}

/* ---------- a live watch ---------- */
function viewWatch(w) {
  if (!w) return `<div class="page">${backLink()}</div>`;
  if (w.missing) return `<div class="page">${backLink()}<div class="empty"><b>This watch isn’t here</b></div></div>`;
  return `<div class="page">${backLink()}
    <div class="dt"><h1 class="h1-live">${w.live ? '<span class="live-dot" aria-hidden="true"></span>' : ""}${esc(w.channel)}</h1>
      <p class="meta">${watchMeta(w)}${w.since ? ` · since ${clock(w.since)}` : ""}</p>
      <div class="nums">${w.chatPerSec != null && w.live ? `<span><b>${w.chatPerSec.toFixed(1)}</b>chat/s</span>` : ""}<span><b>${w.momentsCount}</b>moments</span><span><b>${w.clipped}</b>clipped</span></div>
      ${w.live ? spark(w.series, 600, 64) : ""}</div>
    <div class="day">Moments</div>
    ${w.moments.length ? momentRows(w.moments) : `<div class="empty"><span>Waiting for the first spike in chat or sound.</span></div>`}
  </div>`;
}

/* ---------- chat ---------- */
/**
 * The agent writes markdown. Escape everything first, then turn the few marks it uses into
 * HTML: fenced code, inline code, bold, bullet and numbered lists, paragraphs. Nothing the
 * agent writes can become markup of its own.
 */
export function md(text) {
  const blocks = String(text ?? "").replace(/\r/g, "").split(/\n```[^\n]*\n([\s\S]*?)\n```(?:\n|$)/);
  let out = "";
  blocks.forEach((b, i) => {
    if (i % 2 === 1) { out += `<pre>${esc(b)}</pre>`; return; }
    const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    let list = null;
    const close = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const para of b.split(/\n{2,}/)) {
      for (const line of para.split("\n")) {
        const ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ul || ol) {
          const kind = ul ? "ul" : "ol";
          if (list !== kind) { close(); out += `<${kind}>`; list = kind; }
          out += `<li>${inline((ul ?? ol)[1])}</li>`;
        } else if (line.trim()) { close(); out += `<p>${inline(line)}</p>`; }
      }
      close();
    }
  });
  return out;
}

const HINTS = {
  feed: ["Clip this video: ", "What did I post this week?"],
  run: ["Render the rest", "Why is the first clip first?"],
  runSilent: ["Why was no speech heard?", "Clip another video: "],
  clip: ["Start this clip 2 seconds earlier", "Write three other titles for this clip", "Post this clip tomorrow at 9:00"],
  watch: ["Stop watching", "Clip the last minute now"],
};

function renderChat() {
  const r = route(), tid = threadFor(r), t = S.threads[tid] ?? { messages: [] };
  // The running turn, known from /api/state on load and from "turn" events after: a page opened
  // or reloaded mid-turn still knows it, and every view can stop it.
  const busy = S.state?.busy ?? null, busyHere = busy?.threadId === tid, busyElsewhere = !!busy && !busyHere;
  const live = S.live[tid] ?? (busyHere ? { text: "", tools: [] } : null);
  const info = S.state?.settings?.agent;
  const agent = info?.usable ? info : null;
  const ctx = chatContext(r);
  const about = r.view === "run" ? (S.run?.title ? `${S.run.title}${ctx?.clip ? ` · clip ${ctx.clip}` : ""}` : "") : r.view === "watch" ? (S.watch?.channel ?? "") : "Everything on this computer";
  const hintKey = r.view === "run" ? (ctx?.clip ? "clip" : S.run?.noSpeech ? "runSilent" : "run") : r.view;

  const msgs = t.messages.map((m, i) => m.role === "you"
    ? `<div class="m-you" data-key="h${i}">${esc(m.text)}</div>`
    : `<div class="m-ag" data-key="h${i}">${toolsHtml(m.tools)}${m.text ? `<div class="md">${md(m.text)}</div>` : ""}${m.error ? `<div class="err">${esc(m.error)}</div>` : ""}${m.costUsd ? `<span class="cost">$${m.costUsd.toFixed(2)} on your ${esc(m.agent ?? "agent")} plan</span>` : ""}</div>`).join("");
  const streaming = live ? `<div class="m-ag" data-key="live">${toolsHtml(live.tools)}${live.text ? `<div class="md">${md(live.text)}</div>` : ""}<div class="working"><span class="spin agent"></span>${live.text ? "" : esc(agent?.label ?? "Your agent")} working</div></div>` : "";
  const empty = !t.messages.length && !live
    ? `<div class="ch-hint">${agent ? `<span>Ask Claude Code to change, render or post anything here. It runs on this computer.</span>${(HINTS[hintKey] ?? []).map((h) => `<button data-hint="${esc(h)}">${esc(h)}</button>`).join("")}` : `<span>${info?.installed ? "Claude Code is installed through npm, which the dashboard can’t start safely on Windows. Install it with its own installer, then reload this page." : "The chat needs Claude Code on this computer. Install it, then reload this page. Everything else here works without it."}</span>`}</div>`
    : "";

  morph($("#chat"), `
    <div class="ch-top"><b>Your agent</b><span>${esc(about)}</span></div>
    ${busy ? `<div class="ch-turn" role="status"><span class="spin agent" aria-hidden="true"></span><span class="t">Claude Code is working on ${esc(busy.label)}</span><button type="button" class="btn btn-q" data-chat-stop>Stop</button></div>` : ""}
    <div class="ch-log" id="chlog">${msgs}${streaming}${empty}</div>
    <div class="ch-in">
      <div class="ch-box"><label class="sr" for="chin">Message your agent</label><textarea id="chin" rows="1" placeholder="${agent ? `Message ${esc(agent.label)}` : "No agent found"}" ${agent ? "" : "disabled"}></textarea>
        ${busyHere ? `<button class="btn" data-chat-stop aria-label="Stop">${ic("stop")}</button>` : `<button class="btn btn-p" data-chat-send aria-label="Send" ${agent && !busy ? "" : "disabled"}>${ic("send")}</button>`}</div>
      <div class="ch-foot"><span>Claude Code</span><span>${busyElsewhere ? "Working in another chat" : "Uses your Claude plan"}</span></div>
    </div>`);
}
const toolsHtml = (tools) => (tools?.length ? `<div class="tools">${tools.slice(-4).map((x) => `<span>${esc(toolLabel(x))}</span>`).join("")}${tools.length > 4 ? `<span>and ${tools.length - 4} more steps</span>` : ""}</div>` : "");
/** Agent steps in plain words, with paths shortened to what's inside the boqo home. */
function shortPaths(s) {
  let t = String(s ?? "").replace(/^cd\s+\S+\s*&&\s*/, "");
  const home = S.state?.home;
  if (home) t = t.split(home + "/").join("").split(home).join("~/.boqo");
  return t.replace(/(?:[\w.-]+\/){3,}([\w.-]+\/[\w.-]+)/g, "…/$1");
}
const toolLabel = (x) => {
  const d = shortPaths(x.detail);
  if (/^(Bash|command_execution|shell)$/i.test(x.name)) return `Ran ${d}`;
  if (/^(Read|read)$/.test(x.name)) return `Read ${d}`;
  if (/^(Write|Edit|write|edit)$/.test(x.name)) return `Changed ${d}`;
  if (/^mcp__/.test(x.name)) return `boqo: ${x.name.split("__").pop().replace(/_/g, " ")}`;
  return `${x.name}${d ? ` ${d}` : ""}`;
};

function scrollChat(force) {
  const log = $("#chlog");
  if (!log) return;
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}

async function sendChat() {
  const box = $("#chin");
  const text = box?.value.trim();
  if (!text) return;
  const r = await post(`/api/thread/${threadFor()}`, { text, context: chatContext() });
  if (!r.ok) { toast(r.error === "busy" ? "Claude Code is still answering another message." : r.error ?? "Couldn’t reach Claude Code."); return; }
  box.value = ""; box.style.height = "";
}

/* ---------- events from the server ---------- */
let refreshTimer = null;
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "changed") { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load(false), 150); }
    if (msg.type === "jobs") { S.jobs = msg.jobs; render(); }
    if (msg.type === "job") {
      const { runId, ns, error, errors = {} } = msg.job;
      for (const n of ns) {
        const e = error ?? errors[n];
        if (e) S.jobErrors[`${runId}:${n}`] = e; else delete S.jobErrors[`${runId}:${n}`];
      }
      render();
    }
    if (msg.type === "chat") onChat(msg.threadId, msg.event);
    if (msg.type === "turn") { if (S.state) S.state.busy = msg.busy; renderChat(); }
  };
  es.onerror = () => {}; // EventSource reconnects by itself
}

function onChat(tid, ev) {
  const t = (S.threads[tid] ??= { messages: [], busy: false });
  if (ev.kind === "user") t.messages.push({ role: "you", text: ev.text, at: ev.at });
  if (ev.kind === "busy") S.live[tid] = { text: "", tools: [] };
  // a page that opened mid-turn picks the reply up from wherever it is
  if (!S.live[tid] && (ev.kind === "delta" || ev.kind === "text" || ev.kind === "tool")) S.live[tid] = { text: "", tools: [] };
  const live = S.live[tid];
  if (live && ev.kind === "delta") live.text += ev.text;
  if (live && ev.kind === "text") live.text += (live.text ? "\n\n" : "") + ev.text;
  if (live && ev.kind === "tool") live.tools.push({ name: ev.name, detail: ev.detail });
  if (ev.kind === "end") {
    t.messages.push({ role: "agent", text: ev.text, tools: ev.tools, costUsd: ev.costUsd, error: ev.error, agent: "Claude Code" });
    delete S.live[tid];
    if (S.state) S.state.busy = null;
  }
  if (tid === threadFor()) { renderChat(); scrollChat(ev.kind === "user"); }
}

/* ---------- interactions ---------- */
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600); }

document.addEventListener("click", async (e) => {
  const t = e.target;
  const nav = t.closest("a[data-nav]");
  if (nav && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); go(nav.getAttribute("href")); return; }
  const cp = t.closest("[data-copy]");
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast("Copied"); } catch { toast(cp.dataset.copy); } return; }
  const cl = t.closest("[data-clip]");
  if (cl && S.run) { const n = Number(cl.dataset.clip); S.open[S.run.id] = S.open[S.run.id] === n ? null : n; render(); return; }
  const rd = t.closest("[data-render]");
  if (rd && S.run) {
    const n = Number(rd.dataset.render), style = $(`[data-style-for="${n}"]`)?.value || undefined;
    delete S.jobErrors[`${S.run.id}:${n}`];
    const r = await post("/api/job", { run: S.run.id, n: [n], style });
    if (!r.ok) toast(r.error ?? "Couldn’t start the render.");
    return;
  }
  if (t.closest("[data-render-all]") && S.run) {
    const ns = S.run.clips.filter((c) => !c.rendered).map((c) => c.n);
    const r = await post("/api/job", { run: S.run.id, n: ns });
    if (!r.ok) toast(r.error ?? "Couldn’t start the render.");
    return;
  }
  const say = t.closest("[data-say]");
  if (say) { const box = $("#chin"); if (box) { box.value = say.dataset.say; box.focus(); } return; }
  const hint = t.closest("[data-hint]");
  if (hint) { const box = $("#chin"); if (box) { box.value = hint.dataset.hint; box.focus(); box.setSelectionRange(box.value.length, box.value.length); } return; }
  if (t.closest("[data-focus-chat]")) { $("#chin")?.focus(); return; }
  if (t.closest("[data-chat-send]")) { sendChat(); return; }
  if (t.closest("[data-chat-stop]")) {
    const r = await post("/api/thread-stop", {});
    toast(r.stopped ? "Stopping Claude Code and anything it started…" : "Nothing is running.");
    return;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "chin" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "chin") { e.target.style.height = "auto"; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; }
});

connect();
load(true);
