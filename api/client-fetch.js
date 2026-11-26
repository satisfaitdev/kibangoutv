import { normalizeResolvedPlayback } from "./_sources.js";

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
      return res.status(upstreamRes.status).json({ error: rawText || `HTTP ${upstreamRes.status}` });
    }
  } catch (err) {
    console.error("Client-fetch proxy error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
