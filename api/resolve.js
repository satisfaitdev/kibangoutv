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
    const isLive = playUrl.includes("/live/play/") || playUrl.includes("vavoo");
    const vavooResolveUrl = isLive
      ? `https://vavoo.top/live/resolve?url=${encodeURIComponent(playUrl)}`
      : `https://vavoo.top/vod/resolve?url=${encodeURIComponent(playUrl)}`;

    const r = await fetch(vavooResolveUrl, {
      headers: { "User-Agent": "VAVOO/2.6", "Accept": "application/json" }
    });
    const data = await r.json();

    if (data && typeof data.url === "string" && data.url.startsWith("http://")) {
      data.proxy = true;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(r.status).json(data);
  } catch (err) {
    console.error("Kibangou Resolve Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
