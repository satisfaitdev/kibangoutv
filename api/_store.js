import fs from "node:fs";
import path from "node:path";

const TMP_DIR = "/tmp";

function getRedisCreds() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
  return url && token ? { url, token } : null;
}

export function isPersistentStoreConfigured() {
  return Boolean(getRedisCreds());
}

export async function storeGet(key, fallback = null) {
  const creds = getRedisCreds();
  if (creds) {
    try {
      const res = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        cache: "no-store"
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.result === "string") {
          return JSON.parse(data.result);
        }
        return fallback;
      }
    } catch {}
  }

  try {
    const file = path.join(TMP_DIR, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {}
  return fallback;
}

export async function storeSet(key, value, ttlSec = 0) {
  const serialized = JSON.stringify(value);
  const creds = getRedisCreds();
  let redisOk = false;
  let redisStatus = 0;
  if (creds) {
    try {
      const cmd = ttlSec > 0
        ? ["SET", key, serialized, "EX", String(ttlSec)]
        : ["SET", key, serialized];
      const res = await fetch(creds.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(cmd),
        cache: "no-store"
      });
      redisStatus = res.status;
      redisOk = res.ok;
    } catch {}
  }

  try {
    const file = path.join(TMP_DIR, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    fs.writeFileSync(file, serialized, "utf-8");
  } catch {}
  return { redisOk, redisStatus };
}
