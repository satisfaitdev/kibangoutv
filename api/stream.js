import {
  TRANSCODE_PROFILES,
  buildAdaptiveM3u8,
  buildContentDisposition,
  createTranscodedStream,
  mergeHeadersCaseInsensitive,
  normalizeQualityId,
  resolveFfmpegPath,
  validatePublicStreamUrl
} from "./_streamUtils.js";
import { buildCorsHeaders, checkRateLimit, isTrustedAppRequest } from "./_security.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://kibangoutv.vercel.app",
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Headers, X-Requested-With",
  "Access-Control-Expose-Headers": "*"
};

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOWED_FORWARD_HEADERS = new Set([
  "referer",
  "origin",
  "user-agent",
  "cookie",
  "x-requested-with",
  "accept",
  "accept-language"
]);

// Cache court (2.5s) pour éviter le double aller-retour amont lors du passage Master -> Variante ABR
const M3U8_BURST_TTL_MS = 2500;
const MAX_M3U8_CACHE = 100;
const m3u8Cache = new Map();

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

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(request, "GET, HEAD, OPTIONS") });
}

export async function HEAD(request) {
  return handleStreamRequest(request, "HEAD");
}

export async function GET(request) {
  return handleStreamRequest(request, "GET");
}

async function handleStreamRequest(request, method) {
  const corsHeaders = buildCorsHeaders(request, "GET, HEAD, OPTIONS");
  if (!isTrustedAppRequest(request)) {
    return Response.json(
      { error: "Accès refusé (hotlinking interdit)." },
      { status: 403, headers: corsHeaders }
    );
  }
  const rl = checkRateLimit(request, "stream", 240, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Trop de requêtes vidéo." },
      { status: 429, headers: { ...corsHeaders, "Retry-After": String(rl.retryAfterSec) } }
    );
  }
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

    const dlParam = (parsed.searchParams.get("download") || "").trim().toLowerCase();
    const isDownload = dlParam === "1" || dlParam === "true";
    const requestedFilename = parsed.searchParams.get("filename") || "";

    const customHeaders = decodeHeaderToken(parsed);
    const fetchHeaders = mergeHeadersCaseInsensitive(
      {
        "User-Agent": targetUrl.includes("vavoo") ? "VAVOO/2.6" : CHROME_UA,
        "Accept": "*/*",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
      },
      customHeaders,
      ALLOWED_FORWARD_HEADERS
    );

    const lowerUrlPath = targetUrl.split("?")[0].toLowerCase();
    const isHlsPlaylistHint = lowerUrlPath.endsWith(".m3u8");
    const isTsSegmentHint =
      lowerUrlPath.endsWith(".ts") ||
      lowerUrlPath.endsWith(".m4s") ||
      lowerUrlPath.endsWith(".aac") ||
      lowerUrlPath.endsWith(".key");
    const isMp4Hint = lowerUrlPath.endsWith(".mp4") || lowerUrlPath.endsWith(".mkv");

    const incomingRange = request.headers.get("range");
    if (isDownload) {
      if (incomingRange) {
        fetchHeaders["Range"] = incomingRange;
      }
    } else if (incomingRange) {
      const openMatch = !isHlsPlaylistHint && !isTsSegmentHint && /^bytes=(\d+)-$/i.exec(incomingRange.trim());
      if (openMatch) {
        const start = Number(openMatch[1]);
        fetchHeaders["Range"] = `bytes=${start}-${start + 48 * 1024 * 1024 - 1}`;
      } else {
        fetchHeaders["Range"] = incomingRange;
      }
    } else if (
      !isHlsPlaylistHint &&
      !isTsSegmentHint &&
      (isMp4Hint || lowerUrlPath.includes("cloudatacdn") || lowerUrlPath.includes("mxcontent") || lowerUrlPath.includes("mxdrop"))
    ) {
      fetchHeaders["Range"] = "bytes=0-50331647";
    }

    const q = "";
    const headerCacheKey = `${targetUrl}|${customHeaders.referer || customHeaders.Referer || ""}`;

    // Hit rapide du cache M3U8 sur le passage Master -> Variante
    if (method === "GET" && !isDownload && parsed.searchParams.get("q")) {
      const cachedM3u8 = m3u8Cache.get(headerCacheKey);
      if (cachedM3u8 && Date.now() - cachedM3u8.ts < M3U8_BURST_TTL_MS) {
        const fullStreamBase = buildStreamBaseUrl(request, parsed);
        const rewritten = buildAdaptiveM3u8(cachedM3u8.text, cachedM3u8.finalUrl, fullStreamBase, "", false);
        return new Response(rewritten, {
          status: cachedM3u8.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Kibangou-ABR": "passthrough",
            "X-Kibangou-M3U8-Cache": "HIT"
          }
        });
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method,
      headers: fetchHeaders,
      redirect: "follow",
      signal: request.signal
    });

    const finalUrl = upstreamRes.url || targetUrl;
    const contentType = (upstreamRes.headers.get("content-type") || "application/octet-stream").toLowerCase();
    const isHtmlResponse = contentType.includes("text/html") || contentType.includes("application/xhtml");

    if (isDownload && isHtmlResponse) {
      return Response.json(
        { error: "Upstream returned HTML instead of downloadable video media" },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    if (method === "HEAD") {
      const headHeaders = new Headers(CORS_HEADERS);
      headHeaders.set("Content-Type", contentType);
      if (upstreamRes.headers.get("accept-ranges")) {
        headHeaders.set("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
      }
      if (upstreamRes.headers.get("content-length")) {
        headHeaders.set("Content-Length", upstreamRes.headers.get("content-length"));
      }
      if (isDownload) {
        headHeaders.set("Content-Disposition", buildContentDisposition(requestedFilename, finalUrl, contentType));
      }
      return new Response(null, { status: upstreamRes.status, headers: headHeaders });
    }

    const isPlaylistCandidate =
      !isDownload &&
      (isHlsPlaylistHint ||
        finalUrl.split("?")[0].toLowerCase().endsWith(".m3u8") ||
        contentType.includes("mpegurl"));

    if (isPlaylistCandidate) {
      const text = await upstreamRes.text();
      if (text.includes("#EXTM3U")) {
        if (!q && upstreamRes.ok && text.includes("#EXT-X-STREAM-INF")) {
          if (m3u8Cache.size >= MAX_M3U8_CACHE) {
            m3u8Cache.delete(m3u8Cache.keys().next().value);
          }
          m3u8Cache.set(headerCacheKey, {
            text,
            finalUrl,
            status: upstreamRes.status,
            ts: Date.now()
          });
        }

        const fullStreamBase = buildStreamBaseUrl(request, parsed);
        const rewritten = buildAdaptiveM3u8(text, finalUrl, fullStreamBase, "", false);
        return new Response(rewritten, {
          status: upstreamRes.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Kibangou-ABR": "passthrough"
          }
        });
      }

      return new Response(text, {
        status: upstreamRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": contentType, "Cache-Control": "no-store" }
      });
    }

    // Streaming direct zéro-bufferisation pour segments HLS, MP4/MKV et téléchargements (sans transcodage FFmpeg par segment)
    const outHeaders = new Headers(CORS_HEADERS);
    outHeaders.set("Content-Type", contentType);
    outHeaders.set("Cache-Control", "no-store");
    outHeaders.set("X-Accel-Buffering", "no");

    if (isDownload) {
      outHeaders.set("Content-Disposition", buildContentDisposition(requestedFilename, finalUrl, contentType));
    }

    if (upstreamRes.headers.get("content-range")) {
      outHeaders.set("Content-Range", upstreamRes.headers.get("content-range"));
    }
    if (upstreamRes.headers.get("accept-ranges")) {
      outHeaders.set("Accept-Ranges", upstreamRes.headers.get("accept-ranges"));
    }
    if (upstreamRes.headers.get("content-length") && !upstreamRes.headers.get("content-encoding")) {
      outHeaders.set("Content-Length", upstreamRes.headers.get("content-length"));
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

function buildStreamBaseUrl(request, parsed) {
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
  return `${proto}://${host}${streamBasePath}`;
}
