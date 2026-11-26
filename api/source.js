import { isExcludedVodHost, sortAndLabelSources } from "./_sources.js";

async function fetchVavooSources(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "VAVOO/2.6", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.sources)) return [];
    return data.sources.filter((s) => s && !isExcludedVodHost(s.url));
  } catch {
    return [];
  }
}

async function resolveImdbIdFromTmdb(mainId, isEpisode) {
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
          return String(metaJson.ids.imdb).replace(/^tt/i, "");
        }
      }
    } catch {}
  }
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

    let finalSources = [];

    if (imdbId) {
      const imdbCandidates = buildKindCandidates("imdb", `tt${imdbId}`);
      const results = await Promise.all(imdbCandidates.map(fetchVavooSources));
      finalSources = results.find((list) => list.length > 0) || [];
    } else if (mainId) {
      // Interroger directement tmdb: EN PARALLÈLE avec le lookup imdb: pour éviter 1s de latence séquentielle
      const tmdbCandidates = buildKindCandidates("tmdb", mainId);
      const [primaryTmdbSources, resolvedImdb] = await Promise.all([
        fetchVavooSources(tmdbCandidates[0]),
        resolveImdbIdFromTmdb(mainId, isEpisode)
      ]);

      finalSources = primaryTmdbSources;

      if (finalSources.length === 0 && tmdbCandidates[1]) {
        finalSources = await fetchVavooSources(tmdbCandidates[1]);
      }

      if (finalSources.length === 0 && resolvedImdb) {
        const imdbCandidates = buildKindCandidates("imdb", `tt${resolvedImdb}`);
        const imdbResults = await Promise.all(imdbCandidates.map(fetchVavooSources));
        finalSources = imdbResults.find((list) => list.length > 0) || [];
      }
    }

    const sources = sortAndLabelSources(finalSources);
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({ sources });
  } catch (err) {
    console.error("Kibangou Source API Error:", err);
    return res.status(200).json({ sources: [] });
  }
}
