const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

// Express Ayarları
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Klasör ve Dosya Yolları
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

// Proje başladığında 'data' klasörünü ve boş JSON dosyalarını otomatik oluşturur
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(CHANNELS_FILE)) {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify([], null, 2));
}

// Yardımcı Fonksiyonlar (JSON Okuma/Yazma)
const readData = (filePath) => {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return [];
    }
};

const writeData = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// ==========================================
// 🔐 KIMLIK DOĞRULAMA (AUTH) API
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);

    // Statik Admin Kontrolü
    if (username === 'admin' && password === 'admin123') {
        return res.json({ success: true, role: 'admin', username: 'admin', token: 'admin-master-token' });
    }

    // Kullanıcı Kontrolü (Yoksa otomatik üye kaydı yapar)
    let user = users.find(u => u.username === username);
    if (!user) {
        user = { 
            username, 
            password, 
            allowedCategories: [], 
            token: Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
        };
        users.push(user);
        writeData(USERS_FILE, users);
    } else if (user.password !== password) {
        return res.status(401).json({ success: false, message: 'Hatalı şifre girdiniz!' });
    }

    res.json({ success: true, role: 'user', username: user.username, token: user.token });
});

// ==========================================
// 👑 ADMIN: KANAL YÖNETİMİ API
// ==========================================
app.get('/api/admin/channels', (req, res) => {
    res.json(readData(CHANNELS_FILE));
});

app.post('/api/admin/channels', (req, res) => {
    const channels = readData(CHANNELS_FILE);
    const newChannel = { id: Date.now().toString(), ...req.body }; // name, category, url
    channels.push(newChannel);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, channel: newChannel });
});

app.delete('/api/admin/channels/:id', (req, res) => {
    let channels = readData(CHANNELS_FILE);
    channels = channels.filter(c => c.id !== req.params.id);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true });
});

// 📥 ADMIN: M3U TOPLU IMPORT API
app.post('/api/admin/import-m3u', (req, res) => {
    const { m3uContent } = req.body;
    if (!m3uContent) return res.status(400).json({ success: false, message: 'İçerik boş olamaz!' });

    const lines = m3uContent.split('\n');
    const channels = readData(CHANNELS_FILE);
    let currentInfo = null;
    let importedCount = 0;

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            const nameMatch = line.match(/,(.+)$/);
            const groupMatch = line.match(/group-title="([^"]+)"/);
            
            currentInfo = {
                name: nameMatch ? nameMatch[1].trim() : 'Bilinmeyen Kanal',
                category: groupMatch ? groupMatch[1].trim() : 'Genel'
            };
        } else if (line.startsWith('http') && currentInfo) {
            channels.push({
                id: Math.random().toString(36).substring(2, 9) + Date.now(),
                name: currentInfo.name,
                category: currentInfo.category,
                url: line
            });
            importedCount++;
            currentInfo = null;
        }
    });

    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, count: importedCount });
});

// ==========================================
// 👤 KULLANICI (USER) API
// ==========================================
app.get('/api/user/info', (req, res) => {
    const { token } = req.query;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);
    
    if (!user) return res.status(444).json({ success: false, message: 'Yetkisiz Erişim' });
    
    res.json({ 
        allowedCategories: user.allowedCategories || [], 
        playlistUrl: `http://localhost:${PORT}/get-playlist/${user.token}.m3u` 
    });
});

app.post('/api/user/save-categories', (req, res) => {
    const { token, categories } = req.body;
    const users = readData(USERS_FILE);
    const userIndex = users.findIndex(u => u.token === token);

    if (userIndex === -1) return res.status(444).json({ success: false, message: 'Kullanıcı bulunamadı' });

    users[userIndex].allowedCategories = categories;
    writeData(USERS_FILE, users);
    res.json({ success: true });
});

// ==========================================
// 📺 CANLI M3U ÇIKTI DOSYASI (IPTV PLAYER'LAR İÇİN)
// ==========================================
app.get('/get-playlist/:token.m3u', (req, res) => {
    const { token } = req.params;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);

    if (!user) {
        res.setHeader('Content-Type', 'audio/x-mpegurl');
        return res.send('#EXTM3U\n# KULLANICI BULUNAMADI VEYA LINK GECERSIZ!');
    }

    const channels = readData(CHANNELS_FILE);
    let m3uResponse = '#EXTM3U\n';

    channels.forEach(channel => {
        if (user.allowedCategories && user.allowedCategories.includes(channel.category)) {
            m3uResponse += `#EXTINF:-1 group-title="${channel.category}",${channel.name}\n${channel.url}\n`;
        }
    });

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(m3uResponse);
});

// Sunucuyu Başlat
app.listen(PORT, () => {
    console.log(`\n🚀 IPTV Sunucusu Başarıyla Başlatıldı!`);
    console.log(`👉 Giriş Paneli: http://localhost:${PORT}/login.html\n`);
});
