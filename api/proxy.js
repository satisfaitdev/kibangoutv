export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Nettoyage des éventuels wrappers imbriqués
  targetUrl = decodeURIComponent(targetUrl);
  while (targetUrl.includes("/api/proxy?url=")) {
    targetUrl = decodeURIComponent(targetUrl.split("/api/proxy?url=")[1]);
  }
  if (targetUrl.startsWith("//")) {
    targetUrl = "https:" + targetUrl;
  } else if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
  }

  try {
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    };

    const upstreamRes = await fetch(targetUrl, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: fetchHeaders,
      body: req.method === "POST" ? JSON.stringify(req.body) : undefined
    });

    const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";

    // 1. Détection et réécriture HLS M3U8
    if (targetUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
      const text = await upstreamRes.text();
      const lines = text.split("\n");
      const rewritten = [];

      for (let line of lines) {
        const sline = line.trim();
        if (!sline) {
          rewritten.push(line);
        } else if (sline.startsWith("#")) {
          if (sline.includes('URI="')) {
            const replaced = sline.replace(/URI="([^"]+)"/g, (match, rawUri) => {
              const absUri = new URL(rawUri, targetUrl).href;
              return `URI="/api/proxy?url=${encodeURIComponent(absUri)}"`;
            });
            rewritten.push(replaced);
          } else {
            rewritten.push(sline);
          }
        } else {
          const absUri = new URL(sline, targetUrl).href;
          rewritten.push(`/api/proxy?url=${encodeURIComponent(absUri)}`);
        }
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(upstreamRes.status).send(rewritten.join("\n"));
    }

    // 2. Détection et priorisation des sources francophones VOD
    if (targetUrl.includes("/vod/source/")) {
      const data = await upstreamRes.json();
      const sources = data.sources || [];
      if (sources.length > 0) {
        const fr = [];
        const en = [];
        const other = [];

        for (const s of sources) {
          const langs = (s.languages || []).map(l => String(l).toLowerCase());
          const quality = s.quality || "HD";
          const name = s.name || "Serveur";

          if (langs.includes("fr")) {
            fr.push({ ...s, name: `🇫🇷 Français VF (${quality})` });
          } else if (langs.includes("en")) {
            en.push({ ...s, name: `🇬🇧 VO / VOSTFR (${quality})` });
          } else {
            other.push({ ...s, name: `🌐 ${name} (${langs.join(",").toUpperCase()})` });
          }
        }
        data.sources = [...fr, ...en, ...other];
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(upstreamRes.status).json(data);
    }

    // 3. Réponse standard (JSON, buffer binaire, flux vidéo)
    res.setHeader("Content-Type", contentType);
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.status(upstreamRes.status).send(buffer);

  } catch (err) {
    console.error("Vercel Proxy Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
