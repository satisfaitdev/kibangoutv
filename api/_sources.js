const EXCLUDED_VOD_HOSTS = ["vidoza.", "supervideo.", "superplayer."];

const FAST_HOST_PRIORITY = [
  "dood.yt",
  "filemoon",
  "mixdrop",
  "mxdrop",
  "dood.to",
  "playmogo",
  "d000d",
  "myvidplay",
  "vidply",
  "voe.sx"
];

const LANGUAGE_INFO = {
  fr: { label: "🇫🇷 Français VF", tier: 0 },
  fra: { label: "🇫🇷 Français VF", tier: 0, code: "fr" },
  fre: { label: "🇫🇷 Français VF", tier: 0, code: "fr" },
  french: { label: "🇫🇷 Français VF", tier: 0, code: "fr" },
  vf: { label: "🇫🇷 Français VF", tier: 0, code: "fr" },
  vff: { label: "🇫🇷 Français VFF", tier: 0, code: "fr" },
  truefrench: { label: "🇫🇷 TrueFrench VF", tier: 0, code: "fr" },
  vostfr: { label: "🇫🇷 VOSTFR", tier: 1, code: "fr" },
  en: { label: "🇬🇧 Anglais VO", tier: 2 },
  eng: { label: "🇬🇧 Anglais VO", tier: 2, code: "en" },
  english: { label: "🇬🇧 Anglais VO", tier: 2, code: "en" },
  vo: { label: "🇬🇧 Anglais VO", tier: 2, code: "en" },
  de: { label: "🇩🇪 Allemand DE", tier: 3 },
  ger: { label: "🇩🇪 Allemand DE", tier: 3, code: "de" },
  deu: { label: "🇩🇪 Allemand DE", tier: 3, code: "de" },
  es: { label: "🇪🇸 Espagnol ES", tier: 3 },
  spa: { label: "🇪🇸 Espagnol ES", tier: 3, code: "es" },
  it: { label: "🇮🇹 Italien IT", tier: 3 },
  ita: { label: "🇮🇹 Italien IT", tier: 3, code: "it" },
  pt: { label: "🇵🇹 Portugais PT", tier: 3 },
  por: { label: "🇵🇹 Portugais PT", tier: 3, code: "pt" },
  nl: { label: "🇳🇱 Néerlandais NL", tier: 3 },
  pl: { label: "🇵🇱 Polonais PL", tier: 3 },
  tr: { label: "🇹🇷 Turc TR", tier: 3 },
  ar: { label: "🇸🇦 Arabe AR", tier: 3 },
  ru: { label: "🇷🇺 Russe RU", tier: 3 },
  ja: { label: "🇯🇵 Japonais JA", tier: 3 },
  jpn: { label: "🇯🇵 Japonais JA", tier: 3, code: "ja" },
  ko: { label: "🇰🇷 Coréen KO", tier: 3 },
  zh: { label: "🇨🇳 Chinois ZH", tier: 3 },
  hi: { label: "🇮🇳 Hindi HI", tier: 3 },
  ro: { label: "🇷🇴 Roumain RO", tier: 3 },
  cs: { label: "🇨🇿 Tchèque CS", tier: 3 },
  hu: { label: "🇭🇺 Hongrois HU", tier: 3 },
  multi: { label: "🌐 Multi-Audio", tier: 1 }
};

const RESOLVE_TTL_MS = 45_000;
const MAX_RESOLVE_CACHE = 300;
const resolveCache = new Map();
const inflightResolves = new Map();

export function isExcludedVodHost(url) {
  const lower = String(url || "").toLowerCase();
  return !lower || EXCLUDED_VOD_HOSTS.some((h) => lower.includes(h));
}

function hostPriority(url) {
  const lower = String(url || "").toLowerCase();
  const idx = FAST_HOST_PRIORITY.findIndex((h) => lower.includes(h));
  return idx >= 0 ? idx : FAST_HOST_PRIORITY.length;
}

function extractHostLabel(url, fallbackName = "Serveur") {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    for (const h of FAST_HOST_PRIORITY) {
      if (host.includes(h)) return h;
    }
    return host || fallbackName;
  } catch {
    return fallbackName;
  }
}

function classifySourceLanguage(source) {
  const rawLangs = Array.isArray(source.languages)
    ? source.languages.map((l) => String(l || "").trim().toLowerCase()).filter(Boolean)
    : source.language
      ? [String(source.language).trim().toLowerCase()]
      : [];

  const hintText = `${source.name || ""} ${source.label || ""} ${source.quality || ""} ${
    Array.isArray(source.subtitles) ? source.subtitles.join(" ") : source.subtitles || ""
  }`.toLowerCase();

  const isVostfr =
    hintText.includes("vostfr") ||
    hintText.includes("subfr") ||
    rawLangs.includes("vostfr") ||
    (rawLangs.includes("en") && rawLangs.includes("fr"));

  if (isVostfr) {
    return {
      tier: 1,
      label: "🇫🇷 VOSTFR",
      codes: rawLangs.includes("fr") ? rawLangs : ["fr", ...rawLangs.filter((c) => c !== "fr")]
    };
  }

  for (const raw of rawLangs) {
    const base = raw.split(/[-_]/)[0];
    const info = LANGUAGE_INFO[raw] || LANGUAGE_INFO[base];
    if (info) {
      const normalizedCode = info.code || base || raw;
      return {
        tier: info.tier,
        label: info.label,
        codes: [normalizedCode, ...rawLangs.filter((c) => c !== raw && c !== normalizedCode)]
      };
    }
  }

  if (/\b(truefrench|vff|vf|french|français)\b/i.test(hintText)) {
    return { tier: 0, label: "🇫🇷 Français VF", codes: ["fr"] };
  }
  if (/\b(english|vo)\b/i.test(hintText)) {
    return { tier: 2, label: "🇬🇧 Anglais VO", codes: ["en"] };
  }

  if (rawLangs.length > 0) {
    const primary = rawLangs[0].toUpperCase();
    return { tier: 3, label: `🌐 ${primary}`, codes: rawLangs };
  }

  return { tier: 4, label: "🌐 Multilingue / VO", codes: ["und"] };
}

