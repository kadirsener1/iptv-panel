import re
import os
import sys
import json
import time
import base64
import requests
from urllib.parse import urljoin
from datetime import datetime

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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Bilinen kanal ID'leri
CHANNEL_IDS = {
    "bein-sports-1-turkey": "62",
    "bein-sports-2-turkey": "63",
    "bein-sports-3-turkey": "64",
    "bein-sports-4-turkey": "65",
    "atv-turkey": "1000",
}


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


# ─────────────────────────────────────────────
# YÖNTEM 1: Doğrudan Token Oluştur (En Hızlı)
# ─────────────────────────────────────────────
def generate_direct_token(channel_id):
    """
    Token yapısı basit: {"channelId":"62","ts":timestamp}
    Base64 encode et ve URL'yi oluştur
    """
    ts = int(time.time() * 1000)  # Milisaniye cinsinden timestamp
    
    token_data = {
        "channelId": str(channel_id),
        "ts": ts
    }
    
    # JSON'ı base64'e çevir
    token_json = json.dumps(token_data, separators=(',', ':'))
    token_b64 = base64.b64encode(token_json.encode()).decode()
    
    playlist_url = f"https://chat.cfbu247.sbs/api/proxy/playlist?token={token_b64}"
    
    return playlist_url


def try_direct_token_method(channel_slug):
    """
    Kanal ID'si biliniyorsa doğrudan token oluştur
    """
    log(f"[DirectToken] {channel_slug} deneniyor...")
    
    channel_id = CHANNEL_IDS.get(channel_slug)
    
    if not channel_id:
        # Slug'dan ID çıkarmayı dene (örn: "bein-sports-1" -> son sayıyı bul)
        log(f"  Kanal ID bilinmiyor, sayfadan çıkarılacak")
        return None
    
    playlist_url = generate_direct_token(channel_id)
    log(f"  Token oluşturuldu: {playlist_url[:100]}...")
    
    # URL'nin çalışıp çalışmadığını test et
    try:
        session = requests.Session()
        resp = session.get(
            playlist_url,
            timeout=15,
            headers={
                **HEADERS,
                "Referer": "https://tv247.us/",
                "Origin": "https://chat.cfbu247.sbs",
            }
        )
        
        if resp.status_code == 200:
            content = resp.text[:500]
            if '#EXTM3U' in content or '#EXTINF' in content or 'BANDWIDTH' in content:
                log(f"  ✓ Playlist doğrulandı!")
                return playlist_url
            elif resp.headers.get('content-type', '').startswith(('video/', 'application/')):
                log(f"  ✓ Video stream doğrulandı!")
                return playlist_url
            else:
                log(f"  Yanıt alındı ama playlist değil: {content[:100]}")
                # Yine de çalışıyor olabilir
                return playlist_url
        else:
            log(f"  ✗ HTTP {resp.status_code}")
    except Exception as e:
        log(f"  ✗ Test hatası: {e}")
    
    return playlist_url  # Test başarısız olsa bile URL'yi döndür


