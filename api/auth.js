import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COOKIE_NAME = "kibangou_session";
const USERS_FILE = path.join("/tmp", "kibangou_users.json");
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 jours

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.VERCEL_PROJECT_ID || "kibangoutv-hmac-fallback-2026";
}

function b64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecode(input) {
  return Buffer.from(String(input), "base64url").toString("utf-8");
}

function signToken(payloadObj) {
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(b64urlDecode(payload));
    if (parsed.exp && Date.now() > parsed.exp * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildSessionCookie(token, isHttps) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function buildClearCookie(isHttps) {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users), "utf-8");
  } catch {}
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, keyHex] = String(storedHash || "").split(":");
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, "hex");
  return derived.length === keyBuf.length && crypto.timingSafeEqual(derived, keyBuf);
}

function makeReferralCode(email) {
  return "KIB-" + crypto.createHash("sha256").update(String(email || "").toLowerCase()).digest("hex").slice(0, 6).toUpperCase();
}

function applyReferralReward(users, newEmail, refCode) {
  const cleanRef = String(refCode || "").trim().toUpperCase();
  if (!cleanRef) return null;
  const sponsor = Object.values(users).find((u) => (u.referralCode || makeReferralCode(u.email)) === cleanRef);
  if (!sponsor || sponsor.email === newEmail) return null;
  sponsor.referralCode = sponsor.referralCode || makeReferralCode(sponsor.email);
  sponsor.referralCount = (sponsor.referralCount || 0) + 1;
  sponsor.adFreeUntil = Math.max(Date.now(), sponsor.adFreeUntil || 0) + 86400000;
  return sponsor.email;
}

function getOrigin(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const fwdProto = request.headers.get("x-forwarded-proto");
  const fwdHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (fwdHost) {
    return `${fwdProto || "https"}://${fwdHost}`;
  }
  return url.origin;
}

