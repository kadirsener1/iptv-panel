const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const CHANNELS_FILE = path.join(__dirname, 'data', 'channels.json');

// Yardımcı Fonksiyonlar (JSON Okuma/Yazma)
const readData = (filePath) => {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const writeData = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// --- AUTH API ---
app.post('/api/login', (req, requireRes) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);

    // Statik Admin Kontrolü
    if (username === 'admin' && password === 'admin123') {
        return requireRes.json({ success: true, role: 'admin', username: 'admin' });
    }

    // Kullanıcı Kontrolü (Yoksa otomatik kaydeder - Kolaylık olsun diye)
    let user = users.find(u => u.username === username);
    if (!user) {
        user = { username, password, allowedCategories: [], token: Math.random().toString(36).substring(2, 15) };
        users.push(user);
        writeData(USERS_FILE, users);
    } else if (user.password !== password) {
        return requireRes.status(401).json({ success: false, message: 'Hatalı şifre!' });
    }

    requireRes.json({ success: true, role: 'user', username: user.username, token: user.token });
});

// --- ADMIN: KANAL YÖNETİMİ API ---
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

app.put('/api/admin/channels/:id', (req, res) => {
    let channels = readData(CHANNELS_FILE);
    channels = channels.map(c => c.id === req.params.id ? { ...c, ...req.body } : c);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true });
});

app.delete('/api/admin/channels/:id', (req, res) => {
    let channels = readData(CHANNELS_FILE);
    channels = channels.filter(c => c.id !== req.params.id);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true });
});

// --- ADMIN: M3U IMPORT API ---
app.post('/api/admin/import-m3u', (req, res) => {
    const { m3uContent } = req.body;
    if (!m3uContent) return res.status(400).json({ success: false, message: 'İçerik boş' });

    const lines = m3uContent.split('\n');
    const channels = readData(CHANNELS_FILE);
    let currentInfo = null;

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            // Örnek: #EXTINF:-1 tvg-name="Kanal D" group-title="Ulusal",Kanal D
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
            currentInfo = null;
        }
    });

    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, count: channels.length });
});

// --- USER: KATEGORİ SEÇİMİ API ---
app.post('/api/user/save-categories', (req, res) => {
    const { token, categories } = req.body;
    const users = readData(USERS_FILE);
    const userIndex = users.findIndex(u => u.token === token);

    if (userIndex === -1) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı' });

    users[userIndex].allowedCategories = categories;
    writeData(USERS_FILE, users);
    res.json({ success: true });
});

app.get('/api/user/info', (req, res) => {
    const { token } = req.query;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);
    if (!user) return res.status(404).json({ success: false });
    res.json({ allowedCategories: user.allowedCategories, playlistUrl: `http://localhost:${PORT}/get-playlist/${user.token}.m3u` });
});

// --- CANLI M3U ÇIKTI LİNKİ (IPTV Oynatıcılar İçin) ---
app.get('/get-playlist/:token.m3u', (req, res) => {
    const { token } = req.params;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);

    if (!user) return res.status(404).send('#EXTM3U\n# Hatalı veya geçersiz link!');

    const channels = readData(CHANNELS_FILE);
    let m3uResponse = '#EXTM3U\n';

    channels.forEach(channel => {
        // Eğer kullanıcı bu kanala ait kategoriyi seçtiyse linke ekle
        if (user.allowedCategories.includes(channel.category)) {
            m3uResponse += `#EXTINF:-1 group-title="${channel.category}",${channel.name}\n${channel.url}\n`;
        }
    });

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(m3uResponse);
});

app.listen(PORT, () => console.log(`Sunucu http://localhost:${PORT} üzerinde çalışıyor.`));
