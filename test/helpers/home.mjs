// A boqo home laid out the way the skills write it (boqo-clips, boqo-sniper, boqo-channel
// p0b; field names from engine/clips-record.mjs, tools/watch.mjs, lib/plan.mjs).
// Example data is fictional. Media files are placeholders unless `media` writes real ones.
import fs from "node:fs";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");
const localStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const utcStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const w = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2)); };

export const CLIPS = [
  [91, [94, 88, 90, 86], 4, 5, "stands", "We sold out by 9 a.m. on day one", 82, 39, "A number, a setup and a laugh at the end."],
  [88, [90, 85, 84, 88], 9, 4, "stands", "The oven that almost sank us", 240, 42, "Clear stakes from the first line; ends a little early."],
  [86, [92, 80, 78, 90], 12, 4, "stands", "400 people came from one Reel", 860, 42, "Strong opener; the middle explains too long."],
  [85, [86, 84, 88, 80], 15, 4, "stands", "The landlord’s one condition", 455, 58, "A complete small story."],
  [84, [80, 86, 82, 90], 22, 4, "stands", "Why we never discount bread", 610, 45, "An opinion people will argue with."],
  [79, [82, 78, 80, 74], 30, 3, "stands", "Hiring my first baker", 330, 34, "Warm, but the face is off frame for a moment."],
  [76, [70, 80, 74, 82], 35, 3, "context", "The first month’s numbers", 980, 51, "Opens on “so that month”; needs the episode."],
  [74, [72, 76, 78, 70], 41, 3, "stands", "What I’d do differently", 1060, 36, "Fine advice; nothing surprising."],
  [72, [78, 70, 64, 72], 18, 4, "bridged", "The neighbour’s pizza oven", 285, 28, "Funny and quick, but needs the setup."],
  [70, [64, 74, 76, 72], 52, 2, "stands", "Sourdough is a schedule, not a recipe", 720, 47, "Slow start."],
  [68, [70, 66, 72, 64], 48, null, "stands", "Naming the bakery", 150, 33, null],
  [66, [62, 70, 68, 66], 57, null, "stands", "The flour supplier who said no", 520, 40, null],
  [63, [60, 66, 64, 62], 63, null, "context", "Bread at 4 a.m. is quiet", 40, 30, null],
  [58, [54, 62, 58, 60], 70, null, "stands", "Pricing a croissant", 790, 44, null],
];

/**
 * @param {string} home  folder to fill
 * @param {object} o
 * @param {Date}   o.now
 * @param {(file:string, kind:"jpg"|"mp4", i:number)=>void} [o.media]  writes real media; placeholders otherwise
 * @param {number} [o.rendered]  how many of the done run's clips are rendered (default 10)
 */
