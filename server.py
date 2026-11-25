import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import time
import os
import re
import json

PORT = 8080
DIRECTORY = r"C:\Users\SATISFAIT\.gemini\antigravity\scratch\iptv-vuma-app"
LOGO_FILE = os.path.join(DIRECTORY, "logo.svg")

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

def prioritize_french_sources(content_bytes):
    try:
        data = json.loads(content_bytes.decode('utf-8'))
        sources = [s for s in data.get('sources', []) if s.get('url') and 'vidoza.' not in s.get('url', '').lower()]
        if not sources:
            data['sources'] = []
            return json.dumps(data).encode('utf-8')

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
        target_url = (qs.get("u") or qs.get("url") or [""])[0]
        if not target_url:
            self.send_response(400)
            self.end_headers()
            return
        if target_url.startswith("//"):
            target_url = "https:" + target_url
        elif not target_url.startswith("http://") and not target_url.startswith("https://"):
            target_url = "https://" + target_url.lstrip("/")

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
                        lines = []
                        for line in text.splitlines():
                            sline = line.strip()
                            if not sline:
                                lines.append(line)
                            elif sline.startswith("#"):
                                if 'URI="' in sline:
                                    sline = re.sub(r'URI="([^"]+)"', lambda mm: f'URI="{stream_base}?u={urllib.parse.quote(urllib.parse.urljoin(final_url, mm.group(1)))}"', sline)
                                lines.append(sline)
                            else:
                                abs_u = urllib.parse.urljoin(final_url, sline)
                                lines.append(f'{stream_base}?u={urllib.parse.quote(abs_u)}')
                        out = "\n".join(lines).encode("utf-8")
                        self.send_response(resp.status)
                        self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
                        self.send_header("Content-Length", str(len(out)))
                        self.end_headers()
                        self.wfile.write(out)
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
                        if isinstance(data, dict) and isinstance(data.get("url"), str) and data["url"].startswith("http://"):
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

        # 0b1. Contrôle d'accès et verrouillage du catalogue Adulte (+18) Pro
        if "/adult-addon/catalog/" in clean_path:
            auth_ok = False
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pin = qs.get("pin", [""])[0]
            header_pin = self.headers.get("X-Pro-PIN", "") or self.headers.get("X-Kibangou-PIN", "")
            effective_pin = pin or header_pin
            auth_token = qs.get("pro", [""])[0] or self.headers.get("X-Pro-Auth", "")

            # PINs autorisés par défaut: 8888, 1234, 123456, 0000 ou token pro
            if effective_pin in ["8888", "1234", "123456", "0000"] or auth_token == "1" or auth_token == "true":
                auth_ok = True

            # Si non déverrouillé, retourner un message sécurisé conforme
            if not auth_ok:
                locked_payload = {
                    "items": [
                        {
                            "id": "adult:locked-info",
                            "name": "🔒 Espace Adulte +18 Verrouillé",
                            "type": "live" if "live" in clean_path else "video",
                            "description": "Ce contenu est réservé aux abonnés Pro (18+). Veuillez activer l'accès adulte dans les Réglages avec votre code PIN.",
                            "images": {
                                "logo": "/logo.svg",
                                "poster": "/logo.svg"
                            },
                            "tags": ["Verrouillé", "Pro", "18+"]
                        }
                    ]
                }
                data = json.dumps(locked_payload, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

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
                if isinstance(data, dict) and isinstance(data.get("url"), str) and data["url"].startswith("http://"):
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

            # Sinon proxy vers TMDB
            tmdb_url = f"https://www.mhub.mx/tmdb/item/{sub_path}"
            self.path = f"/api/proxy?url={urllib.parse.quote(tmdb_url)}"
            self.forward_proxy("GET")
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
        if self.path.startswith("/api/proxy?url="):
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
