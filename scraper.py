import re
import os
import sys
import json
import time
import base64
import requests
from urllib.parse import urljoin
from datetime import datetime

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
    "Referer": "https://tv247.us/",
}

# Bilinen kanal ID'leri (yeni kanallar otomatik eklenir)
CHANNEL_IDS = {
    "bein-sports-1-turkey": "62",
    "bein-sports-2-turkey": "63",
    "bein-sports-3-turkey": "64",
    "bein-sports-5-turkey": "1010",
    "atv-turkey": "1000", 
}


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


# ─────────────────────────────────────────────
# TOKEN OLUŞTUR
# ─────────────────────────────────────────────
def generate_playlist_url(channel_id):
    """Channel ID'den playlist URL'si oluştur"""
    ts = int(time.time() * 1000)
    
    token_data = {
        "channelId": str(channel_id),
        "ts": ts
    }
    
    token_json = json.dumps(token_data, separators=(',', ':'))
    token_b64 = base64.b64encode(token_json.encode()).decode()
    
    return f"https://chat.cfbu247.sbs/api/proxy/playlist?token={token_b64}"


# ─────────────────────────────────────────────
# KANAL ID BUL (Sayfadan)
# ─────────────────────────────────────────────
def find_channel_id_from_page(channel_slug):
    """
    Sayfa HTML'inden channel ID'yi çıkar
    """
    url = f"{BASE_URL}{channel_slug}/"
    session = requests.Session()
    session.headers.update(HEADERS)
    
    log(f"  Sayfa taranıyor: {url}")
    
    try:
        resp = session.get(url, timeout=30)
        html = resp.text
        
        # 1. Doğrudan sayfada ID ara
        id_patterns = [
            r'data-id=["\'](\d+)["\']',
            r'channel[_-]?id["\']?\s*[:=]\s*["\']?(\d+)',
            r'stream[_-]?id["\']?\s*[:=]\s*["\']?(\d+)',
            r'/embed/(\d+)',
            r'\?id=(\d+)',
            r'&id=(\d+)',
        ]
        
        for pattern in id_patterns:
            matches = re.findall(pattern, html, re.IGNORECASE)
            if matches:
                channel_id = matches[0]
                log(f"  ✓ Sayfada ID bulundu: {channel_id}")
                return channel_id
        
        # 2. iframe src'lerini kontrol et
        iframe_pattern = r'<iframe[^>]+src=["\']([^"\']+)["\']'
        iframes = re.findall(iframe_pattern, html, re.IGNORECASE)
        
        for iframe_src in iframes:
            iframe_url = urljoin(url, iframe_src)
            log(f"  iframe kontrol: {iframe_url[:80]}...")
            
            # iframe URL'sinde ID var mı?
            id_match = re.search(r'[?&]id=(\d+)', iframe_url)
            if id_match:
                channel_id = id_match.group(1)
                log(f"  ✓ iframe URL'de ID bulundu: {channel_id}")
                return channel_id
            
            # iframe içeriğini çek
            try:
                resp2 = session.get(
                    iframe_url,
                    timeout=30,
                    headers={**HEADERS, "Referer": url}
                )
                iframe_html = resp2.text
                
                # iframe içinde ID ara
                for pattern in id_patterns:
                    matches = re.findall(pattern, iframe_html, re.IGNORECASE)
                    if matches:
                        channel_id = matches[0]
                        log(f"  ✓ iframe içinde ID bulundu: {channel_id}")
                        return channel_id
                
                # iframe içinde başka iframe var mı?
                inner_iframes = re.findall(iframe_pattern, iframe_html, re.IGNORECASE)
                for inner_src in inner_iframes:
                    inner_url = urljoin(iframe_url, inner_src)
                    log(f"    iç iframe: {inner_url[:80]}...")
                    
                    id_match = re.search(r'[?&]id=(\d+)', inner_url)
                    if id_match:
                        channel_id = id_match.group(1)
                        log(f"  ✓ iç iframe'de ID bulundu: {channel_id}")
                        return channel_id
                    
                    # İç iframe içeriğini çek
                    try:
                        resp3 = session.get(
                            inner_url,
                            timeout=30,
                            headers={**HEADERS, "Referer": iframe_url}
                        )
                        inner_html = resp3.text
                        
                        for pattern in id_patterns:
                            matches = re.findall(pattern, inner_html, re.IGNORECASE)
                            if matches:
                                channel_id = matches[0]
                                log(f"  ✓ iç iframe içinde ID bulundu: {channel_id}")
                                return channel_id
                        
                        # Token URL var mı?
                        token_match = re.search(
                            r'channelId["\']?\s*[:=]\s*["\']?(\d+)',
                            inner_html,
                            re.IGNORECASE
                        )
                        if token_match:
                            return token_match.group(1)
                            
                    except Exception as e:
                        log(f"    iç iframe hatası: {e}")
                        
            except Exception as e:
                log(f"  iframe hatası: {e}")
        
        # 3. Script tag'larında ara
        script_pattern = r'<script[^>]*>(.*?)</script>'
        scripts = re.findall(script_pattern, html, re.DOTALL | re.IGNORECASE)
        
        for script in scripts:
            for pattern in id_patterns:
                matches = re.findall(pattern, script, re.IGNORECASE)
                if matches:
                    channel_id = matches[0]
                    log(f"  ✓ Script'te ID bulundu: {channel_id}")
                    return channel_id
                    
    except Exception as e:
        log(f"  Sayfa hatası: {e}")
    
    return None