export function makeHome(home, { now = new Date(), media, rendered = 10 } = {}) {
  const put = (file, kind, i) => (media ? media(file, kind, i) : w(file, kind === "jpg" ? "jpg" : "mp4"));
  const at = (mins) => new Date(now.getTime() - mins * 60000);

  // brand kits
  w(path.join(home, "brands", "longtable", "brand.json"), { version: 2, name: "The Long Table", ratio: "9:16", captions: { style: "punch", accentColours: ["#FF8A3D"], positionFraction: 0.62 }, headline: { style: "plate", seconds: 12 }, logo: { file: "logo.png", anchor: "top-left", width: 0.12, opacity: 0.9 } });
  put(path.join(home, "brands", "longtable", "logo.png"), "jpg", 0);
  w(path.join(home, "brands", "default.txt"), "longtable\n");

  // a finished clips run
  const doneName = `${localStamp(at(240))}-lt48-bakery`;
  const done = path.join(home, "boqo-clips", "runs", doneName);
  w(path.join(done, "words.json"), [{ w: "So", s: 0, e: 0.2 }]);
  w(path.join(done, "transcript.md"), "# transcript\n");
  w(path.join(done, "select-request.md"), "request\n");
  w(path.join(done, "info.json"), { title: "Opening a Bakery With No Money", webpage_url: "https://www.youtube.com/watch?v=lt48-bakery", formats: [{ url: "https://example.invalid/signed?sig=SECRET" }] });
  w(path.join(done, "upload-01.json"), { url: "https://example.invalid/upload?sig=SECRET" });
  const rows = CLIPS.map(([score, ax, pct, j, outcome, title, start, len, why], i) => {
    const n = i + 1, isRendered = i < rendered;
    const row = { n, start, end: start + len, title, title_alternatives: [], hook: "", score, axes: { hook: ax[0], flow: ax[1], standalone: ax[2], value: ax[3] }, emphasis_words: [], standalone: { v: 1, outcome }, replay: { pct: 1 - pct / 100, mean: 0.5 }, judgment: isRendered && j != null ? { overall: j, why, annotation: {} } : null, panels: null, rendered: isRendered, file: null, notes: [] };
    if (isRendered) {
      row.file = `out/clip-${pad(n)}.mp4`; row.thumb = `out/clip-${pad(n)}.jpg`; row.seconds = len; row.window = { start, end: start + len };
      put(path.join(done, row.file), "mp4", i); put(path.join(done, row.thumb), "jpg", i);
    }
    return row;
  });
  w(path.join(done, "clips.json"), { version: 1, video: { id: "lt48-bakery", title: "Opening a Bakery With No Money", duration: 1120, language: "en" }, target: 19, cap: 24, clips: rows });
  w(path.join(home, "boqo-clips", "runs.md"), `${at(240).toISOString().slice(0, 16).replace("T", " ")} | https://www.youtube.com/watch?v=lt48-bakery | 14 clips | ${path.join(done, "out")} | posted 3\n`);
  w(path.join(home, "boqo-clips", "config.json"), { posting: "ask", accounts: ["acct-1"], transcript: "local" });

  // a run in progress: the agent is reading the transcript
  const workName = `${localStamp(at(4))}-kitchen-hours-12`;
  const work = path.join(home, "boqo-clips", "runs", workName);
  w(path.join(work, "info.json"), { title: "Knife Skills in Ten Minutes" });
  w(path.join(work, "words.json"), [{ w: "Hold", s: 0, e: 0.3 }]);
  w(path.join(work, "select-request.md"), "request\n");

  // a live Stream Sniper watch
  const wStart = at(80);
  const sess = path.join(home, "boqo-sniper", "watch", "twitch-nova_plays", utcStamp(wStart));
  w(path.join(sess, "status.json"), { state: "live", platform: "twitch", channel: "nova_plays", since: wStart.toISOString(), segments: 480, moments: 3, skipped: { queue: 0, disk: 0 }, chatPerSec: 9.4, updatedAt: now.toISOString() });
  const moments = [
    ["m1", at(60), 91, "“LOL” ×38 · 41 msg/s", "The boss fight ends on one hit point", true],
    ["m2", at(40), 54, "Audio +9 LU", null, false],
    ["m3", at(10), 88, "“KEKW” ×41 · 44 msg/s", "Three missed jumps in a row", true],
  ];
  for (const [id, t, score, signal, title, clipped] of moments) {
    w(path.join(sess, "moments", id, "meta.json"), { peakAt: 0, score, signal: "chat", title: null, signalLine: signal, peakIso: t.toISOString(), platform: "twitch", channel: "nova_plays" });
    if (clipped) {
      const cdir = path.join(home, "boqo-sniper", "clips", "twitch-nova_plays", id);
      w(path.join(cdir, "clips.json"), { version: 1, clips: [{ n: 1, start: 0, end: 34, title, score, axes: {}, rendered: true, file: "out/clip-01.mp4", thumb: "out/clip-01.jpg", seconds: 34 }] });
      put(path.join(cdir, "out", "clip-01.mp4"), "mp4", 3); put(path.join(cdir, "out", "clip-01.jpg"), "jpg", 3);
    }
  }

  // today's channel plan, made at 06:00
  const planDay = new Date(now); planDay.setHours(6, 0, 0, 0);
  const date = `${planDay.getFullYear()}-${pad(planDay.getMonth() + 1)}-${pad(planDay.getDate())}`;
  w(path.join(home, "boqo-channel", "runs", localStamp(planDay), "plan.json"), [
    ["09:00", "The flour supplier who said no", "@longtable.clips", true],
    ["12:00", "Why a dull knife cuts you", "@kitchenhours", false],
    ["17:30", "Dicing an onion in 20 seconds", "@kitchenhours", false],
    ["20:15", "Regulars by week three", "@longtable.clips", false],
  ].map(([time, title, handle, posted], i) => ({ clip: i + 1, title, hook: "", video: "vid" + i, start: 0, end: 30, channel: handle.includes("kitchen") ? "@kitchenhours" : "@longtablepod", accountIds: ["a"], handles: [handle], when: { date, time }, ...(posted ? { posted: new Date().toISOString() } : {}) })));
  w(path.join(home, "boqo-channel", "config.json"), { channels: [], posting: "ask" });

  return { doneName, workName, watchId: `twitch-nova_plays/${utcStamp(wStart)}`, done, sess };
}
