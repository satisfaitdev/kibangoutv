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
    const rawId = parts[1]; // "tmdb:1726", "tmdb:290826:1:1", "imdb:tt...", etc.

    const segments = rawId.split(":");
    let isEpisode = segments.length >= 3 || type === "series";
    let prefix = segments[0];
    let mainId = segments[1] || rawId;
    let season = "1";
    let episode = "1";

    if (segments.length >= 3) {
      isEpisode = true;
      season = segments[2];
      episode = segments[3] || "1";
    }

    let imdbId = "";
    if (prefix === "imdb") {
      imdbId = mainId.replace(/^tt/, "");
    } else if (prefix === "tmdb") {
      // Résolution de l'identifiant IMDb auprès de TMDB
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
        } catch (e) {
          // Continuer vers le type suivant
        }
      }
    } else if (rawId.startsWith("tt")) {
      imdbId = rawId.replace(/^tt/, "");
    }

    // Construction de la liste des URLs Vavoo VOD candidates à tester
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
      }
      candidateUrls.push(`https://vavoo.top/vod/source/video/tmdb:${mainId}.json?region=FR&language=fr`);
      if (imdbId) {
        candidateUrls.push(`https://vavoo.top/vod/source/series/imdb:tt${imdbId}.json?region=FR&language=fr`);
      }
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
            finalSources = vData.sources;
            break;
          }
        }
      } catch (err) {
        // Essayer l'URL suivante
      }
    }

    // Priorisation des flux francophones (VF > VOSTFR > Autres)
    const fr = [];
    const en = [];
    const other = [];

    for (const s of finalSources) {
      const langs = (s.languages || []).map(l => String(l).toLowerCase());
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

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      sources: [...fr, ...en, ...other]
    });

  } catch (err) {
    console.error("Kibangou Source API Error:", err);
    return res.status(200).json({ sources: [] });
  }
}
