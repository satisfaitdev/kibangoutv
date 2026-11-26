import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Profiles de transcodage adaptatif optimisés pour les réseaux mobiles 2G/3G/4G.
 * Chaque profil garantit un keyframe IDR initial et des timestamps PTS conservés (-copyts)
 * pour permettre le changement de qualité à la volée dans Hls.js sans coupure ni désynchronisation.
 */
export const TRANSCODE_PROFILES = Object.freeze({
  "720p": {
    id: "720p",
    bandwidth: 1200000,
    resolution: "1280x720",
    name: "720p HD",
    height: 720,
    vBitrate: "1050k",
    maxRate: "1200k",
    bufSize: "2400k",
    aBitrate: "96k",
    audioCh: "2",
    fpsFilter: ""
  },
  "480p": {
    id: "480p",
    bandwidth: 550000,
    resolution: "854x480",
    name: "480p 3G",
    height: 480,
    vBitrate: "450k",
    maxRate: "550k",
    bufSize: "1100k",
    aBitrate: "64k",
    audioCh: "2",
    fpsFilter: ""
  },
  "360p": {
    id: "360p",
    bandwidth: 260000,
    resolution: "640x360",
    name: "360p 2G/3G",
    height: 360,
    vBitrate: "210k",
    maxRate: "260k",
    bufSize: "520k",
    aBitrate: "48k",
    audioCh: "2",
    fpsFilter: ""
  },
  "240p": {
    id: "240p",
    bandwidth: 130000,
    resolution: "426x240",
    name: "240p Ultra-Éco",
    height: 240,
    vBitrate: "95k",
    maxRate: "120k",
    bufSize: "240k",
    aBitrate: "32k",
    audioCh: "1",
    fpsFilter: ",fps=20"
  }
});

export const ORDERED_DOWNSCALE_IDS = ["720p", "480p", "360p", "240p"];

let cachedFfmpegPath = undefined;

/**
 * Résout le chemin vers le binaire statique FFmpeg sans bloquer les requêtes passthrough.
 */
export async function resolveFfmpegPath() {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  const localBin = path.join(
    process.cwd(),
    "node_modules",
    "ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );
  if (fs.existsSync(localBin)) {
    try {
      if (process.platform !== "win32") fs.chmodSync(localBin, 0o755);
    } catch {}
    cachedFfmpegPath = localBin;
    return cachedFfmpegPath;
  }

  try {
    const mod = await import("ffmpeg-static");
    const modPath = mod && typeof mod.default === "string" ? mod.default : null;
    if (modPath && fs.existsSync(modPath)) {
      try {
        if (process.platform !== "win32") fs.chmodSync(modPath, 0o755);
      } catch {}
      cachedFfmpegPath = modPath;
      return cachedFfmpegPath;
    }
  } catch {}

  cachedFfmpegPath = null;
  return null;
}

/**
 * Fusionne des en-têtes personnalisés de façon insensible à la casse
 * pour éviter les doublons (ex: "User-Agent" + "user-agent" provoquant 403 sur mixdrop).
 */
export function mergeHeadersCaseInsensitive(baseHeaders, extraHeaders, allowedLowerSet = null) {
  const out = {};
  const lowerToKey = new Map();

  for (const [k, v] of Object.entries(baseHeaders || {})) {
    if (typeof v !== "string" || !v) continue;
    out[k] = v;
    lowerToKey.set(k.toLowerCase(), k);
  }

  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (typeof v !== "string" || !v) continue;
      const lk = k.toLowerCase();
      if (allowedLowerSet && !allowedLowerSet.has(lk)) continue;
      const prevKey = lowerToKey.get(lk);
      if (prevKey && prevKey !== k) {
        delete out[prevKey];
      }
      out[k] = v;
      lowerToKey.set(lk, k);
    }
  }

  return out;
}

/**
 * Nettoie et déduit un nom de fichier sûr pour Content-Disposition: attachment.
 */
