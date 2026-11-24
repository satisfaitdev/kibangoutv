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
        if not text.startswith('#EXTM3U'):
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
                # Détection et réécriture automatique des playlists HLS (.m3u8)
                is_m3u8 = ".m3u8" in target_url
                is_source = "/vod/source/" in target_url

                if is_m3u8:
                    content = resp.read()
                    global LAST_STREAM_BASE
                    LAST_STREAM_BASE = target_url.split("?", 1)[0].rsplit("/", 1)[0] + "/"
                    content = rewrite_m3u8(content, target_url)
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
                else:
                    ctype = resp.headers.get("Content-Type", "application/octet-stream")
                    clength = resp.headers.get("Content-Length")
                    self.send_response(resp.status)
                    self.send_header("Content-Type", ctype)
                    if clength:
                        self.send_header("Content-Length", clength)
                    self.end_headers()

                    # Streaming direct par blocs de 64KB (faible latence pour les segments vidéo)
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError):
                            break

        except Exception as e:
            if fallback_to_logo:
                self.serve_fallback_logo()
                return
            if isinstance(e, urllib.error.HTTPError):
                err_content = e.read()
                self.send_response(e.code)
                ctype = e.headers.get("Content-Type", "application/json") if e.headers else "application/json"
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(err_content if err_content else f'{{"error": "{e.reason}"}}\n'.encode("utf-8"))
            else:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(f'{{"error": "{str(e)}"}}\n'.encode("utf-8"))

    def do_GET(self):
        # 0. Nettoyage de query au milieu d'un chemin local
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

        # 1. Redimensionneur et cache d'images de Vuma /get?url=...
        if self.path.startswith("/get?url=") or self.path.startswith("/get?"):
            raw = self.path.split("url=", 1)[1] if "url=" in self.path else ""
            raw = raw.split("&", 1)[0]
            target = urllib.parse.unquote(raw)

            # Si image locale /logo.svg ou vide
            if not target or target == "/logo.svg" or target == "logo.svg" or target.endswith("/logo.svg"):
                self.serve_fallback_logo()
                return

            # Si logo de chaîne VAVOO relatif
            if "/live2/logo/" in target or "/live/logo/" in target:
                logo_name = target.split("logo/", 1)[1]
                target = f"https://vavoo.top/live2/logo/{logo_name}"

            # Proxy de l'image avec fallback automatique sur le logo si 404
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

        # 4. Métadonnées d'items pour le bouquet Kibangou (gère tmdb: et tmdb%3A)
        unquoted_path = urllib.parse.unquote(self.path)
        if "/kibangou-addon/item/" in unquoted_path:
            sub_path = unquoted_path.split("/kibangou-addon/item/", 1)[1]
            tmdb_url = f"https://www.mhub.mx/tmdb/item/{sub_path}"
            self.path = f"/api/proxy?url={urllib.parse.quote(tmdb_url)}"
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
