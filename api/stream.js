import {
  TRANSCODE_PROFILES,
  buildAdaptiveM3u8,
  createTranscodedStream,
  normalizeQualityId,
  resolveFfmpegPath,
  validatePublicStreamUrl
} from "./_streamUtils.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*"
};

const ALLOWED_FORWARD_HEADERS = new Set([
  "referer",
  "origin",
  "user-agent",
  "cookie",
  "x-requested-with",
  "accept",
  "accept-language"
]);

function decodeHeaderToken(parsed) {
  let hCode = parsed.searchParams.get("h") || "";
  if (!hCode) {
    const m = parsed.pathname.match(/\/h_([A-Za-z0-9_-]+)/);
    if (m) hCode = m[1];
  }
  if (!hCode) return {};

  try {
    const b64 = hCode.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function HEAD(request) {
  return handleStreamRequest(request, "HEAD");
}

export async function GET(request) {
  return handleStreamRequest(request, "GET");
}

async function handleStreamRequest(request, method) {
  try {
    const parsed = new URL(request.url, "https://kibangoutv.vercel.app");
    const rawTarget = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    const targetUrl = validatePublicStreamUrl(rawTarget);

    if (!targetUrl) {
      return Response.json(
        { error: "Invalid or missing public stream URL" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const customHeaders = decodeHeaderToken(parsed);
    const fetchHeaders = {
      "User-Agent": targetUrl.includes("vavoo")
        ? "VAVOO/2.6"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    };

    for (const [k, v] of Object.entries(customHeaders)) {
      if (typeof v === "string" && v && ALLOWED_FORWARD_HEADERS.has(k.toLowerCase())) {
        fetchHeaders[k] = v;
      }
    }

    const lowerUrlPath = targetUrl.split("?")[0].toLowerCase();
    const isHlsPlaylistHint = lowerUrlPath.endsWith(".m3u8");
    const isTsSegmentHint =
      lowerUrlPath.endsWith(".ts") ||
      lowerUrlPath.endsWith(".m4s") ||
      lowerUrlPath.endsWith(".aac") ||
      lowerUrlPath.endsWith(".key");
    const isMp4Hint = lowerUrlPath.endsWith(".mp4") || lowerUrlPath.endsWith(".mkv");

    const incomingRange = request.headers.get("range");
    if (incomingRange) {
      const openMatch = !isHlsPlaylistHint && !isTsSegmentHint && /^bytes=(\d+)-$/i.exec(incomingRange.trim());
      if (openMatch) {
        const start = Number(openMatch[1]);
        fetchHeaders["Range"] = `bytes=${start}-${start + 3 * 1024 * 1024 - 1}`;
      } else {
        fetchHeaders["Range"] = incomingRange;
      }
    } else if (
      !isHlsPlaylistHint &&
      !isTsSegmentHint &&
      (isMp4Hint || lowerUrlPath.includes("cloudatacdn") || lowerUrlPath.includes("mxcontent"))
    ) {
      fetchHeaders["Range"] = "bytes=0-3145727";
    }

    const upstreamRes = await fetch(targetUrl, {
      method,
      headers: fetchHeaders,
      redirect: "follow",
      signal: request.signal
    });

    const finalUrl = upstreamRes.url || targetUrl;
    const contentType = (upstreamRes.headers.get("content-type") || "application/octet-stream").toLowerCase();

    if (method === "HEAD") {
      const headHeaders = new Headers(CORS_HEADERS);
      headHeaders.set("Content-Type", contentType);
      if (upstreamRes.headers.get("accept-ranges")) {
        headHeaders.set("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
      }
      return new Response(null, { status: upstreamRes.status, headers: headHeaders });
    }

    const isPlaylistCandidate =
      isHlsPlaylistHint ||
      finalUrl.split("?")[0].toLowerCase().endsWith(".m3u8") ||
      contentType.includes("mpegurl");

    const q = normalizeQualityId(parsed.searchParams.get("q"));
    const ffmpegBin = await resolveFfmpegPath();

    if (isPlaylistCandidate) {
      const text = await upstreamRes.text();
      if (text.includes("#EXTM3U")) {
        const proto = (request.headers.get("x-forwarded-proto") || parsed.protocol.replace(":", "") || "https")
          .split(",")[0]
          .trim();
        const host =
          request.headers.get("x-forwarded-host") ||
          request.headers.get("host") ||
          parsed.host ||
          "kibangoutv.vercel.app";

        let hCode = parsed.searchParams.get("h") || "";
        if (!hCode) {
          const m = parsed.pathname.match(/\/h_([A-Za-z0-9_-]+)/);
          if (m) hCode = m[1];
        }
        const streamBasePath = hCode ? `/api/stream/h_${hCode}` : "/api/stream";
        const fullStreamBase = `${proto}://${host}${streamBasePath}`;

        const rewritten = buildAdaptiveM3u8(text, finalUrl, fullStreamBase, q, Boolean(ffmpegBin));
        return new Response(rewritten, {
          status: upstreamRes.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Kibangou-ABR": ffmpegBin ? "adaptive-ffmpeg" : "passthrough"
          }
        });
      }

      return new Response(text, {
        status: upstreamRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": contentType, "Cache-Control": "no-store" }
      });
    }

    // Transcodage adaptatif à la volée des segments MPEG-TS quand un profil bas débit est demandé
    if (q && q !== "orig" && ffmpegBin && TRANSCODE_PROFILES[q] && upstreamRes.ok && upstreamRes.body) {
      const profile = TRANSCODE_PROFILES[q];
      const transcodedStream = createTranscodedStream(ffmpegBin, upstreamRes.body, profile, request.signal);
      return new Response(transcodedStream, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "video/mp2t",
          "Cache-Control": "no-store",
          "X-Kibangou-Quality": q,
          "X-Kibangou-Transcoded": "ffmpeg-pipe"
        }
      });
    }

    // Streaming direct zéro-bufferisation pour passthrough 1080p/4K et VOD
    const outHeaders = new Headers(CORS_HEADERS);
    outHeaders.set("Content-Type", contentType);
    outHeaders.set("Cache-Control", "no-store");
    if (upstreamRes.headers.get("content-range")) {
      outHeaders.set("Content-Range", upstreamRes.headers.get("content-range"));
    }
    if (upstreamRes.headers.get("accept-ranges")) {
      outHeaders.set("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: outHeaders
    });
  } catch (err) {
    if (err?.name === "AbortError" || err?.code === "ECONNRESET") {
      return new Response(null, { status: 499, headers: CORS_HEADERS });
    }
    console.error("Kibangou Stream Error:", err);
    return Response.json(
      { error: String(err?.message || err) },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
