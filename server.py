import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import shutil
import subprocess
import threading
import time
import os
import re
import json

PORT = 8080
DIRECTORY = r"C:\Users\SATISFAIT\.gemini\antigravity\scratch\iptv-vuma-app"
LOGO_FILE = os.path.join(DIRECTORY, "logo.svg")

CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

TRANSCODE_PROFILES = {
    "720p": {"height": 720, "bandwidth": 1200000, "resolution": "1280x720", "name": "720p HD", "v_br": "1050k", "max_br": "1200k", "buf": "2400k", "a_br": "96k", "ac": "2", "fps_f": ""},
    "480p": {"height": 480, "bandwidth": 550000, "resolution": "854x480", "name": "480p 3G", "v_br": "450k", "max_br": "550k", "buf": "1100k", "a_br": "64k", "ac": "2", "fps_f": ""},
    "360p": {"height": 360, "bandwidth": 260000, "resolution": "640x360", "name": "360p 2G/3G", "v_br": "210k", "max_br": "260k", "buf": "520k", "a_br": "48k", "ac": "2", "fps_f": ""},
    "240p": {"height": 240, "bandwidth": 130000, "resolution": "426x240", "name": "240p Ultra-Éco", "v_br": "95k", "max_br": "120k", "buf": "240k", "a_br": "32k", "ac": "1", "fps_f": ",fps=20"},
}
ORDERED_DOWNSCALE_IDS = ["720p", "480p", "360p", "240p"]

# Caches courts thread-safe : 45s pour resolve, 2.5s pour M3U8 lors du passage Master -> Variante
RESOLVE_CACHE = {}
RESOLVE_CACHE_TTL = 45.0
MAX_RESOLVE_CACHE = 300

M3U8_CACHE = {}
M3U8_CACHE_TTL = 2.5
MAX_M3U8_CACHE = 100

CACHE_LOCK = threading.Lock()
LAST_STREAM_BASE = None

EXCLUDED_VOD_HOSTS = ("vidoza.", "supervideo.", "superplayer.")
FAST_HOST_PRIORITY = [
    "dood.yt",
    "filemoon",
    "mixdrop",
    "mxdrop",
    "dood.to",
    "playmogo",
    "d000d",
    "myvidplay",
    "vidply",
    "voe.sx",
]

LANGUAGE_INFO = {
    "fr": ("🇫🇷 Français VF", 0, "fr"),
    "fra": ("🇫🇷 Français VF", 0, "fr"),
    "fre": ("🇫🇷 Français VF", 0, "fr"),
    "french": ("🇫🇷 Français VF", 0, "fr"),
    "vf": ("🇫🇷 Français VF", 0, "fr"),
    "vff": ("🇫🇷 Français VFF", 0, "fr"),
    "truefrench": ("🇫🇷 TrueFrench VF", 0, "fr"),
    "vostfr": ("🇫🇷 VOSTFR", 1, "fr"),
    "en": ("🇬🇧 Anglais VO", 2, "en"),
    "eng": ("🇬🇧 Anglais VO", 2, "en"),
    "english": ("🇬🇧 Anglais VO", 2, "en"),
    "vo": ("🇬🇧 Anglais VO", 2, "en"),
    "de": ("🇩🇪 Allemand DE", 3, "de"),
    "ger": ("🇩🇪 Allemand DE", 3, "de"),
    "deu": ("🇩🇪 Allemand DE", 3, "de"),
    "es": ("🇪🇸 Espagnol ES", 3, "es"),
    "spa": ("🇪🇸 Espagnol ES", 3, "es"),
    "it": ("🇮🇹 Italien IT", 3, "it"),
    "ita": ("🇮🇹 Italien IT", 3, "it"),
    "pt": ("🇵🇹 Portugais PT", 3, "pt"),
    "por": ("🇵🇹 Portugais PT", 3, "pt"),
    "nl": ("🇳🇱 Néerlandais NL", 3, "nl"),
    "pl": ("🇵🇱 Polonais PL", 3, "pl"),
    "tr": ("🇹🇷 Turc TR", 3, "tr"),
    "ar": ("🇸🇦 Arabe AR", 3, "ar"),
    "ru": ("🇷🇺 Russe RU", 3, "ru"),
    "ja": ("🇯🇵 Japonais JA", 3, "ja"),
    "jpn": ("🇯🇵 Japonais JA", 3, "ja"),
    "ko": ("🇰🇷 Coréen KO", 3, "ko"),
    "zh": ("🇨🇳 Chinois ZH", 3, "zh"),
    "hi": ("🇮🇳 Hindi HI", 3, "hi"),
    "ro": ("🇷🇴 Roumain RO", 3, "ro"),
    "cs": ("🇨🇿 Tchèque CS", 3, "cs"),
    "hu": ("🇭🇺 Hongrois HU", 3, "hu"),
    "multi": ("🌐 Multi-Audio", 1, "multi"),
}