export function buildContentDisposition(rawFilename, finalUrl, contentType) {
  let base = String(rawFilename || "").trim();
  base = base.replace(/[/\\]/g, " ").replace(/\.\.+/g, ".").replace(/[\r\n"<>:|?*]+/g, "").trim();

  if (!base) {
    try {
      const urlPath = new URL(finalUrl).pathname.split("/").filter(Boolean).pop() || "";
      base = decodeURIComponent(urlPath).replace(/[\r\n"<>:|?*]+/g, "").trim();
    } catch {}
  }
  if (!base) base = "kibangoutv-video";

  const hasKnownExt = /\.(mp4|mkv|webm|mov|avi|ts|m4v|mp3|aac)$/i.test(base);
  if (!hasKnownExt) {
    const lowerUrl = String(finalUrl || "").split("?")[0].toLowerCase();
    const lowerCt = String(contentType || "").toLowerCase();
    let ext = ".mp4";
    if (lowerUrl.endsWith(".mkv") || lowerCt.includes("matroska")) ext = ".mkv";
    else if (lowerUrl.endsWith(".webm") || lowerCt.includes("webm")) ext = ".webm";
    else if (lowerUrl.endsWith(".ts") || lowerCt.includes("mp2t")) ext = ".ts";
    else if (lowerUrl.endsWith(".m4v")) ext = ".m4v";
    else if (lowerUrl.endsWith(".mov")) ext = ".mov";
    base = `${base}${ext}`;
  }

  if (base.length > 140) {
    const dotIdx = base.lastIndexOf(".");
    const ext = dotIdx > 0 ? base.slice(dotIdx) : ".mp4";
    base = `${base.slice(0, 140 - ext.length)}${ext}`;
  }

  const asciiSafe = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "kibangoutv-video.mp4";
  const encodedUtf8 = encodeURIComponent(base).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodedUtf8}`;
}

/**
 * Protection anti-SSRF : autorise uniquement HTTP/HTTPS publics, bloque loopback et métadonnées cloud.
 */
export function validatePublicStreamUrl(rawUrl) {
  let target = String(rawUrl || "").trim();
  if (!target) return null;

  if (target.startsWith("//")) target = "https:" + target;
  else if (!/^https?:\/\//i.test(target)) target = "https://" + target.replace(/^\/+/, "");

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }

  return parsed.href;
}

export function normalizeQualityId(rawQ) {
  if (!rawQ) return "";
  const q = String(rawQ).trim().toLowerCase();
  if (q === "orig" || q === "original" || q === "1080p") return "orig";
  return Object.prototype.hasOwnProperty.call(TRANSCODE_PROFILES, q) ? q : "";
}

/**
 * Construit un Master Playlist Multi-Débit (#EXT-X-STREAM-INF) pour tout flux HLS
 * afin d'offrir de véritables variantes compressées 720p/480p/360p/240p sur 2G/3G.
 */
export function buildAdaptiveM3u8(playlistText, finalUrl, fullStreamBase, requestedQuality, canTranscode) {
  const isMaster = playlistText.includes("#EXT-X-STREAM-INF");
  const hasFmp4Map = playlistText.includes("#EXT-X-MAP");
  const isEncrypted = playlistText.includes("#EXT-X-KEY") && !playlistText.includes("METHOD=NONE");
  const allowTranscode = canTranscode && !hasFmp4Map && !isEncrypted;
  const lines = playlistText.split(/\r?\n/);

  if (!isMaster) {
    if (!requestedQuality && allowTranscode && playlistText.includes("#EXTINF:")) {
      const encodedSrc = encodeURIComponent(finalUrl);
      const masterLines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,NAME="Original HD"`,
        `${fullStreamBase}?u=${encodedSrc}&q=orig`
      ];
      for (const pid of ORDERED_DOWNSCALE_IDS) {
        const p = TRANSCODE_PROFILES[pid];
        masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},RESOLUTION=${p.resolution},NAME="${p.name}"`);
        masterLines.push(`${fullStreamBase}?u=${encodedSrc}&q=${pid}`);
      }
      return masterLines.join("\n");
    }

    const qSuffix = requestedQuality && requestedQuality !== "orig" && !hasFmp4Map && !isEncrypted ? `&q=${requestedQuality}` : "";
    return lines
      .map((line) => {
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
          return `${fullStreamBase}?u=${encodeURIComponent(absUri)}${qSuffix}`;
        } catch {
          return sline;
        }
      })
      .join("\n");
  }

  let lowestBandwidth = Infinity;
  let lowestVariantUrl = null;
  const rewritten = [];

  for (let i = 0; i < lines.length; i++) {
    const sline = lines[i].trim();
    if (!sline) {
      rewritten.push(lines[i]);
      continue;
    }

    if (sline.startsWith("#EXT-X-STREAM-INF:")) {
      const bwMatch = sline.match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? Number(bwMatch[1]) : Infinity;
      const nextLine = (lines[i + 1] || "").trim();
      if (nextLine && !nextLine.startsWith("#") && bw < lowestBandwidth) {
        try {
          lowestBandwidth = bw;
          lowestVariantUrl = new URL(nextLine, finalUrl).href;
        } catch {}
      }
      rewritten.push(sline);
      continue;
    }

    if (sline.startsWith("#")) {
      if (sline.includes('URI="')) {
        rewritten.push(
          sline.replace(/URI="([^"]+)"/g, (match, rawUri) => {
            try {
              const absUri = new URL(rawUri, finalUrl).href;
              return `URI="${fullStreamBase}?u=${encodeURIComponent(absUri)}"`;
            } catch {
              return match;
            }
          })
        );
      } else {
        rewritten.push(sline);
      }
      continue;
    }

    try {
      const absUri = new URL(sline, finalUrl).href;
      rewritten.push(`${fullStreamBase}?u=${encodeURIComponent(absUri)}&q=orig`);
    } catch {
      rewritten.push(sline);
    }
  }

  if (allowTranscode && lowestVariantUrl && lowestBandwidth > 650000) {
    const encodedLowest = encodeURIComponent(lowestVariantUrl);
    for (const pid of ["480p", "360p", "240p"]) {
      const p = TRANSCODE_PROFILES[pid];
      if (p.bandwidth < lowestBandwidth) {
        rewritten.push(`#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},RESOLUTION=${p.resolution},NAME="${p.name}"`);
        rewritten.push(`${fullStreamBase}?u=${encodedLowest}&q=${pid}`);
      }
    }
  }

  return rewritten.join("\n");
}

