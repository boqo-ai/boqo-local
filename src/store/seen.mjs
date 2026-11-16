// What this app last saw of each rendered clip: its video version (the file's modification
// time) and its stranger judgment. The engine keeps a clip's judgment when the clip is
// rendered again (read at boqo-clips p0b, tools/render.mjs), whether the page, the agent or
// the person re-rendered it. When the video changes and the judgment doesn't, the judgment is
// about the old render, and the page says so until the clip is judged again.
// Measured 2026-11-16: an agent asked from the chat to re-render a clip did so and, by its
// own account, skipped re-judging; the page showed the old judgment as current.
import path from "node:path";
import { readJson, writeJson, localDir } from "../home.mjs";

const fileOf = (home) => path.join(localDir(home), "seen.json");

/**
 * Note the clips as they are now and return the clip numbers whose judgment predates their
 * current render. `rows`: { n, videoV, judgment } (judgment as stored in clips.json).
 * Best effort: a re-render that happened before this app ever saw the clip can't be told.
 */
export function noteClips(home, runId, rows) {
  const file = fileOf(home);
  const all = readJson(file) ?? {};
  const seen = (all[runId] ??= {});
  const stale = new Set();
  let changed = false;
  for (const r of rows) {
    if (r.videoV == null) continue;
    const j = JSON.stringify(r.judgment ?? null);
    const e = seen[r.n];
    let next;
    if (!e) next = { v: r.videoV, j, stale: false };
    else if (e.v !== r.videoV) next = { v: r.videoV, j, stale: r.judgment != null && e.j === j };
    else if (e.j !== j) next = { v: r.videoV, j, stale: false }; // judged again
    else next = e;
    if (next !== e) { seen[r.n] = next; changed = true; }
    if (next.stale) stale.add(r.n);
  }
  if (changed) writeJson(file, all);
  return stale;
}
