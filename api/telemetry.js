import crypto from "node:crypto";

const MAX_EVENTS = 1000;
const telemetryEvents = [];
const ADMIN_COOKIE = "kibangou_admin";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function getSecret() {
  return process.env.AUTH_SECRET || process.env.VERCEL_PROJECT_ID || "kibangoutv-hmac-fallback-2026";
}

function getAdminKey() {
  return process.env.ADMIN_KEY || "KibangouAdmin#2026";
}

function signAdminToken() {
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp: Math.floor(Date.now() / 1000) + 86400 * 7 })).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
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

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAdminAuthorized(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const adminTok = verifyToken(cookies[ADMIN_COOKIE]);
  if (adminTok && adminTok.role === "admin") return true;

  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    const userTok = verifyToken(cookies["kibangou_session"]);
    if (userTok && String(userTok.email || "").toLowerCase() === adminEmail) return true;
  }
  return false;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function summarizeMetric(name) {
  const vals = telemetryEvents
    .filter((e) => e.metric === name && typeof e.value === "number" && Number.isFinite(e.value))
    .map((e) => e.value)
    .sort((a, b) => a - b);
  if (!vals.length) return { count: 0, avg: null, p75: null, p95: null };
  const sum = vals.reduce((acc, v) => acc + v, 0);
  return {
    count: vals.length,
    avg: Math.round((sum / vals.length) * 100) / 100,
    p75: percentile(vals, 75),
    p95: percentile(vals, 95)
  };
}

function topCounts(filterFn, keyFn, limit = 10) {
  const map = new Map();
  for (const ev of telemetryEvents) {
    if (!filterFn(ev)) continue;
    const k = keyFn(ev) || "—";
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request) {
  try {
    const url = new URL(request.url, "https://kibangoutv.vercel.app");
    const action = url.searchParams.get("action") || "";
    const body = await request.json().catch(() => null);

    if (action === "unlock") {
      const provided = String(body?.key || "");
      const expected = getAdminKey();
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return Response.json({ error: "Clé administrateur incorrecte." }, { status: 401, headers: CORS_HEADERS });
      }
      const token = signAdminToken();
      const isHttps = (request.headers.get("x-forwarded-proto") || "https") === "https";
      const cookie = `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${86400 * 7}${isHttps ? "; Secure" : ""}`;
      return Response.json({ ok: true }, { status: 200, headers: { ...CORS_HEADERS, "Set-Cookie": cookie } });
    }

    if (action === "lock") {
      return Response.json(
        { ok: true },
        { status: 200, headers: { ...CORS_HEADERS, "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } }
      );
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Invalid payload" }, { status: 400, headers: CORS_HEADERS });
    }

    const entries = Array.isArray(body.events) ? body.events : [body];
    for (const raw of entries.slice(0, 30)) {
      if (!raw || typeof raw.metric !== "string") continue;
      if (telemetryEvents.length >= MAX_EVENTS) telemetryEvents.shift();
      telemetryEvents.push({
        metric: String(raw.metric).slice(0, 48),
        value: typeof raw.value === "number" ? raw.value : Number(raw.value) || 0,
        label: typeof raw.label === "string" ? raw.label.slice(0, 120) : "",
        path: typeof raw.path === "string" ? raw.path.slice(0, 120) : "/",
        connection: typeof raw.connection === "string" ? raw.connection.slice(0, 24) : "unknown",
        device: typeof raw.device === "string" ? raw.device.slice(0, 24) : "web",
        ts: Date.now()
      });
    }

    return Response.json({ ok: true, total: telemetryEvents.length }, { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return Response.json({ error: err?.message || "Telemetry error" }, { status: 500, headers: CORS_HEADERS });
  }
}

export async function GET(request) {
  if (!isAdminAuthorized(request)) {
    return Response.json({ error: "Accès réservé à l'administrateur." }, { status: 401, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  const metrics = ["LCP", "FCP", "CLS", "INP", "TTFB", "BUFFER_STALL", "STREAM_ERROR"];
  const summary = {};
  for (const m of metrics) {
    summary[m] = summarizeMetric(m);
  }

  const totalClicks = telemetryEvents.filter((e) => e.metric === "CLICK").length;
  const totalMoves = telemetryEvents.filter((e) => e.metric === "PAGE_VIEW").length;
  const totalPlays = telemetryEvents.filter((e) => e.metric === "PLAY_START").length;
  const totalDownloads = telemetryEvents.filter((e) => e.metric === "DOWNLOAD_CLICK").length;

  return Response.json(
    {
      ok: true,
      totalEvents: telemetryEvents.length,
      activity: { totalClicks, totalMoves, totalPlays, totalDownloads },
      topClicks: topCounts((e) => e.metric === "CLICK", (e) => e.label || e.path, 12),
      topRoutes: topCounts((e) => e.metric === "PAGE_VIEW", (e) => e.path, 12),
      summary,
      recent: telemetryEvents.slice(-50).reverse()
    },
    { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}
