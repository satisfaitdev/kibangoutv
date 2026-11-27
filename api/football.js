import fs from "node:fs";
import path from "node:path";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

let cache = { ts: 0, data: null };
const CACHE_TTL_MS = 60000;

function loadSportChannels() {
  const out = [];
  for (const rel of ["kibangou-addon/catalog/live/canal_congo.json", "kibangou-addon/catalog/live/bein.json"]) {
    try {
      const p = path.join(process.cwd(), rel);
      if (!fs.existsSync(p)) continue;
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      const src = rel.includes("bein.json") ? "bein" : "canal_congo";
      for (const it of d.items || []) {
        if (it && it.id && it.name) {
          out.push({ id: it.id, name: it.name, src });
        }
      }
    } catch {}
  }
  return out;
}

function matchBroadcastChannels(leagueSlug, allChannels) {
  const s = String(leagueSlug || "").toLowerCase();
  let patterns = [/canal\+ sport 1/i, /bein sports 1/i, /dazn 1/i, /canal\+ premi/i];
  if (s.includes("premier-league") || s.includes("eng.")) {
    patterns = [/canal\+ sport 1/i, /canal\+ sport 2/i, /canal\+ premi/i, /dazn 1/i];
  } else if (s.includes("laliga") || s.includes("esp.")) {
    patterns = [/bein sports 1/i, /bein sports 2/i, /dazn 1/i, /canal\+ sport 3/i];
  } else if (s.includes("ligue-1") || s.includes("fra.")) {
    patterns = [/dazn 1/i, /dazn 2/i, /bein sports 1/i, /canal\+ sport 1/i];
  } else if (s.includes("serie-a") || s.includes("ita.")) {
    patterns = [/dazn 1/i, /bein sports 2/i, /canal\+ sport 4/i];
  } else if (s.includes("bundesliga") || s.includes("ger.")) {
    patterns = [/bein sports 1/i, /bein sports 3/i, /canal\+ sport 5/i];
  } else if (s.includes("caf") || s.includes("africa")) {
    patterns = [/africa sport/i, /canal\+ sport 1/i, /bein sports 1/i, /canal\+ premi/i];
  }

  const matched = [];
  const seen = new Set();
  for (const rx of patterns) {
    const found = allChannels.find((c) => rx.test(c.name) && !seen.has(c.id));
    if (found) {
      seen.add(found.id);
      matched.push(found);
    }
  }
  return matched;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return Response.json(cache.data, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard");
    if (!res.ok) {
      return Response.json({ matches: [], error: "Scoreboard unavailable" }, { status: 502, headers: CORS_HEADERS });
    }
    const raw = await res.json();
    const allChannels = loadSportChannels();

    const matches = (raw.events || []).slice(0, 40).map((ev) => {
      const comp = ev.competitions?.[0] || {};
      const competitors = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === "home") || competitors[0] || {};
      const away = competitors.find((c) => c.homeAway === "away") || competitors[1] || {};
      const state = ev.status?.type?.state || "pre";
      const leagueSlug = ev.season?.slug || "";
      const leagueName = leagueSlug
        .replace(/^\d{4}-\d{2}-/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase()) || "Football";
      const channels = matchBroadcastChannels(leagueSlug, allChannels);

      return {
        id: ev.id,
        home: home.team?.shortDisplayName || home.team?.name || "Équipe A",
        away: away.team?.shortDisplayName || away.team?.name || "Équipe B",
        homeScore: home.score ?? "0",
        awayScore: away.score ?? "0",
        homeLogo: home.team?.logo || "",
        awayLogo: away.team?.logo || "",
        league: leagueName,
        state,
        status: ev.status?.type?.shortDetail || ev.status?.type?.description || "",
        date: ev.date || "",
        channels
      };
    });

    matches.sort((a, b) => {
      const rank = (s) => (s === "in" ? 0 : s === "pre" ? 1 : 2);
      return rank(a.state) - rank(b.state);
    });

    const payload = { ok: true, count: matches.length, matches };
    cache = { ts: Date.now(), data: payload };
    return Response.json(payload, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ matches: [], error: err?.message || "Football API error" }, { status: 500, headers: CORS_HEADERS });
  }
}
