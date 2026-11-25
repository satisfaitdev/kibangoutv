import fs from "fs";
import path from "path";

const adultIds = [
  { id: 24402, name: "Emmanuelle", year: 1974 },
  { id: 10682, name: "Emmanuelle 2 (L'antivierge)", year: 1975 },
  { id: 664413, name: "365 jours", year: 2020 },
  { id: 829557, name: "365 jours : Au lendemain", year: 2022 },
  { id: 980933, name: "365 jours : L'année d'après", year: 2022 },
  { id: 216015, name: "Cinquante Nuances de Grey", year: 2015 },
  { id: 341174, name: "Cinquante Nuances plus sombres", year: 2017 },
  { id: 337167, name: "Cinquante Nuances plus claires", year: 2018 },
  { id: 146303, name: "Nymphomaniac : Volume 1", year: 2013 },
  { id: 249397, name: "Nymphomaniac : Volume 2", year: 2013 },
  { id: 422204, name: "Nymphomaniac (Director's Cut)", year: 2014 },
  { id: 152584, name: "La Vie d'Adèle", year: 2013 },
  { id: 345, name: "Eyes Wide Shut", year: 1999 },
  { id: 402, name: "Basic Instinct", year: 1992 },
  { id: 10061, name: "Basic Instinct 2", year: 2006 },
  { id: 10068, name: "9 Semaines 1/2", year: 1986 },
  { id: 34852, name: "Caligula", year: 1979 },
  { id: 389, name: "Salò ou les 120 Journées de Sodome", year: 1975 },
  { id: 301358, name: "Love (Gaspar Noé)", year: 2015 },
  { id: 10204, name: "L'Amant", year: 1992 },
  { id: 987, name: "Le Dernier Tango à Paris", year: 1972 },
  { id: 10683, name: "Histoire d'O", year: 1975 },
  { id: 887, name: "Crash (David Cronenberg)", year: 1996 },
  { id: 829, name: "Attache-moi !", year: 1990 },
  { id: 11216, name: "La Pianiste", year: 2001 },
  { id: 10741, name: "La Secrétaire (Secretary)", year: 2002 },
  { id: 283587, name: "The Duke of Burgundy", year: 2014 },
  { id: 10599, name: "Lunes de Fiel (Bitter Moon)", year: 1992 },
  { id: 11528, name: "L'Orchidée Sauvage (Wild Orchid)", year: 1989 },
  { id: 25769, name: "Chloé", year: 2009 },
  { id: 1017, name: "Mulholland Drive", year: 2001 },
  { id: 1979, name: "Innocents (The Dreamers)", year: 2003 },
  { id: 10398, name: "Femme Fatale", year: 2002 },
  { id: 10395, name: "Swimming Pool", year: 2003 },
  { id: 10594, name: "Lucía et le Sexe", year: 2001 }
];

async function main() {
  const items = [];
  const itemDir = "C:/Users/SATISFAIT/.gemini/antigravity/scratch/iptv-vuma-app/adult-addon/item/video";
  if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });

  for (const m of adultIds) {
    try {
      const url = `https://www.mhub.mx/tmdb/item/video/tmdb:${m.id}.json`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) {
        const data = await res.json();
        data.id = `tmdb:${m.id}`;
        data.type = "video";
        if (!data.genres) data.genres = ["Adulte", "Érotique", "Cinéma Pro"];
        else if (!data.genres.includes("Adulte")) data.genres.push("Adulte");
        items.push(data);
        fs.writeFileSync(path.join(itemDir, `tmdb:${m.id}.json`), JSON.stringify(data, null, 2), "utf8");
        console.log(`✓ Fetched TMDB ${m.id} : ${data.name || m.name}`);
      } else {
        console.warn(`✗ HTTP ${res.status} for ${m.id}`);
        // Fallback item
        const fallback = {
          id: `tmdb:${m.id}`,
          type: "video",
          name: m.name,
          ids: { tmdb: String(m.id) },
          genres: ["Adulte", "Érotique", "Cinéma Pro"],
          releaseDate: `${m.year}-01-01`,
          images: {
            poster: "/logo.svg",
            backdrops: ["/logo.svg"]
          }
        };
        items.push(fallback);
      }
    } catch (e) {
      console.error(`Error fetching ${m.id}:`, e.message);
    }
  }

  const outPath = "C:/Users/SATISFAIT/.gemini/antigravity/scratch/iptv-vuma-app/adult-addon/catalog/video/adult-vod.json";
  fs.writeFileSync(outPath, JSON.stringify({ items }, null, 2), "utf8");
  console.log(`\n🎉 Saved ${items.length} adult VOD titles to adult-vod.json!`);
}

main().catch(console.error);
