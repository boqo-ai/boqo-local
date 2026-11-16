// The chat panel's bridge to the person's own agent. Each message starts the agent CLI in
// print mode, resuming the thread's session, and streams its events to the page.
// One turn runs at a time across the whole app: two agents editing one run folder at once
// would race on clips.json.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ADAPTERS, lineParser } from "./adapters.mjs";
import { ensureDir, readJson, writeJson } from "../home.mjs";

const isWin = process.platform === "win32";

/** The full path of a command on PATH, or null. On Windows an .exe is preferred over a shim. */
export function resolveBin(bin) {
  const r = spawnSync(isWin ? "where" : "which", [bin], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const all = r.stdout.trim().split(/\r?\n/);
  return (isWin && all.find((p) => /\.exe$/i.test(p))) || all[0];
}

/**
 * The agent is started without a shell, so nothing in the message or the context (a video
 * title, say) can become a command. On Windows that rules out .cmd/.bat shims, which only
 * a shell can run; the page then asks for the agent's native install.
 */
export const shimOnly = (exe) => isWin && /\.(cmd|bat|ps1)$/i.test(exe);

/** Which agent CLIs are on PATH. */
export function detectAgents() {
  const found = [];
  for (const a of Object.values(ADAPTERS)) {
    const p = resolveBin(a.bin);
    if (p) found.push({ id: a.id, label: a.label, path: p, usable: !shimOnly(p) });
  }
  return found;
}

export function createRelay({ home, localDir, bus, settings, log = () => {} }) {
  const dir = ensureDir(path.join(localDir, "threads"));
  let running = null; // { threadId, child }

  const metaFile = (id) => path.join(dir, `${id}.json`);
  const logFile = (id) => path.join(dir, `${id}.jsonl`);
  const safeId = (id) => /^[a-z0-9-]{1,80}$/i.test(id);

  function readThread(id) {
    if (!safeId(id)) return null;
    const meta = readJson(metaFile(id)) ?? { id, sessionId: null, agent: null, startedAt: null };
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
   * Send one message. `context` is the page's selection (run folder, clip, file) and becomes
   * the agent's standing instructions for this thread.
   */
  function send(threadId, text, context) {
    if (!safeId(threadId)) return { error: "bad thread" };
    if (running) return { error: "busy", threadId: running.threadId };
    const s = settings();
    const adapter = ADAPTERS[s.agent];
    if (!adapter) return { error: "no agent" };
    const exe = resolveBin(adapter.bin);
    if (!exe) return { error: `${adapter.label} isn't installed on this computer.` };
    if (shimOnly(exe)) return { error: `${adapter.label} is installed through npm here, which the dashboard can't start safely on Windows. Install it with its own installer.` };

    const meta = readJson(metaFile(threadId)) ?? { id: threadId, sessionId: null, agent: adapter.id, startedAt: new Date().toISOString() };
    if (meta.agent && meta.agent !== adapter.id) { meta.sessionId = null; } // switching agents starts a fresh session
    meta.agent = adapter.id;
    const resume = !!meta.sessionId;
    if (!resume && adapter.choosesSessionId) meta.sessionId = crypto.randomUUID();
    writeJson(metaFile(threadId), meta);

    const at = new Date().toISOString();
    append(threadId, { role: "you", text, at, context: context?.label ?? null });
    bus.emit({ type: "chat", threadId, event: { kind: "user", text, at } });

    const args = adapter.args({
      prompt: text,
      sessionId: meta.sessionId,
      resume,
      system: systemPrompt(home, context),
      allowedTools: s.allowedTools,
      sandbox: s.codexSandbox,
      force: s.cursorForce,
      cwdExtra: [],
    });
    log(`agent ${adapter.id} ${resume ? "resume" : "start"} thread=${threadId}`);
    const child = spawn(exe, args, { cwd: home, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    running = { threadId, child };
    bus.emit({ type: "chat", threadId, event: { kind: "busy", agent: adapter.label } });

    let streamed = "", tools = [], final = null;
    const onEvent = (ev) => {
      // A resumed session can come back under a new id; always keep the latest one.
      if (ev.kind === "session" && ev.id !== meta.sessionId) { meta.sessionId = ev.id; writeJson(metaFile(threadId), meta); }
      if (ev.kind === "delta") streamed += ev.text;
      if (ev.kind === "text") streamed += (streamed ? "\n\n" : "") + ev.text;
      if (ev.kind === "tool") tools.push({ name: ev.name, detail: ev.detail });
      if (ev.kind === "done") final = ev;
      if (ev.kind !== "session") bus.emit({ type: "chat", threadId, event: ev });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", lineParser((o) => adapter.parse(o).forEach(onEvent)));
    let errTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });

    const finish = (code) => {
      if (running?.child !== child) return;
      running = null;
      const textOut = (final?.text || streamed).trim();
      const error = final?.error ?? (code !== 0 && !textOut ? lastMeaningfulLine(errTail) || `${adapter.label} stopped (exit ${code})` : null);
      append(threadId, { role: "agent", agent: adapter.label, text: textOut, tools, costUsd: final?.costUsd ?? null, error, at: new Date().toISOString() });
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

/** The standing instructions for a dashboard thread. Short: the page shows the clips itself. */
export function systemPrompt(home, ctx) {
  const lines = [
    "The person is talking to you from the boqo dashboard on their computer, not the terminal.",
    `Their boqo files are in ${home}. Follow the boqo skill that made the files for anything you change (its SKILL.md).`,
    "Answer briefly, in plain sentences. The dashboard already shows the clips, scores and progress, so don't repeat lists or tables.",
    "Posting follows the skill's posting rule; a request typed here is the person's own yes for exactly what they asked.",
  ];
  if (ctx?.runDir) lines.push(`They have this run open: ${ctx.runDir}${ctx.title ? ` ("${ctx.title}")` : ""}.`);
  if (ctx?.clip) lines.push(`The selected clip is #${ctx.clip.rank} "${ctx.clip.title}"${ctx.clip.file ? `, file ${ctx.clip.file}` : ""}${ctx.clip.start != null ? `, ${ctx.clip.start}s to ${ctx.clip.end}s of the source` : ""}.`);
  if (ctx?.watch) lines.push(`They have the Stream Sniper watch on ${ctx.watch} open.`);
  return lines.join("\n");
}
