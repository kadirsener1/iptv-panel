import re
import os
import sys
import json
import time
import base64
import requests
from urllib.parse import urljoin, unquote, quote
from datetime import datetime

# Playwright kullanacağız (headless browser)
try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ─────────────────────────────────────────────
# YAPILANDIRMA
# ─────────────────────────────────────────────
BASE_URL = "https://tv247.us/watch/"
OUTPUT_FILE = "tv247.m3u"
CHANNELS_FILE = "channels.txt"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/125.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
}


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


# ─────────────────────────────────────────────
# YÖNTEM 1: Requests + Regex (iframe zincirleme)
# ─────────────────────────────────────────────
def try_requests_method(channel_slug):
    """
    Basit HTTP istekleriyle iframe zincirini takip edip
    m3u8 / playlist URL'sini bulmaya çalışır.
    """
    log(f"[Requests] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    session = requests.Session()
    session.headers.update(HEADERS)

    try:
        # Ana sayfa
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        html = resp.text

        # iframe src bul (birden fazla katman olabilir)
        stream_url = None
        visited = set()
        current_url = url
        current_html = html

        for depth in range(10):  # max 10 iframe derinliği
            # iframe src ara
            iframe_matches = re.findall(
                r'<iframe[^>]+src=["\']([^"\']+)["\']',
                current_html,
                re.IGNORECASE
            )

            if not iframe_matches:
                log(f"  Depth {depth}: iframe bulunamadı")
                break

            for iframe_src in iframe_matches:
                iframe_url = urljoin(current_url, iframe_src)
                if iframe_url in visited:
                    continue
                visited.add(iframe_url)
                log(f"  Depth {depth}: iframe -> {iframe_url[:120]}")

                try:
                    resp2 = session.get(
                        iframe_url,
                        timeout=30,
                        headers={**HEADERS, "Referer": current_url}
                    )
                    current_html = resp2.text
                    current_url = iframe_url
                except Exception as e:
                    log(f"  iframe fetch hatası: {e}")
                    continue

                # playlist / m3u8 URL ara
                found = search_stream_url(current_html, current_url)
                if found:
                    return found

        # Son HTML'de de ara
        found = search_stream_url(html, url)
        if found:
            return found

    except Exception as e:
        log(f"[Requests] Hata: {e}")

    return None


def search_stream_url(html, page_url):
    """
    HTML içeriğinde stream URL'si arar.
    Çeşitli pattern'leri dener.
    """

    # Pattern 1: Doğrudan proxy/playlist URL
    patterns = [
        # chat.cfbu247 veya benzeri proxy playlist
        r'(https?://[^\s"\'<>]+/api/proxy/playlist\?token=[^\s"\'<>&]+)',
        # m3u8 linkleri
        r'(https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*)',
        # hlsx, hls proxy
        r'(https?://[^\s"\'<>]+/hls/[^\s"\'<>]+)',
        r'(https?://[^\s"\'<>]+/playlist\.m3u8[^\s"\'<>]*)',
        # source veya file değişkenlerinde
        r'(?:source|file|src|url|stream|video_url|playbackUrl)\s*[:=]\s*["\']'
        r'(https?://[^\s"\'<>]+)',
    ]

    for pattern in patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        if matches:
            for m in matches:
                url = m.strip().rstrip("'\">;,)")
                log(f"  Stream URL bulundu (regex): {url[:150]}")
                return url

    # Pattern 2: Base64 encoded token içinde m3u8
    b64_matches = re.findall(
        r'token=([A-Za-z0-9+/=_-]{50,})', html
    )
    for b64 in b64_matches:
        try:
            # URL-safe base64
            padded = b64 + "=" * (4 - len(b64) % 4) if len(b64) % 4 else b64
            decoded = base64.urlsafe_b64decode(padded).decode('utf-8', errors='ignore')
            if 'm3u8' in decoded or 'playlist' in decoded:
                # Token'ın tam URL'sini oluştur
                token_url_match = re.search(
                    r'(https?://[^\s"\'<>]+token=' + re.escape(b64) + r')',
                    html
                )
                if token_url_match:
                    log(f"  Token URL bulundu: {token_url_match.group(1)[:150]}")
                    return token_url_match.group(1)
        except Exception:
            pass

    # Pattern 3: JavaScript değişkenlerinde
    js_patterns = [
        r'var\s+\w+\s*=\s*["\']'
        r'(https?://[^\s"\']+(?:m3u8|playlist|proxy)[^\s"\']*)["\']',
        r'atob\(["\']([A-Za-z0-9+/=]+)["\']\)',
    ]

    for pattern in js_patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        for m in matches:
            # atob decode denemesi
            try:
                decoded = base64.b64decode(m).decode('utf-8', errors='ignore')
                if 'http' in decoded:
                    log(f"  atob decoded URL: {decoded[:150]}")
                    return decoded
            except Exception:
                if m.startswith('http'):
                    log(f"  JS var URL: {m[:150]}")
                    return m

    return None


# ─────────────────────────────────────────────
# YÖNTEM 2: Playwright (headless browser)
# ─────────────────────────────────────────────
def try_playwright_method(channel_slug):
    """
    Playwright ile tarayıcı açıp network isteklerini
    dinleyerek stream URL'sini yakalar.
    """
    if not HAS_PLAYWRIGHT:
        log("[Playwright] Playwright yüklü değil, atlanıyor.")
        return None

    log(f"[Playwright] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    stream_url = None
    found_urls = []

    def handle_request(request):
        req_url = request.url
        # Stream URL pattern'leri
        if any(kw in req_url.lower() for kw in [
            '/api/proxy/playlist',
            '.m3u8',
            '/playlist',
            'token=ey',
            '/hls/',
            '/live/',
            'mono.css',  # bu sitede css uzantılı m3u8 kullanılıyor
        ]):
            found_urls.append(req_url)
            log(f"  [Network] Yakalandı: {req_url[:200]}")

    def handle_response(response):
        resp_url = response.url
        content_type = response.headers.get('content-type', '')
        if any(kw in resp_url.lower() for kw in [
            '/api/proxy/playlist',
            '.m3u8',
            'token=ey',
        ]):
            found_urls.append(resp_url)
            log(f"  [Response] Yakalandı: {resp_url[:200]}")
        # mpegurl content type
        if 'mpegurl' in content_type.lower() or 'x-mpegurl' in content_type.lower():
            found_urls.append(resp_url)
            log(f"  [Response mpegurl] Yakalandı: {resp_url[:200]}")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                ]
            )
            context = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=HEADERS["User-Agent"],
                ignore_https_errors=True,
            )
            page = context.new_page()

            # Network dinleme
            page.on("request", handle_request)
            page.on("response", handle_response)

            log(f"  Sayfa yükleniyor: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)

            # iframe içine gir
            frames = page.frames
            log(f"  {len(frames)} frame bulundu")

            for i, frame in enumerate(frames):
                try:
                    frame_url = frame.url
                    log(f"  Frame {i}: {frame_url[:120]}")

                    # Frame içindeki HTML'i al ve stream URL ara
                    try:
                        frame_html = frame.content()
                        found = search_stream_url(frame_html, frame_url)
                        if found:
                            found_urls.append(found)
                    except Exception:
                        pass

                    # Frame içindeki iframe'lere de bak
                    inner_iframes = frame.query_selector_all("iframe")
                    for inner_iframe in inner_iframes:
                        try:
                            inner_src = inner_iframe.get_attribute("src")
                            if inner_src:
                                log(f"    Inner iframe: {inner_src[:120]}")
                        except Exception:
                            pass

                except Exception as e:
                    log(f"  Frame {i} hatası: {e}")

            # Biraz daha bekle (lazy load)
            page.wait_for_timeout(5000)

            # Play butonuna tıklamayı dene
            try:
                for frame in page.frames:
                    try:
                        play_selectors = [
                            'button.vjs-big-play-button',
                            '.play-button',
                            'button[aria-label="Play"]',
                            '.jw-icon-playback',
                            'video',
                            '.vjs-poster',
                        ]
                        for selector in play_selectors:
                            try:
                                el = frame.query_selector(selector)
                                if el:
                                    el.click(timeout=3000)
                                    log(f"  Play butonuna tıklandı: {selector}")
                                    page.wait_for_timeout(5000)
                                    break
                            except Exception:
                                pass
                    except Exception:
                        pass
            except Exception:
                pass

            # Son kontrol: Tüm frame HTML'lerini tara
            for frame in page.frames:
                try:
                    html = frame.content()
                    found = search_stream_url(html, frame.url)
                    if found:
                        found_urls.append(found)
                except Exception:
                    pass

            # Console mesajlarından da URL ara
            page.wait_for_timeout(3000)

            browser.close()

    except Exception as e:
        log(f"[Playwright] Hata: {e}")

    # En iyi URL'yi seç
    if found_urls:
        # Öncelik sırası: proxy/playlist > m3u8 > diğer
        for url_candidate in found_urls:
            if '/api/proxy/playlist' in url_candidate:
                return url_candidate
        for url_candidate in found_urls:
            if '.m3u8' in url_candidate:
                return url_candidate
        return found_urls[0]

    return None


# ─────────────────────────────────────────────
# YÖNTEM 3: Detaylı iframe zinciri takibi
# ─────────────────────────────────────────────
def try_deep_iframe_method(channel_slug):
    """
    Requests ile derin iframe zincirini takip eder.
    Her iframe'in JS'ini de parse eder.
    """
    log(f"[DeepIframe] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    session = requests.Session()
    session.headers.update(HEADERS)

    try:
        resp = session.get(url, timeout=30)
        html = resp.text

        # Tüm iframe'leri recursive takip et
        result = recursive_iframe_search(session, url, html, depth=0, max_depth=8)
        if result:
            return result

    except Exception as e:
        log(f"[DeepIframe] Hata: {e}")

    return None


def recursive_iframe_search(session, page_url, html, depth, max_depth):
    """Recursive iframe arama"""
    if depth > max_depth:
        return None

    indent = "  " * depth

    # Önce mevcut sayfada stream URL ara
    found = search_stream_url(html, page_url)
    if found:
        return found

    # Script tag'larını da kontrol et
    script_matches = re.findall(
        r'<script[^>]*>(.*?)</script>', html, re.DOTALL | re.IGNORECASE
    )
    for script in script_matches:
        found = search_stream_url(script, page_url)
        if found:
            return found

        # JS fetch/XMLHttpRequest URL'lerini bul
        fetch_urls = re.findall(
            r'(?:fetch|XMLHttpRequest|\.open)\s*\(\s*["\']'
            r'(https?://[^\s"\']+)["\']',
            script,
            re.IGNORECASE
        )
        for fetch_url in fetch_urls:
            log(f"{indent}  JS fetch URL: {fetch_url[:120]}")
            if any(kw in fetch_url for kw in ['playlist', 'm3u8', 'proxy', 'stream']):
                return fetch_url

        # JS içinde JSON config veya setup objeleri
        json_matches = re.findall(
            r'\{[^{}]*(?:source|file|url|stream)[^{}]*\}',
            script,
            re.IGNORECASE
        )
        for jm in json_matches:
            url_in_json = re.findall(r'https?://[^\s"\'<>]+', jm)
            for u in url_in_json:
                if any(kw in u for kw in ['m3u8', 'playlist', 'proxy', 'hls']):
                    log(f"{indent}  JSON config URL: {u[:120]}")
                    return u

    # iframe'leri bul ve takip et
    iframe_matches = re.findall(
        r'<iframe[^>]+src=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE
    )

    for iframe_src in iframe_matches:
        iframe_url = urljoin(page_url, iframe_src)
        log(f"{indent}  iframe[{depth}]: {iframe_url[:120]}")

        try:
            resp = session.get(
                iframe_url,
                timeout=30,
                headers={
                    **HEADERS,
                    "Referer": page_url,
                },
                allow_redirects=True
            )
            result = recursive_iframe_search(
                session, iframe_url, resp.text, depth + 1, max_depth
            )
            if result:
                return result
        except Exception as e:
            log(f"{indent}  iframe fetch hatası: {e}")

    # JS ile oluşturulan iframe'ler (document.createElement("iframe"))
    dynamic_srcs = re.findall(
        r'\.(?:src|setAttribute\s*\(\s*["\']src["\']\s*,)\s*[=]\s*["\']'
        r'(https?://[^\s"\']+)["\']',
        html,
        re.IGNORECASE
    )
    for dsrc in dynamic_srcs:
        dsrc_url = urljoin(page_url, dsrc)
        log(f"{indent}  dynamic iframe: {dsrc_url[:120]}")
        try:
            resp = session.get(
                dsrc_url,
                timeout=30,
                headers={**HEADERS, "Referer": page_url}
            )
            result = recursive_iframe_search(
                session, dsrc_url, resp.text, depth + 1, max_depth
            )
            if result:
                return result
        except Exception:
            pass

    return None


# ─────────────────────────────────────────────
# YÖNTEM 4: Token oluşturma (reverse engineer)
# ─────────────────────────────────────────────
def try_token_construct_method(channel_slug):
    """
    Bilinen token yapısını kullanarak URL oluşturmayı dener.
    Token format: base64({referer, m3u8, ts, channelId})
    """
    log(f"[TokenConstruct] {channel_slug} deneniyor...")

    # Bilinen channel ID mapping
    channel_map = {
        "bein-sports-1-turkey": "62",
        "bein-sports-2-turkey": "63",
        "bein-sports-3-turkey": "64",
        "bein-sports-4-turkey": "65",
    }

    channel_id = channel_map.get(channel_slug)
    if not channel_id:
        # Channel slug'dan ID çıkarmayı dene
        log(f"  Bilinmeyen kanal: {channel_slug}")
        return None

    # Bilinen pattern'lere göre token oluştur
    # Önce mevcut embed sayfasını ziyaret edip güncel subdomain'leri bul
    session = requests.Session()
    session.headers.update(HEADERS)

    # Birkaç bilinen pattern dene
    embed_patterns = [
        f"https://donis.jimpenopisonline.online/premiumtv/daddy3.php?id={channel_id}",
    ]

    stream_patterns = [
        f"https://kompis.zempovlantis.online/premium{channel_id}/tracks-v1a1/mono.css",
    ]

    # Güncel domain'leri bulmak için ana sayfayı kontrol et
    try:
        url = f"{BASE_URL}{channel_slug}/"
        resp = session.get(url, timeout=30)
        html = resp.text

        # Embed domain'lerini bul
        embed_domains = re.findall(
            r'(https?://[a-z0-9.-]+\.[a-z]+/premiumtv/daddy3\.php\?id=\d+)',
            html,
            re.IGNORECASE
        )
        if embed_domains:
            embed_patterns = embed_domains + embed_patterns

        # iframe'lerden de embed domain bul
        iframes = re.findall(
            r'<iframe[^>]+src=["\']([^"\']+)["\']',
            html,
            re.IGNORECASE
        )
        for iframe_src in iframes:
            iframe_url = urljoin(url, iframe_src)
            try:
                resp2 = session.get(
                    iframe_url,
                    timeout=30,
                    headers={**HEADERS, "Referer": url}
                )
                inner_embeds = re.findall(
                    r'(https?://[a-z0-9.-]+/premiumtv/[^\s"\'<>]+)',
                    resp2.text,
                    re.IGNORECASE
                )
                if inner_embeds:
                    embed_patterns = inner_embeds + embed_patterns

                # Stream domain bul
                stream_domains = re.findall(
                    r'(https?://[a-z0-9.-]+/premium\d+/[^\s"\'<>]+)',
                    resp2.text,
                    re.IGNORECASE
                )
                if stream_domains:
                    stream_patterns = stream_domains + stream_patterns

            except Exception:
                pass

    except Exception as e:
        log(f"  Sayfa fetch hatası: {e}")

    # Token oluştur ve dene
    for referer in embed_patterns:
        for m3u8_url in stream_patterns:
            ts = int(time.time() * 1000)

            token_data = {
                "referer": referer,
                "m3u8": m3u8_url,
                "ts": ts,
                "channelId": channel_id
            }

            token_json = json.dumps(token_data, separators=(',', ':'))
            token_b64 = base64.b64encode(token_json.encode()).decode()

            # Proxy API endpoint'leri dene
            proxy_hosts = [
                "chat.cfbu247.sbs",
            ]

            for proxy_host in proxy_hosts:
                playlist_url = (
                    f"https://{proxy_host}/api/proxy/playlist?token={token_b64}"
                )

                try:
                    test_resp = session.get(
                        playlist_url,
                        timeout=15,
                        headers={
                            **HEADERS,
                            "Referer": referer,
                            "Origin": f"https://{proxy_host}",
                        }
                    )
                    if test_resp.status_code == 200:
                        content = test_resp.text
                        if '#EXTM3U' in content or '#EXTINF' in content or 'BANDWIDTH' in content:
                            log(f"  ✓ Çalışan playlist URL bulundu!")
                            log(f"    {playlist_url[:150]}")
                            return playlist_url
                        elif test_resp.headers.get('content-type', '').startswith(('video/', 'application/octet')):
                            log(f"  ✓ Video stream URL bulundu!")
                            return playlist_url
                        else:
                            log(f"  ✗ Playlist yanıt verdi ama geçersiz içerik: "
                                f"{content[:100]}")
                    else:
                        log(f"  ✗ HTTP {test_resp.status_code}: {proxy_host}")
                except Exception as e:
                    log(f"  ✗ Bağlantı hatası ({proxy_host}): {e}")

    return None


# ─────────────────────────────────────────────
# YÖNTEM 5: Playwright ile Network Sniffing
# (en güvenilir yöntem)
# ─────────────────────────────────────────────
def try_playwright_network_sniff(channel_slug):
    """
    Playwright ile sayfayı açar, tüm network trafiğini dinler,
    ve stream URL'sini yakalar. En güvenilir yöntem.
    """
    if not HAS_PLAYWRIGHT:
        log("[PlaywrightSniff] Playwright yüklü değil.")
        return None

    log(f"[PlaywrightSniff] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    found_urls = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--autoplay-policy=no-user-gesture-required',
                ]
            )
            context = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=HEADERS["User-Agent"],
                ignore_https_errors=True,
            )

            page = context.new_page()

            # Tüm istekleri dinle
            def on_request(request):
                url_str = request.url
                if any(kw in url_str.lower() for kw in [
                    '/api/proxy/playlist',
                    '.m3u8',
                    'token=ey',
                    '/playlist',
                    'mono.css',
                    '/hls/',
                    '/live/',
                    'mpegts',
                ]):
                    found_urls.append({
                        'url': url_str,
                        'type': 'request',
                        'headers': dict(request.headers),
                    })
                    log(f"  ★ Network request: {url_str[:180]}")

            def on_response(response):
                url_str = response.url
                ct = response.headers.get('content-type', '')
                if ('mpegurl' in ct.lower() or
                    'x-mpegurl' in ct.lower() or
                    any(kw in url_str.lower() for kw in [
                        '/api/proxy/playlist', '.m3u8', 'token=ey'
                    ])):
                    found_urls.append({
                        'url': url_str,
                        'type': 'response',
                        'content_type': ct,
                    })
                    log(f"  ★ Network response: {url_str[:180]}")

            page.on("request", on_request)
            page.on("response", on_response)

            # Sayfayı yükle
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            log("  Sayfa yüklendi, stream yüklemesi bekleniyor...")

            # Video oynatıcı yüklenene kadar bekle
            page.wait_for_timeout(10000)

            # Tüm frame'lerde play butonuna tıkla
            for frame in page.frames:
                try:
                    for selector in [
                        'video', '.vjs-big-play-button', '.play-button',
                        'button[aria-label="Play"]', '.jw-icon-playback',
                        '.vjs-poster', '#player', '.player',
                        'div[class*="play"]', 'button[class*="play"]'
                    ]:
                        try:
                            el = frame.query_selector(selector)
                            if el and el.is_visible():
                                el.click(timeout=3000)
                                log(f"  Tıklandı: {selector}")
                                break
                        except Exception:
                            pass
                except Exception:
                    pass

            # Tıklamadan sonra bekle
            page.wait_for_timeout(10000)

            # Frame HTML'lerini de tara
            for frame in page.frames:
                try:
                    html = frame.content()
                    found = search_stream_url(html, frame.url)
                    if found:
                        found_urls.append({'url': found, 'type': 'html_parse'})
                except Exception:
                    pass

            browser.close()

    except Exception as e:
        log(f"[PlaywrightSniff] Hata: {e}")

    # En iyi URL'yi seç
    if found_urls:
        # Öncelik: proxy/playlist > m3u8 > diğer
        for item in found_urls:
            if '/api/proxy/playlist' in item['url']:
                return item['url']
        for item in found_urls:
            if '.m3u8' in item['url']:
                return item['url']
        return found_urls[0]['url']

    return None