/**
 * Transcode un flux ReadableStream MPEG-TS en continu via FFmpeg (pipe:0 -> pipe:1)
 * avec flush immédiat des paquets (-flush_packets 1) pour un démarrage sans latence.
 */
export function createTranscodedStream(ffmpegBin, upstreamBody, profile, signal) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    "pipe:0",
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=-2:${profile.height}:flags=fast_bilinear${profile.fpsFilter}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "0",
    "-force_key_frames",
    "expr:eq(n,0)",
    "-b:v",
    profile.vBitrate,
    "-maxrate",
    profile.maxRate,
    "-bufsize",
    profile.bufSize,
    "-c:a",
    "aac",
    "-b:a",
    profile.aBitrate,
    "-ac",
    profile.audioCh,
    "-ar",
    "44100",
    "-copyts",
    "-muxdelay",
    "0",
    "-f",
    "mpegts",
    "-flush_packets",
    "1",
    "pipe:1"
  ];

  let ff = null;
  let reader = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      reader?.cancel().catch(() => {});
    } catch {}
    try {
      if (ff && !ff.killed) ff.kill("SIGKILL");
    } catch {}
  };

  return new ReadableStream({
    start(controller) {
      ff = spawn(ffmpegBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderrTail = "";

      if (signal) {
        if (signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        signal.addEventListener("abort", cleanup, { once: true });
      }

      ff.stdout.on("data", (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          cleanup();
        }
      });

      ff.stderr.on("data", (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-500);
      });

      ff.stdout.on("end", () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      });

      ff.on("error", (err) => {
        if (!closed) {
          closed = true;
          controller.error(err);
        }
      });

      ff.on("close", (code) => {
        if (code && code !== 0 && !closed) {
          console.error("[KibangouTV Transcoder] FFmpeg exit", code, stderrTail);
        }
      });

      if (!upstreamBody) {
        ff.stdin.end();
        return;
      }

      reader = upstreamBody.getReader();
      (async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!ff.stdin.writable) break;
            if (!ff.stdin.write(value)) {
              await new Promise((resolve) => ff.stdin.once("drain", resolve));
            }
          }
        } catch (err) {
          if (!closed) console.error("[KibangouTV Transcoder] Pipe input error:", err?.message || err);
        } finally {
          try {
            ff.stdin.end();
          } catch {}
        }
      })();
    },
    cancel() {
      cleanup();
    }
  });
}
