#!/usr/bin/env node
// A demo home with fictional example data: a finished run, a run that moves through its
// steps, a live Stream Sniper watch and a channel plan. Starts the dashboard on it.
//   node scripts/demo.mjs [--port 4190] [--keep]
// Real stills and clips are made with ffmpeg when it's on PATH; otherwise placeholders.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHome, CLIPS } from "../test/helpers/home.mjs";
import { startServer } from "../src/server.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "boqo-demo-"));
const COLORS = ["0x3b2a1f", "0x1f2b3b", "0x3a1f3b", "0x20351f", "0x2c2c44", "0x3b331f", "0x1f3b39"];
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function media(file, kind, i) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!hasFfmpeg) return fs.writeFileSync(file, kind);
  const c = COLORS[i % COLORS.length];
  const title = (CLIPS[i]?.[5] ?? "boqo").replace(/[’':]/g, "").split(" ").slice(0, 3).join(" ").toUpperCase();
  const draw = `drawbox=x=iw*0.32:y=ih*0.22:w=iw*0.36:h=iw*0.36:color=0xd9a07a@1:t=fill,drawbox=x=iw*0.16:y=ih*0.46:w=iw*0.68:h=ih*0.6:color=0x8e3b4a@1:t=fill,drawbox=x=iw*0.08:y=ih*0.07:w=iw*0.84:h=ih*0.07:color=0xc8ff4d@1:t=fill,drawtext=text='${title}':fontcolor=0x111111:fontsize=h*0.03:x=(w-tw)/2:y=h*0.092`;
  const make = (vf) => spawnSync("ffmpeg", ["-loglevel", "error", ...(kind === "jpg"
    ? ["-y", "-f", "lavfi", "-i", `color=c=${c}:s=360x640`, "-vf", vf, "-frames:v", "1", file]
    : ["-y", "-f", "lavfi", "-i", `color=c=${c}:s=360x640:d=4`, "-f", "lavfi", "-i", "sine=f=220:d=4", "-vf", vf, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file])]);
  // Homebrew's plain ffmpeg has no drawtext (no freetype); draw the frame without the title then.
  if (make(draw).status !== 0 && make(draw.replace(/,drawtext=.*$/, "")).status !== 0) fs.writeFileSync(file, kind);
}

const ids = makeHome(home, { media });
const srv = await startServer({ home, ports: [Number(arg("--port", 4190))], log: (m) => console.log(`[boqo] ${m}`), idleExit: false });
console.log(`demo home: ${home}\nboqo is running at ${srv.url}`);

// the working run moves on: picked after 6 s, then one clip renders every 3 s, then judging
const work = path.join(home, "boqo-clips", "runs", ids.workName);
const titles = ["Hold the knife like this", "The claw grip in one shot", "Why a dull knife cuts you", "Dicing an onion in 20 seconds", "The only three knives you need", "Honing is not sharpening", "Board slipping? A wet towel", "Julienne without the stress", "Mincing garlic, two ways", "Sharpen once a month"];
let tick = 0, rendered = 0;
const record = () => ({ version: 1, video: { id: "kh12", title: "Knife Skills in Ten Minutes", duration: 2300 }, target: 12, cap: 15, clips: titles.map((t, i) => ({ n: i + 1, start: 60 + i * 200, end: 95 + i * 200, title: t, score: 93 - i * 3, axes: { hook: 90 - i * 3, flow: 86 - i * 2, standalone: 88 - i * 3, value: 84 - i * 2 }, standalone: { outcome: "stands" }, replay: { pct: 1 - (5 + i * 6) / 100 }, judgment: i < rendered - 2 ? { overall: Math.max(2, 5 - Math.floor(i / 3)), why: "Clear and complete." } : null, rendered: i < rendered, file: i < rendered ? `out/clip-${String(i + 1).padStart(2, "0")}.mp4` : null, thumb: i < rendered ? `out/clip-${String(i + 1).padStart(2, "0")}.jpg` : null, seconds: 35 })) });
setInterval(() => {
  tick++;
  if (tick === 2) fs.writeFileSync(path.join(work, "clips.json"), JSON.stringify(record()));
  if (tick === 3) fs.writeFileSync(path.join(work, "sections.json"), "{}");
  if (tick > 3 && rendered < 10) {
    rendered++;
    const n = String(rendered).padStart(2, "0");
    media(path.join(work, "out", `clip-${n}.jpg`), "jpg", rendered + 2);
    media(path.join(work, "out", `clip-${n}.mp4`), "mp4", rendered + 2);
    fs.writeFileSync(path.join(work, "clips.json"), JSON.stringify(record()));
  } else if (rendered >= 10 && rendered < 12) { rendered++; fs.writeFileSync(path.join(work, "clips.json"), JSON.stringify(record())); }
}, 3000);

// the live watch: chat per second every 2 s, a new moment now and then
const status = path.join(ids.sess, "status.json");
let t2 = 0, moments = 3;
setInterval(() => {
  t2++;
  const st = JSON.parse(fs.readFileSync(status, "utf8"));
  const burst = t2 % 15 > 11 ? 18 + Math.random() * 10 : 0;
  st.chatPerSec = +(7 + Math.random() * 4 + Math.sin(t2 / 5) * 1.5 + burst).toFixed(1);
  st.updatedAt = new Date().toISOString();
  if (t2 % 15 === 13) {
    moments++;
    const id = `m${moments}`;
    fs.mkdirSync(path.join(ids.sess, "moments", id), { recursive: true });
    fs.writeFileSync(path.join(ids.sess, "moments", id, "meta.json"), JSON.stringify({ score: 70 + Math.round(Math.random() * 25), signalLine: "“no way” ×27 · 31 msg/s", peakIso: new Date().toISOString() }));
    fs.writeFileSync(path.join(ids.sess, "moments", id, ".taken"), "");
    st.moments = moments;
  }
  fs.writeFileSync(status, JSON.stringify(st));
}, 2000);

const quit = async () => { await srv.close(); if (!process.argv.includes("--keep")) fs.rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
