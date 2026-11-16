// Brand kits: <home>/brands/<name>/brand.json (v2) and logo.png|jpg; the default kit's
// name is in <home>/brands/default.txt (contract: boqo-clips p0b, engine/brand.mjs).
import fs from "node:fs";
import path from "node:path";
import { readJson, statSafe, listDirs } from "../home.mjs";
import { mediaRel } from "../security.mjs";

export const CAPTION_STYLES = [
  ["karaoke", "Karaoke"], ["punch", "Punch"], ["clean", "Clean"], ["highlight", "Highlight"], ["classic", "Classic"],
  ["bounce", "Bounce"], ["neon", "Neon"], ["boldkeys", "Bold Keys"], ["typewriter", "Typewriter"], ["slide", "Slide"],
  ["comic", "Comic"], ["marker", "Marker"], ["stack", "Shadow Stack"], ["minimal", "Minimal"], ["editorial", "Editorial"],
];

export function brandsDir(home) { return path.join(home, "brands"); }

export function defaultKit(home) {
  try { return fs.readFileSync(path.join(brandsDir(home), "default.txt"), "utf8").trim() || null; } catch { return null; }
}

export function readKit(home, name) {
  if (!/^[\w .-]{1,80}$/.test(name) || name.includes("..")) return null;
  const dir = path.join(brandsDir(home), name);
  const b = readJson(path.join(dir, "brand.json"));
  if (!b) return null;
  const logoFile = ["logo.png", "logo.jpg", "logo.jpeg"].map((f) => path.join(dir, f)).find((f) => statSafe(f));
  const cap = b.captions ?? {};
  return {
    id: name,
    name: b.name ?? name,
    version: b.version ?? 1,
    style: cap.style ?? b.captions?.preset ?? null,
    accent: (cap.accentColours ?? cap.accentColors ?? [])[0] ?? b.colors?.accent ?? null,
    headline: !!b.headline,
    logo: logoFile ? mediaRel(home, logoFile) : null,
    logoAt: b.logo?.anchor ?? b.logo?.corner ?? null,
    ratio: b.ratio ?? "9:16",
  };
}

export function listKits(home) {
  const def = defaultKit(home);
  return listDirs(brandsDir(home)).map((n) => readKit(home, n)).filter(Boolean).map((k) => ({ ...k, isDefault: k.id === def }));
}

export function rawKit(home, name) {
  return readJson(path.join(brandsDir(home), name, "brand.json"));
}
