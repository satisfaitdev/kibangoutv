import crypto from "node:crypto";
import { storeGet, storeSet } from "./_store.js";

const SASPAY_BASE = "https://api.saspay.me/api/v1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const VIP_PLANS = {
  adult_vip: { id: "adult_vip", name: "Abonnement Adulte +18 (30 jours)", amount: "2500.00", currency: "XAF", days: 30 },
  no_ads_vip: { id: "no_ads_vip", name: "Abonnement Sans Publicités (30 jours)", amount: "1500.00", currency: "XAF", days: 30 }
};

async function saspayFetch(pathStr, { method = "GET", body = null, idempotencyKey = "" } = {}) {
  const apiKey = process.env.SASPAY_API_KEY || "";
  if (!apiKey) {
    return { status: 503, ok: false, data: { error: { message: "Clé API SasPay (SASPAY_API_KEY) non configurée côté serveur." } } };
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${SASPAY_BASE}${pathStr}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function deliverPlanOnce(paymentId, metadata, amountStr, currency) {
  if (!paymentId) return { delivered: false };
  const deliveredMap = await storeGet("kibangou_delivered_payments", {});
  if (deliveredMap[paymentId]) {
    return { delivered: true, alreadyDelivered: true };
  }

  const email = String(metadata?.email || "").trim().toLowerCase();
  const plan = metadata?.plan === "no_ads_vip" ? "no_ads_vip" : "adult_vip";
  const days = Math.max(1, Number(metadata?.days) || 30);

  if (email) {
    const users = await storeGet("kibangou_users", {});
    if (!users[email]) {
      users[email] = { email, name: email.split("@")[0], provider: "saspay", createdAt: Date.now(), lastSeen: Date.now() };
    }
    const field = plan === "adult_vip" ? "adultVipUntil" : "noAdsVipUntil";
    users[email][field] = Math.max(Date.now(), users[email][field] || 0) + days * 86400000;
    await storeSet("kibangou_users", users);
  }

  const ledger = await storeGet("kibangou_ledger", []);
  const list = Array.isArray(ledger) ? ledger : [];
  list.unshift({
    id: `sas_${paymentId}`,
    type: plan,
    email: email || "client",
    days,
    amountFcfa: Number(amountStr) || 0,
    currency: currency || "XAF",
    note: `SasPay ${plan === "adult_vip" ? "Adulte +18" : "Sans Pubs"} (${days}j)`,
    ts: Date.now()
  });
  await storeSet("kibangou_ledger", list.slice(0, 200));

  deliveredMap[paymentId] = { ts: Date.now(), email, plan };
  await storeSet("kibangou_delivered_payments", deliveredMap);
  return { delivered: true, alreadyDelivered: false };
}

function verifyWebhookSignature(rawBody, signature, timestamp, secret) {
  if (!secret || !signature || !timestamp) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(String(signature).toLowerCase());
  const b = Buffer.from(expected.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "config";

  if (action === "config") {
    return Response.json(
      {
        configured: Boolean(process.env.SASPAY_API_KEY),
        plans: Object.values(VIP_PLANS)
      },
      { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
    );
  }

  if (action === "countries") {
    const res = await fetch(`${SASPAY_BASE}/countries/`).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    return Response.json(data, { status: res ? res.status : 502, headers: CORS_HEADERS });
  }

  if (action === "verify") {
    const paymentId = (url.searchParams.get("payment_id") || "").trim();
    if (!paymentId) {
      return Response.json({ error: "payment_id requis." }, { status: 400, headers: CORS_HEADERS });
    }
    const r = await saspayFetch(`/payments/${encodeURIComponent(paymentId)}/verify/`);
    if (!r.ok) {
      return Response.json(r.data, { status: r.status, headers: CORS_HEADERS });
    }
    const payload = r.data?.data || r.data || {};
    const status = String(payload.status || "").toUpperCase();
    if (status === "SUCCESS") {
      await deliverPlanOnce(paymentId, payload.metadata || {}, payload.net_amount || payload.charged || payload.amount, payload.currency);
    }
    return Response.json({ ok: true, status, payment: payload }, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Unknown action" }, { status: 400, headers: CORS_HEADERS });
}

export async function POST(request) {
  const url = new URL(request.url, "https://kibangoutv.vercel.app");
  const action = url.searchParams.get("action") || "";

  if (action === "webhook") {
    const rawBody = await request.text();
    const signature = request.headers.get("x-webhook-signature") || "";
    const timestamp = request.headers.get("x-webhook-timestamp") || "";
    const secret = process.env.SASPAY_WEBHOOK_SECRET || "";

    if (!verifyWebhookSignature(rawBody, signature, timestamp, secret)) {
      return Response.json({ error: "Signature webhook invalide ou expirée." }, { status: 401, headers: CORS_HEADERS });
    }

    const evt = JSON.parse(rawBody || "{}");
    if (evt.event === "transaction.success" && evt.data?.id) {
      await deliverPlanOnce(
        String(evt.data.id),
        evt.data.metadata || {},
        evt.data.net_amount || evt.data.charged || evt.data.amount,
        evt.data.currency
      );
    }
    return Response.json({ received: true }, { status: 200, headers: CORS_HEADERS });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Payload invalide." }, { status: 400, headers: CORS_HEADERS });
  }

  const plan = VIP_PLANS[body.plan] || VIP_PLANS.adult_vip;
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || email.split("@")[0] || "Client KibangouTV").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Adresse e-mail requise pour activer l'abonnement." }, { status: 400, headers: CORS_HEADERS });
  }

  const origin = (process.env.APP_URL || "https://kibangoutv.vercel.app").replace(/\/+$/, "");

  if (action === "checkout") {
    const r = await saspayFetch("/checkout-sessions/", {
      method: "POST",
      body: {
        amount: plan.amount,
        currency: String(body.currency || plan.currency),
        description: plan.name,
        customer_email: email,
        customer_name: name,
        customer_phone: body.phone ? String(body.phone).trim() : undefined,
        return_url: `${origin}/?saspay_return=1`,
        metadata: { email, plan: plan.id, days: plan.days }
      }
    });
    return Response.json(r.data, { status: r.status, headers: CORS_HEADERS });
  }

  if (action === "softpay") {
    const idempotencyKey = String(body.idempotencyKey || crypto.randomUUID());
    const r = await saspayFetch("/payments/softpay/", {
      method: "POST",
      idempotencyKey,
      body: {
        amount: plan.amount,
        currency: String(body.currency || plan.currency),
        country: String(body.country || "CG").toUpperCase(),
        network: String(body.network || "mtn_cg"),
        description: plan.name,
        customer: {
          email,
          first_name: name.split(" ")[0] || "Client",
          last_name: name.split(" ").slice(1).join(" ") || "KibangouTV",
          phone: String(body.phone || "")
        },
        metadata: { email, plan: plan.id, days: plan.days }
      }
    });
    return Response.json(r.data, { status: r.status, headers: CORS_HEADERS });
  }

  return Response.json({ error: "Action SasPay inconnue." }, { status: 400, headers: CORS_HEADERS });
}
