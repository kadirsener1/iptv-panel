const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000; // İnternete yüklendiğinde otomatik port alır

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const M3U_URL = "https://raw.githubusercontent.com/kadirsener1/tivim/refs/heads/main/merged.m3u";

// Klasörleri otomatik oluştur
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));

const readUsers = () => {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } 
    catch (e) { return []; }
};
const writeUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));

// ==========================================
// 📡 GİTHUB'DAN CANLI KATEGORİLERİ ÇEKME API
// ==========================================
app.get('/api/categories', async (req, res) => {
    try {
        const response = await fetch(M3U_URL);
        const text = await response.text();
        const lines = text.split('\n');
        const categories = new Set();

        lines.forEach(line => {
            if (line.startsWith('#EXTINF:')) {
                const groupMatch = line.match(/group-title="([^"]+)"/);
                if (groupMatch) categories.add(groupMatch[1].trim());
            }
        });
        res.json([...categories].sort());
    } catch (err) {
        res.status(500).json({ error: "GitHub M3U listesi yüklenemedi." });
    }
});

// ==========================================
// 🔐 GİRİŞ & OTOMATİK ÜYELİK API
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Boş alan bırakmayın." });
    
    const users = readUsers();
    let user = users.find(u => u.username === username.toLowerCase());

    if (!user) {
        // Otomatik Kayıt
        user = { username: username.toLowerCase(), password, allowedCategories: [] };
        users.push(user);
        writeUsers(users);
    } else if (user.password !== password) {
        return res.status(401).json({ success: false, message: "Hatalı şifre!" });
    }

    res.json({ success: true, username: user.username, allowedCategories: user.allowedCategories });
});

// ==========================================
// 🎛️ KATEGORİ KAYDETME API
// ==========================================
app.post('/api/save-categories', (req, res) => {
    const { username, categories } = req.body;
    const users = readUsers();
    const userIndex = users.findIndex(u => u.username === username.toLowerCase());

    if (userIndex === -1) return res.status(444).json({ success: false });

    users[userIndex].allowedCategories = categories;
    writeUsers(users);
    res.json({ success: true });
});

// ==========================================
// 📺 IPTV PROGRAMLARI İÇİN DİNAMİK M3U LİNKİ
// ==========================================
app.get('/playlist/:username.m3u', async (req, res) => {
    const username = req.params.username.toLowerCase();
    const users = readUsers();
    const user = users.find(u => u.username === username);

    res.setHeader('Content-Type', 'audio/x-mpegurl');

    if (!user || user.allowedCategories.length === 0) {
        return res.send('#EXTM3U\n# LİSTE BOŞ VEYA KATEGORİ SEÇİLMEDİ!');
    }

    try {
        const response = await fetch(M3U_URL);
        const text = await response.text();
        const lines = text.split('\n');
        
        let m3uResponse = '#EXTM3U\n';
        let currentInfo = null;

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const nameMatch = line.match(/,(.+)$/);
                const groupMatch = line.match(/group-title="([^"]+)"/);
                currentInfo = {
                    fullLine: line,
                    category: groupMatch ? groupMatch[1].trim() : 'Genel'
                };
            } else if (line.startsWith('http') && currentInfo) {
                // Eğer kullanıcı bu kategoriyi seçtiyse linke ekle
                if (user.allowedCategories.includes(currentInfo.category)) {
                    m3uResponse += `${currentInfo.fullLine}\n${line}\n`;
                }
                currentInfo = null;
            }
        });

        res.send(m3uResponse);
    } catch (err) {
        res.send('#EXTM3U\n# ANA KAYNAK BAĞLANTI HATASI!');
    }
});

app.listen(PORT, () => console.log(`Sunucu port ${PORT} üzerinde aktif.`));
