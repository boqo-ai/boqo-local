// One adapter per agent CLI: how to start a turn, how to resume a session, and how to read
// its JSON lines into the few events the page shows. Shapes measured 2026-11-16 against
// Claude Code 2.1.325, codex-cli 0.166.0 and cursor-agent 2026.11.05 (test/fixtures/relay).
//
// Normalised events:
//   { kind: "session", id }           the agent's session or thread id, kept to resume later
//   { kind: "delta", text }           a piece of the reply while it streams
//   { kind: "text", text }            a whole message (agents that don't stream)
//   { kind: "tool", name, detail }    the agent ran something (a command, a file read, an MCP tool)
//   { kind: "done", text, costUsd, error }

const firstLine = (s, n = 140) => {
  const t = String(s ?? "").split("\n")[0].trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function toolDetail(name, input) {
  if (!input || typeof input !== "object") return "";
  if (input.command) return firstLine(input.command);
  if (input.file_path) return firstLine(input.file_path);
  if (input.path) return firstLine(input.path);
  if (input.pattern) return firstLine(input.pattern);
  return firstLine(JSON.stringify(input));
}

export const ADAPTERS = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    /**
     * `--session-id` starts a session under an id we choose; `--resume` continues it.
     * Tools the skill needs are allowed up front, because nobody is there to click Allow.
     */
    args({ prompt, sessionId, resume, system, allowedTools, cwdExtra }) {
      const a = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
      a.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
      if (system) a.push("--append-system-prompt", system);
      if (allowedTools?.length) a.push("--allowedTools", ...allowedTools);
      for (const d of cwdExtra ?? []) a.push("--add-dir", d);
      return a;
    },
    choosesSessionId: true,
    parse(e) {
      const out = [];
      if (e.session_id && (e.type === "system" && e.subtype === "init")) out.push({ kind: "session", id: e.session_id });
      if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
        out.push({ kind: "delta", text: e.event.delta.text });
      }
      if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) if (c.type === "tool_use") out.push({ kind: "tool", name: c.name, detail: toolDetail(c.name, c.input) });
      }
      if (e.type === "result") {
        out.push({ kind: "done", text: typeof e.result === "string" ? e.result : "", costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null, error: e.is_error ? firstLine(e.result || e.subtype) : null });
      }
      return out;
    },
  },

  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    /** Codex has no system-prompt flag; the context goes in front of the first message. */
    args({ prompt, sessionId, resume, system, sandbox }) {
      const text = !resume && system ? `${system}\n\n${prompt}` : prompt;
      const a = ["exec"];
      if (resume) a.push("resume", sessionId);
      a.push("--json", "--skip-git-repo-check");
      if (sandbox) a.push("-s", sandbox);
      a.push(text);
      return a;
    },
    choosesSessionId: false,
    parse(e) {
      const out = [];
      if (e.type === "thread.started" && e.thread_id) out.push({ kind: "session", id: e.thread_id });
      const it = e.item;
      if (e.type === "item.completed" && it?.type === "agent_message") out.push({ kind: "text", text: it.text ?? "" });
      if ((e.type === "item.started") && it && it.type !== "agent_message" && it.type !== "reasoning") {
        out.push({ kind: "tool", name: it.type, detail: firstLine(it.command ?? it.path ?? it.name ?? "") });
      }
      if (e.type === "turn.completed") out.push({ kind: "done", text: "", costUsd: null, error: null });
      if (e.type === "turn.failed" || e.type === "error") out.push({ kind: "done", text: "", costUsd: null, error: firstLine(e.error?.message ?? e.message ?? "Codex stopped") });
      return out;
    },
  },

  cursor: {
    id: "cursor",
    label: "Cursor",
    bin: "cursor-agent",
    /** `--trust` is required in print mode for a folder Cursor hasn't seen; `--force` lets it run commands. */
    args({ prompt, sessionId, resume, system, force }) {
      const text = !resume && system ? `${system}\n\n${prompt}` : prompt;
      const a = ["-p", text, "--output-format", "stream-json", "--stream-partial-output", "--trust"];
      if (resume) a.push("--resume", sessionId);
      if (force) a.push("--force");
      return a;
    },
    choosesSessionId: false,
    parse(e) {
      const out = [];
      if (e.type === "system" && e.subtype === "init" && e.session_id) out.push({ kind: "session", id: e.session_id });
      if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) if (c.type === "text" && c.text) out.push({ kind: "delta", text: c.text });
      }
      if (e.type === "tool_call" && e.subtype === "started") {
        const call = e.tool_call ?? {};
        const key = Object.keys(call)[0] ?? "tool";
        out.push({ kind: "tool", name: key.replace(/ToolCall$/, ""), detail: toolDetail(key, call[key]?.args) });
      }
      if (e.type === "result") out.push({ kind: "done", text: typeof e.result === "string" ? e.result : "", costUsd: null, error: e.is_error ? firstLine(e.result || "Cursor stopped") : null });
      return out;
    },
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
