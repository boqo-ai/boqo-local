// The page is served on 127.0.0.1 and can start renders and talk to the person's agent,
// so every request is checked against three things any other website open in the same
// browser cannot fake:
//   1. the Host header must name this server (stops DNS rebinding);
//   2. a write must carry this run's token in a custom header (another origin cannot set a
//      custom header without a CORS preflight, and this server answers no preflight);
//   3. a write's Origin, when the browser sends one, must be this server's own.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const h = String(hostHeader).toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export function originAllowed(originHeader, port) {
  if (!originHeader) return true; // same-origin GETs and some fetches send none; the token still gates writes
  const o = String(originHeader).toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export function tokenMatches(given, token) {
  if (typeof given !== "string" || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// Media the page may load from the boqo home. Everything else (JSON with signed upload
// URLs, config with tokens, transcripts) reaches the page only through the readers, which
// pick the fields they need.
const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Resolve a media path requested by the page to a real file inside the boqo home, or null.
 * Refuses: other extensions, anything outside the home after symlinks are resolved, and
 * dot-folders other than the home itself.
 */
export function resolveMedia(home, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const ext = path.extname(rel).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || (p.startsWith(".") && p.length > 1))) return null;
  const abs = path.resolve(home, ...parts);
  let real, realHome;
  try {
    real = fs.realpathSync(abs);
    realHome = fs.realpathSync(home);
  } catch {
    return null;
  }
  if (real !== realHome && !real.startsWith(realHome + path.sep)) return null;
  const st = fs.statSync(real, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  return { file: real, type, size: st.size };
}

/** A path relative to the home, with forward slashes, for the page to request. */
export function mediaRel(home, abs) {
  if (!abs) return null;
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