# ─────────────────────────────────────────────
# DOĞRUDAN TOKEN URL BUL
# ─────────────────────────────────────────────
def find_direct_token_url(channel_slug):
    """
    Sayfada hazır token URL'si ara
    """
    url = f"{BASE_URL}{channel_slug}/"
    session = requests.Session()
    session.headers.update(HEADERS)
    
    try:
        resp = session.get(url, timeout=30)
        html = resp.text
        
        # Hazır playlist URL'si var mı?
        token_pattern = r'(https?://[^\s"\'<>]+/api/proxy/playlist\?token=[A-Za-z0-9+/=_-]+)'
        
        # Ana sayfada ara
        matches = re.findall(token_pattern, html)
        if matches:
            log(f"  ✓ Doğrudan token URL bulundu!")
            return matches[0]
        
        # iframe'lerde ara
        iframe_pattern = r'<iframe[^>]+src=["\']([^"\']+)["\']'
        iframes = re.findall(iframe_pattern, html, re.IGNORECASE)
        
        for iframe_src in iframes:
            iframe_url = urljoin(url, iframe_src)
            
            try:
                resp2 = session.get(
                    iframe_url,
                    timeout=30,
                    headers={**HEADERS, "Referer": url}
                )
                
                matches = re.findall(token_pattern, resp2.text)
                if matches:
                    log(f"  ✓ iframe'de token URL bulundu!")
                    return matches[0]
                
                # Daha derin iframe
                inner_iframes = re.findall(iframe_pattern, resp2.text, re.IGNORECASE)
                for inner_src in inner_iframes:
                    inner_url = urljoin(iframe_url, inner_src)
                    
                    try:
                        resp3 = session.get(
                            inner_url,
                            timeout=30,
                            headers={**HEADERS, "Referer": iframe_url}
                        )
                        
                        matches = re.findall(token_pattern, resp3.text)
                        if matches:
                            log(f"  ✓ iç iframe'de token URL bulundu!")
                            return matches[0]
                            
                    except:
                        pass
                        
            except:
                pass
                
    except Exception as e:
        log(f"  Hata: {e}")
    
    return None