# ─────────────────────────────────────────────
# ANA FONKSİYON: Tüm yöntemleri dene
# ─────────────────────────────────────────────
def find_stream_url(channel_slug):
    """
    Tüm yöntemleri sırasıyla dener ve ilk bulunan
    stream URL'sini döndürür.
    """
    methods = [
        ("Requests", try_requests_method),
        ("DeepIframe", try_deep_iframe_method),
        ("TokenConstruct", try_token_construct_method),
        ("PlaywrightSniff", try_playwright_network_sniff),
        ("Playwright", try_playwright_method),
    ]

    for method_name, method_func in methods:
        try:
            result = method_func(channel_slug)
            if result:
                log(f"✓ {method_name} ile bulundu: {result[:150]}")
                return result
            log(f"✗ {method_name} ile bulunamadı")
        except Exception as e:
            log(f"✗ {method_name} hatası: {e}")

    return None


# ─────────────────────────────────────────────
# KANAL LİSTESİ ve M3U OLUŞTURMA
# ─────────────────────────────────────────────
def load_channels():
    """channels.txt'den kanal listesi yükler"""
    channels = []

    if os.path.exists(CHANNELS_FILE):
        with open(CHANNELS_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                parts = line.split('|')
                slug = parts[0].strip()
                name = parts[1].strip() if len(parts) > 1 else slug
                channels.append({'slug': slug, 'name': name})
    else:
        # Varsayılan kanal
        channels = [
            {'slug': 'bein-sports-1-turkey', 'name': 'Bein Sports 1 Turkey'},
        ]

    return channels


def generate_m3u(channels_with_urls):
    """M3U dosyası oluşturur"""
    lines = ['#EXTM3U']
    lines.append(f'# Generated: {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}')
    lines.append('')

    for channel in channels_with_urls:
        if channel.get('url'):
            name = channel['name']
            url = channel['url']
            slug = channel['slug']

            lines.append(
                f'#EXTINF:-1 tvg-id="{slug}" '
                f'tvg-name="{name}" '
                f'group-title="TV247",{name}'
            )
            lines.append(url)
            lines.append('')

    m3u_content = '\n'.join(lines)

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(m3u_content)

    log(f"M3U dosyası yazıldı: {OUTPUT_FILE}")
    log(f"Toplam kanal: {sum(1 for c in channels_with_urls if c.get('url'))}")

    return m3u_content


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 60)
    log("TV247 Stream Finder & M3U Generator")
    log("=" * 60)

    channels = load_channels()
    log(f"Toplam {len(channels)} kanal yüklenecek")

    results = []

    for i, channel in enumerate(channels):
        log(f"\n{'─' * 50}")
        log(f"[{i+1}/{len(channels)}] {channel['name']} ({channel['slug']})")
        log(f"{'─' * 50}")

        stream_url = find_stream_url(channel['slug'])

        results.append({
            'slug': channel['slug'],
            'name': channel['name'],
            'url': stream_url,
        })

        if stream_url:
            log(f"✓ Stream URL: {stream_url[:150]}")
        else:
            log(f"✗ Stream URL bulunamadı!")

        # Rate limiting
        if i < len(channels) - 1:
            time.sleep(2)

    # M3U oluştur
    log(f"\n{'=' * 60}")
    log("M3U dosyası oluşturuluyor...")
    m3u_content = generate_m3u(results)
    print(f"\n{m3u_content}")

    # Sonuç özeti
    found = sum(1 for r in results if r.get('url'))
    total = len(results)
    log(f"\nSonuç: {found}/{total} kanal bulundu")

    if found == 0:
        log("UYARI: Hiçbir kanal bulunamadı!")
        sys.exit(1)

    return 0


if __name__ == "__main__":
    sys.exit(main())
