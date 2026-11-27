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
    const parsedUrl = new URL(req.url || "/", "https://kibangoutv.vercel.app");
    const sp = parsedUrl.searchParams;

    if (q.football === "1" || sp.get("football") === "1") {
      const sportChannels = [];
      for (const rel of ["kibangou-addon/catalog/live/canal_congo.json", "kibangou-addon/catalog/live/bein.json"]) {
        try {
          const p = path.join(process.cwd(), rel);
          if (!fs.existsSync(p)) continue;
          const d = JSON.parse(fs.readFileSync(p, "utf8"));
          const src = rel.includes("bein.json") ? "bein" : "canal_congo";
          for (const it of d.items || []) {
            if (it && it.id && it.name) {
              let rawLogo = it.images?.logo || it.images?.poster || it.logo || "";
              if (rawLogo.startsWith("/live2/")) rawLogo = `https://vavoo.to${rawLogo}`;
              sportChannels.push({ id: it.id, name: it.name, src, logo: rawLogo || "/logo.svg" });
            }
          }
        } catch {}
      }
      const matchCh = (slug) => {
        const s = String(slug || "").toLowerCase();
        let rxList = [/canal\+ sport 1/i, /bein sports 1/i, /dazn 1/i, /canal\+ premi/i];
        if (s.includes("premier-league") || s.includes("eng.")) rxList = [/canal\+ sport 1/i, /canal\+ sport 2/i, /canal\+ premi/i, /dazn 1/i];
        else if (s.includes("laliga") || s.includes("esp.")) rxList = [/bein sports 1/i, /bein sports 2/i, /dazn 1/i, /canal\+ sport 3/i];
        else if (s.includes("ligue-1") || s.includes("fra.")) rxList = [/dazn 1/i, /dazn 2/i, /bein sports 1/i, /canal\+ sport 1/i];
        else if (s.includes("serie-a") || s.includes("ita.")) rxList = [/dazn 1/i, /bein sports 2/i, /canal\+ sport 4/i];
        else if (s.includes("bundesliga") || s.includes("ger.")) rxList = [/bein sports 1/i, /bein sports 3/i, /canal\+ sport 5/i];
        else if (s.includes("caf") || s.includes("africa")) rxList = [/africa sport/i, /canal\+ sport 1/i, /bein sports 1/i, /canal\+ premi/i];
        const out = [];
        const seen = new Set();
        for (const rx of rxList) {
          const f = sportChannels.find((c) => rx.test(c.name) && !seen.has(c.id));
          if (f) { seen.add(f.id); out.push(f); }
        }
        return out;
      };
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard");
      const raw = r.ok ? await r.json() : { events: [] };
      const translateStatus = (s) => {
        const raw = String(s || "").trim();
        if (/^scheduled$/i.test(raw)) return "À venir";
        if (/^ft$/i.test(raw) || /^final$/i.test(raw)) return "Terminé";
        if (/^ht$/i.test(raw)) return "Mi-temps";
        if (/^postponed$/i.test(raw)) return "Reporté";
        if (/^canceled$/i.test(raw) || /^cancelled$/i.test(raw)) return "Annulé";
        return raw;
      };
      const matches = (raw.events || []).slice(0, 40).map((ev) => {
        const comp = ev.competitions?.[0] || {};
        const comps = comp.competitors || [];
        const home = comps.find((c) => c.homeAway === "home") || comps[0] || {};
        const away = comps.find((c) => c.homeAway === "away") || comps[1] || {};
        const slug = ev.season?.slug || "";
        return {
          id: ev.id,
          home: home.team?.shortDisplayName || home.team?.name || "Équipe A",
          away: away.team?.shortDisplayName || away.team?.name || "Équipe B",
          homeLogo: home.team?.logo || "",
          awayLogo: away.team?.logo || "",
          homeScore: home.score ?? "0",
          awayScore: away.score ?? "0",
          league: slug.replace(/^\d{4}-\d{2}-/, "").replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) || "Football",
          state: ev.status?.type?.state || "pre",
          status: translateStatus(ev.status?.type?.shortDetail || ev.status?.type?.description || ""),
          channels: matchCh(slug)
        };
      }).sort((a, b) => (a.state === "in" ? 0 : a.state === "pre" ? 1 : 2) - (b.state === "in" ? 0 : b.state === "pre" ? 1 : 2));
      return res.status(200).json({ ok: true, count: matches.length, matches });
    }

    if (q.stats === "1" || sp.get("stats") === "1") {
      const readCount = (rel) => {
        try {
          const p = path.join(process.cwd(), rel);
          if (!fs.existsSync(p)) return 0;
          const d = JSON.parse(fs.readFileSync(p, "utf8"));
          return Array.isArray(d.items) ? d.items.length : 0;
        } catch {
          return 0;
        }
      };
      const live =
        readCount("kibangou-addon/catalog/live/canal_congo.json") +
        readCount("kibangou-addon/catalog/live/local_channels.json") +
        readCount("kibangou-addon/catalog/live/bein.json") +
        readCount("kibangou-addon/catalog/live/tnt.json") +
        readCount("adult-addon/catalog/live/adult-channels.json");
      const movies =
        readCount("kibangou-addon/catalog/video/movie.json") +
        readCount("french-addon/catalog/video/films-vf.json") +
        readCount("french-addon/catalog/video/boxoffice-fr.json") +
        readCount("french-addon/catalog/video/comedies-fr.json") +
        readCount("adult-addon/catalog/video/adult-vod.json");
      const series =
        readCount("kibangou-addon/catalog/series/series.json") +
        readCount("french-addon/catalog/series/series-vf.json") +
        readCount("adult-addon/catalog/series/adult-series.json");
      return res.status(200).json({ live, movies, series, total: live + movies + series });
    }

    const addon = q.addon || sp.get("addon") || "kibangou-addon";
    let type = q.type || sp.get("type") || "live";
    let id = q.id || sp.get("id") || "canal_congo";

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
    let items = Array.isArray(catalogData.items)
      ? catalogData.items
      : Array.isArray(catalogData)
        ? catalogData
        : [];

    const catFilter =
      q["filter.category"] ||
      q["filter[category]"] ||
      q.category ||
      sp.get("filter[category]") ||
      sp.get("filter.category") ||
      sp.get("category");

    if (catFilter && catFilter !== "all" && catFilter !== "Tous") {
      const cfLower = String(catFilter).toLowerCase().trim();
      items = items.filter((it) => {
        const cat = (it.category || it.group || "").toLowerCase();
        const name = (it.name || "").toLowerCase();
        const genres = Array.isArray(it.genres) ? it.genres.map((g) => String(g).toLowerCase()) : [];
        const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t).toLowerCase()) : [];
        return (
          cat.includes(cfLower) ||
          genres.some((g) => g.includes(cfLower)) ||
          tags.some((t) => t.includes(cfLower)) ||
          name.includes(cfLower)
        );
      });
    }

    const countryFilter =
      q["filter.country"] ||
      q["filter[country]"] ||
      q.country ||
      sp.get("filter[country]") ||
      sp.get("filter.country") ||
      sp.get("country");

    if (countryFilter && countryFilter !== "all" && countryFilter !== "Tous") {
      const coLower = String(countryFilter).toLowerCase().trim();
      items = items.filter((it) => {
        const country = (it.country || "").toLowerCase();
        const cat = (it.category || it.group || "").toLowerCase();
        const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t).toLowerCase()) : [];
        return (
          country === coLower ||
          country.includes(coLower) ||
          cat === coLower ||
          tags.some((t) => t === coLower)
        );
      });
    }

    const query = q.search || q.q || q.query || sp.get("search") || sp.get("q") || sp.get("query");
    if (query) {
      const qLower = String(query).toLowerCase().trim();
      items = items.filter((it) => {
        const name = (it.name || "").toLowerCase();
        const desc = (it.description || "").toLowerCase();
        const cat = (it.category || it.group || "").toLowerCase();
        const tags = Array.isArray(it.tags) ? it.tags.join(" ").toLowerCase() : "";
        return name.includes(qLower) || desc.includes(qLower) || cat.includes(qLower) || tags.includes(qLower);
      });
    }

    const sortBy = (q.sort || sp.get("sort") || "").toLowerCase();
    if (sortBy === "name" || sortBy === "a-z") {
      items = [...items].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ items });
  } catch (err) {
    console.error("Catalog API Error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
