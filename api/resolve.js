import { normalizeResolvedPlayback, resolveVavooWithCache } from "./_sources.js";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
          "User-Agent": CHROME_UA
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      const rawText = await upstreamRes.text();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        const data = normalizeResolvedPlayback(JSON.parse(rawText), false);
        return res.status(upstreamRes.status).json(data);
      } catch {
        return res.status(upstreamRes.status).send(rawText);
      }
    }

    const playUrl = req.query.url;
    if (!playUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    const isLive = playUrl.includes("/live/play/") || playUrl.includes("vavoo");
    const vavooResolveUrl = isLive
      ? `https://vavoo.top/live/resolve?url=${encodeURIComponent(playUrl)}`
      : `https://vavoo.top/vod/resolve?url=${encodeURIComponent(playUrl)}`;

    const bypassCache = req.query.nocache === "1";
    const { status, data, rawText, cacheHit } = await resolveVavooWithCache(vavooResolveUrl, {
      isLive,
      bypassCache
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Kibangou-Cache", cacheHit ? "HIT" : "MISS");
    if (status >= 200 && status < 300 && data && data.url) {
      res.setHeader("Cache-Control", "private, max-age=30");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }

    if (data !== null) {
      return res.status(status).json(data);
    }
    return res.status(status).send(rawText || "");
  } catch (err) {
    console.error("Kibangou Resolve Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
