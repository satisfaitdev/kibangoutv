const HLS_CLOUD_HOSTS = ["voe.sx", "dood.yt", "vidply", "myvidplay", "filemoon", "d000d", "supervideo"];

function hostPriority(url) {
  const lower = String(url || "").toLowerCase();
  const idx = HLS_CLOUD_HOSTS.findIndex((h) => lower.includes(h));
  return idx >= 0 ? idx : HLS_CLOUD_HOSTS.length;
}

export function sortAndLabelSources(rawList) {
  const valid = (rawList || []).filter((s) => {
    const u = (s && s.url ? String(s.url) : "").toLowerCase();
    return u && !u.includes("vidoza.");
  });

  const ordered = [...valid].sort((a, b) => hostPriority(a.url) - hostPriority(b.url));
  const fr = [];
  const en = [];
  const other = [];

  for (const s of ordered) {
    const langs = (s.languages || []).map((l) => String(l).toLowerCase());
    const quality = s.quality || "HD";
    const name = s.name || "Serveur";

    if (langs.includes("fr")) {
      fr.push({ ...s, name: `🇫🇷 Français VF (${quality})` });
    } else if (langs.includes("en")) {
      en.push({ ...s, name: `🇬🇧 VO / VOSTFR (${quality})` });
    } else {
      other.push({ ...s, name: `🌐 ${name} (${langs.join(",").toUpperCase()})` });
    }
  }

  return [...fr, ...en, ...other];
}
