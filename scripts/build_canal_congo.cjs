const fs = require('fs');
const path = require('path');

const liveDir = 'C:/Users/SATISFAIT/.gemini/antigravity/scratch/iptv-vuma-app/kibangou-addon/catalog/live';
const itemDir = 'C:/Users/SATISFAIT/.gemini/antigravity/scratch/iptv-vuma-app/kibangou-addon/item/live';

if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });

const categoryMapping = [
  { file: 'canal.json', cat: 'A. Chaînes CANAL+' },
  { file: 'cinema_series.json', cat: 'B. Cinéma & Séries' },
  { file: 'sport.json', cat: 'C. Sport' },
  { file: 'decouverte.json', cat: 'D. Découverte & Documentaires' },
  { file: 'jeunesse.json', cat: 'E. Jeunesse & Éducation' },
  { file: 'divertissement.json', cat: 'F. Divertissement' },
  { file: 'infos.json', cat: 'G. Informations' },
  { file: 'musique.json', cat: 'H. Musique' },
  { file: 'religions.json', cat: 'I. Religions' }
];

const canalCongoItems = [];

for (const m of categoryMapping) {
  const p = path.join(liveDir, m.file);
  if (fs.existsSync(p)) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const it of (raw.items || [])) {
      if (!it.id) continue;
      const enriched = {
        ...it,
        category: m.cat,
        group: m.cat,
        genres: [m.cat],
        tags: Array.from(new Set([...(it.tags || []), m.cat, 'Canal+ Congo']))
      };
      canalCongoItems.push(enriched);
      
      const itemFile = path.join(itemDir, it.id + '.json');
      fs.writeFileSync(itemFile, JSON.stringify(enriched, null, 2), 'utf8');
    }
  }
}

fs.writeFileSync(path.join(liveDir, 'canal_congo.json'), JSON.stringify({ items: canalCongoItems }, null, 2), 'utf8');
console.log('canal_congo.json created with', canalCongoItems.length, 'items');

let localItems = [];
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const africanPath = 'C:/Users/SATISFAIT/AppData/Local/Temp/african_working.json';
const seenUrls = new Set();

if (fs.existsSync(africanPath)) {
  const africanRaw = JSON.parse(fs.readFileSync(africanPath, 'utf8'));
  for (const raw of africanRaw) {
    if (!raw.url || !raw.name || /\[Geo-blocked\]/i.test(raw.name)) continue;
    if (seenUrls.has(raw.url)) continue;
    seenUrls.add(raw.url);
    const id = 'af_' + slugify(`${raw.country}_${raw.name}`).slice(0, 48);
    const logo = raw.logo || '/logo.svg';
    const item = {
      id,
      name: `${raw.name} (${raw.country})`,
      type: 'live',
      url: raw.url,
      country: raw.country,
      category: raw.country,
      group: 'Chaînes Locales',
      genres: [raw.country],
      images: { logo, poster: logo },
      tags: [raw.country, 'Afrique', 'Chaînes Locales']
    };
    localItems.push(item);
  }
}

const extraLocal = [
  {
    id: 'af_ci_aplus_ivoire',
    name: "A+ IVOIRE (Côte d'Ivoire)",
    type: 'live',
    url: 'https://www.vavoo.to/live/play/3193136015',
    country: "Côte d'Ivoire",
    category: "Côte d'Ivoire",
    group: 'Chaînes Locales',
    genres: ["Côte d'Ivoire"],
    images: { logo: '/logo.svg', poster: '/logo.svg' },
    tags: ["Côte d'Ivoire", 'Afrique', 'Chaînes Locales']
  },
  {
    id: 'af_pan_africa24',
    name: 'AFRICA 24 (Panafricain)',
    type: 'live',
    url: 'https://www.vavoo.to/live/play/2290952272',
    country: 'Panafricain & Monde',
    category: 'Panafricain & Monde',
    group: 'Chaînes Locales',
    genres: ['Panafricain & Monde'],
    images: { logo: '/logo.svg', poster: '/logo.svg' },
    tags: ['Panafricain & Monde', 'Afrique', 'Info', 'Chaînes Locales']
  }
];
for (const it of extraLocal) {
  if (!seenUrls.has(it.url)) {
    seenUrls.add(it.url);
    localItems.push(it);
  }
}

const congoPath = path.join(liveDir, 'congo.json');
if (fs.existsSync(congoPath)) {
  const cData = JSON.parse(fs.readFileSync(congoPath, 'utf8'));
  for (const it of (cData.items || [])) {
    if (!it.url || seenUrls.has(it.url)) continue;
    seenUrls.add(it.url);
    const country = ['tv5monde', 'euronews', 'bfmtv'].includes(it.id) ? 'Panafricain & Monde' : 'Congo-Brazzaville';
    localItems.push({
      ...it,
      country,
      category: country,
      group: 'Chaînes Locales',
      genres: [country],
      tags: Array.from(new Set([...(it.tags || []), country, 'Chaînes Locales']))
    });
  }
}

for (const enriched of localItems) {
  const itemFile = path.join(itemDir, enriched.id + '.json');
  fs.writeFileSync(itemFile, JSON.stringify(enriched, null, 2), 'utf8');
}
fs.writeFileSync(path.join(liveDir, 'local_channels.json'), JSON.stringify({ items: localItems }, null, 2), 'utf8');
console.log('local_channels.json created with', localItems.length, 'items');
