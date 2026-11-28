import { isExcludedVodHost, sortAndLabelSources } from "./_sources.js";

async function fetchVavooSources(url, metrics = null) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "VAVOO/2.6", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (metrics) metrics.vavooMs = Math.max(metrics.vavooMs || 0, Date.now() - t0);
    if (!res.ok) {
      if (metrics) metrics.vavooErrors = (metrics.vavooErrors || 0) + 1;
      return [];
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.sources)) return [];
    return data.sources.filter((s) => s && !isExcludedVodHost(s.url));
  } catch (err) {
    if (metrics) {
      metrics.vavooMs = Math.max(metrics.vavooMs || 0, Date.now() - t0);
      if (err?.name === "TimeoutError" || err?.name === "AbortError") metrics.timeouts = (metrics.timeouts || 0) + 1;
      else metrics.vavooErrors = (metrics.vavooErrors || 0) + 1;
    }
    return [];
  }
}

async function resolveImdbIdFromTmdb(mainId, isEpisode, metrics = null) {
  const t0 = Date.now();
  const metaTypes = isEpisode ? ["series", "video"] : ["video", "series"];
  for (const mType of metaTypes) {
    try {
      const res = await fetch(`https://www.mhub.mx/tmdb/item/${mType}/tmdb:${mainId}.json`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const metaJson = await res.json();
        if (metaJson?.ids?.imdb) {
          if (metrics) metrics.tmdbMs = Date.now() - t0;
          return String(metaJson.ids.imdb).replace(/^tt/i, "");
        }
      }
    } catch (err) {
      if (metrics && (err?.name === "TimeoutError" || err?.name === "AbortError")) {
        metrics.timeouts = (metrics.timeouts || 0) + 1;
      }
    }
  }
  if (metrics) metrics.tmdbMs = Date.now() - t0;
  return "";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const rawUrl = req.url || "";
    let subPath = "";

    if (rawUrl.includes("/kibangou-addon/source/")) {
      subPath = rawUrl.split("/kibangou-addon/source/")[1];
    } else if (rawUrl.includes("/french-addon/source/")) {
      subPath = rawUrl.split("/french-addon/source/")[1];
    } else if (rawUrl.includes("/adult-addon/source/")) {
      subPath = rawUrl.split("/adult-addon/source/")[1];
    } else if (rawUrl.includes("/source/")) {
      subPath = rawUrl.split("/source/")[1];
    } else {
      subPath = rawUrl.replace(/^\/+/, "");
    }

    subPath = decodeURIComponent(subPath).split("?")[0].replace(/\.json$/i, "");
    const parts = subPath.split("/").filter(Boolean);

    if (parts.length < 2) {
      return res.status(200).json({ sources: [] });
    }

    const type = parts[0];
    const rawId = parts[1];
    const segments = rawId.split(":");
    let isEpisode = false;
    let mainId = "";
    let season = "1";
    let episode = "1";
    let imdbId = "";

    if (segments[0] === "tmdb" || segments[0] === "imdb") {
      mainId = segments[1] || "";
      if (segments.length >= 4) {
        isEpisode = true;
        season = segments[2];
        episode = segments[3];
      }
      if (segments[0] === "imdb") {
        imdbId = mainId.replace(/^tt/i, "");
      }
    } else {
      mainId = segments[0];
      if (segments.length >= 3) {
        isEpisode = true;
        season = segments[1];
        episode = segments[2];
      }
      if (mainId.startsWith("tt")) {
        imdbId = mainId.replace(/^tt/i, "");
      }
    }

    if (type === "series" && segments.length >= 2 && !isEpisode) {
      isEpisode = true;
      season = segments[segments.length - 2] || "1";
      episode = segments[segments.length - 1] || "1";
    }

    const buildKindCandidates = (prefix, idVal) => {
      const suffix = isEpisode ? `${prefix}:${idVal}:${season}:${episode}` : `${prefix}:${idVal}`;
      const kinds = isEpisode ? ["series", "video"] : ["video", "series"];
      return kinds.map((k) => `https://vavoo.top/vod/source/${k}/${suffix}.json?region=FR&language=fr`);
    };

    const metrics = { tmdbMs: 0, vavooMs: 0, secondaryMs: 0, timeouts: 0, vavooErrors: 0 };
    const reqStart = Date.now();
    let finalSources = [];

    if (imdbId) {
      const imdbCandidates = [...new Set(buildKindCandidates("imdb", `tt${imdbId}`))];
      const results = await Promise.all(imdbCandidates.map((u) => fetchVavooSources(u, metrics)));
      finalSources = results.find((list) => list.length > 0) || [];
    } else if (mainId) {
      // Recherche principale : Vavoo TMDB + lookup IMDb en parallèle
      const tmdbCandidates = buildKindCandidates("tmdb", mainId);
      const [primaryTmdbSources, resolvedImdb] = await Promise.all([
        fetchVavooSources(tmdbCandidates[0], metrics),
        resolveImdbIdFromTmdb(mainId, isEpisode, metrics)
      ]);

      finalSources = primaryTmdbSources;

      // Si aucune source exploitable en recherche principale, lancer les recherches secondaires uniques en parallèle
      if (finalSources.length === 0) {
        const secondaryUrls = new Set();
        if (tmdbCandidates[1] && tmdbCandidates[1] !== tmdbCandidates[0]) {
          secondaryUrls.add(tmdbCandidates[1]);
        }
        if (resolvedImdb) {
          for (const u of buildKindCandidates("imdb", `tt${resolvedImdb}`)) {
            secondaryUrls.add(u);
          }
        }
        if (secondaryUrls.size > 0) {
          const secStart = Date.now();
          const secResults = await Promise.all(Array.from(secondaryUrls).map((u) => fetchVavooSources(u, metrics)));
          metrics.secondaryMs = Date.now() - secStart;
          finalSources = secResults.find((list) => list.length > 0) || [];
        }
      }
    }

    const sources = sortAndLabelSources(finalSources);
    const totalMs = Date.now() - reqStart;
    res.setHeader(
      "Server-Timing",
      `tmdb;dur=${metrics.tmdbMs}, vavoo;dur=${metrics.vavooMs}, secondary;dur=${metrics.secondaryMs}, total;dur=${totalMs}`
    );
    res.setHeader("X-Kibangou-Source-Metrics", `to=${metrics.timeouts};err=${metrics.vavooErrors}`);
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({ sources });
  } catch (err) {
    console.error("Kibangou Source API Error:", err);
    return res.status(200).json({ sources: [] });
  }
}
