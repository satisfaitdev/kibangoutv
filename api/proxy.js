export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");

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

  if (!targetUrl.includes("?") && targetUrl.includes("&")) {
    targetUrl = targetUrl.replace("&", "?");
  }

  try {
    const fetchHeaders = {
      "User-Agent": targetUrl.includes("vavoo")
        ? "VAVOO/2.6"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    };

    if (req.headers["content-type"]) {
      fetchHeaders["Content-Type"] = req.headers["content-type"];
    }

    // Forward custom browser-restricted headers (Referer, Origin, Cookie, User-Agent, etc.)
    const rawCustomHeaders = req.headers["x-proxy-headers"];
    if (rawCustomHeaders) {
      try {
        const parsedCustom = JSON.parse(String(rawCustomHeaders));
        if (parsedCustom && typeof parsedCustom === "object") {
          for (const [k, v] of Object.entries(parsedCustom)) {
            if (typeof v === "string" && v) {
              fetchHeaders[k] = v;
            }
          }
        }
      } catch {}
    }

    if (req.headers.range) {
      fetchHeaders["Range"] = req.headers.range;
    }

    let reqBody = undefined;
    if (req.method === "POST") {
      if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
        reqBody = req.body;
      } else if (req.body && typeof req.body === "object") {
        reqBody = JSON.stringify(req.body);
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: fetchHeaders,
      redirect: "follow",
      body: reqBody
    });

    const finalUrl = upstreamRes.url || targetUrl;
    const contentType = (upstreamRes.headers.get("content-type") || "application/octet-stream").toLowerCase();
    const upstreamEncoding = upstreamRes.headers.get("content-encoding");

    res.setHeader("X-Final-Url", finalUrl);
    if (upstreamRes.headers.get("set-cookie")) {
      res.setHeader("X-Upstream-Set-Cookie", upstreamRes.headers.get("set-cookie"));
    }

    // 1. Resolution endpoints (/resolve & /client-fetch):
    // Keep raw stream URL intact so Vuma sees .m3u8 / .ts / .mp4 extensions and routes via openStream
    if (finalUrl.includes("/resolve") || targetUrl.includes("/resolve") || finalUrl.includes("/client-fetch") || targetUrl.includes("/client-fetch")) {
      const text = await upstreamRes.text();
      try {
        const data = JSON.parse(text);
        if (data && typeof data.url === "string") {
          if (data.url.startsWith("http://")) {
            data.proxy = true;
          }
        }
        const out = Buffer.from(JSON.stringify(data), "utf-8");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", out.length);
        return res.status(upstreamRes.status).send(out);
      } catch {
        const buf = Buffer.from(text, "utf-8");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", buf.length);
        return res.status(upstreamRes.status).send(buf);
      }
    }

    // 2. VOD Sources filtering & French language prioritization
    if (finalUrl.includes("/vod/source/")) {
      const data = await upstreamRes.json();
      const rawSources = (data.sources || []).filter((s) => {
        const u = (s.url || "").toLowerCase();
        return u && !u.includes("vidoza.");
      });

      if (rawSources.length > 0) {
        const fr = [];
        const en = [];
        const other = [];

        for (const s of rawSources) {
          const langs = (s.languages || []).map((l) => String(l).toLowerCase());
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
      } else {
        data.sources = [];
      }

      const out = Buffer.from(JSON.stringify(data), "utf-8");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", out.length);
      return res.status(upstreamRes.status).send(out);
    }

    // 3. HLS M3U8 rewriting (when requested directly via /api/proxy)
    const isM3u8Url = finalUrl.split("?")[0].toLowerCase().endsWith(".m3u8") || targetUrl.split("?")[0].toLowerCase().endsWith(".m3u8");
    const isM3u8Type = contentType.includes("mpegurl");

    if (isM3u8Url || isM3u8Type) {
      const text = await upstreamRes.text();
      if (text.includes("#EXTM3U")) {
        const rewritten = text.split("\n").map((line) => {
          const sline = line.trim();
          if (!sline) return line;
          if (sline.startsWith("#")) {
            if (sline.includes('URI="')) {
              return sline.replace(/URI="([^"]+)"/g, (match, rawUri) => {
                try {
                  const absUri = new URL(rawUri, finalUrl).href;
                  return `URI="/api/stream?u=${encodeURIComponent(absUri)}"`;
                } catch {
                  return match;
                }
              });
            }
            return sline;
          }
          try {
            const absUri = new URL(sline, finalUrl).href;
            return `/api/stream?u=${encodeURIComponent(absUri)}`;
          } catch {
            return sline;
          }
        }).join("\n");

        const out = Buffer.from(rewritten, "utf-8");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Content-Length", out.length);
        return res.status(upstreamRes.status).send(out);
      }
    }

    // 4. Buffered safe delivery for all JSON, HTML, text, SVG, images (never copy gzip Content-Length!)
    const isTextOrStructured =
      contentType.includes("json") ||
      contentType.includes("html") ||
      contentType.includes("text/") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("image/") ||
      targetUrl.includes(".json") ||
      !!upstreamEncoding;

    if (isTextOrStructured || !upstreamRes.body) {
      const arrayBuffer = await upstreamRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", buffer.length);
      return res.status(upstreamRes.status).send(buffer);
    }

    // 5. Real-time streaming for large uncompressed media/binary
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
    res.status(upstreamRes.status);

    let clientClosed = false;
    res.on("close", () => { clientClosed = true; });
    for await (const chunk of upstreamRes.body) {
      if (clientClosed) break;
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
      }
    }
    if (!clientClosed) res.end();
  } catch (err) {
    if (err.name === "AbortError" || err.code === "ECONNRESET") {
      return;
    }
    console.error("Vercel Proxy Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