/**
 * Filtre les hébergeurs cassés, priorise Français VF puis VOSTFR/VO et les serveurs les plus rapides,
 * et formate proprement le nom + codes de langue pour Vuma.
 */
export function sortAndLabelSources(rawList) {
  const seen = new Set();
  const valid = [];

  for (const s of rawList || []) {
    if (!s || typeof s.url !== "string" || !s.url) continue;
    if (isExcludedVodHost(s.url)) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    valid.push(s);
  }

  const enriched = valid.map((s, originalIndex) => {
    const lang = classifySourceLanguage(s);
    const quality = s.quality ? String(s.quality).trim() : "HD";
    const hostLabel = extractHostLabel(s.url, s.name || "Serveur");
    return {
      tier: lang.tier,
      hostRank: hostPriority(s.url),
      originalIndex,
      source: {
        ...s,
        name: `${lang.label} • ${hostLabel}`,
        quality,
        languages: lang.codes
      }
    };
  });

  enriched.sort(
    (a, b) => a.tier - b.tier || a.hostRank - b.hostRank || a.originalIndex - b.originalIndex
  );

  return enriched.map((entry) => entry.source);
}

/**
 * Direct-first : n'active le proxy que si le flux est en HTTP clair (Mixed Content)
 * ou nécessite des en-têtes personnalisés (ex: Referer/UA sur mixdrop ou dood.to).
 * Les flux HTTPS sans en-têtes personnalisés sont lus directement par le navigateur.
 */
export function normalizeResolvedPlayback(data, isLive = false) {
  if (!data || typeof data !== "object") return data;
  if (typeof data.url === "string" && data.url) {
    const hasCustomHeaders =
      data.headers && typeof data.headers === "object" && Object.keys(data.headers).length > 0;
    if (data.url.startsWith("http://") || hasCustomHeaders) {
      data.proxy = true;
    } else if (data.url.startsWith("https://")) {
      data.proxy = false;
    }
  }
  return data;
}

function getEntryExpiryMs(data, fallbackTs) {
  const defaultExp = fallbackTs + RESOLVE_TTL_MS;
  if (typeof data?.url !== "string" || !data.url) return 0;
  try {
    const parsed = new URL(data.url);
    if (!parsed.searchParams.has("expiry")) {
      return defaultExp;
    }
    const rawExp = parsed.searchParams.get("expiry");
    if (!rawExp || !/^\d+(\.\d+)?$/.test(rawExp.trim())) {
      return 0;
    }
    const expParam = Number(rawExp);
    if (!Number.isFinite(expParam) || expParam <= 0) {
      return 0;
    }
    // Vavoo retourne un timestamp Unix en ms (13 chiffres) ou secondes (10 chiffres) ; marge de sécurité de 5s
    const tokenExp = (expParam < 1e12 ? expParam * 1000 : expParam) - 5000;
    if (tokenExp <= fallbackTs) {
      return 0;
    }
    return Math.min(defaultExp, tokenExp);
  } catch {
    return 0;
  }
}

/**
 * Cache TTL court (45s max, borné par expiry amont) + déduplication des requêtes simultanées pour /resolve.
 */
export async function resolveVavooWithCache(upstreamUrl, { isLive = false, bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache) {
    const cached = resolveCache.get(upstreamUrl);
    if (cached && now < cached.expiresAt) {
      return {
        status: cached.status,
        data: { ...cached.data },
        cacheHit: true,
        durationMs: 0,
        timedOut: false
      };
    }
    if (cached) resolveCache.delete(upstreamUrl);
  }

  if (inflightResolves.has(upstreamUrl)) {
    const shared = await inflightResolves.get(upstreamUrl);
    return {
      status: shared.status,
      data: shared.data ? { ...shared.data } : shared.data,
      rawText: shared.rawText,
      cacheHit: false,
      durationMs: shared.durationMs || 0,
      timedOut: Boolean(shared.timedOut)
    };
  }

  const t0 = Date.now();
  const task = (async () => {
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: { "User-Agent": "VAVOO/2.6", "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      const rawText = await upstreamRes.text();
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return { status: upstreamRes.status, rawText, data: null, durationMs: Date.now() - t0, timedOut: false };
      }
      const durationMs = Date.now() - t0;

      normalizeResolvedPlayback(parsed, isLive);

      if (upstreamRes.ok && parsed && typeof parsed.url === "string" && parsed.url) {
        const tsNow = Date.now();
        const expiresAt = getEntryExpiryMs(parsed, tsNow);
        if (expiresAt > tsNow) {
          if (resolveCache.size >= MAX_RESOLVE_CACHE) {
            const oldestKey = resolveCache.keys().next().value;
            resolveCache.delete(oldestKey);
          }
          resolveCache.set(upstreamUrl, { status: upstreamRes.status, data: parsed, expiresAt });
        }
      }

      return { status: upstreamRes.status, data: parsed, rawText: null, durationMs, timedOut: false };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw Object.assign(err || new Error("Resolve failed"), { durationMs, timedOut });
    }
  })();

  inflightResolves.set(upstreamUrl, task);
  try {
    const res = await task;
    return { ...res, cacheHit: false };
  } finally {
    inflightResolves.delete(upstreamUrl);
  }
}