def resolve_ffmpeg_bin():
    win_static = os.path.join(DIRECTORY, "node_modules", "ffmpeg-static", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if os.path.isfile(win_static):
        return win_static
    return shutil.which("ffmpeg")


FFMPEG_BIN = resolve_ffmpeg_bin()


def merge_headers_ci(base_headers, extra_headers, allowed_lower=None):
    out = {}
    lower_to_key = {}
    for k, v in (base_headers or {}).items():
        if isinstance(v, str) and v:
            out[k] = v
            lower_to_key[k.lower()] = k
    if isinstance(extra_headers, dict):
        for k, v in extra_headers.items():
            if not isinstance(v, str) or not v:
                continue
            lk = k.lower()
            if allowed_lower is not None and lk not in allowed_lower:
                continue
            prev_k = lower_to_key.get(lk)
            if prev_k and prev_k != k:
                del out[prev_k]
            out[k] = v
            lower_to_key[lk] = k
    return out


def build_content_disposition(raw_filename, final_url, content_type):
    base = str(raw_filename or "").strip()
    base = re.sub(r"[/\\]", " ", base)
    base = re.sub(r"\.\.+", ".", base)
    base = re.sub(r'[\r\n"<>:|?*]+', "", base).strip()

    if not base:
        try:
            upath = urllib.parse.unquote(urllib.parse.urlparse(final_url).path).strip("/")
            base = upath.split("/")[-1] if upath else ""
            base = re.sub(r'[\r\n"<>:|?*]+', "", base).strip()
        except Exception:
            base = ""
    if not base:
        base = "kibangoutv-video"

    if not re.search(r"\.(mp4|mkv|webm|mov|avi|ts|m4v|mp3|aac)$", base, re.I):
        lurl = str(final_url or "").split("?", 1)[0].lower()
        lct = str(content_type or "").lower()
        ext = ".mp4"
        if lurl.endswith(".mkv") or "matroska" in lct:
            ext = ".mkv"
        elif lurl.endswith(".webm") or "webm" in lct:
            ext = ".webm"
        elif lurl.endswith(".ts") or "mp2t" in lct:
            ext = ".ts"
        elif lurl.endswith(".m4v"):
            ext = ".m4v"
        elif lurl.endswith(".mov"):
            ext = ".mov"
        base = f"{base}{ext}"

    if len(base) > 140:
        dot = base.rfind(".")
        ext = base[dot:] if dot > 0 else ".mp4"
        base = base[: 140 - len(ext)] + ext

    ascii_safe = re.sub(r"[^\x20-\x7E]", "_", base).replace('"', "_").replace("\\", "_") or "kibangoutv-video.mp4"
    utf8_enc = urllib.parse.quote(base, safe="")
    return f'attachment; filename="{ascii_safe}"; filename*=UTF-8\'\'{utf8_enc}'


def normalize_resolved_playback(data, is_live=False):
    if isinstance(data, dict) and isinstance(data.get("url"), str) and data["url"]:
        has_headers = isinstance(data.get("headers"), dict) and len(data["headers"]) > 0
        if is_live or data.get("live") or data["url"].startswith("http://") or has_headers:
            data["proxy"] = True
    return data


def resolve_vavoo_cached(upstream_url, is_live=False, bypass_cache=False):
    now = time.time()
    if not bypass_cache:
        with CACHE_LOCK:
            cached = RESOLVE_CACHE.get(upstream_url)
            if cached and (now - cached["ts"]) < RESOLVE_CACHE_TTL:
                return cached["status"], dict(cached["data"]), None, True

    req = urllib.request.Request(upstream_url, headers={"User-Agent": "VAVOO/2.6", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            raw_text = r.read().decode("utf-8", errors="ignore")
            status = r.status
    except urllib.error.HTTPError as e:
        raw_text = e.read().decode("utf-8", errors="ignore") if e.fp else ""
        status = e.code
        try:
            parsed_err = json.loads(raw_text) if raw_text else {"error": e.reason}
        except Exception:
            parsed_err = None
        return status, parsed_err, raw_text, False

    try:
        parsed = json.loads(raw_text)
    except Exception:
        return status, None, raw_text, False

    normalize_resolved_playback(parsed, is_live)

    if 200 <= status < 300 and isinstance(parsed, dict) and isinstance(parsed.get("url"), str) and parsed["url"]:
        with CACHE_LOCK:
            if len(RESOLVE_CACHE) >= MAX_RESOLVE_CACHE:
                oldest = next(iter(RESOLVE_CACHE))
                del RESOLVE_CACHE[oldest]
            RESOLVE_CACHE[upstream_url] = {"status": status, "data": dict(parsed), "ts": time.time()}

    return status, parsed, None, False


def validate_public_stream_url(raw_url):
    target = str(raw_url or "").strip()
    if not target:
        return None
    if target.startswith("//"):
        target = "https:" + target
    elif not target.startswith("http://") and not target.startswith("https://"):
        target = "https://" + target.lstrip("/")
    try:
        parsed = urllib.parse.urlparse(target)
    except Exception:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if host in ("localhost", "0.0.0.0", "::1") or host.endswith(".local"):
        return None
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return None
    except ValueError:
        pass
    return target


def normalize_quality_id(raw_q):
    if not raw_q:
        return ""
    q = str(raw_q).strip().lower()
    if q in ("orig", "original", "1080p"):
        return "orig"
    return q if q in TRANSCODE_PROFILES else ""


def build_adaptive_m3u8(text, final_url, full_stream_base, requested_q, can_transcode):
    is_master = "#EXT-X-STREAM-INF" in text
    has_fmp4_map = "#EXT-X-MAP" in text
    is_encrypted = "#EXT-X-KEY" in text and "METHOD=NONE" not in text
    allow_transcode = bool(can_transcode and not has_fmp4_map and not is_encrypted)
    lines = text.splitlines()

    if not is_master:
        if not requested_q and allow_transcode and "#EXTINF:" in text:
            enc_src = urllib.parse.quote(final_url, safe="")
            master = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                "#EXT-X-INDEPENDENT-SEGMENTS",
                '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,NAME="Original HD"',
                f"{full_stream_base}?u={enc_src}&q=orig",
            ]
            for pid in ORDERED_DOWNSCALE_IDS:
                p = TRANSCODE_PROFILES[pid]
                master.append(f'#EXT-X-STREAM-INF:BANDWIDTH={p["bandwidth"]},RESOLUTION={p["resolution"]},NAME="{p["name"]}"')
                master.append(f"{full_stream_base}?u={enc_src}&q={pid}")
            return "\n".join(master)

        q_suffix = f"&q={requested_q}" if (requested_q and requested_q != "orig" and not has_fmp4_map and not is_encrypted) else ""
        out_lines = []
        for line in lines:
            sline = line.strip()
            if not sline:
                out_lines.append(line)
            elif sline.startswith("#"):
                if 'URI="' in sline:
                    sline = re.sub(
                        r'URI="([^"]+)"',
                        lambda mm: f'URI="{full_stream_base}?u={urllib.parse.quote(urllib.parse.urljoin(final_url, mm.group(1)), safe="")}"',
                        sline,
                    )
                out_lines.append(sline)
            else:
                abs_u = urllib.parse.urljoin(final_url, sline)
                out_lines.append(f'{full_stream_base}?u={urllib.parse.quote(abs_u, safe="")}{q_suffix}')
        return "\n".join(out_lines)

    lowest_bw = float("inf")
    lowest_variant = None
    rewritten = []
    for idx, line in enumerate(lines):
        sline = line.strip()
        if not sline:
            rewritten.append(line)
            continue
        if sline.startswith("#EXT-X-STREAM-INF:"):
            bw_match = re.search(r"BANDWIDTH=(\d+)", sline)
            bw = int(bw_match.group(1)) if bw_match else float("inf")
            nxt = lines[idx + 1].strip() if idx + 1 < len(lines) else ""
            if nxt and not nxt.startswith("#") and bw < lowest_bw:
                lowest_bw = bw
                lowest_variant = urllib.parse.urljoin(final_url, nxt)
            rewritten.append(sline)
            continue
        if sline.startswith("#"):
            if 'URI="' in sline:
                sline = re.sub(
                    r'URI="([^"]+)"',
                    lambda mm: f'URI="{full_stream_base}?u={urllib.parse.quote(urllib.parse.urljoin(final_url, mm.group(1)), safe="")}"',
                    sline,
                )
            rewritten.append(sline)
            continue
        abs_u = urllib.parse.urljoin(final_url, sline)
        rewritten.append(f'{full_stream_base}?u={urllib.parse.quote(abs_u, safe="")}&q=orig')

    if allow_transcode and lowest_variant and lowest_bw > 650000:
        enc_lowest = urllib.parse.quote(lowest_variant, safe="")
        for pid in ("480p", "360p", "240p"):
            p = TRANSCODE_PROFILES[pid]
            if p["bandwidth"] < lowest_bw:
                rewritten.append(f'#EXT-X-STREAM-INF:BANDWIDTH={p["bandwidth"]},RESOLUTION={p["resolution"]},NAME="{p["name"]}"')
                rewritten.append(f"{full_stream_base}?u={enc_lowest}&q={pid}")
    return "\n".join(rewritten)


def rewrite_m3u8(content_bytes, target_url):
    try:
        text = content_bytes.decode("utf-8", errors="ignore")
        if "#EXTM3U" not in text:
            return content_bytes

        lines = []
        for line in text.splitlines():
            sline = line.strip()
            if not sline:
                lines.append(line)
            elif sline.startswith("#"):
                if 'URI="' in sline:
                    def repl_uri(m):
                        raw_u = m.group(1)
                        abs_u = urllib.parse.urljoin(target_url, raw_u)
                        return f'URI="/api/proxy?url={urllib.parse.quote(abs_u)}"'
                    sline = re.sub(r'URI="([^"]+)"', repl_uri, sline)
                lines.append(sline)
            else:
                abs_u = urllib.parse.urljoin(target_url, sline)
                lines.append(f"/api/proxy?url={urllib.parse.quote(abs_u)}")

        return "\n".join(lines).encode("utf-8")
    except Exception as e:
        print("Erreur réécriture M3U8:", e)
        return content_bytes


def _is_excluded_vod_host(url):
    lower = str(url or "").lower()
    return not lower or any(h in lower for h in EXCLUDED_VOD_HOSTS)


def _host_priority(url):
    lower = str(url or "").lower()
    for i, h in enumerate(FAST_HOST_PRIORITY):
        if h in lower:
            return i
    return len(FAST_HOST_PRIORITY)


def _extract_host_label(url, fallback="Serveur"):
    try:
        host = urllib.parse.urlparse(url).hostname or ""
        host = re.sub(r"^www\.", "", host.lower())
        for h in FAST_HOST_PRIORITY:
            if h in host:
                return h
        return host or fallback
    except Exception:
        return fallback


def _classify_source_language(source):
    raw_langs = []
    if isinstance(source.get("languages"), list):
        raw_langs = [str(l).strip().lower() for l in source["languages"] if str(l or "").strip()]
    elif source.get("language"):
        raw_langs = [str(source["language"]).strip().lower()]

    subs = source.get("subtitles") or ""
    if isinstance(subs, list):
        subs = " ".join(str(x) for x in subs)
    hint = f"{source.get('name', '')} {source.get('label', '')} {source.get('quality', '')} {subs}".lower()

    is_vostfr = (
        "vostfr" in hint
        or "subfr" in hint
        or "vostfr" in raw_langs
        or ("en" in raw_langs and "fr" in raw_langs)
    )
    if is_vostfr:
        codes = raw_langs if "fr" in raw_langs else ["fr"] + [c for c in raw_langs if c != "fr"]
        return 1, "🇫🇷 VOSTFR", codes

    for raw in raw_langs:
        base = re.split(r"[-_]", raw)[0]
        info = LANGUAGE_INFO.get(raw) or LANGUAGE_INFO.get(base)
        if info:
            label, tier, norm = info
            codes = [norm] + [c for c in raw_langs if c not in (raw, norm)]
            return tier, label, codes

    if re.search(r"\b(truefrench|vff|vf|french|français)\b", hint, re.I):
        return 0, "🇫🇷 Français VF", ["fr"]
    if re.search(r"\b(english|vo)\b", hint, re.I):
        return 2, "🇬🇧 Anglais VO", ["en"]

    if raw_langs:
        return 3, f"🌐 {raw_langs[0].upper()}", raw_langs

    return 4, "🌐 Multilingue / VO", ["und"]


def sort_and_label_sources(raw_list):
    seen = set()
    enriched = []
    for idx, s in enumerate(raw_list or []):
        if not isinstance(s, dict):
            continue
        u = s.get("url")
        if not isinstance(u, str) or not u or _is_excluded_vod_host(u):
            continue
        if u in seen:
            continue
        seen.add(u)
        tier, lang_label, codes = _classify_source_language(s)
        quality = str(s.get("quality") or "").strip() or "HD"
        host_label = _extract_host_label(u, s.get("name") or "Serveur")
        sc = dict(s)
        sc["name"] = f"{lang_label} • {host_label}"
        sc["quality"] = quality
        sc["languages"] = codes
        enriched.append((tier, _host_priority(u), idx, sc))

    enriched.sort(key=lambda x: (x[0], x[1], x[2]))
    return [x[3] for x in enriched]


def prioritize_french_sources(content_bytes):
    try:
        data = json.loads(content_bytes.decode("utf-8"))
        data["sources"] = sort_and_label_sources(data.get("sources", []))
        return json.dumps(data, ensure_ascii=False).encode("utf-8")
    except Exception as e:
        print("Erreur réorganisation sources VF:", e)
        return content_bytes


def fetch_vavoo_sources_safe(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VAVOO/2.6", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            if r.status != 200:
                return []
            parsed = json.loads(r.read().decode("utf-8"))
            return [s for s in parsed.get("sources", []) if isinstance(s, dict) and not _is_excluded_vod_host(s.get("url"))]
    except Exception:
        return []


def resolve_imdb_from_tmdb(main_id, is_episode):
    meta_types = ["series", "video"] if is_episode else ["video", "series"]
    for mt in meta_types:
        try:
            req = urllib.request.Request(
                f"https://www.mhub.mx/tmdb/item/{mt}/tmdb:{main_id}.json",
                headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=4) as tr:
                tdata = json.loads(tr.read().decode("utf-8"))
                imdb_val = (tdata.get("ids") or {}).get("imdb")
                if imdb_val:
                    return str(imdb_val).replace("tt", "")
        except Exception:
            pass
    return ""


class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def serve_fallback_logo(self):
        try:
            with open(LOGO_FILE, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_response(204)
            self.end_headers()

    def clean_target_url(self, raw_path):
        target = raw_path.split("/api/proxy?url=", 1)[1] if "/api/proxy?url=" in raw_path else raw_path
        target = urllib.parse.unquote(target)
        while "/api/proxy?url=" in target:
            target = urllib.parse.unquote(target.split("/api/proxy?url=", 1)[1])
        if target.startswith("//"):
            target = "https:" + target
        elif not target.startswith("http://") and not target.startswith("https://"):
            target = "https://" + target.lstrip("/")
        return target

    def handle_stream(self, method="GET"):
        import base64
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        raw_target = (qs.get("u") or qs.get("url") or [""])[0]
        target_url = validate_public_stream_url(raw_target)
        if not target_url:
            self.send_response(400)
            self.end_headers()
            return

        dl_param = (qs.get("download") or [""])[0].strip().lower()
        is_download = dl_param in ("1", "true")
        requested_filename = (qs.get("filename") or [""])[0]
        req_quality = normalize_quality_id((qs.get("q") or [""])[0])

        custom_hdrs = {}
        m = re.search(r"/h_([A-Za-z0-9_-]+)", parsed.path)
        if m:
            try:
                b64 = m.group(1).replace("-", "+").replace("_", "/")
                b64 += "=" * ((4 - len(b64) % 4) % 4)
                parsed_custom = json.loads(base64.b64decode(b64).decode("utf-8"))
                if isinstance(parsed_custom, dict):
                    custom_hdrs = parsed_custom
            except Exception:
                pass

        allowed_fwd = {"referer", "origin", "user-agent", "cookie", "x-requested-with", "accept", "accept-language"}
        headers = merge_headers_ci(
            {
                "User-Agent": "VAVOO/2.6" if "vavoo" in target_url else CHROME_UA,
                "Accept": "*/*",
                "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            },
            custom_hdrs,
            allowed_fwd,
        )
        if "Range" in self.headers:
            headers["Range"] = self.headers["Range"]

        header_cache_key = f"{target_url}|{custom_hdrs.get('referer') or custom_hdrs.get('Referer') or ''}"
        if method == "GET" and not is_download and req_quality:
            with CACHE_LOCK:
                cached_m3u8 = M3U8_CACHE.get(header_cache_key)
                if cached_m3u8 and (time.time() - cached_m3u8["ts"]) < M3U8_CACHE_TTL:
                    stream_base = parsed.path if parsed.path.startswith("/api/stream") else "/api/stream"
                    proto = (self.headers.get("X-Forwarded-Proto") or "http").split(",")[0].strip()
                    host_hdr = self.headers.get("Host", f"localhost:{PORT}")
                    full_stream_base = f"{proto}://{host_hdr}{stream_base}"
                    out_text = build_adaptive_m3u8(
                        cached_m3u8["text"], cached_m3u8["final_url"], full_stream_base, req_quality, bool(FFMPEG_BIN)
                    )
                    out = out_text.encode("utf-8")
                    self.send_response(cached_m3u8["status"])
                    self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Kibangou-M3U8-Cache", "HIT")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                    return

        headers_sent = False
        try:
            req = urllib.request.Request(target_url, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=25) as resp:
                final_url = resp.geturl() or target_url
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                ctype_lower = ctype.lower()
                is_html = "text/html" in ctype_lower or "application/xhtml" in ctype_lower
                is_m3u8 = (
                    not is_download
                    and (
                        final_url.split("?", 1)[0].lower().endswith(".m3u8")
                        or target_url.split("?", 1)[0].lower().endswith(".m3u8")
                        or "mpegurl" in ctype_lower
                    )
                )

                if is_download and is_html:
                    err_body = json.dumps({"error": "La source renvoie une page HTML au lieu d'une vidéo téléchargeable."}).encode("utf-8")
                    self.send_response(422)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(err_body)))
                    self.end_headers()
                    headers_sent = True
                    if method != "HEAD":
                        self.wfile.write(err_body)
                    return

                if method == "HEAD":
                    self.send_response(resp.status)
                    self.send_header("Content-Type", ctype)
                    if resp.headers.get("Accept-Ranges"):
                        self.send_header("Accept-Ranges", resp.headers.get("Accept-Ranges"))
                    if resp.headers.get("Content-Length"):
                        self.send_header("Content-Length", resp.headers.get("Content-Length"))
                    if is_download:
                        self.send_header("Content-Disposition", build_content_disposition(requested_filename, final_url, ctype))
                    self.end_headers()
                    headers_sent = True
                    return

                if is_m3u8:
                    raw = resp.read()
                    text = raw.decode("utf-8", errors="ignore")
                    if "#EXTM3U" in text:
                        if not req_quality and 200 <= resp.status < 300:
                            with CACHE_LOCK:
                                if len(M3U8_CACHE) >= MAX_M3U8_CACHE:
                                    oldest = next(iter(M3U8_CACHE))
                                    del M3U8_CACHE[oldest]
                                M3U8_CACHE[header_cache_key] = {
                                    "text": text,
                                    "final_url": final_url,
                                    "status": resp.status,
                                    "ts": time.time(),
                                }
                        stream_base = parsed.path if parsed.path.startswith("/api/stream") else "/api/stream"
                        proto = (self.headers.get("X-Forwarded-Proto") or "http").split(",")[0].strip()
                        host_hdr = self.headers.get("Host", f"localhost:{PORT}")
                        full_stream_base = f"{proto}://{host_hdr}{stream_base}"
                        out_text = build_adaptive_m3u8(text, final_url, full_stream_base, req_quality, bool(FFMPEG_BIN))
                        out = out_text.encode("utf-8")
                        self.send_response(resp.status)
                        self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Accel-Buffering", "no")
                        self.send_header("X-Kibangou-ABR", "adaptive-ffmpeg" if FFMPEG_BIN else "passthrough")
                        self.send_header("Content-Length", str(len(out)))
                        self.end_headers()
                        headers_sent = True
                        self.wfile.write(out)
                        return

                if not is_download and req_quality and req_quality != "orig" and req_quality in TRANSCODE_PROFILES and FFMPEG_BIN:
                    prof = TRANSCODE_PROFILES[req_quality]
                    cmd = [
                        FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                        "-fflags", "+genpts+discardcorrupt",
                        "-i", "pipe:0",
                        "-map", "0:v:0?", "-map", "0:a:0?",
                        "-vf", f'scale=-2:{prof["height"]}:flags=fast_bilinear{prof["fps_f"]}',
                        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                        "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
                        "-bf", "0", "-force_key_frames", "expr:eq(n,0)",
                        "-b:v", prof["v_br"], "-maxrate", prof["max_br"], "-bufsize", prof["buf"],
                        "-c:a", "aac", "-b:a", prof["a_br"], "-ac", prof["ac"], "-ar", "44100",
                        "-copyts", "-muxdelay", "0",
                        "-f", "mpegts", "-flush_packets", "1", "pipe:1",
                    ]
                    popen_kw = {"creationflags": 0x08000000} if os.name == "nt" else {}
                    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **popen_kw)

                    def feed_stdin():
                        try:
                            while True:
                                chunk = resp.read1(32768) if hasattr(resp, "read1") else resp.read(32768)
                                if not chunk:
                                    break
                                proc.stdin.write(chunk)
                                proc.stdin.flush()
                        except Exception:
                            pass
                        finally:
                            try:
                                proc.stdin.close()
                            except Exception:
                                pass

                    t = threading.Thread(target=feed_stdin, daemon=True)
                    t.start()

                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp2t")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Accel-Buffering", "no")
                    self.send_header("X-Kibangou-Quality", req_quality)
                    self.send_header("X-Kibangou-Transcoded", "ffmpeg-pipe")
                    self.end_headers()
                    headers_sent = True
                    stdout_fd = proc.stdout.fileno()
                    try:
                        while True:
                            out_chunk = os.read(stdout_fd, 16384)
                            if not out_chunk:
                                break
                            self.wfile.write(out_chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ConnectionError, OSError):
                        pass
                    finally:
                        try:
                            proc.kill()
                            proc.wait(timeout=2)
                        except Exception:
                            pass
                    return

                self.send_response(resp.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Accel-Buffering", "no")
                if is_download:
                    self.send_header("Content-Disposition", build_content_disposition(requested_filename, final_url, ctype))
                if resp.headers.get("Content-Range"):
                    self.send_header("Content-Range", resp.headers.get("Content-Range"))
                if resp.headers.get("Accept-Ranges"):
                    self.send_header("Accept-Ranges", resp.headers.get("Accept-Ranges"))
                if resp.headers.get("Content-Length"):
                    self.send_header("Content-Length", resp.headers.get("Content-Length"))
                self.end_headers()
                headers_sent = True
                while True:
                    chunk = resp.read1(32768) if hasattr(resp, "read1") else resp.read(32768)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ConnectionError):
            return
        except urllib.error.HTTPError as e:
            if not headers_sent:
                self.send_response(e.code)
                self.end_headers()
        except Exception:
            if not headers_sent:
                self.send_response(502)
                self.end_headers()

    def forward_proxy(self, method="GET", body=None, fallback_to_logo=False):
        target_url = self.clean_target_url(self.path)

        try:
            if method == "GET" and ("/live/resolve" in target_url or "/vod/resolve" in target_url):
                is_live = "/live/resolve" in target_url
                status, data, raw_text, cache_hit = resolve_vavoo_cached(target_url, is_live=is_live)
                self.send_response(status)
                self.send_header("X-Final-Url", target_url)
                self.send_header("X-Kibangou-Cache", "HIT" if cache_hit else "MISS")
                self.send_header("Content-Type", "application/json; charset=utf-8")
                if 200 <= status < 300 and data and data.get("url"):
                    self.send_header("Cache-Control", "private, max-age=30")
                payload = json.dumps(data).encode("utf-8") if data is not None else (raw_text or "").encode("utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            custom_headers = None
            if "X-Proxy-Headers" in self.headers:
                try:
                    custom_headers = json.loads(self.headers["X-Proxy-Headers"])
                except Exception:
                    pass

            base_headers = {
                "User-Agent": "VAVOO/2.6" if "vavoo" in target_url else CHROME_UA,
                "Accept": "*/*",
                "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            }
            if "Content-Type" in self.headers:
                base_headers["Content-Type"] = self.headers["Content-Type"]
            if "Range" in self.headers:
                base_headers["Range"] = self.headers["Range"]

            headers = merge_headers_ci(base_headers, custom_headers)

            req = urllib.request.Request(target_url, data=body, headers=headers, method=method)

            with urllib.request.urlopen(req, timeout=20) as resp:
                final_url = resp.geturl() or target_url
                ctype = resp.headers.get("Content-Type", "")
                is_m3u8 = final_url.split("?", 1)[0].lower().endswith(".m3u8") or target_url.split("?", 1)[0].lower().endswith(".m3u8") or "mpegurl" in ctype.lower()
                is_source = "/vod/source/" in target_url or "/vod/source/" in final_url

                if is_m3u8:
                    content = resp.read()
                    global LAST_STREAM_BASE
                    LAST_STREAM_BASE = final_url.split("?", 1)[0].rsplit("/", 1)[0] + "/"
                    content = rewrite_m3u8(content, final_url)
                    self.send_response(resp.status)
                    self.send_header("X-Final-Url", final_url)
                    self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif is_source:
                    content = resp.read()
                    content = prioritize_french_sources(content)
                    self.send_response(resp.status)
                    self.send_header("X-Final-Url", final_url)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif "/resolve" in target_url or "/resolve" in final_url or "/client-fetch" in target_url or "/client-fetch" in final_url:
                    content = resp.read()
                    try:
                        data = json.loads(content.decode("utf-8"))
                        normalize_resolved_playback(data, "/live/resolve" in target_url)
                        content = json.dumps(data).encode("utf-8")
                    except Exception as e:
                        print("Error handling resolve json in server.py:", e)
                    self.send_response(resp.status)
                    self.send_header("X-Final-Url", final_url)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                else:
                    clength = resp.headers.get("Content-Length")
                    self.send_response(resp.status)
                    self.send_header("X-Final-Url", final_url)
                    self.send_header("Content-Type", ctype if ctype else "application/octet-stream")
                    if clength:
                        self.send_header("Content-Length", clength)
                    self.end_headers()

                    while True:
                        chunk = resp.read1(32768) if hasattr(resp, "read1") else resp.read(32768)
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ConnectionError, OSError):
                            break

        except Exception as e:
            if fallback_to_logo:
                self.serve_fallback_logo()
                return
            if isinstance(e, urllib.error.HTTPError):
                try:
                    err_content = e.read()
                except Exception:
                    err_content = b""
                self.send_response(e.code)
                ctype = e.headers.get("Content-Type", "application/json") if e.headers else "application/json"
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(err_content if err_content else f'{{"error": "{e.reason}"}}\n'.encode("utf-8"))
            else:
                try:
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(f'{{"error": "{str(e)}"}}\n'.encode("utf-8"))
                except Exception:
                    pass

    def do_GET(self):
        clean_path = self.path.split("?", 1)[0].rstrip("/")
        if clean_path == "/sw.js":
            sw_file = os.path.join(DIRECTORY, "sw.js")
            if os.path.isfile(sw_file):
                with open(sw_file, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Service-Worker-Allowed", "/")
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

        if clean_path in ["/manifest.webmanifest", "/manifest.json"]:
            m_name = "manifest.webmanifest" if clean_path == "/manifest.webmanifest" else "manifest.json"
            m_file = os.path.join(DIRECTORY, m_name)
            if os.path.isfile(m_file):
                with open(m_file, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/manifest+json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

        if any(p in self.path for p in ["/kibangou-addon/", "/french-addon/", "/adult-addon/"]):
            self.path = re.sub(r"\?v=[^/]+/?", "", self.path)

        clean_path = self.path.split("?", 1)[0].rstrip("/")
        addon_manifest_map = {
            "/kibangou-addon": os.path.join(DIRECTORY, "kibangou-addon", "mhub-addon.json"),
            "/kibangou-addon/mhub-addon.json": os.path.join(DIRECTORY, "kibangou-addon", "mhub-addon.json"),
            "/french-addon": os.path.join(DIRECTORY, "french-addon", "mhub-addon.json"),
            "/french-addon/mhub-addon.json": os.path.join(DIRECTORY, "french-addon", "mhub-addon.json"),
            "/adult-addon": os.path.join(DIRECTORY, "adult-addon", "mhub-addon.json"),
            "/adult-addon/mhub-addon.json": os.path.join(DIRECTORY, "adult-addon", "mhub-addon.json"),
        }
        if clean_path in addon_manifest_map:
            manifest_file = addon_manifest_map[clean_path]
            if os.path.isfile(manifest_file):
                try:
                    with open(manifest_file, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as e:
                    print("Error serving addon manifest:", e)

        for addon_prefix in ["/kibangou-addon/catalog/", "/french-addon/catalog/", "/adult-addon/catalog/"]:
            if addon_prefix in clean_path:
                addon_name = addon_prefix.split("/")[1]
                sub_catalog = clean_path.split(addon_prefix, 1)[1].replace(".json", "")
                cat_file = os.path.join(DIRECTORY, addon_name, "catalog", sub_catalog + ".json")
                if os.path.isfile(cat_file):
                    try:
                        with open(cat_file, "r", encoding="utf-8") as f:
                            cat_data = json.load(f)
                        items = cat_data.get("items", []) if isinstance(cat_data, dict) else (cat_data if isinstance(cat_data, list) else [])

                        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                        cat_filter = (
                            qs.get("filter.category", [""])[0]
                            or qs.get("filter[category]", [""])[0]
                            or qs.get("category", [""])[0]
                        )
                        if cat_filter and cat_filter.lower() not in ["all", "tous"]:
                            cf_lower = cat_filter.lower().strip()
                            items = [
                                it for it in items
                                if cf_lower in (it.get("category") or "").lower()
                                or cf_lower in (it.get("group") or "").lower()
                                or cf_lower in (it.get("name") or "").lower()
                                or any(cf_lower in str(g).lower() for g in it.get("genres", []))
                                or any(cf_lower in str(t).lower() for t in it.get("tags", []))
                            ]

                        search_q = qs.get("search", [""])[0] or qs.get("q", [""])[0] or qs.get("query", [""])[0]
                        if search_q:
                            sq_lower = search_q.lower().strip()
                            items = [
                                it for it in items
                                if sq_lower in (it.get("name") or "").lower()
                                or sq_lower in (it.get("description") or "").lower()
                                or sq_lower in (it.get("category") or it.get("group") or "").lower()
                                or any(sq_lower in str(t).lower() for t in it.get("tags", []))
                            ]

                        sort_by = (qs.get("sort", [""])[0] or "").lower()
                        if sort_by in ("name", "a-z"):
                            items = sorted(items, key=lambda it: (it.get("name") or "").lower())

                        out_bytes = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(out_bytes)))
                        self.end_headers()
                        self.wfile.write(out_bytes)
                        return
                    except Exception as e:
                        print("Error serving catalog in server.py:", e)

        if clean_path.startswith("/tmdb:") or clean_path.startswith("/imdb:"):
            clean_id = clean_path.lstrip("/").split("?")[0].replace(".json", "")
            for mt in ["video", "series"]:
                tmdb_url = f"https://www.mhub.mx/tmdb/item/{mt}/{clean_id}.json"
                try:
                    req = urllib.request.Request(tmdb_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=4) as tr:
                        data = tr.read()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                except Exception:
                    pass

        if (".ts" in self.path or ".m3u8" in self.path) and not self.path.startswith("/api/proxy?url=") and not self.path.startswith("/api/stream"):
            seg_name = self.path.split("?", 1)[0].split("/")[-1]
            if LAST_STREAM_BASE and seg_name:
                abs_target = urllib.parse.urljoin(LAST_STREAM_BASE, seg_name)
                self.path = f"/api/proxy?url={urllib.parse.quote(abs_target)}"
                self.forward_proxy("GET")
                return

        if any(p in self.path for p in ["/kibangou-addon/resolve", "/french-addon/resolve", "/adult-addon/resolve", "/api/resolve"]) or self.path.startswith("/resolve"):
            parsed_res = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed_res.query)
            play_url = (qs.get("url") or [""])[0]
            if not play_url:
                self.send_response(400)
                self.end_headers()
                return
            bypass = (qs.get("nocache") or [""])[0] == "1"
            try:
                is_live = "/live/play/" in play_url or "vavoo" in play_url
                vavoo_resolve = f"https://vavoo.top/{'live' if is_live else 'vod'}/resolve?url={urllib.parse.quote(play_url)}"
                status, data, raw_text, cache_hit = resolve_vavoo_cached(vavoo_resolve, is_live=is_live, bypass_cache=bypass)
                resp_bytes = json.dumps(data).encode("utf-8") if data is not None else (raw_text or "").encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("X-Kibangou-Cache", "HIT" if cache_hit else "MISS")
                if 200 <= status < 300 and data and data.get("url"):
                    self.send_header("Cache-Control", "private, max-age=30")
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)
                return
            except Exception as e:
                print("Resolve error:", e)
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
                return

        if self.path.startswith("/api/stream"):
            self.handle_stream("GET")
            return

        if self.path.startswith("/get?url=") or self.path.startswith("/get?"):
            raw = self.path.split("url=", 1)[1] if "url=" in self.path else ""
            raw = raw.split("&", 1)[0]
            target = urllib.parse.unquote(raw)

            if not target or target == "/logo.svg" or target == "logo.svg" or target.endswith("/logo.svg"):
                self.serve_fallback_logo()
                return

            if "/live2/logo/" in target or "/live/logo/" in target:
                logo_name = target.split("logo/", 1)[1]
                target = f"https://vavoo.top/live2/logo/{logo_name}"

            self.path = f"/api/proxy?url={urllib.parse.quote(target)}"
            self.forward_proxy("GET", fallback_to_logo=True)
            return

        if self.path.startswith("/live2/logo/") or self.path.startswith("/live/logo/"):
            logo_name = self.path.split("logo/", 1)[1]
            target = f"https://vavoo.top/live2/logo/{logo_name}"
            self.path = f"/api/proxy?url={urllib.parse.quote(target)}"
            self.forward_proxy("GET", fallback_to_logo=True)
            return

        if self.path.startswith("/api/proxy?url="):
            self.forward_proxy("GET")
            return

        unquoted_path = urllib.parse.unquote(self.path)
        matching_addon_item = None
        for prefix in ["/kibangou-addon/item/", "/french-addon/item/", "/adult-addon/item/"]:
            if prefix in unquoted_path:
                matching_addon_item = prefix
                break

        if matching_addon_item or unquoted_path.startswith("/item/"):
            if matching_addon_item:
                sub_path = unquoted_path.split(matching_addon_item, 1)[1]
            else:
                sub_path = unquoted_path.split("/item/", 1)[1]

            clean_sub = sub_path.split("?", 1)[0].replace(".json", "")
            safe_sub = clean_sub.replace(":", "_")
            for addon_dir in ["kibangou-addon", "french-addon", "adult-addon"]:
                for cand_name in (clean_sub, safe_sub):
                    local_json = os.path.join(DIRECTORY, addon_dir, "item", cand_name + ".json")
                    if os.path.isfile(local_json):
                        try:
                            with open(local_json, "rb") as f:
                                data = f.read()
                            self.send_response(200)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Content-Length", str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)
                            return
                        except Exception as e:
                            print("Error serving local item:", e)

            req_type = "video"
            req_id = clean_sub
            if "/" in clean_sub:
                parts = clean_sub.split("/", 1)
                req_type = parts[0]
                req_id = parts[1]
            clean_id = req_id.replace("tmdb:", "").replace("imdb:", "")
            types_to_try = ["series", "video"] if req_type == "series" else ["video", "series"]
            for t in types_to_try:
                try:
                    u = f"https://www.mhub.mx/tmdb/item/{t}/tmdb:{clean_id}.json"
                    tmdb_req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "fr-FR,fr;q=0.9"})
                    with urllib.request.urlopen(tmdb_req, timeout=6) as resp:
                        if resp.status == 200:
                            item_data = json.loads(resp.read().decode("utf-8"))
                            item_data["id"] = req_id
                            if "ids" not in item_data:
                                item_data["ids"] = {}
                            if "tmdb" not in item_data["ids"]:
                                item_data["ids"]["tmdb"] = clean_id
                            payload = json.dumps(item_data).encode("utf-8")
                            self.send_response(200)
                            self.send_header("Content-Type", "application/json; charset=utf-8")
                            self.send_header("Content-Length", str(len(payload)))
                            self.end_headers()
                            self.wfile.write(payload)
                            return
                except Exception:
                    pass
            self.send_error(404, "Item not found")
            return

        matching_addon_source = None
        for prefix in ["/kibangou-addon/source/", "/french-addon/source/", "/adult-addon/source/"]:
            if prefix in unquoted_path:
                matching_addon_source = prefix
                break

        if matching_addon_source or unquoted_path.startswith("/source/"):
            if matching_addon_source:
                sub_path = unquoted_path.split(matching_addon_source, 1)[1]
            else:
                sub_path = unquoted_path.split("/source/", 1)[1]

            clean_sub = sub_path.split("?", 1)[0].replace(".json", "")
            parts = [p for p in clean_sub.split("/") if p]
            if len(parts) >= 2:
                stype = parts[0]
                sid = parts[1]
                segs = sid.split(":")
                is_episode = len(segs) >= 3 or stype == "series"
                main_id = segs[1] if len(segs) > 1 else sid
                season = segs[2] if len(segs) >= 3 else "1"
                episode = segs[3] if len(segs) >= 4 else "1"
                imdb_id = ""

                if segs[0] == "imdb":
                    imdb_id = main_id.replace("tt", "")
                elif main_id.startswith("tt"):
                    imdb_id = main_id.replace("tt", "")

                def build_candidates(prefix, id_val):
                    suffix = f"{prefix}:{id_val}:{season}:{episode}" if is_episode else f"{prefix}:{id_val}"
                    kinds = ["series", "video"] if is_episode else ["video", "series"]
                    return [f"https://vavoo.top/vod/source/{k}/{suffix}.json?region=FR&language=fr" for k in kinds]

                final_sources = []
                if imdb_id:
                    cands = build_candidates("imdb", f"tt{imdb_id}")
                    with ThreadPoolExecutor(max_workers=2) as ex:
                        for res in ex.map(fetch_vavoo_sources_safe, cands):
                            if res:
                                final_sources = res
                                break
                elif main_id:
                    tmdb_cands = build_candidates("tmdb", main_id)
                    with ThreadPoolExecutor(max_workers=2) as ex:
                        fut_tmdb = ex.submit(fetch_vavoo_sources_safe, tmdb_cands[0])
                        fut_imdb = ex.submit(resolve_imdb_from_tmdb, main_id, is_episode)
                        final_sources = fut_tmdb.result()
                        resolved_imdb = fut_imdb.result()
                    if not final_sources and len(tmdb_cands) > 1:
                        final_sources = fetch_vavoo_sources_safe(tmdb_cands[1])
                    if not final_sources and resolved_imdb:
                        imdb_cands = build_candidates("imdb", f"tt{resolved_imdb}")
                        with ThreadPoolExecutor(max_workers=2) as ex:
                            for res in ex.map(fetch_vavoo_sources_safe, imdb_cands):
                                if res:
                                    final_sources = res
                                    break

                out_bytes = json.dumps({"sources": sort_and_label_sources(final_sources)}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "public, max-age=120")
                self.send_header("Content-Length", str(len(out_bytes)))
                self.end_headers()
                self.wfile.write(out_bytes)
                return

        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/api/stream"):
            self.handle_stream("HEAD")
        else:
            super().do_HEAD()

    def do_POST(self):
        if "/client-fetch" in self.path or any(p in self.path for p in ["/kibangou-addon/resolve", "/french-addon/resolve", "/adult-addon/resolve", "/resolve"]):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            try:
                req = urllib.request.Request(
                    "https://vavoo.top/vod/client-fetch",
                    data=body,
                    headers={"Content-Type": "application/json", "User-Agent": CHROME_UA},
                )
                with urllib.request.urlopen(req, timeout=12) as upstream:
                    raw_text = upstream.read().decode("utf-8", errors="ignore")
                    try:
                        data = normalize_resolved_playback(json.loads(raw_text), False)
                        out_bytes = json.dumps(data).encode("utf-8")
                    except Exception:
                        out_bytes = raw_text.encode("utf-8")
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(out_bytes)))
                    self.end_headers()
                    self.wfile.write(out_bytes)
                    return
            except urllib.error.HTTPError as e:
                err_content = e.read()
                try:
                    json.loads(err_content.decode("utf-8"))
                    out_err = err_content
                except Exception:
                    out_err = json.dumps({"error": err_content.decode("utf-8", errors="ignore") or f"HTTP {e.code}"}).encode("utf-8")
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(out_err)))
                self.end_headers()
                self.wfile.write(out_err)
                return
            except Exception as e:
                print("Server.py client-fetch error:", e)
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
                return
        elif self.path.startswith("/api/proxy?url="):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            self.forward_proxy("POST", body)
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), ProxyHTTPRequestHandler) as httpd:
        print(f"KibangouTV Multi-Threaded Streaming Server running on http://localhost:{PORT}")
        httpd.serve_forever()
