export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const rawReqUrl = req.url || "";
    const parsed = new URL(rawReqUrl, "https://localhost");

    // Extract optional encoded headers from path: /api/stream/h_<base64url>
    let customHeaders = {};
    const pathMatch = parsed.pathname.match(/\/h_([A-Za-z0-9_-]+)/);
    if (pathMatch) {
      try {
        const b64 = pathMatch[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf-8");
        const obj = JSON.parse(decoded);
        if (obj && typeof obj === "object") {
          customHeaders = obj;
        }
      } catch {}
    }

    let targetUrl = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    if (!targetUrl) {
      return res.status(400).json({ error: "Missing u parameter" });
    }

    if (targetUrl.startsWith("//")) {
      targetUrl = "https:" + targetUrl;
    } else if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
    }

    const fetchHeaders = {
      "User-Agent": targetUrl.includes("vavoo")
        ? "VAVOO/2.6"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    };

    for (const [k, v] of Object.entries(customHeaders)) {
      if (typeof v !== "string" || !v) continue;
      const lk = k.toLowerCase();
      if (["referer", "origin", "user-agent", "cookie", "x-requested-with", "accept", "accept-language"].includes(lk)) {
        fetchHeaders[k] = v;
      }
    }

    // Open-ended byte range slicing for multi-GB MP4s on serverless (3 MB slices avoid Lambda timeouts)
    const lowerUrlPath = targetUrl.split("?")[0].toLowerCase();
    const isHlsPlaylistHint = lowerUrlPath.endsWith(".m3u8");
    const isTsSegmentHint = lowerUrlPath.endsWith(".ts") || lowerUrlPath.endsWith(".m4s") || lowerUrlPath.endsWith(".aac");
    const incomingRange = req.headers.range;

    if (incomingRange) {
      const openMatch = !isHlsPlaylistHint && !isTsSegmentHint && /^bytes=(\d+)-$/i.exec(incomingRange.trim());
      if (openMatch) {
        const start = Number(openMatch[1]);
        const sliceEnd = start + 3 * 1024 * 1024 - 1;
        fetchHeaders["Range"] = `bytes=${start}-${sliceEnd}`;
      } else {
        fetchHeaders["Range"] = incomingRange;
      }
    } else if (!isHlsPlaylistHint && !isTsSegmentHint && (lowerUrlPath.endsWith(".mp4") || lowerUrlPath.includes("cloudatacdn") || lowerUrlPath.includes("mxcontent"))) {
      // Initial probe/fetch for MP4 without explicit Range: cap at first 3 MB
      fetchHeaders["Range"] = "bytes=0-3145727";
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: fetchHeaders,
      redirect: "follow"
    });

    const finalUrl = upstreamRes.url || targetUrl;
    const contentType = (upstreamRes.headers.get("content-type") || "application/octet-stream").toLowerCase();
    const upstreamEncoding = upstreamRes.headers.get("content-encoding");

    if (req.method === "HEAD") {
      res.setHeader("Content-Type", contentType);
      if (upstreamRes.headers.get("accept-ranges")) {
        res.setHeader("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
      }
      if (!upstreamEncoding && upstreamRes.headers.get("content-length")) {
        res.setHeader("Content-Length", upstreamRes.headers.get("content-length"));
      }
      return res.status(upstreamRes.status).end();
    }

    // Handle HLS playlists (.m3u8): rewrite relative/external URIs to stay on /api/stream base
    const isM3u8 = finalUrl.split("?")[0].toLowerCase().endsWith(".m3u8") ||
      targetUrl.split("?")[0].toLowerCase().endsWith(".m3u8") ||
      contentType.includes("mpegurl");

    if (isM3u8) {
      const text = await upstreamRes.text();
      if (text.includes("#EXTM3U")) {
        const streamBasePath = parsed.pathname.startsWith("/api/stream") ? parsed.pathname : "/api/stream";
        const rewritten = text.split("\n").map((line) => {
          const sline = line.trim();
          if (!sline) return line;
          if (sline.startsWith("#")) {
            if (sline.includes('URI="')) {
              return sline.replace(/URI="([^"]+)"/g, (match, rawUri) => {
                try {
                  const absUri = new URL(rawUri, finalUrl).href;
                  return `URI="${streamBasePath}?u=${encodeURIComponent(absUri)}"`;
                } catch {
                  return match;
                }
              });
            }
            return sline;
          }
          try {
            const absUri = new URL(sline, finalUrl).href;
            return `${streamBasePath}?u=${encodeURIComponent(absUri)}`;
          } catch {
            return sline;
          }
        }).join("\n");

        const outBuf = Buffer.from(rewritten, "utf-8");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Content-Length", outBuf.length);
        res.setHeader("Cache-Control", "no-store");
        return res.status(upstreamRes.status).send(outBuf);
      }
      const fallbackBuf = Buffer.from(text, "utf-8");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", fallbackBuf.length);
      return res.status(upstreamRes.status).send(fallbackBuf);
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    if (upstreamRes.headers.get("content-range")) {
      res.setHeader("Content-Range", upstreamRes.headers.get("content-range"));
    }
    if (upstreamRes.headers.get("accept-ranges")) {
      res.setHeader("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
    }
    // IMPORTANT: Never forward compressed Content-Length for decoded Web streams
    if (!upstreamEncoding && upstreamRes.headers.get("content-length")) {
      res.setHeader("Content-Length", upstreamRes.headers.get("content-length"));
    }

    res.status(upstreamRes.status);

    if (upstreamRes.body) {
      let clientClosed = false;
      res.on("close", () => { clientClosed = true; });
      try {
        for await (const chunk of upstreamRes.body) {
          if (clientClosed) break;
          const ok = res.write(chunk);
          if (!ok) {
            await new Promise((resolve) => {
              res.once("drain", resolve);
              res.once("close", resolve);
            });
          }
        }
      } catch (streamErr) {
        if (!clientClosed) {
          console.error("Stream write loop error:", streamErr);
        }
      }
      if (!clientClosed) {
        res.end();
      }
      return;
    }

    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    res.setHeader("Content-Length", buf.length);
    return res.send(buf);
  } catch (err) {
    if (err.name === "AbortError" || err.code === "ECONNRESET") {
      return;
    }
    console.error("Kibangou Stream Error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
