import { sortAndLabelSources } from "./_sources.js";

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

    res.setHeader("X-Final-Url", finalUrl);
    if (upstreamRes.headers.get("set-cookie")) {
      res.setHeader("X-Upstream-Set-Cookie", upstreamRes.headers.get("set-cookie"));
    }

    // 1. Resolution endpoints (/resolve & /client-fetch):
    if (finalUrl.includes("/resolve") || targetUrl.includes("/resolve") || finalUrl.includes("/client-fetch") || targetUrl.includes("/client-fetch")) {
      const text = await upstreamRes.text();
      try {
        const data = JSON.parse(text);
        if (data && typeof data.url === "string" && data.url.startsWith("http://")) {
          data.proxy = true;
        }
        return res.status(upstreamRes.status).json(data);
      } catch {
        res.setHeader("Content-Type", contentType);
        return res.status(upstreamRes.status).send(Buffer.from(text, "utf-8"));
      }
    }

    // 2. VOD Sources filtering & French language prioritization
    if (finalUrl.includes("/vod/source/")) {
      const data = await upstreamRes.json();
      data.sources = sortAndLabelSources(data.sources || []);
      return res.status(upstreamRes.status).json(data);
    }

    // 3. JSON delivery (Channels catalog, mhub-addon.json, etc.):
    // Use res.json() to prevent any Content-Length / compression mismatch!
    const isJson = contentType.includes("json") || targetUrl.endsWith(".json") || targetUrl.includes(".json?");
    if (isJson) {
      try {
        const text = await upstreamRes.text();
        const parsed = JSON.parse(text);
        return res.status(upstreamRes.status).json(parsed);
      } catch {
        // Fallback to text if JSON parse fails
      }
    }

    // 4. HLS M3U8 rewriting (when requested directly via /api/proxy)
    const isM3u8Url = finalUrl.split("?")[0].toLowerCase().endsWith(".m3u8") || targetUrl.split("?")[0].toLowerCase().endsWith(".m3u8");
    const isM3u8Type = contentType.includes("mpegurl");

    if (isM3u8Url || isM3u8Type) {
      const text = await upstreamRes.text();
      if (text.includes("#EXTM3U")) {
        const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
        const host = req.headers["x-forwarded-host"] || req.headers.host || "kibangoutv.vercel.app";
        const fullStreamBase = `${proto}://${host}/api/stream`;
        const rewritten = text.split("\n").map((line) => {
          const sline = line.trim();
          if (!sline) return line;
          if (sline.startsWith("#")) {
            if (sline.includes('URI="')) {
              return sline.replace(/URI="([^"]+)"/g, (match, rawUri) => {
                try {
                  const absUri = new URL(rawUri, finalUrl).href;
                  return `URI="${fullStreamBase}?u=${encodeURIComponent(absUri)}"`;
                } catch {
                  return match;
                }
              });
            }
            return sline;
          }
          try {
            const absUri = new URL(sline, finalUrl).href;
            return `${fullStreamBase}?u=${encodeURIComponent(absUri)}`;
          } catch {
            return sline;
          }
        }).join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        return res.status(upstreamRes.status).send(Buffer.from(rewritten, "utf-8"));
      }
    }

    // 5. Safe delivery for other resources (images, HTML, binary)
    const arrayBuffer = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader("Content-Type", contentType);
    if (upstreamRes.headers.get("content-range")) {
      res.setHeader("Content-Range", upstreamRes.headers.get("content-range"));
    }
    if (upstreamRes.headers.get("accept-ranges")) {
      res.setHeader("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
    }
    return res.status(upstreamRes.status).send(buffer);

  } catch (err) {
    if (err.name === "AbortError" || err.code === "ECONNRESET") {
      return;
    }
    console.error("Vercel Proxy Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
