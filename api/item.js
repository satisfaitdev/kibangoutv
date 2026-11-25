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
    const cleanSub = subPath.split("?")[0].replace(/\.json$/i, "");

    // 1. Local live items (e.g. live/drtv, live/tv5monde, live/canalplus_pop, etc.)
    if (cleanSub.startsWith("live/")) {
      const channelId = cleanSub.replace(/^live\//, "");
      for (const addonDir of ["kibangou-addon", "french-addon", "adult-addon"]) {
        const localFile = path.join(process.cwd(), addonDir, "item", "live", `${channelId}.json`);
        if (fs.existsSync(localFile)) {
          const content = fs.readFileSync(localFile, "utf-8");
          try {
            const data = JSON.parse(content);
            return res.status(200).json(data);
          } catch {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return res.status(200).send(content);
          }
        }
      }
    }

    // 2. Determine requested type and ID
    let reqType = "video";
    let reqId = cleanSub;
    if (cleanSub.includes("/")) {
      const parts = cleanSub.split("/");
      reqType = parts[0];
      reqId = parts.slice(1).join("/");
    }

    // Extract raw numeric ID and prefix
    let cleanId = reqId;
    if (cleanId.startsWith("tmdb:")) cleanId = cleanId.slice(5);
    else if (cleanId.startsWith("imdb:")) cleanId = cleanId.slice(5);

    // Fetch from TMDB proxy
    const typesToTry = reqType === "series" ? ["series", "video"] : ["video", "series"];
    let fetchedData = null;

    for (const t of typesToTry) {
      try {
        const tmdbUrl = `https://www.mhub.mx/tmdb/item/${t}/tmdb:${cleanId}.json`;
        const upstream = await fetch(tmdbUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
          }
        });
        if (upstream.ok) {
          fetchedData = await upstream.json();
          break;
        }
      } catch (e) {}
    }

    if (fetchedData) {
      // CRITICAL FIX: Ensure returned item.id matches the format requested by Vuma route!
      // If Vuma requested tmdb:1726, item.id must be "tmdb:1726" (or cleanId if requested bare)
      fetchedData.id = reqId;
      if (!fetchedData.ids) fetchedData.ids = {};
      if (!fetchedData.ids.tmdb) fetchedData.ids.tmdb = cleanId;

      return res.status(200).json(fetchedData);
    }

    return res.status(404).json({ error: "Item not found" });

  } catch (err) {
    console.error("Item handler error:", err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
