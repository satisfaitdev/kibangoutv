export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method === "POST") {
      let payload = req.body;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {}
      }

      const upstreamRes = await fetch("https://vavoo.top/vod/client-fetch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        },
        body: JSON.stringify(payload)
      });

      const data = await upstreamRes.json();
      if (data && typeof data.url === "string" && data.url.startsWith("http://")) {
        data.proxy = true;
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(upstreamRes.status).json(data);
    }

    const playUrl = req.query.url;
    if (!playUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    const isLive = playUrl.includes("/live/play/") || playUrl.includes("vavoo");
    const vavooResolveUrl = isLive
      ? `https://vavoo.top/live/resolve?url=${encodeURIComponent(playUrl)}`
      : `https://vavoo.top/vod/resolve?url=${encodeURIComponent(playUrl)}`;

    const r = await fetch(vavooResolveUrl, {
      headers: { "User-Agent": "VAVOO/2.6", "Accept": "application/json" }
    });
    const data = await r.json();

    if (data && typeof data.url === "string" && (isLive || data.live || data.url.startsWith("http://"))) {
      data.proxy = true;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(r.status).json(data);
  } catch (err) {
    console.error("Kibangou Resolve Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