export async function GET(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || (url.pathname.includes("google/callback") ? "google_callback" : "me");
  const origin = getOrigin(request);
  const isHttps = origin.startsWith("https://");
  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = `${origin}/api/auth/google/callback`;

  if (action === "config") {
    return Response.json({
      googleEnabled: Boolean(googleClientId && googleClientSecret),
      redirectUri
    });
  }

  if (action === "me") {
    const cookies = parseCookies(request.headers.get("cookie") || "");
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const session = verifyToken(cookies[COOKIE_NAME] || bearer);
    if (!session) {
      return Response.json({ authenticated: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    const users = loadUsers();
    const uRec = users[String(session.email || "").toLowerCase()] || {};
    if (uRec.banned) {
      return Response.json({ authenticated: false, banned: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      {
        authenticated: true,
        user: {
          email: session.email,
          name: session.name || session.email.split("@")[0],
          picture: session.picture || "",
          provider: session.provider || "email",
          referralCode: uRec.referralCode || makeReferralCode(session.email),
          referralCount: uRec.referralCount || 0,
          adFreeUntil: uRec.adFreeUntil || 0,
          adultVipUntil: uRec.adultVipUntil || 0,
          noAdsVipUntil: uRec.noAdsVipUntil || 0
        }
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (action === "google") {
    if (!googleClientId || !googleClientSecret) {
      return Response.redirect(`${origin}/?auth_error=google_not_configured`, 302);
    }
    const refParam = (url.searchParams.get("ref") || "").trim().toUpperCase();
    const state = signToken({
      nonce: crypto.randomBytes(12).toString("hex"),
      ref: refParam,
      exp: Math.floor(Date.now() / 1000) + 600
    });
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", googleClientId);
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("access_type", "online");
    googleUrl.searchParams.set("prompt", "select_account");
    googleUrl.searchParams.set("state", state);
    return Response.redirect(googleUrl.toString(), 302);
  }

  if (action === "google_callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    const stateObj = verifyToken(state);
    if (err || !code || !stateObj) {
      return Response.redirect(`${origin}/?auth_error=${encodeURIComponent(err || "invalid_state")}`, 302);
    }
    if (!googleClientId || !googleClientSecret) {
      return Response.redirect(`${origin}/?auth_error=google_not_configured`, 302);
    }

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return Response.redirect(`${origin}/?auth_error=google_token_failed`, 302);
      }

      const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const profile = await userRes.json();
      if (!userRes.ok || !profile.email) {
        return Response.redirect(`${origin}/?auth_error=google_profile_failed`, 302);
      }

      const sessionToken = signToken({
        email: profile.email,
        name: profile.name || profile.email.split("@")[0],
        picture: profile.picture || "",
        provider: "google",
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
      });

      const users = loadUsers();
      const gEmail = String(profile.email).toLowerCase();
      if (users[gEmail]?.banned) {
        return Response.redirect(`${origin}/?auth_error=account_suspended`, 302);
      }
      const isNew = !users[gEmail];
      const referredBy = isNew ? applyReferralReward(users, gEmail, stateObj.ref) : (users[gEmail]?.referredBy || null);
      users[gEmail] = {
        ...(users[gEmail] || {}),
        email: gEmail,
        name: profile.name || gEmail.split("@")[0],
        provider: "google",
        referralCode: users[gEmail]?.referralCode || makeReferralCode(gEmail),
        referredBy,
        createdAt: users[gEmail]?.createdAt || Date.now(),
        lastSeen: Date.now()
      };
      saveUsers(users);

      return new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?auth_success=google`,
          "Set-Cookie": buildSessionCookie(sessionToken, isHttps)
        }
      });
    } catch {
      return Response.redirect(`${origin}/?auth_error=google_network_error`, 302);
    }
  }

  return Response.json({ error: "Unknown auth action" }, { status: 400 });
}

export async function POST(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "login";
  const origin = getOrigin(request);
  const isHttps = origin.startsWith("https://");

  if (action === "logout") {
    return Response.json(
      { ok: true },
      { status: 200, headers: { "Set-Cookie": buildClearCookie(isHttps) } }
    );
  }

  const body = await request.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const name = String(body?.name || "").trim();
  const ref = String(body?.ref || "").trim().toUpperCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Adresse e-mail invalide." }, { status: 400 });
  }
  if (password.length < 6) {
    return Response.json({ error: "Le mot de passe doit contenir au moins 6 caractères." }, { status: 400 });
  }

  const users = loadUsers();

  if (action === "register") {
    if (users[email]) {
      return Response.json({ error: "Un compte existe déjà avec cet e-mail." }, { status: 409 });
    }
    const referredBy = applyReferralReward(users, email, ref);
    users[email] = {
      email,
      name: name || email.split("@")[0],
      provider: "email",
      referralCode: makeReferralCode(email),
      referredBy,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    saveUsers(users);
  } else if (action === "login") {
    const existing = users[email];
    if (existing) {
      if (existing.banned) {
        return Response.json({ error: "Ce compte a été suspendu par l'administrateur." }, { status: 403 });
      }
      if (!verifyPassword(password, existing.passwordHash)) {
        return Response.json({ error: "Mot de passe incorrect." }, { status: 401 });
      }
      existing.referralCode = existing.referralCode || makeReferralCode(email);
      existing.lastSeen = Date.now();
      saveUsers(users);
    } else {
      const referredBy = applyReferralReward(users, email, ref);
      users[email] = {
        email,
        name: name || email.split("@")[0],
        provider: "email",
        referralCode: makeReferralCode(email),
        referredBy,
        passwordHash: hashPassword(password),
        createdAt: Date.now(),
        lastSeen: Date.now()
      };
      saveUsers(users);
    }
  } else {
    return Response.json({ error: "Action invalide." }, { status: 400 });
  }

  const uRec = users[email] || {};
  const userObj = {
    email,
    name: uRec.name || email.split("@")[0],
    picture: "",
    provider: "email",
    referralCode: uRec.referralCode || makeReferralCode(email),
    referralCount: uRec.referralCount || 0,
    adFreeUntil: uRec.adFreeUntil || 0,
    adultVipUntil: uRec.adultVipUntil || 0,
    noAdsVipUntil: uRec.noAdsVipUntil || 0
  };

  const sessionToken = signToken({
    ...userObj,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
  });

  return Response.json(
    { ok: true, user: userObj },
    {
      status: 200,
      headers: {
        "Set-Cookie": buildSessionCookie(sessionToken, isHttps),
        "Cache-Control": "no-store"
      }
    }
  );
}