# ─────────────────────────────────────────────
# YÖNTEM 2: Sayfadan Channel ID Bul
# ─────────────────────────────────────────────
def try_find_channel_id(channel_slug):
    """
    Sayfa HTML'inden veya iframe'lerden channel ID'yi bul
    """
    log(f"[FindChannelID] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    session = requests.Session()
    session.headers.update(HEADERS)
    
    try:
        resp = session.get(url, timeout=30)
        html = resp.text
        
        # Channel ID pattern'leri
        patterns = [
            r'channelId["\']?\s*[:=]\s*["\']?(\d+)',
            r'channel_id["\']?\s*[:=]\s*["\']?(\d+)',
            r'id=(\d+)',
            r'/premium(\d+)/',
            r'"id"\s*:\s*"?(\d+)"?',
        ]
        
        for pattern in patterns:
            matches = re.findall(pattern, html, re.IGNORECASE)
            if matches:
                channel_id = matches[0]
                log(f"  Channel ID bulundu: {channel_id}")
                
                # Token oluştur
                playlist_url = generate_direct_token(channel_id)
                return playlist_url
        
        # iframe'lere bak
        iframe_matches = re.findall(
            r'<iframe[^>]+src=["\']([^"\']+)["\']',
            html, re.IGNORECASE
        )
        
        for iframe_src in iframe_matches:
            iframe_url = urljoin(url, iframe_src)
            log(f"  iframe: {iframe_url[:100]}")
            
            # iframe URL'sinden ID çıkar
            id_match = re.search(r'[?&]id=(\d+)', iframe_url)
            if id_match:
                channel_id = id_match.group(1)
                log(f"  iframe'den Channel ID: {channel_id}")
                return generate_direct_token(channel_id)
            
            # iframe içeriğini çek
            try:
                resp2 = session.get(
                    iframe_url, 
                    timeout=30,
                    headers={**HEADERS, "Referer": url}
                )
                
                for pattern in patterns:
                    matches = re.findall(pattern, resp2.text, re.IGNORECASE)
                    if matches:
                        channel_id = matches[0]
                        log(f"  iframe içinden Channel ID: {channel_id}")
                        return generate_direct_token(channel_id)
                
                # Token URL'si var mı?
                token_match = re.search(
                    r'(https?://[^\s"\']+/api/proxy/playlist\?token=[A-Za-z0-9+/=_-]+)',
                    resp2.text
                )
                if token_match:
                    log(f"  Doğrudan token URL bulundu!")
                    return token_match.group(1)
                    
            except Exception as e:
                log(f"  iframe fetch hatası: {e}")
                
    except Exception as e:
        log(f"  Hata: {e}")
    
    return None


# ─────────────────────────────────────────────
# YÖNTEM 3: Playwright ile Network Dinle
# ─────────────────────────────────────────────
def try_playwright_method(channel_slug):
    """
    Playwright ile sayfayı aç ve network isteklerinden
    playlist URL'sini yakala
    """
    if not HAS_PLAYWRIGHT:
        log("[Playwright] Playwright yüklü değil")
        return None
    
    log(f"[Playwright] {channel_slug} deneniyor...")
    url = f"{BASE_URL}{channel_slug}/"
    found_urls = []
    found_channel_ids = []
    
    def handle_request(request):
        req_url = request.url
        
        # Playlist URL'si mi?
        if '/api/proxy/playlist' in req_url or 'token=' in req_url:
            found_urls.append(req_url)
            log(f"  ★ Playlist URL yakalandı: {req_url[:150]}")
        
        # Channel ID içeriyor mu?
        id_match = re.search(r'[?&]id=(\d+)', req_url)
        if id_match:
            found_channel_ids.append(id_match.group(1))
    
    def handle_response(response):
        if '/api/proxy/playlist' in response.url:
            found_urls.append(response.url)
            log(f"  ★ Playlist response: {response.url[:150]}")
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=['--no-sandbox', '--disable-setuid-sandbox']
            )
            context = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=HEADERS["User-Agent"],
                ignore_https_errors=True,
            )
            page = context.new_page()
            
            page.on("request", handle_request)
            page.on("response", handle_response)
            
            log(f"  Sayfa yükleniyor...")
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            
            # Sayfa yüklenmesini bekle
            page.wait_for_timeout(5000)
            
            # Server 1 / Server 2 butonlarını bul ve tıkla
            server_buttons = page.query_selector_all('a[href*="server"], button:has-text("Server"), .server-btn, [data-server]')
            log(f"  {len(server_buttons)} server butonu bulundu")
            
            for i, btn in enumerate(server_buttons[:2]):  # İlk 2 server
                try:
                    btn.click(timeout=5000)
                    log(f"  Server {i+1} tıklandı")
                    page.wait_for_timeout(5000)
                except Exception:
                    pass
            
            # iframe'lere gir
            frames = page.frames
            log(f"  {len(frames)} frame bulundu")
            
            for frame in frames:
                try:
                    # Frame HTML'ini al
                    html = frame.content()
                    
                    # Token URL ara
                    token_match = re.search(
                        r'(https?://[^\s"\']+/api/proxy/playlist\?token=[A-Za-z0-9+/=_-]+)',
                        html
                    )
                    if token_match:
                        found_urls.append(token_match.group(1))
                        log(f"  HTML'den token URL: {token_match.group(1)[:100]}")
                    
                    # Channel ID ara
                    id_matches = re.findall(r'channelId["\']?\s*[:=]\s*["\']?(\d+)', html)
                    found_channel_ids.extend(id_matches)
                    
                    # Play butonuna tıkla
                    for selector in ['video', '.play-button', '.vjs-big-play-button', 'button[aria-label="Play"]']:
                        try:
                            el = frame.query_selector(selector)
                            if el:
                                el.click(timeout=3000)
                                log(f"  Play tıklandı: {selector}")
                                page.wait_for_timeout(3000)
                                break
                        except:
                            pass
                            
                except Exception as e:
                    pass
            
            # Biraz daha bekle
            page.wait_for_timeout(5000)
            
            browser.close()
            
    except Exception as e:
        log(f"  Playwright hatası: {e}")
    
    # Sonuçları değerlendir
    if found_urls:
        # En iyi URL'yi seç
        for u in found_urls:
            if '/api/proxy/playlist' in u:
                return u
        return found_urls[0]
    
    # Channel ID bulduysa token oluştur
    if found_channel_ids:
        channel_id = found_channel_ids[0]
        log(f"  Channel ID ile token oluşturuluyor: {channel_id}")
        return generate_direct_token(channel_id)
    
    return None


