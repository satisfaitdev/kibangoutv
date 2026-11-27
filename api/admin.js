import { storeGet, storeSet } from "./_store.js";
import { buildCorsHeaders, checkRateLimit, verifyHmacToken } from "./_security.js";

const USERS_FILE = "kibangou_users";
const ADS_FILE = "kibangou_ads";
const LEDGER_FILE = "kibangou_ledger";
const ADMIN_COOKIE = "kibangou_admin";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://kibangoutv.vercel.app",
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function verifyToken(token) {
  return verifyHmacToken(token);
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

async function readJson(key, fallback) {
  return await storeGet(key, fallback);
}

async function writeJson(key, data) {
  await storeSet(key, data);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "public_ads";

  if (action === "public_ads") {
    const ads = await readJson(ADS_FILE, []);
    const active = Array.isArray(ads) ? ads.filter((a) => a && a.active) : [];
    return Response.json({ ads: active }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  if (!isAdminAuthorized(request)) {
    return Response.json({ error: "Accès administrateur requis." }, { status: 401, headers: CORS_HEADERS });
  }

  if (action === "store_health") {
    const w = await storeSet("kibangou_health_test", { ok: true, ts: Date.now() }, 60);
    const r = await storeGet("kibangou_health_test", null);
    return Response.json({ persistent: Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL), write: w, readOk: Boolean(r?.ok) }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "users") {
    const usersObj = await readJson(USERS_FILE, {});
    const users = Object.values(usersObj).map((u) => ({
      email: u.email,
      name: u.name || u.email,
      provider: u.provider || "email",
      banned: Boolean(u.banned),
      referralCode: u.referralCode || "",
      referralCount: u.referralCount || 0,
      referredBy: u.referredBy || null,
      adFreeUntil: u.adFreeUntil || 0,
      adultVipUntil: u.adultVipUntil || 0,
      noAdsVipUntil: u.noAdsVipUntil || 0,
      createdAt: u.createdAt || null,
      lastSeen: u.lastSeen || u.createdAt || null
    }));
    users.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return Response.json({ users }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  if (action === "monetization") {
    const usersObj = await readJson(USERS_FILE, {});
    const usersList = Object.values(usersObj);
    const ads = await readJson(ADS_FILE, []);
    const ledger = await readJson(LEDGER_FILE, []);
    const now = Date.now();

    const adFcfa = ledger.filter((l) => l.type === "ad_revenue").reduce((s, l) => s + (Number(l.amountFcfa) || 0), 0);
    const noAdsFcfa = ledger.filter((l) => l.type === "no_ads_vip").reduce((s, l) => s + (Number(l.amountFcfa) || 0), 0);
    const adultFcfa = ledger.filter((l) => l.type === "adult_vip").reduce((s, l) => s + (Number(l.amountFcfa) || 0), 0);

    const activeAdultSubs = usersList.filter((u) => (u.adultVipUntil || 0) > now).length;
    const activeNoAdsSubs = usersList.filter((u) => (u.noAdsVipUntil || 0) > now).length;
    const totalReferrals = usersList.reduce((s, u) => s + (u.referralCount || 0), 0);
    const adImpressions = (Array.isArray(ads) ? ads : []).reduce((s, a) => s + (a.impressions || 0), 0);
    const adClicks = (Array.isArray(ads) ? ads : []).reduce((s, a) => s + (a.clicks || 0), 0);

    return Response.json(
      {
        totals: {
          totalFcfa: adFcfa + noAdsFcfa + adultFcfa,
          adFcfa,
          noAdsFcfa,
          adultFcfa,
          activeAdultSubs,
          activeNoAdsSubs,
          totalReferrals,
          adImpressions,
          adClicks
        },
        ledger: (Array.isArray(ledger) ? ledger : []).slice(0, 50)
      },
      { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
    );
  }

  if (action === "ads") {
    const ads = await readJson(ADS_FILE, []);
    return Response.json({ ads: Array.isArray(ads) ? ads : [] }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Unknown action" }, { status: 400, headers: CORS_HEADERS });
}

export async function POST(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "";
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid payload" }, { status: 400, headers: CORS_HEADERS });
  }

  if (action === "ad_event") {
    const ads = await readJson(ADS_FILE, []);
    const list = Array.isArray(ads) ? ads : [];
    const ad = list.find((a) => a.id === String(body.id || ""));
    if (ad) {
      if (body.event === "click") ad.clicks = (ad.clicks || 0) + 1;
      else ad.impressions = (ad.impressions || 0) + 1;
      await writeJson(ADS_FILE, list);
    }
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  if (!isAdminAuthorized(request)) {
    return Response.json({ error: "Accès administrateur requis." }, { status: 401, headers: CORS_HEADERS });
  }

  if (action === "grant_sub") {
    const email = String(body.email || "").trim().toLowerCase();
    const plan = body.plan === "no_ads_vip" ? "no_ads_vip" : "adult_vip";
    const days = Math.max(1, Number(body.days) || 30);
    const amountFcfa = Math.max(0, Number(body.amountFcfa) || 0);
    const users = await readJson(USERS_FILE, {});
    if (!users[email]) {
      users[email] = { email, name: email.split("@")[0], provider: "manual", createdAt: Date.now(), lastSeen: Date.now() };
    }
    const until = Math.max(Date.now(), users[email][plan === "adult_vip" ? "adultVipUntil" : "noAdsVipUntil"] || 0) + days * 86400000;
    if (plan === "adult_vip") users[email].adultVipUntil = until;
    else users[email].noAdsVipUntil = until;
    await writeJson(USERS_FILE, users);

    const ledger = await readJson(LEDGER_FILE, []);
    const list = Array.isArray(ledger) ? ledger : [];
    list.unshift({
      id: `tx_${Date.now()}`,
      type: plan,
      email,
      days,
      amountFcfa,
      note: plan === "adult_vip" ? `Abonnement Adulte +18 (${days}j)` : `Abonnement Sans Pubs (${days}j)`,
      ts: Date.now()
    });
    await writeJson(LEDGER_FILE, list.slice(0, 200));
    return Response.json({ ok: true, until }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "add_ad_revenue") {
    const amountFcfa = Math.max(0, Number(body.amountFcfa) || 0);
    const note = String(body.note || "Revenus publicitaires").slice(0, 120);
    const ledger = await readJson(LEDGER_FILE, []);
    const list = Array.isArray(ledger) ? ledger : [];
    list.unshift({
      id: `tx_${Date.now()}`,
      type: "ad_revenue",
      email: "ads-network",
      amountFcfa,
      note,
      ts: Date.now()
    });
    await writeJson(LEDGER_FILE, list.slice(0, 200));
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "user_toggle_ban") {
    const email = String(body.email || "").trim().toLowerCase();
    const users = await readJson(USERS_FILE, {});
    if (!users[email]) return Response.json({ error: "Utilisateur introuvable." }, { status: 404, headers: CORS_HEADERS });
    users[email].banned = Boolean(body.banned);
    await writeJson(USERS_FILE, users);
    return Response.json({ ok: true, banned: users[email].banned }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "user_delete") {
    const email = String(body.email || "").trim().toLowerCase();
    const users = await readJson(USERS_FILE, {});
    delete users[email];
    await writeJson(USERS_FILE, users);
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_save") {
    const ads = await readJson(ADS_FILE, []);
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
    await writeJson(ADS_FILE, list);
    return Response.json({ ok: true, ad: entry }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_toggle") {
    const ads = await readJson(ADS_FILE, []);
    const list = Array.isArray(ads) ? ads : [];
    const item = list.find((a) => a.id === String(body.id || ""));
    if (!item) return Response.json({ error: "Publicité introuvable." }, { status: 404, headers: CORS_HEADERS });
    item.active = Boolean(body.active);
    await writeJson(ADS_FILE, list);
    return Response.json({ ok: true, active: item.active }, { status: 200, headers: CORS_HEADERS });
  }

  if (action === "ad_delete") {
    const ads = await readJson(ADS_FILE, []);
    const next = (Array.isArray(ads) ? ads : []).filter((a) => a.id !== String(body.id || ""));
    await writeJson(ADS_FILE, next);
    return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  return Response.json({ error: "Unknown action" }, { status: 400, headers: CORS_HEADERS });
}