# ─────────────────────────────────────────────
# ANA STREAM BULMA FONKSİYONU
# ─────────────────────────────────────────────
def find_stream_url(channel_slug):
    """
    Kanal için stream URL'si bul
    """
    log(f"Kanal: {channel_slug}")
    
    # 1. Bilinen ID varsa doğrudan kullan
    if channel_slug in CHANNEL_IDS and CHANNEL_IDS[channel_slug]:
        channel_id = CHANNEL_IDS[channel_slug]
        log(f"  Bilinen ID: {channel_id}")
        return generate_playlist_url(channel_id)
    
    # 2. Doğrudan token URL ara
    log(f"  [1/3] Doğrudan token URL aranıyor...")
    direct_url = find_direct_token_url(channel_slug)
    if direct_url:
        return direct_url
    
    # 3. Sayfadan ID bul
    log(f"  [2/3] Sayfadan ID çıkarılıyor...")
    channel_id = find_channel_id_from_page(channel_slug)
    if channel_id:
        # Bulunan ID'yi kaydet
        CHANNEL_IDS[channel_slug] = channel_id
        return generate_playlist_url(channel_id)
    
    # 4. Slug'dan tahmin et (son çare)
    log(f"  [3/3] ID tahmin ediliyor...")
    
    # Bazı bilinen pattern'ler
    slug_guesses = {
        "atv": ["1", "101", "201"],
        "star-tv": ["2", "102", "202"],
        "show-tv": ["3", "103", "203"],
        "kanal-d": ["4", "104", "204"],
        "fox-tv": ["5", "105", "205"],
        "tv8": ["6", "106", "206"],
        "trt-1": ["10", "110", "210"],
    }
    
    for key, ids in slug_guesses.items():
        if key in channel_slug:
            for test_id in ids:
                log(f"    ID {test_id} deneniyor...")
                test_url = generate_playlist_url(test_id)
                
                # Test et
                try:
                    resp = requests.get(
                        test_url,
                        timeout=10,
                        headers=HEADERS
                    )
                    if resp.status_code == 200 and len(resp.content) > 100:
                        log(f"  ✓ Çalışan ID bulundu: {test_id}")
                        CHANNEL_IDS[channel_slug] = test_id
                        return test_url
                except:
                    pass
    
    log(f"  ✗ ID bulunamadı!")
    return None


# ─────────────────────────────────────────────
# KANAL LİSTESİ
# ─────────────────────────────────────────────
def load_channels():
    """channels.txt'den kanal listesi yükle"""
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
        channels = [
            {'slug': 'bein-sports-1-turkey', 'name': 'beIN Sports 1'},
        ]
    
    return channels


def generate_m3u(results):
    """M3U dosyası oluştur"""
    lines = ['#EXTM3U']
    lines.append(f'# Updated: {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}')
    lines.append('')
    
    for ch in results:
        if ch.get('url'):
            lines.append(
                f'#EXTINF:-1 tvg-id="{ch["slug"]}" '
                f'tvg-name="{ch["name"]}" '
                f'group-title="TV247",{ch["name"]}'
            )
            lines.append(ch['url'])
            lines.append('')
    
    content = '\n'.join(lines)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(content)
    
    log(f"\n✓ {OUTPUT_FILE} oluşturuldu")
    return content


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 50)
    log("TV247 M3U Generator")
    log("=" * 50)
    
    channels = load_channels()
    log(f"\n{len(channels)} kanal işlenecek\n")
    
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
            log(f"✓ {stream_url[:80]}...")
        else:
            log(f"✗ Bulunamadı")
        
        time.sleep(1)
    
    # M3U oluştur
    log("\n" + "=" * 50)
    content = generate_m3u(results)
    print(f"\n{content}")
    
    # Özet
    found = sum(1 for r in results if r.get('url'))
    log(f"\nSONUÇ: {found}/{len(results)} kanal bulundu")
    
    # Bulunan ID'leri göster
    log("\nBulunan Kanal ID'leri:")
    for slug, cid in CHANNEL_IDS.items():
        if cid:
            log(f"  {slug}: {cid}")
    
    return 0 if found > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
