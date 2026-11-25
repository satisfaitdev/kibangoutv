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
    const rawUrl = req.url || "";
    let cleanPath = rawUrl.split("?")[0].replace(/\.json$/i, "");
    
    let addon = "kibangou-addon";
    if (cleanPath.includes("french-addon")) addon = "french-addon";
    else if (cleanPath.includes("adult-addon")) addon = "adult-addon";

    let parts = cleanPath.split("/catalog/")[1];
    if (!parts) {
      parts = cleanPath.replace(/^\/+/, "");
    }
    const [type, id] = parts.split("/").filter(Boolean);

    if (!type || !id) {
      return res.status(404).json({ error: "Catalog not found" });
    }

    const filePath = path.join(process.cwd(), addon, "catalog", type, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Catalog file not found" });
    }

    const fileContent = fs.readFileSync(filePath, "utf8");
    const catalogData = JSON.parse(fileContent);
    let items = Array.isArray(catalogData.items) ? catalogData.items : (Array.isArray(catalogData) ? catalogData : []);

    const urlObj = new URL(req.url, "http://localhost");
    const searchParams = urlObj.searchParams;

    // Filter by category or group
    const catFilter = searchParams.get("filter.category") || searchParams.get("filter[category]") || searchParams.get("category");
    if (catFilter && catFilter !== "all" && catFilter !== "Tous") {
      items = items.filter(it => {
        const cat = it.category || it.group || "";
        const genres = Array.isArray(it.genres) ? it.genres : [];
        const tags = Array.isArray(it.tags) ? it.tags : [];
        return cat.toLowerCase().includes(catFilter.toLowerCase()) ||
               genres.some(g => g.toLowerCase().includes(catFilter.toLowerCase())) ||
               tags.some(t => t.toLowerCase().includes(catFilter.toLowerCase()));
      });
    }

    // Search query filter
    const query = searchParams.get("search") || searchParams.get("q") || searchParams.get("query");
    if (query) {
      const qLower = query.toLowerCase().trim();
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
