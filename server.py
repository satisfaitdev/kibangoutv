import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
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

TRANSCODE_PROFILES = {
    "720p": {"height": 720, "bandwidth": 1200000, "resolution": "1280x720", "name": "720p HD", "v_br": "1050k", "max_br": "1200k", "buf": "2400k", "a_br": "96k", "ac": "2", "fps_f": ""},
    "480p": {"height": 480, "bandwidth": 550000, "resolution": "854x480", "name": "480p 3G", "v_br": "450k", "max_br": "550k", "buf": "1100k", "a_br": "64k", "ac": "2", "fps_f": ""},
    "360p": {"height": 360, "bandwidth": 260000, "resolution": "640x360", "name": "360p 2G/3G", "v_br": "210k", "max_br": "260k", "buf": "520k", "a_br": "48k", "ac": "2", "fps_f": ""},
    "240p": {"height": 240, "bandwidth": 130000, "resolution": "426x240", "name": "240p Ultra-Éco", "v_br": "95k", "max_br": "120k", "buf": "240k", "a_br": "32k", "ac": "1", "fps_f": ",fps=20"},
}
ORDERED_DOWNSCALE_IDS = ["720p", "480p", "360p", "240p"]


def resolve_ffmpeg_bin():
    win_static = os.path.join(DIRECTORY, "node_modules", "ffmpeg-static", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if os.path.isfile(win_static):
        return win_static
    return shutil.which("ffmpeg")


FFMPEG_BIN = resolve_ffmpeg_bin()


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

# Cache mémoire ultra-rapide (TTL 10 min)
CACHE = {}
CACHE_TTL = 600

# Base URL du dernier flux vidéo HLS lu (pour résolution instantanée des segments orphelins)
LAST_STREAM_BASE = None

def rewrite_m3u8(content_bytes, target_url):
    try:
        text = content_bytes.decode('utf-8', errors='ignore')
        if '#EXTM3U' not in text:
            return content_bytes
        
        lines = []
        for line in text.splitlines():
            sline = line.strip()
            if not sline:
                lines.append(line)
            elif sline.startswith('#'):
                if 'URI="' in sline:
                    def repl_uri(m):
                        raw_u = m.group(1)
                        abs_u = urllib.parse.urljoin(target_url, raw_u)
                        return f'URI="/api/proxy?url={urllib.parse.quote(abs_u)}"'
                    sline = re.sub(r'URI="([^"]+)"', repl_uri, sline)
                lines.append(sline)
            else:
                abs_u = urllib.parse.urljoin(target_url, sline)
                proxied_u = f"/api/proxy?url={urllib.parse.quote(abs_u)}"
                lines.append(proxied_u)
        
        return '\n'.join(lines).encode('utf-8')
    except Exception as e:
        print("Erreur réécriture M3U8:", e)
        return content_bytes

HLS_CLOUD_HOSTS = ["voe.sx", "dood.yt", "vidply", "myvidplay", "filemoon", "d000d", "supervideo"]

def _host_priority(url):
    lower = str(url or "").lower()
    for i, h in enumerate(HLS_CLOUD_HOSTS):
        if h in lower:
            return i
    return len(HLS_CLOUD_HOSTS)

def prioritize_french_sources(content_bytes):
    try:
        data = json.loads(content_bytes.decode('utf-8'))
        sources = [s for s in data.get('sources', []) if s.get('url') and 'vidoza.' not in s.get('url', '').lower()]
        if not sources:
            data['sources'] = []
            return json.dumps(data).encode('utf-8')

        sources.sort(key=lambda s: _host_priority(s.get('url')))

        fr_sources = []
        en_sources = []
        other_sources = []

        for s in sources:
            langs = [l.lower() for l in s.get('languages', [])]
            name = s.get('name', 'Serveur')
            quality = s.get('quality', 'HD')

            if 'fr' in langs:
                s_copy = dict(s)
                s_copy['name'] = f"🇫🇷 Français VF ({quality})"
                fr_sources.append(s_copy)
            elif 'en' in langs:
                s_copy = dict(s)
                s_copy['name'] = f"🇬🇧 VO / VOSTFR ({quality})"
                en_sources.append(s_copy)
            else:
                s_copy = dict(s)
                s_copy['name'] = f"🌐 {name} ({','.join(langs).upper()})"
                other_sources.append(s_copy)

        data['sources'] = fr_sources + en_sources + other_sources
        return json.dumps(data).encode('utf-8')
    except Exception as e:
        print("Erreur réorganisation sources VF:", e)
        return content_bytes

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

        req_quality = normalize_quality_id((qs.get("q") or [""])[0])

        headers = {
            "User-Agent": "VAVOO/2.6" if "vavoo" in target_url else "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
        }

        m = re.search(r'/h_([A-Za-z0-9_-]+)', parsed.path)
        if m:
            try:
                b64 = m.group(1).replace('-', '+').replace('_', '/')
                b64 += '=' * ((4 - len(b64) % 4) % 4)
                custom = json.loads(base64.b64decode(b64).decode('utf-8'))
                if isinstance(custom, dict):
                    for k, v in custom.items():
                        if isinstance(v, str) and v and k.lower() in ("referer", "origin", "user-agent", "cookie", "x-requested-with", "accept", "accept-language"):
                            headers[k] = v
            except Exception:
                pass

        if "Range" in self.headers:
            headers["Range"] = self.headers["Range"]

        try:
            req = urllib.request.Request(target_url, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=25) as resp:
                final_url = resp.geturl() or target_url
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                is_m3u8 = final_url.split("?", 1)[0].lower().endswith(".m3u8") or target_url.split("?", 1)[0].lower().endswith(".m3u8") or "mpegurl" in ctype.lower()

                if method == "HEAD":
                    self.send_response(resp.status)
                    self.send_header("Content-Type", ctype)
                    if resp.headers.get("Accept-Ranges"):
                        self.send_header("Accept-Ranges", resp.headers.get("Accept-Ranges"))
                    if resp.headers.get("Content-Length"):
                        self.send_header("Content-Length", resp.headers.get("Content-Length"))
                    self.end_headers()
                    return

                if is_m3u8:
                    raw = resp.read()
                    text = raw.decode("utf-8", errors="ignore")
                    if "#EXTM3U" in text:
                        stream_base = parsed.path if parsed.path.startswith("/api/stream") else "/api/stream"
                        host_hdr = self.headers.get("Host", f"localhost:{PORT}")
                        full_stream_base = f"http://{host_hdr}{stream_base}"
                        out_text = build_adaptive_m3u8(text, final_url, full_stream_base, req_quality, bool(FFMPEG_BIN))
                        out = out_text.encode("utf-8")
                        self.send_response(resp.status)
                        self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Kibangou-ABR", "adaptive-ffmpeg" if FFMPEG_BIN else "passthrough")
                        self.send_header("Content-Length", str(len(out)))
                        self.end_headers()
                        self.wfile.write(out)
                        return

                if req_quality and req_quality != "orig" and req_quality in TRANSCODE_PROFILES and FFMPEG_BIN:
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
                        "-f", "mpegts", "pipe:1",
                    ]
                    popen_kw = {"creationflags": 0x08000000} if os.name == "nt" else {}
                    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **popen_kw)

                    def feed_stdin():
                        try:
                            while True:
                                chunk = resp.read(65536)
                                if not chunk:
                                    break
                                proc.stdin.write(chunk)
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
                    self.send_header("X-Kibangou-Quality", req_quality)
                    self.send_header("X-Kibangou-Transcoded", "ffmpeg-pipe")
                    self.end_headers()
                    try:
                        while True:
                            out_chunk = proc.stdout.read(32768)
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
                if resp.headers.get("Content-Range"):
                    self.send_header("Content-Range", resp.headers.get("Content-Range"))
                if resp.headers.get("Accept-Ranges"):
                    self.send_header("Accept-Ranges", resp.headers.get("Accept-Ranges"))
                if resp.headers.get("Content-Length"):
                    self.send_header("Content-Length", resp.headers.get("Content-Length"))
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ConnectionError, OSError):
                        break
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
        except Exception as e:
            self.send_response(502)
            self.end_headers()

    def forward_proxy(self, method="GET", body=None, fallback_to_logo=False):
        target_url = self.clean_target_url(self.path)

        if method == "GET" and target_url in CACHE:
            cached_data, cached_time, ctype = CACHE[target_url]
            if time.time() - cached_time < CACHE_TTL:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(cached_data)
                return

        try:
            headers = {
                "User-Agent": "VAVOO/2.6" if "vavoo" in target_url else "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
            }
            if "Content-Type" in self.headers:
                headers["Content-Type"] = self.headers["Content-Type"]
            if "X-Proxy-Headers" in self.headers:
                try:
                    custom = json.loads(self.headers["X-Proxy-Headers"])
                    if isinstance(custom, dict):
                        for k, v in custom.items():
                            if isinstance(v, str) and v:
                                headers[k] = v
                except Exception:
                    pass
            if "Range" in self.headers:
                headers["Range"] = self.headers["Range"]

            req = urllib.request.Request(
                target_url,
                data=body,
                headers=headers,
                method=method
            )

            with urllib.request.urlopen(req, timeout=20) as resp:
                final_url = resp.geturl() or target_url
                ctype = resp.headers.get("Content-Type", "")
                is_m3u8 = final_url.split("?", 1)[0].lower().endswith(".m3u8") or target_url.split("?", 1)[0].lower().endswith(".m3u8") or "mpegurl" in ctype.lower()
                is_source = "/vod/source/" in target_url

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
                        if isinstance(data, dict) and isinstance(data.get("url"), str) and (data.get("live") or "/live/resolve" in target_url or data["url"].startswith("http://")):
                            data["proxy"] = True
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
                        chunk = resp.read(65536)
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
        # 0. Service des fichiers PWA (sw.js, manifest.webmanifest, etc.)
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

        # 0b. Nettoyage de query au milieu d'un chemin local
        if any(p in self.path for p in ["/kibangou-addon/", "/french-addon/", "/adult-addon/"]):
            self.path = re.sub(r'\?v=[^/]+/?', '', self.path)

        # 0b. Service direct des manifests des addons (Kibangou, French Cinema, Adult Pro)
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

        # 0b1. Service et filtrage dynamique des catalogues (Canal+ Congo, Chaînes Locales, beIN, etc.)
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

                        # Parsing des paramètres de requête (filtre catégorie & recherche)
                        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                        cat_filter = qs.get("filter.category", [""])[0] or qs.get("filter[category]", [""])[0] or qs.get("category", [""])[0]
                        if cat_filter and cat_filter.lower() not in ["all", "tous"]:
                            cf_lower = cat_filter.lower()
                            items = [
                                it for it in items
                                if cf_lower in (it.get("category") or "").lower()
                                or cf_lower in (it.get("group") or "").lower()
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
                                or any(sq_lower in str(t).lower() for t in it.get("tags", []))
                            ]

                        out_bytes = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(out_bytes)))
                        self.end_headers()
                        self.wfile.write(out_bytes)
                        return
                    except Exception as e:
                        print("Error serving catalog in server.py:", e)

        # 0b2. Résolution directe des identifiants TMDB / IMDb orphelins (ex: /tmdb:1726)
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

        # 0c. Interception de secours des segments TS / M3U8 relatifs orphelins (ex: /6b0585cf_84.ts)
        if (".ts" in self.path or ".m3u8" in self.path) and not self.path.startswith("/api/proxy?url="):
            seg_name = self.path.split("?", 1)[0].split("/")[-1]
            if LAST_STREAM_BASE and seg_name:
                abs_target = urllib.parse.urljoin(LAST_STREAM_BASE, seg_name)
                self.path = f"/api/proxy?url={urllib.parse.quote(abs_target)}"
                self.forward_proxy("GET")
                return

        if any(p in self.path for p in ["/kibangou-addon/resolve", "/french-addon/resolve", "/adult-addon/resolve"]) or self.path.startswith("/resolve"):
            raw_url = self.path.split("url=", 1)[1] if "url=" in self.path else ""
            play_url = urllib.parse.unquote(raw_url)
            try:
                is_live = "/live/play/" in play_url or "vavoo" in play_url
                vavoo_resolve = f"https://vavoo.top/{'live' if is_live else 'vod'}/resolve?url={urllib.parse.quote(play_url)}"
                req = urllib.request.Request(vavoo_resolve, headers={"User-Agent": "VAVOO/2.6"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())
                if isinstance(data, dict) and isinstance(data.get("url"), str) and (is_live or data.get("live") or data["url"].startswith("http://")):
                    data["proxy"] = True
                resp_bytes = json.dumps(data).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)
                return
            except Exception as e:
                print("Resolve error:", e)

        if self.path.startswith("/api/stream"):
            self.handle_stream("GET")
            return

        # 1. Redimensionneur et cache d'images de Vuma /get?url=...
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

        # 2. Logos directs de chaînes VAVOO /live2/logo/... ou /live/logo/...
        if self.path.startswith("/live2/logo/") or self.path.startswith("/live/logo/"):
            logo_name = self.path.split("logo/", 1)[1]
            target = f"https://vavoo.top/live2/logo/{logo_name}"
            self.path = f"/api/proxy?url={urllib.parse.quote(target)}"
            self.forward_proxy("GET", fallback_to_logo=True)
            return

        # 3. Proxy générique d'API /api/proxy?url=...
        if self.path.startswith("/api/proxy?url="):
            self.forward_proxy("GET")
            return

        # 4. Métadonnées d'items pour Kibangou, French Cinema & Adult (gère /kibangou-addon/item/, /french-addon/item/, /adult-addon/item/ ET /item/)
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

            # Vérifier d'abord si c'est un item local (ex: live/drtv, live/tv5monde)
            clean_sub = sub_path.split("?", 1)[0].replace(".json", "")
            for addon_dir in ["kibangou-addon", "french-addon", "adult-addon"]:
                local_json = os.path.join(DIRECTORY, addon_dir, "item", clean_sub + ".json")
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

            # Sinon proxy vers TMDB avec préservation de l'ID demandé
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
                            if "ids" not in item_data: item_data["ids"] = {}
                            if "tmdb" not in item_data["ids"]: item_data["ids"]["tmdb"] = clean_id
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

        # 4b. Sources VOD pour Kibangou, French Cinema & Adult (gère /.../source/ ET /source/)
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
            parts = clean_sub.split("/")
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
                elif segs[0] == "tmdb":
                    meta_types = ["series", "video"] if is_episode else ["video", "series"]
                    for mt in meta_types:
                        try:
                            tmdb_req = urllib.request.Request(f"https://www.mhub.mx/tmdb/item/{mt}/tmdb:{main_id}.json", headers={"User-Agent": "Mozilla/5.0"})
                            with urllib.request.urlopen(tmdb_req, timeout=4) as tr:
                                tdata = json.loads(tr.read().decode())
                                if "ids" in tdata and "imdb" in tdata["ids"]:
                                    imdb_id = str(tdata["ids"]["imdb"]).replace("tt", "")
                                    break
                        except Exception:
                            pass

                candidates = []
                if is_episode:
                    if imdb_id:
                        candidates.append(f"https://vavoo.top/vod/source/series/imdb:tt{imdb_id}:{season}:{episode}.json?region=FR&language=fr")
                        candidates.append(f"https://vavoo.top/vod/source/video/imdb:tt{imdb_id}:{season}:{episode}.json?region=FR&language=fr")
                    candidates.append(f"https://vavoo.top/vod/source/series/tmdb:{main_id}:{season}:{episode}.json?region=FR&language=fr")
                    candidates.append(f"https://vavoo.top/vod/source/video/tmdb:{main_id}:{season}:{episode}.json?region=FR&language=fr")
                else:
                    if imdb_id:
                        candidates.append(f"https://vavoo.top/vod/source/video/imdb:tt{imdb_id}.json?region=FR&language=fr")
                    candidates.append(f"https://vavoo.top/vod/source/video/tmdb:{main_id}.json?region=FR&language=fr")
                    if imdb_id:
                        candidates.append(f"https://vavoo.top/vod/source/series/imdb:tt{imdb_id}.json?region=FR&language=fr")

                for cu in candidates:
                    try:
                        req = urllib.request.Request(cu, headers={"User-Agent": "VAVOO/2.6"})
                        with urllib.request.urlopen(req, timeout=3) as cr:
                            cdata = cr.read()
                            try:
                                parsed = json.loads(cdata.decode('utf-8'))
                                if parsed.get('sources'):
                                    cdata = prioritize_french_sources(cdata)
                                    self.send_response(200)
                                    self.send_header("Content-Type", "application/json; charset=utf-8")
                                    self.send_header("Content-Length", str(len(cdata)))
                                    self.end_headers()
                                    self.wfile.write(cdata)
                                    return
                            except Exception:
                                pass
                    except Exception:
                        pass

                empty_resp = b'{"sources": []}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(empty_resp)))
                self.end_headers()
                self.wfile.write(empty_resp)
                return

        # 5. Fichiers statiques normaux
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
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                    }
                )
                with urllib.request.urlopen(req, timeout=12) as upstream:
                    data = json.loads(upstream.read().decode())
                    if isinstance(data, dict) and isinstance(data.get("url"), str) and data["url"].startswith("http://"):
                        data["proxy"] = True
                    out_bytes = json.dumps(data).encode("utf-8")
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(out_bytes)))
                    self.end_headers()
                    self.wfile.write(out_bytes)
                    return
            except urllib.error.HTTPError as e:
                err_content = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(err_content)))
                self.end_headers()
                self.wfile.write(err_content)
                return
            except Exception as e:
                print("Server.py client-fetch error:", e)
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(f'{{"error": "{str(e)}"}}\n'.encode("utf-8"))
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
