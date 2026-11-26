import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const USERS_FILE = path.join("/tmp", "kibangou_users.json");
const ADS_FILE = path.join("/tmp", "kibangou_ads.json");
const ADMIN_COOKIE = "kibangou_admin";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function getSecret() {
  return process.env.AUTH_SECRET || process.env.VERCEL_PROJECT_ID || "kibangoutv-hmac-fallback-2026";
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
  const tok = verifyToken(cookies[ADMIN_COOKIE]);
  if (tok && tok.role === "admin") return true;
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    const uTok = verifyToken(cookies["kibangou_session"]);
    if (uTok && String(uTok.email || "").toLowerCase() === adminEmail) return true;
  }
  return false;
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data), "utf-8");
  } catch {}
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "public_ads";

  if (action === "public_ads") {
    const ads = readJson(ADS_FILE, []);
    const active = Array.isArray(ads) ? ads.filter((a) => a && a.active) : [];
    return Response.json({ ads: active }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  if (!isAdminAuthorized(request)) {
    return Response.json({ error: "Accès administrateur requis." }, { status: 401, headers: CORS_HEADERS });
  }

  if (action === "users") {
    const usersObj = readJson(USERS_FILE, {});
    const users = Object.values(usersObj).map((u) => ({
      email: u.email,
      name: u.name || u.email,
      provider: u.provider || "email",
      banned: Boolean(u.banned),
      createdAt: u.createdAt || null,
      lastSeen: u.lastSeen || u.createdAt || null
    }));
    users.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return Response.json({ users }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  if (action === "ads") {
    const ads = readJson(ADS_FILE, []);
    return Response.json({ ads: Array.isArray(ads) ? ads : [] }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Unknown action" }, { status: 400, headers: CORS_HEADERS });
}

export async function POST(request) {
  if (!isAdminAuthorized(request)) {
    return Response.json({ error: "Accès administrateur requis." }, { status: 401, headers: CORS_HEADERS });
  }

  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "";
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid payload" }, { status: 400, headers: CORS_HEADERS });
  }

  if (action === "user_toggle_ban") {
    const email = String(body.email || "").trim().toLowerCase();
    const users = readJson(USERS_FILE, {});
    if (!users[email]) return Response.json({ error: "Utilisateur introuvable." }, { status: 404, headers: CORS_HEADERS });
    users[email].banned = Boolean(body.banned);
    writeJson(USERS_FILE, users);
    return Response.json({ ok: true, banned: users[email].banned }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "user_delete") {
    const email = String(body.email || "").trim().toLowerCase();
    const users = readJson(USERS_FILE, {});
    delete users[email];
    writeJson(USERS_FILE, users);
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_save") {
    const ads = readJson(ADS_FILE, []);
    const list = Array.isArray(ads) ? ads : [];
    const title = String(body.title || "").trim().slice(0, 100);
    const text = String(body.text || "").trim().slice(0, 220);
    const linkUrl = String(body.linkUrl || "").trim().slice(0, 300);
    const imageUrl = String(body.imageUrl || "").trim().slice(0, 300);
    const placement = String(body.placement || "home_banner").slice(0, 32);
    if (!title) return Response.json({ error: "Titre requis." }, { status: 400, headers: CORS_HEADERS });

    const id = body.id ? String(body.id) : `ad_${Date.now()}`;
    const existingIdx = list.findIndex((a) => a.id === id);
    const entry = {
      id,
      title,
      text,
      linkUrl,
      imageUrl,
      placement,
      active: body.active !== false,
      updatedAt: Date.now()
    };
    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.unshift(entry);
    writeJson(ADS_FILE, list);
    return Response.json({ ok: true, ad: entry }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_toggle") {
    const ads = readJson(ADS_FILE, []);
    const list = Array.isArray(ads) ? ads : [];
    const item = list.find((a) => a.id === String(body.id || ""));
    if (!item) return Response.json({ error: "Publicité introuvable." }, { status: 404, headers: CORS_HEADERS });
    item.active = Boolean(body.active);
    writeJson(ADS_FILE, list);
    return Response.json({ ok: true, active: item.active }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_delete") {
    const ads = readJson(ADS_FILE, []);
    const next = (Array.isArray(ads) ? ads : []).filter((a) => a.id !== String(body.id || ""));
    writeJson(ADS_FILE, next);
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  return Response.json({ error: "Unknown action" }, { status: 400, headers: CORS_HEADERS });
}
