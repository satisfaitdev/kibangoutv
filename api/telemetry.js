const MAX_EVENTS = 500;
const telemetryEvents = [];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

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

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Invalid payload" }, { status: 400, headers: CORS_HEADERS });
    }

    const entries = Array.isArray(body.events) ? body.events : [body];
    for (const raw of entries.slice(0, 20)) {
      if (!raw || typeof raw.metric !== "string") continue;
      if (telemetryEvents.length >= MAX_EVENTS) telemetryEvents.shift();
      telemetryEvents.push({
        metric: String(raw.metric).slice(0, 48),
        value: typeof raw.value === "number" ? raw.value : Number(raw.value) || 0,
        rating: typeof raw.rating === "string" ? raw.rating.slice(0, 24) : "info",
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

export async function GET() {
  const metrics = ["LCP", "FCP", "CLS", "INP", "TTFB", "STREAM_START_MS", "BUFFER_STALL", "STREAM_ERROR"];
  const summary = {};
  for (const m of metrics) {
    summary[m] = summarizeMetric(m);
  }

  return Response.json(
    {
      ok: true,
      totalEvents: telemetryEvents.length,
      summary,
      recent: telemetryEvents.slice(-30).reverse()
    },
    { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}
