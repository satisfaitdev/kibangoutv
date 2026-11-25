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
        sources = data.get('sources', [])
        if not sources:
            return content_bytes
        
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
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
            }
            if "Content-Type" in self.headers:
                headers["Content-Type"] = self.headers["Content-Type"]

            req = urllib.request.Request(
                target_url,
                data=body,
                headers=headers,
                method=method
            )

            with urllib.request.urlopen(req, timeout=20) as resp:
                final_url = resp.geturl() or target_url
                ctype = resp.headers.get("Content-Type", "")
                is_m3u8 = ".m3u8" in target_url or "mpegurl" in ctype.lower()
                is_source = "/vod/source/" in target_url

                if is_m3u8:
                    content = resp.read()
                    global LAST_STREAM_BASE
                    LAST_STREAM_BASE = final_url.split("?", 1)[0].rsplit("/", 1)[0] + "/"
                    content = rewrite_m3u8(content, final_url)
                    self.send_response(resp.status)
                    self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif is_source:
                    content = resp.read()
                    content = prioritize_french_sources(content)
                    self.send_response(resp.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif "/resolve" in target_url or "/resolve" in final_url:
                    content = resp.read()
                    try:
                        data = json.loads(content.decode("utf-8"))
                        if isinstance(data, dict) and "url" in data and isinstance(data["url"], str):
                            if not data["url"].startswith("/api/proxy"):
                                data["url"] = f"/api/proxy?url={urllib.parse.quote(data['url'])}"
                        content = json.dumps(data).encode("utf-8")
                    except Exception as e:
                        print("Error rewriting resolve json in server.py:", e)
                    self.send_response(resp.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                else:
                    clength = resp.headers.get("Content-Length")
                    self.send_response(resp.status)
                    self.send_header("Content-Type", ctype if ctype else "application/octet-stream")
                    if clength:
                        self.send_header("Content-Length", clength)
                    self.end_headers()

                    # Streaming direct par blocs de 64KB (faible latence)
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
        if "/kibangou-addon/" in self.path:
            self.path = re.sub(r'\?v=[^/]+/?', '', self.path)

        # 0b. Service direct du manifest de l'addon Kibangou (indispensable pour Vuma)
        clean_path = self.path.split("?", 1)[0].rstrip("/")
        if clean_path in ["/kibangou-addon", "/kibangou-addon/mhub-addon.json"]:
            manifest_file = os.path.join(DIRECTORY, "kibangou-addon", "mhub-addon.json")
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
                    print("Error serving kibangou manifest:", e)

        # 0c. Interception de secours des segments TS / M3U8 relatifs orphelins (ex: /6b0585cf_84.ts)
        if (".ts" in self.path or ".m3u8" in self.path) and not self.path.startswith("/api/proxy?url="):
            seg_name = self.path.split("?", 1)[0].split("/")[-1]
            if LAST_STREAM_BASE and seg_name:
                abs_target = urllib.parse.urljoin(LAST_STREAM_BASE, seg_name)
                self.path = f"/api/proxy?url={urllib.parse.quote(abs_target)}"
                self.forward_proxy("GET")
                return

        # 0d. Résolution des flux Live TV avec proxy HTTPS automatique
        if "/kibangou-addon/resolve" in self.path or self.path.startswith("/resolve"):
            raw_url = self.path.split("url=", 1)[1] if "url=" in self.path else ""
            play_url = urllib.parse.unquote(raw_url)
            try:
                vavoo_resolve = f"https://vavoo.top/live/resolve?url={urllib.parse.quote(play_url)}"
                req = urllib.request.Request(vavoo_resolve, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())
                if data and "url" in data:
                    data["url"] = f"/api/proxy?url={urllib.parse.quote(data['url'])}"
                resp_bytes = json.dumps(data).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)
                return
            except Exception as e:
                print("Resolve error:", e)

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

        # 4. Métadonnées d'items pour le bouquet Kibangou (gère /kibangou-addon/item/ ET /item/)
        unquoted_path = urllib.parse.unquote(self.path)
        if "/kibangou-addon/item/" in unquoted_path or unquoted_path.startswith("/item/"):
            if "/kibangou-addon/item/" in unquoted_path:
                sub_path = unquoted_path.split("/kibangou-addon/item/", 1)[1]
            else:
                sub_path = unquoted_path.split("/item/", 1)[1]

            # Vérifier d'abord si c'est un item local (ex: live/drtv, live/tv5monde)
            clean_sub = sub_path.split("?", 1)[0].replace(".json", "")
            local_json = os.path.join(DIRECTORY, "kibangou-addon", "item", clean_sub + ".json")
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

        # 4b. Sources VOD pour le bouquet Kibangou (gère /kibangou-addon/source/ ET /source/)
        if "/kibangou-addon/source/" in unquoted_path or unquoted_path.startswith("/source/"):
            if "/kibangou-addon/source/" in unquoted_path:
                sub_path = unquoted_path.split("/kibangou-addon/source/", 1)[1]
            else:
                sub_path = unquoted_path.split("/source/", 1)[1]

            clean_sub = sub_path.split("?", 1)[0].replace(".json", "")
            parts = clean_sub.split("/")
            if len(parts) >= 2:
                stype = parts[0]
                sid = parts[1]
                imdb_id = ""
                season = "1"
                episode = "1"

                if sid.startswith("tmdb:"):
                    segs = sid.split(":")
                    tmdb_num = segs[1]
                    if len(segs) >= 4:
                        season = segs[2]
                        episode = segs[3]
                    try:
                        tmdb_req = urllib.request.Request(f"https://www.mhub.mx/tmdb/item/{stype}/tmdb:{tmdb_num}.json", headers={"User-Agent": "Mozilla/5.0"})
                        with urllib.request.urlopen(tmdb_req, timeout=5) as tr:
                            tdata = json.loads(tr.read().decode())
                            if "ids" in tdata and "imdb" in tdata["ids"]:
                                imdb_id = tdata["ids"]["imdb"].replace("tt", "")
                    except Exception as te:
                        print("TMDB to IMDb error in server.py:", te)
                elif sid.startswith("imdb:"):
                    segs = sid.split(":")
                    imdb_id = segs[1].replace("tt", "")
                    if len(segs) >= 4:
                        season = segs[2]
                        episode = segs[3]

                target_id = f"imdb:tt{imdb_id}:{season}:{episode}" if stype == "series" else f"imdb:tt{imdb_id}" if imdb_id else sid
                vavoo_vod_url = f"https://vavoo.top/vod/source/{stype}/{target_id}.json?region=FR&language=fr"
                self.path = f"/api/proxy?url={urllib.parse.quote(vavoo_vod_url)}"
                self.forward_proxy("GET")
                return

        # 5. Fichiers statiques normaux
        super().do_GET()

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
