// Where boqo's files live on this computer, and where this app keeps its own.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** The boqo home: BOQO_HOME when set, else ~/.boqo (the skills' own default). */
export function boqoHome(env = process.env) {
  const h = env.BOQO_HOME && env.BOQO_HOME.trim();
  return path.resolve(h || path.join(os.homedir(), ".boqo"));
}

/** This app's own folder inside the home: server.json, chat threads, settings. */
export function localDir(home = boqoHome()) {
  return path.join(home, "local");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Read JSON, or null when the file is missing or half-written. Never throws. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write JSON atomically (temp file, then rename), so readers never see half a file. */
export function writeJson(file, value, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

export function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