# ─────────────────────────────────────────────
# ANA FONKSİYON
# ─────────────────────────────────────────────
def find_stream_url(channel_slug):
    """
    Tüm yöntemleri dene
    """
    methods = [
        ("DirectToken", try_direct_token_method),
        ("FindChannelID", try_find_channel_id),
        ("Playwright", try_playwright_method),
    ]
    
    for name, func in methods:
        try:
            result = func(channel_slug)
            if result:
                log(f"✓ {name} başarılı!")
                return result
        except Exception as e:
            log(f"✗ {name} hatası: {e}")
    
    return None


# ─────────────────────────────────────────────
# KANAL YÜKLEYİCİ ve M3U OLUŞTURUCU
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
                name = parts[1].strip() if len(parts) > 1 else slug.replace('-', ' ').title()
                channels.append({'slug': slug, 'name': name})
    else:
        # Varsayılan
        channels = [
            {'slug': 'bein-sports-1-turkey', 'name': 'Bein Sports 1 Turkey'},
        ]
    
    return channels


def generate_m3u(channels_with_urls):
    """M3U dosyası oluşturur"""
    lines = ['#EXTM3U']
    lines.append(f'# Generated: {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}')
    lines.append(f'# Source: tv247.us')
    lines.append('')
    
    for ch in channels_with_urls:
        if ch.get('url'):
            lines.append(
                f'#EXTINF:-1 tvg-id="{ch["slug"]}" '
                f'tvg-name="{ch["name"]}" '
                f'group-title="Sports",{ch["name"]}'
            )
            lines.append(ch['url'])
            lines.append('')
    
    content = '\n'.join(lines)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(content)
    
    log(f"M3U yazıldı: {OUTPUT_FILE}")
    return content


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 50)
    log("TV247 Stream Finder")
    log("=" * 50)
    
    channels = load_channels()
    log(f"{len(channels)} kanal yüklenecek")
    
    results = []
    
    for i, ch in enumerate(channels):
        log(f"\n[{i+1}/{len(channels)}] {ch['name']}")
        log("-" * 40)
        
        stream_url = find_stream_url(ch['slug'])
        
        results.append({
            'slug': ch['slug'],
            'name': ch['name'],
            'url': stream_url
        })
        
        if stream_url:
            log(f"✓ URL: {stream_url[:100]}...")
        else:
            log(f"✗ URL bulunamadı")
        
        # Rate limit
        if i < len(channels) - 1:
            time.sleep(1)
    
    # M3U oluştur
    log("\n" + "=" * 50)
    content = generate_m3u(results)
    print(f"\n{content}")
    
    # Özet
    found = sum(1 for r in results if r.get('url'))
    log(f"\nSonuç: {found}/{len(results)} kanal bulundu")
    
    return 0 if found > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
