// The chat panel's bridge to Claude Code. Each message starts `claude -p`, resuming the
// thread's session, and streams its events to the page. One turn runs at a time across the
// whole app: two turns editing one run folder at once would race on clips.json.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE, lineParser } from "./adapters.mjs";
import { ensureDir, readJson, writeJson, statSafe } from "../home.mjs";
import os from "node:os";

const isWin = process.platform === "win32";

/** The full path of a command on PATH, or null. On Windows an .exe is preferred over a shim. */
export function resolveBin(bin) {
  const r = spawnSync(isWin ? "where" : "which", [bin], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const all = r.stdout.trim().split(/\r?\n/);
  return (isWin && all.find((p) => /\.exe$/i.test(p))) || all[0];
}

/**
 * Claude Code is started without a shell, so nothing in the message or the context (a video
 * title, say) can become a command. On Windows that rules out an npm .cmd shim, which only
 * a shell can run; the page then asks for the native install.
 */
export const shimOnly = (exe) => isWin && /\.(cmd|bat|ps1)$/i.test(exe);

/** Is Claude Code here, and can the chat start it? */
export function detectAgent() {
  const p = resolveBin(CLAUDE.bin);
  if (!p) return { label: CLAUDE.label, installed: false, usable: false };
  return { label: CLAUDE.label, installed: true, usable: !shimOnly(p) };
}

export function createRelay({ home, localDir, bus, settings, log = () => {} }) {
  const dir = ensureDir(path.join(localDir, "threads"));
  let running = null; // { threadId, child }

  const metaFile = (id) => path.join(dir, `${id}.json`);
  const logFile = (id) => path.join(dir, `${id}.jsonl`);
  const safeId = (id) => /^[a-z0-9-]{1,80}$/i.test(id);

  function readThread(id) {
    if (!safeId(id)) return null;
    const meta = readJson(metaFile(id)) ?? { id, sessionId: null, startedAt: null };
    let messages = [];
    try {
      messages = fs.readFileSync(logFile(id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* new thread */ }
    return { ...meta, messages, busy: running?.threadId === id };
  }

  function append(id, msg) {
    fs.appendFileSync(logFile(id), JSON.stringify(msg) + "\n", { mode: 0o600 });
  }

  /**
   * Send one message. `context` is the page's selection (run folder, clip) and becomes the
   * standing instructions for the turn.
   */
  function send(threadId, text, context) {
    if (!safeId(threadId)) return { error: "bad thread" };
    if (running) return { error: "busy", threadId: running.threadId };
    const exe = resolveBin(CLAUDE.bin);
    if (!exe) return { error: "Claude Code isn't installed on this computer." };
    if (shimOnly(exe)) return { error: "Claude Code is installed through npm here, which the dashboard can't start safely on Windows. Install it with its own installer." };

    const meta = readJson(metaFile(threadId)) ?? { id: threadId, sessionId: null, startedAt: new Date().toISOString() };
    const resume = !!meta.sessionId;
    if (!resume) meta.sessionId = crypto.randomUUID();
    writeJson(metaFile(threadId), meta);

    const at = new Date().toISOString();
    append(threadId, { role: "you", text, at, context: context?.label ?? null });
    bus.emit({ type: "chat", threadId, event: { kind: "user", text, at } });

    const args = CLAUDE.args({ prompt: text, sessionId: meta.sessionId, resume, system: systemPrompt(home, context), allowedTools: settings().allowedTools });
    log(`claude ${resume ? "resume" : "start"} thread=${threadId}`);
    const child = spawn(exe, args, { cwd: home, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    running = { threadId, child };
    bus.emit({ type: "chat", threadId, event: { kind: "busy", agent: CLAUDE.label } });

    let streamed = "", tools = [], final = null;
    const onEvent = (ev) => {
      // A resumed session can come back under a new id; always keep the latest one.
      if (ev.kind === "session" && ev.id !== meta.sessionId) { meta.sessionId = ev.id; writeJson(metaFile(threadId), meta); }
      if (ev.kind === "delta") streamed += ev.text;
      if (ev.kind === "tool") tools.push({ name: ev.name, detail: ev.detail });
      if (ev.kind === "done") final = ev;
      if (ev.kind !== "session") bus.emit({ type: "chat", threadId, event: ev });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", lineParser((o) => CLAUDE.parse(o).forEach(onEvent)));
    let errTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });

    const finish = (code) => {
      if (running?.child !== child) return;
      running = null;
      const textOut = (final?.text || streamed).trim();
      const error = final?.error ?? (code !== 0 && !textOut ? lastMeaningfulLine(errTail) || `Claude Code stopped (exit ${code})` : null);
      append(threadId, { role: "agent", agent: CLAUDE.label, text: textOut, tools, costUsd: final?.costUsd ?? null, error, at: new Date().toISOString() });
      bus.emit({ type: "chat", threadId, event: { kind: "end", text: textOut, tools, costUsd: final?.costUsd ?? null, error } });
      bus.emit({ type: "changed" }); // the agent may have rendered or posted something
    };
    child.on("close", finish);
    child.on("error", (err) => { errTail += String(err.message); finish(-1); });
    return { ok: true };
  }

  function stop() {
    if (!running) return false;
    try { running.child.kill(isWin ? undefined : "SIGINT"); } catch { /* already gone */ }
    return true;
  }

  return { readThread, send, stop, busy: () => running?.threadId ?? null };
}

function lastMeaningfulLine(s) {
  const lines = String(s).split("\n").map((l) => l.trim()).filter((l) => l && !/^\d{4}-\d\d-\d\dT/.test(l));
  return lines.at(-1)?.slice(0, 200) ?? "";
}

/**
 * The skills' code, where INSTALL.md puts it (~/.boqo-<skill>), or BOQO_CLIPS_DIR for boqo-clips.
 * Measured 2026-11-16: without this, an agent asked for a re-render searched the home folder for
 * the skill and stopped when the searches needed approval.
 */
export function installedSkills(env = process.env) {
  return ["boqo-clips", "boqo-channel", "boqo-sniper"].map((name) => {
    const root = name === "boqo-clips" && env.BOQO_CLIPS_DIR ? env.BOQO_CLIPS_DIR : path.join(os.homedir(), `.${name}`);
    const skill = path.join(root, "skills", name, "SKILL.md");
    return statSafe(skill) ? { name, root, skill } : null;
  }).filter(Boolean);
}

/** The standing instructions for a dashboard turn. Short: the page shows the clips itself. */
export function systemPrompt(home, ctx) {
  const lines = [
    "The person is talking to you from the boqo dashboard on their computer, not the terminal.",
    `Their boqo files are in ${home}. Follow the boqo skill that made the files for anything you change.`,
    ...installedSkills().map((s) => `The ${s.name} skill is installed at ${s.root}: its instructions are ${s.skill}, its tools are in ${path.join(s.root, "tools")}.`),
    "Write commands with absolute paths and no shell variables ($HOME, ${…}): commands with variables can't be approved here, so they fail.",
    "Answer briefly, in plain sentences. The dashboard already shows the clips, scores and progress, so don't repeat lists or tables.",
    "Posting follows the skill's posting rule; a request typed here is the person's own yes for exactly what they asked.",
  ];
  if (ctx?.runDir) lines.push(`They have this run open: ${ctx.runDir}${ctx.title ? ` ("${ctx.title}")` : ""}.`);
  if (ctx?.clip) lines.push(`The selected clip is #${ctx.clip.rank} "${ctx.clip.title}"${ctx.clip.file ? `, file ${ctx.clip.file}` : ""}${ctx.clip.start != null ? `, ${ctx.clip.start}s to ${ctx.clip.end}s of the source` : ""}.`);
  if (ctx?.watch) lines.push(`They have the Stream Sniper watch on ${ctx.watch} open.`);
  return lines.join("\n");
}
