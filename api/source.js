import { sortAndLabelSources } from "./_sources.js";

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

    const type = parts[0]; // "video" ou "series"
    const rawId = parts[1]; // "tmdb:1726", "tmdb:96677:1:1", "1726", etc.

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
        imdbId = mainId.replace(/^tt/, "");
      }
    } else {
      mainId = segments[0];
      if (segments.length >= 3) {
        isEpisode = true;
        season = segments[1];
        episode = segments[2];
      }
      if (mainId.startsWith("tt")) {
        imdbId = mainId.replace(/^tt/, "");
      }
    }

    if (type === "series" && segments.length >= 2 && !isEpisode) {
      isEpisode = true;
      season = segments[segments.length - 2] || "1";
      episode = segments[segments.length - 1] || "1";
    }

    // Si on a un ID TMDB mais pas encore l'IMDb ID, on résout rapidement via TMDB
    if (!imdbId && mainId && !mainId.startsWith("tt")) {
      const metaTypes = isEpisode ? ["series", "video"] : ["video", "series"];
      for (const mType of metaTypes) {
        try {
          const tmdbMetaUrl = `https://www.mhub.mx/tmdb/item/${mType}/tmdb:${mainId}.json`;
          const metaRes = await fetch(tmdbMetaUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
          });
          if (metaRes.ok) {
            const metaJson = await metaRes.json();
            if (metaJson && metaJson.ids && metaJson.ids.imdb) {
              imdbId = String(metaJson.ids.imdb).replace(/^tt/, "");
              break;
            }
          }
        } catch (e) {}
      }
    }

    // Construction des URLs Vavoo candidates
    const candidateUrls = [];
    if (isEpisode) {
      if (imdbId) {
        candidateUrls.push(`https://vavoo.top/vod/source/series/imdb:tt${imdbId}:${season}:${episode}.json?region=FR&language=fr`);
        candidateUrls.push(`https://vavoo.top/vod/source/video/imdb:tt${imdbId}:${season}:${episode}.json?region=FR&language=fr`);
      }
      candidateUrls.push(`https://vavoo.top/vod/source/series/tmdb:${mainId}:${season}:${episode}.json?region=FR&language=fr`);
      candidateUrls.push(`https://vavoo.top/vod/source/video/tmdb:${mainId}:${season}:${episode}.json?region=FR&language=fr`);
    } else {
      if (imdbId) {
        candidateUrls.push(`https://vavoo.top/vod/source/video/imdb:tt${imdbId}.json?region=FR&language=fr`);
        candidateUrls.push(`https://vavoo.top/vod/source/series/imdb:tt${imdbId}.json?region=FR&language=fr`);
      }
      candidateUrls.push(`https://vavoo.top/vod/source/video/tmdb:${mainId}.json?region=FR&language=fr`);
      candidateUrls.push(`https://vavoo.top/vod/source/series/tmdb:${mainId}.json?region=FR&language=fr`);
    }

    let finalSources = [];
    for (const vUrl of candidateUrls) {
      try {
        const vRes = await fetch(vUrl, {
          headers: {
            "User-Agent": "VAVOO/2.6",
            "Accept": "application/json"
          }
        });
        if (vRes.ok) {
          const vData = await vRes.json();
          if (vData && Array.isArray(vData.sources) && vData.sources.length > 0) {
            const valid = vData.sources.filter((s) => {
              const u = (s.url || "").toLowerCase();
              return u && !u.includes("vidoza.");
            });
            if (valid.length > 0) {
              finalSources = valid;
              break;
            }
          }
        }
      } catch (err) {}
    }

    const sources = sortAndLabelSources(finalSources);
    return res.status(200).json({ sources });

  } catch (err) {
    console.error("Kibangou Source API Error:", err);
    return res.status(200).json({ sources: [] });
  }
}
