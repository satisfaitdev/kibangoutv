import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let target = req.query.url;
  const fallbackLogo = () => {
    try {
      const logoPath = path.join(process.cwd(), "logo.svg");
      const content = fs.readFileSync(logoPath);
      res.setHeader("Content-Type", "image/svg+xml");
      return res.status(200).send(content);
    } catch (e) {
      return res.status(204).end();
    }
  };

  if (!target || target === "/logo.svg" || target === "logo.svg" || target.endsWith("/logo.svg")) {
    return fallbackLogo();
  }

  target = decodeURIComponent(target);
  if (target.includes("/live2/logo/") || target.includes("/live/logo/")) {
    const logoName = target.split("logo/")[1];
    target = `https://vavoo.top/live2/logo/${logoName}`;
  }

  try {
    const upstreamRes = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "image/*,*/*"
      }
    });

    if (!upstreamRes.ok) {
      return fallbackLogo();
    }

    const ctype = upstreamRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", ctype);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (err) {
    return fallbackLogo();
  }
}
