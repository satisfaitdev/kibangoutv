import fs from "fs";
import path from "path";

const ROOT = "C:/Users/SATISFAIT/.gemini/antigravity/scratch/iptv-vuma-app";

// Titres adultes / érotiques (+18) vérifiés sur TMDB ET résolubles via VAVOO VOD (#16)
const ADULT_MOVIES = [
  { id: 968739, name: "Les Liaisons dangereuses" },
  { id: 1010581, name: "À contre-sens" },
  { id: 664413, name: "365 jours" },
  { id: 829557, name: "365 jours : Au lendemain" },
  { id: 619979, name: "Eaux profondes (Deep Water)" },
  { id: 988078, name: "À travers ma fenêtre : L'amour pour horizon" },
  { id: 24402, name: "Emmanuelle" },
  { id: 9453, name: "Caligula" },
  { id: 4946, name: "La Piscine" },
  { id: 1791, name: "La Pianiste" },
  { id: 1364, name: "Lucia et le Sexe" },
  { id: 645710, name: "The Voyeurs" },
  { id: 937287, name: "Challengers" },
  { id: 818647, name: "À travers ma fenêtre" },
  { id: 345, name: "Eyes Wide Shut" },
  { id: 402, name: "Basic Instinct" },
  { id: 3093, name: "Basic Instinct 2" },
  { id: 5336, name: "Salò ou les 120 Journées de Sodome" },
  { id: 249397, name: "Nymphomaniac : Volume 2" },
  { id: 2057, name: "Péché originel (Original Sin)" },
  { id: 11013, name: "La Secrétaire (Secretary)" },
  { id: 1278, name: "Innocents (The Dreamers)" },
  { id: 976293, name: "Arrête avec tes mensonges" },
  { id: 152584, name: "La Vie d'Adèle" },
  { id: 4561, name: "Histoire d'O" },
  { id: 3134, name: "Baise-moi" },
  { id: 216015, name: "Cinquante Nuances de Grey" },
  { id: 341174, name: "Cinquante Nuances plus sombres" },
  { id: 337167, name: "Cinquante Nuances plus claires" },
  { id: 976576, name: "Emmanuelle (2024)" },
  { id: 1097549, name: "Babygirl" },
  { id: 10802, name: "Showgirls" },
  { id: 870518, name: "Sanctuary" },
  { id: 10995, name: "L'Amant" },
  { id: 10497, name: "Lunes de fiel (Bitter Moon)" },
  { id: 28211, name: "Chloé" },
  { id: 302, name: "Swimming Pool" },
  { id: 27, name: "9 Songs" },
  { id: 1378, name: "Shortbus" },
  { id: 5879, name: "L'Empire des sens" },
  { id: 10068, name: "9 Semaines 1/2" },
  { id: 1643, name: "Le Dernier Tango à Paris" },
  { id: 2469, name: "Attache-moi !" },
  { id: 4588, name: "Lust, Caution" },
  { id: 370663, name: "Below Her Mouth" },
  { id: 930564, name: "Saltburn" },
  { id: 1064213, name: "Anora" },
  { id: 792307, name: "Pauvres Créatures" },
  { id: 19173, name: "Journal d'une nymphomane" },
  { id: 884, name: "Crash (David Cronenberg)" },
  { id: 1018, name: "Mulholland Drive" },
  { id: 290098, name: "Mademoiselle (The Handmaiden)" },
  { id: 250225, name: "The Duke of Burgundy" },
  { id: 5203, name: "L'Orchidée sauvage" }
];

const ADULT_SERIES = [
  { id: 76669, name: "Élite" },
  { id: 10545, name: "True Blood" },
  { id: 227975, name: "Fatal Seduction" },
  { id: 101918, name: "Valeria" },
  { id: 91239, name: "La Chronique des Bridgerton" },
  { id: 46296, name: "Spartacus" },
  { id: 130464, name: "Tell Me Lies" },
  { id: 227371, name: "Faux Profil" },
  { id: 135251, name: "The Idol" },
  { id: 126280, name: "Sex/Life" },
  { id: 81356, name: "Sex Education" },
  { id: 88512, name: "Bonding" },
  { id: 87763, name: "Toy Boy" },
  { id: 1215, name: "Californication" },
  { id: 85552, name: "Euphoria" },
  { id: 65817, name: "The Deuce" },
  { id: 89905, name: "Normal People" },
  { id: 105214, name: "Sombre Désir (Dark Desire)" },
  { id: 58937, name: "Masters of Sex" },
  { id: 64387, name: "The Girlfriend Experience" }
];

async function fetchTmdbItem(mediaType, entry) {
  const url = `https://www.mhub.mx/tmdb/item/${mediaType}/tmdb:${entry.id}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${mediaType} tmdb:${entry.id}`);
  }
  const data = await res.json();
  data.id = `tmdb:${entry.id}`;
  data.type = mediaType;
  if (!data.ids) data.ids = {};
  data.ids.tmdb = String(entry.id);
  const genres = Array.isArray(data.genres) ? data.genres : [];
  if (!genres.includes("Adulte +18")) genres.push("Adulte +18");
  data.genres = genres;
  return data;
}

async function fetchBatch(mediaType, entries) {
  const results = [];
  const chunkSize = 8;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(chunk.map((e) => fetchTmdbItem(mediaType, e)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const entry = chunk[j];
      if (r.status === "fulfilled") {
        results.push(r.value);
        console.log(`✓ [${mediaType}] tmdb:${entry.id} -> ${r.value.name}`);
      } else {
        console.warn(`✗ [${mediaType}] tmdb:${entry.id} (${entry.name}): ${r.reason?.message || r.reason}`);
      }
    }
  }
  return results;
}

async function main() {
  const [movies, series] = await Promise.all([
    fetchBatch("video", ADULT_MOVIES),
    fetchBatch("series", ADULT_SERIES)
  ]);

  const vodOut = path.join(ROOT, "adult-addon/catalog/video/adult-vod.json");
  const seriesOut = path.join(ROOT, "adult-addon/catalog/series/adult-series.json");
  fs.mkdirSync(path.dirname(vodOut), { recursive: true });
  fs.mkdirSync(path.dirname(seriesOut), { recursive: true });

  fs.writeFileSync(vodOut, JSON.stringify({ items: movies }, null, 2), "utf8");
  fs.writeFileSync(seriesOut, JSON.stringify({ items: series }, null, 2), "utf8");

  console.log(`\nSaved ${movies.length} movies to ${vodOut}`);
  console.log(`Saved ${series.length} series to ${seriesOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
