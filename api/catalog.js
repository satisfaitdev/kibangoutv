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
    const q = req.query || {};
    let addon = q.addon || "kibangou-addon";
    let type = q.type || "live";
    let id = q.id || "canal_congo";

    if (q.match) {
      const matchParts = String(q.match).replace(/\.json$/i, "").split("/").filter(Boolean);
      if (matchParts.length >= 2) {
        type = matchParts[0];
        id = matchParts[1];
      } else if (matchParts.length === 1) {
        id = matchParts[0];
      }
    }

    id = String(id).replace(/\.json$/i, "");

    const filePath = path.join(process.cwd(), addon, "catalog", type, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Catalog not found: ${filePath}` });
    }

    const fileContent = fs.readFileSync(filePath, "utf8");
    const catalogData = JSON.parse(fileContent);
    let items = Array.isArray(catalogData.items) ? catalogData.items : (Array.isArray(catalogData) ? catalogData : []);

    // Filter by category or group
    const catFilter = q["filter.category"] || q["filter[category]"] || q.category;
    if (catFilter && catFilter !== "all" && catFilter !== "Tous") {
      const cfLower = String(catFilter).toLowerCase();
      items = items.filter(it => {
        const cat = (it.category || it.group || "").toLowerCase();
        const genres = Array.isArray(it.genres) ? it.genres.map(g => String(g).toLowerCase()) : [];
        const tags = Array.isArray(it.tags) ? it.tags.map(t => String(t).toLowerCase()) : [];
        return cat.includes(cfLower) || genres.some(g => g.includes(cfLower)) || tags.some(t => t.includes(cfLower));
      });
    }

    // Search query filter
    const query = q.search || q.q || q.query;
    if (query) {
      const qLower = String(query).toLowerCase().trim();
      items = items.filter(it => {
        const name = (it.name || "").toLowerCase();
        const desc = (it.description || "").toLowerCase();
        const tags = Array.isArray(it.tags) ? it.tags.join(" ").toLowerCase() : "";
        return name.includes(qLower) || desc.includes(qLower) || tags.includes(qLower);
      });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ items });
  } catch (err) {
    console.error("Catalog API Error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
