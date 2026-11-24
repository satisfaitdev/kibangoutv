import { Readable } from "stream";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let targetUrl = req.query.url;
  if (req.url && req.url.includes("?url=")) {
    const rawParam = req.url.slice(req.url.indexOf("?url=") + 5);
    try {
      targetUrl = decodeURIComponent(rawParam);
    } catch {
      targetUrl = rawParam;
    }
  }

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Nettoyage des éventuels wrappers imbriqués
  while (targetUrl && (targetUrl.includes("/api/proxy?url=") || targetUrl.includes("/api/proxy.js?url="))) {
    const parts = targetUrl.split(/\/api\/proxy(?:\.js)?\?url=/);
    const lastPart = parts[parts.length - 1];
    try {
      targetUrl = decodeURIComponent(lastPart);
    } catch {
      targetUrl = lastPart;
    }
  }

  if (targetUrl.startsWith("//")) {
    targetUrl = "https:" + targetUrl;
  } else if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
  }

  try {
    const fetchHeaders = {
      "User-Agent": targetUrl.includes("vavoo") ? "VAVOO/2.6" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    };

    const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
    if (clientIp) {
      fetchHeaders["X-Forwarded-For"] = clientIp;
      fetchHeaders["X-Real-IP"] = clientIp;
    }

    if (req.headers.range) {
      fetchHeaders["Range"] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: fetchHeaders,
      redirect: "follow",
      body: req.method === "POST" ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : undefined
    });

    const finalUrl = upstreamRes.url || targetUrl;
    const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";

    // 1. Détection et réécriture HLS M3U8
    if (finalUrl.includes(".m3u8") || contentType.includes("mpegurl") || contentType.includes("x-mpegURL")) {
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
              try {
                const absUri = new URL(rawUri, finalUrl).href;
                return `URI="/api/proxy?url=${encodeURIComponent(absUri)}"`;
              } catch {
                return match;
              }
            });
            rewritten.push(replaced);
          } else {
            rewritten.push(sline);
          }
        } else {
          try {
            const absUri = new URL(sline, finalUrl).href;
            rewritten.push(`/api/proxy?url=${encodeURIComponent(absUri)}`);
          } catch {
            rewritten.push(sline);
          }
        }
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(upstreamRes.status).send(rewritten.join("\n"));
    }

    // 2. Détection et priorisation des sources francophones VOD
    if (finalUrl.includes("/vod/source/")) {
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

    // 3. Réponse standard (flux vidéo, fragments TS, images, buffers)
    res.setHeader("Content-Type", contentType);
    if (upstreamRes.headers.get("content-range")) {
      res.setHeader("Content-Range", upstreamRes.headers.get("content-range"));
    }
    if (upstreamRes.headers.get("accept-ranges")) {
      res.setHeader("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
    }
    if (upstreamRes.headers.get("content-length")) {
      res.setHeader("Content-Length", upstreamRes.headers.get("content-length"));
    }

    if (upstreamRes.body) {
      if (typeof Readable.fromWeb === "function") {
        return Readable.fromWeb(upstreamRes.body).pipe(res);
      } else {
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        return res.status(upstreamRes.status).send(buffer);
      }
    } else {
      return res.status(upstreamRes.status).end();
    }

  } catch (err) {
    console.error("Vercel Proxy Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
