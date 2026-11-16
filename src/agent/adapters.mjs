// How the chat talks to Claude Code: start a turn, resume a session, and read its JSON lines
// into the few events the page shows. Claude Code only for now (owner, 2026-11-16).
// Shapes measured 2026-11-16 against Claude Code 2.1.325 (test/fixtures/relay/claude.jsonl).
//
// Normalised events:
//   { kind: "session", id }           the session id, kept to resume later
//   { kind: "delta", text }           a piece of the reply while it streams
//   { kind: "tool", name, detail }    the agent ran something (a command, a file read, an MCP tool)
//   { kind: "done", text, costUsd, error }

const firstLine = (s, n = 140) => {
  const t = String(s ?? "").split("\n")[0].trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function toolDetail(input) {
  if (!input || typeof input !== "object") return "";
  if (input.command) return firstLine(input.command);
  if (input.file_path) return firstLine(input.file_path);
  if (input.path) return firstLine(input.path);
  if (input.pattern) return firstLine(input.pattern);
  return firstLine(JSON.stringify(input));
}

export const CLAUDE = {
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  /**
   * `--session-id` starts a session under an id we choose; `--resume` continues it.
   * Tools the skill needs are allowed up front, because nobody is there to click Allow.
   */
  args({ prompt, sessionId, resume, system, allowedTools }) {
    // acceptEdits: file edits the skill needs (selection.json, clips.json) are accepted inside the
    // working folder, which the relay sets to the boqo home; anything else still needs the allow-list.
    const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"];
    a.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
    if (system) a.push("--append-system-prompt", system);
    if (allowedTools?.length) a.push("--allowedTools", ...allowedTools);
    return a;
  },
  parse(e) {
    const out = [];
    if (e.type === "system" && e.subtype === "init" && e.session_id) out.push({ kind: "session", id: e.session_id });
    if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
      out.push({ kind: "delta", text: e.event.delta.text });
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c.type === "tool_use") out.push({ kind: "tool", name: c.name, detail: toolDetail(c.input) });
    }
    if (e.type === "result") {
      out.push({ kind: "done", text: typeof e.result === "string" ? e.result : "", costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null, error: e.is_error ? firstLine(e.result || e.subtype) : null });
    }
    return out;
  },
};

/** Split a byte stream into JSON objects, one per line; junk lines are skipped, not fatal. */
export function lineParser(onObject) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { /* a log line, not an event */ }
    }
  };
}
