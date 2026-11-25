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
    } else if (rawUrl.includes("/source/")) {
      subPath = rawUrl.split("/source/")[1];
    } else {
      subPath = rawUrl.replace(/^\/+/, "");
    }

    subPath = decodeURIComponent(subPath).split("?")[0].replace(/\.json$/i, "");
    const parts = subPath.split("/").filter(Boolean);

    if (parts.length < 2) {
      return res.status(400).json({ sources: [] });
    }

    const type = parts[0]; // "video" ou "series"
    let id = parts[1];    // "tmdb:1726", "imdb:tt0371746", ou "imdb:tt2531336:1:1"

    let imdbId = "";
    let season = "1";
    let episode = "1";

    if (id.includes(":")) {
      const segments = id.split(":");
      if (segments[0] === "imdb") {
        imdbId = segments[1];
        if (segments.length >= 4) {
          season = segments[2];
          episode = segments[3];
        }
      } else if (segments[0] === "tmdb") {
        const tmdbNum = segments[1];
        if (segments.length >= 4) {
          season = segments[2];
          episode = segments[3];
        }
        // Résolution de l'IMDb ID via l'API TMDB
        try {
          const tmdbMetaUrl = `https://www.mhub.mx/tmdb/item/${type}/tmdb:${tmdbNum}.json`;
          const metaRes = await fetch(tmdbMetaUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
          });
          if (metaRes.ok) {
            const metaJson = await metaRes.json();
            if (metaJson.ids && metaJson.ids.imdb) {
              imdbId = metaJson.ids.imdb.replace(/^tt/, "");
            }
          }
        } catch (e) {
          console.error("TMDB to IMDb resolution error:", e);
        }
      }
    } else if (id.startsWith("tt")) {
      imdbId = id.replace(/^tt/, "");
    }

    // Construction de l'URL cible VAVOO VOD
    let vavooVodUrl = "";
    if (type === "series") {
      const targetId = imdbId ? `imdb:tt${imdbId}:${season}:${episode}` : id;
      vavooVodUrl = `https://vavoo.top/vod/source/series/${targetId}.json?region=FR&language=fr`;
    } else {
      const targetId = imdbId ? `imdb:tt${imdbId}` : id;
      vavooVodUrl = `https://vavoo.top/vod/source/video/${targetId}.json?region=FR&language=fr`;
    }

    const upstreamRes = await fetch(vavooVodUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json"
      }
    });

    if (!upstreamRes.ok) {
      return res.status(200).json({ sources: [] });
    }

    const data = await upstreamRes.json();
    const rawSources = data.sources || [];

    // Priorisation des sources francophones
    const fr = [];
    const en = [];
    const other = [];

    for (const s of rawSources) {
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

    data.sources = [...fr, ...en, ...other];
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(data);

  } catch (err) {
    console.error("Kibangou Source API Error:", err);
    return res.status(200).json({ sources: [] });
  }
}
