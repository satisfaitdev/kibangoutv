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
const congoPath = path.join(liveDir, 'congo.json');
if (fs.existsSync(congoPath)) {
  const cData = JSON.parse(fs.readFileSync(congoPath, 'utf8'));
  localItems = (cData.items || []).map(it => {
    const baseTags = Array.isArray(it.tags) ? it.tags : [];
    const primaryCat = baseTags.includes('Congo') ? 'Congo' : (baseTags.includes('Info') ? 'Info' : (baseTags.includes('Francophonie') ? 'Francophonie' : 'Chaînes Locales'));
    const enriched = {
      ...it,
      category: primaryCat,
      group: 'Chaînes Locales',
      genres: [primaryCat],
      tags: Array.from(new Set([...baseTags, 'Chaînes Locales']))
    };
    const itemFile = path.join(itemDir, it.id + '.json');
    fs.writeFileSync(itemFile, JSON.stringify(enriched, null, 2), 'utf8');
    return enriched;
  });
}
fs.writeFileSync(path.join(liveDir, 'local_channels.json'), JSON.stringify({ items: localItems }, null, 2), 'utf8');
console.log('local_channels.json created with', localItems.length, 'items');
