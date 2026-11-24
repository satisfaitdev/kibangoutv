export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const playUrl = req.query.url;
  if (!playUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const vavooResolveUrl = `https://vavoo.top/live/resolve?url=${encodeURIComponent(playUrl)}`;
    const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
    const headers = { "User-Agent": "Mozilla/5.0" };
    if (clientIp) {
      headers["X-Forwarded-For"] = clientIp;
      headers["X-Real-IP"] = clientIp;
    }

    const r = await fetch(vavooResolveUrl, { headers });
    const data = await r.json();

    if (data && data.url) {
      // Sécurisation HTTPS et proxy pour éviter le blocage Mixed Content
      data.url = `/api/proxy?url=${encodeURIComponent(data.url)}`;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Kibangou Resolve Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
