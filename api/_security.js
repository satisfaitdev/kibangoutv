import crypto from "node:crypto";

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString("hex");
const RATE_BUCKETS = new Map();
const MAX_RATE_KEYS = 5000;

/**
 * Retourne le secret HMAC du serveur sans jamais utiliser de chaîne statique en dur.
 */
export function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.VERCEL_PROJECT_ID || EPHEMERAL_SECRET;
}

/**
 * Signe un payload JSON en jeton HMAC-SHA256 compact.
 */
export function signHmacToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Vérifie un jeton HMAC-SHA256 en temps constant et contrôle son expiration.
 */
export function verifyHmacToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (parsed.exp && Date.now() > parsed.exp * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getHeader(req, name) {
  if (!req?.headers) return "";
  if (typeof req.headers.get === "function") return req.headers.get(name) || "";
  return String(req.headers[name.toLowerCase()] || "");
}

export function getClientIp(req) {
  const fwd = getHeader(req, "x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return getHeader(req, "x-real-ip") || "unknown";
}

/**
 * Limiteur de débit par fenêtre glissante (protection brute-force et anti-DDoS applicatif).
 */
export function checkRateLimit(req, bucket, maxReq = 30, windowMs = 60_000) {
  const now = Date.now();
  const key = `${bucket}:${getClientIp(req)}`;
  if (RATE_BUCKETS.size > MAX_RATE_KEYS) RATE_BUCKETS.clear();

  let entry = RATE_BUCKETS.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
  }
  entry.count += 1;
  RATE_BUCKETS.set(key, entry);

  const remaining = Math.max(0, maxReq - entry.count);
  const retryAfterSec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
  return { ok: entry.count <= maxReq, remaining, retryAfterSec };
}

export function isAllowedOriginValue(originStr, hostHeader = "") {
  if (!originStr) return false;
  try {
    const u = new URL(originStr);
    const h = u.hostname.toLowerCase();
    if (h === "kibangoutv.vercel.app") return true;
    if (h.endsWith(".vercel.app") && h.startsWith("kibangoutv")) return true;
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (hostHeader && u.host.toLowerCase() === hostHeader.toLowerCase()) return true;
    return false;
  } catch {
    return false;
  }
}

export function buildCorsHeaders(req, methods = "GET, POST, OPTIONS") {
  const origin = getHeader(req, "origin");
  const host = getHeader(req, "host");
  const allowed = isAllowedOriginValue(origin, host) ? origin : "https://kibangoutv.vercel.app";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Headers, X-Requested-With",
    "Access-Control-Allow-Credentials": "true"
  };
}

/**
 * Bloque le hotlinking inter-sites sur les routes de proxy/streaming tout en restant compatible WebView/Safari.
 */
export function isTrustedAppRequest(req) {
  const fetchSite = getHeader(req, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site") return false;

  const host = getHeader(req, "host");
  const origin = getHeader(req, "origin");
  if (origin && !isAllowedOriginValue(origin, host)) return false;

  const referer = getHeader(req, "referer");
  if (referer && !isAllowedOriginValue(referer, host)) return false;

  return true;
}
