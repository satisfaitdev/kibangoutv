import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    let rawPath = req.url || "";
    let subPath = "";

    if (rawPath.includes("/kibangou-addon/item/")) {
      subPath = rawPath.split("/kibangou-addon/item/")[1];
    } else if (rawPath.includes("/french-addon/item/")) {
      subPath = rawPath.split("/french-addon/item/")[1];
    } else if (rawPath.includes("/adult-addon/item/")) {
      subPath = rawPath.split("/adult-addon/item/")[1];
    } else if (rawPath.includes("/item/")) {
      subPath = rawPath.split("/item/")[1];
    } else {
      subPath = rawPath.replace(/^\/+/, "");
    }

    subPath = decodeURIComponent(subPath);

    // 1. Vérification si c'est un item live local (ex: live/drtv, live/tv5monde)
    const cleanSub = subPath.split("?")[0].replace(/\.json$/i, "");
    if (cleanSub.startsWith("live/")) {
      const channelId = cleanSub.replace(/^live\//, "");
      const localFile = path.join(process.cwd(), "kibangou-addon", "item", "live", `${channelId}.json`);
      if (fs.existsSync(localFile)) {
        const content = fs.readFileSync(localFile, "utf-8");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(content);
      }
    }

    // 2. Si l'identifiant est direct sans préfixe de type (ex: tmdb:1726 ou imdb:tt0371746)
    if (!cleanSub.includes("/")) {
      const idJson = subPath.includes(".json") ? subPath : `${subPath}.json`;
      for (const t of ["video", "series"]) {
        try {
          const testUrl = `https://www.mhub.mx/tmdb/item/${t}/${idJson}`;
          const upstream = await fetch(testUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "application/json"
            }
          });
          if (upstream.ok) {
            const body = await upstream.text();
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return res.status(200).send(body);
          }
        } catch (e) {}
      }
    }

    // 3. Redirection vers TMDB pour les métadonnées de Films et Séries
    const tmdbUrl = `https://www.mhub.mx/tmdb/item/${subPath}`;
    const upstream = await fetch(tmdbUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
      }
    });

    const body = await upstream.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(upstream.status).send(body);

  } catch (err) {
    console.error("Item handler error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
