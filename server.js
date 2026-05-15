const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Render.com Kalıcı Disk (Volume) kontrolü
const DATA_DIR = process.env.DISK_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

// İlk kurulumda boş JSON dosyalarını oluşturma
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(CHANNELS_FILE)) fs.writeFileSync(CHANNELS_FILE, JSON.stringify([]));

// Helper fonksiyonlar
const readData = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'iptv-gizli-anahtar-123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 Gün
}));

// --- AUTH MIDDLEWARES ---
const authRequired = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Yetkisiz erişim' });
    next();
};

const adminRequired = (req, res, next) => {
    if (!req.session.user || !req.session.user.isAdmin) return res.status(403).json({ error: 'Admin yetkisi gerekli' });
    next();
};

// --- API ROTALARI ---

// Kayıt Olma (Normal Üye)
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);
    
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: uuidv4(),
        username,
        password: hashedPassword,
        isAdmin: users.length === 0, // İlk kayıt olanı otomatik Admin yapar
        allowedCategories: [],
        token: uuidv4().substring(0, 8) // Kullanıcının M3U link belirteci
    };
    
    users.push(newUser);
    writeData(USERS_FILE, users);
    res.json({ success: true, message: 'Kayıt başarılı.' });
});

// Giriş Yapma
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.username === username);
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Hatalı kullanıcı adı veya şifre.' });
    }
    
    req.session.user = { id: user.id, username: user.username, isAdmin: user.isAdmin, token: user.token };
    res.json({ success: true, isAdmin: user.isAdmin });
});

// Çıkış
app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Kullanıcı Bilgisi Getir
app.get('/api/me', authRequired, (req, res) => {
    res.json(req.session.user);
});

// --- ADMIN KANAL YÖNETİMİ ---

// Kanalları Listele
app.get('/api/admin/channels', adminRequired, (req, res) => {
    res.json(readData(CHANNELS_FILE));
});

// Tekil Kanal Ekle
app.post('/api/admin/channels', adminRequired, (req, res) => {
    const { name, url, category } = req.body;
    const channels = readData(CHANNELS_FILE);
    const newChannel = { id: uuidv4(), name, url, category: category || 'Genel' };
    channels.push(newChannel);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, channel: newChannel });
});

// Kanal Sil
delete app.delete('/api/admin/channels/:id', adminRequired, (req, res) => {
    let channels = readData(CHANNELS_FILE);
    channels = channels.filter(c => c.id !== req.params.id);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true });
});

// M3U Import Etme
app.post('/api/admin/import-m3u', adminRequired, (req, res) => {
    const { m3uContent } = req.body;
    if (!m3uContent) return res.status(400).json({ error: 'İçerik boş olamaz.' });

    const channels = readData(CHANNELS_FILE);
    const lines = m3uContent.split('\n');
    let currentChannel = {};

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            // Kategori bulma (group-title="...")
            const groupMatch = line.match(/group-title="([^"]+)"/);
            currentChannel.category = groupMatch ? groupMatch[1] : 'M3U Import';
            
            // Kanal ismi bulma (Virgülden sonrası)
            const nameParts = line.split(',');
            currentChannel.name = nameParts[nameParts.length - 1].trim();
        } else if (line.startsWith('http')) {
            currentChannel.url = line;
            currentChannel.id = uuidv4();
            if (currentChannel.name && currentChannel.url) {
                channels.push({ ...currentChannel });
            }
            currentChannel = {};
        }
    });

    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, count: channels.length });
});

// --- KULLANICI ALANI ---

// Mevcut Tüm Kategorileri Çek (Kullanıcının seçebilmesi için)
app.get('/api/user/categories', authRequired, (req, res) => {
    const channels = readData(CHANNELS_FILE);
    const categories = [...new Set(channels.map(c => c.category))];
    res.json(categories);
});

// Kullanıcının Tercih Ettiği Kategorileri Güncelle ve Kaydet
app.post('/api/user/my-categories', authRequired, (req, res) => {
    const { categories } = req.body;
    const users = readData(USERS_FILE);
    const userIndex = users.findIndex(u => u.id === req.session.user.id);
    
    if (userIndex !== -1) {
        users[userIndex].allowedCategories = categories;
        writeData(USERS_FILE, users);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }
});

// Kullanıcının Seçtiği Kategorileri Getir
app.get('/api/user/my-categories', authRequired, (req, res) => {
    const users = readData(USERS_FILE);
    const user = users.find(u => u.id === req.session.user.id);
    res.json(user ? user.allowedCategories : []);
});


// --- CANLI M3U ÇIKTI DOSYASI (IPTV Oynatıcılar İçin Açık Link) ---
app.get('/get-m3u/:token', (req, res) => {
    const { token } = req.params;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);
    
    if (!user) return res.status(404).send('Geçersiz Token veya Üyelik.');

    const channels = readData(CHANNELS_FILE);
    // Eğer kullanıcı hiç kategori seçmediyse boş liste döner veya hepsini dönebilirsiniz. 
    // Burada sadece seçtiği kategorideki kanalları filtreliyoruz.
    const userChannels = channels.filter(c => user.allowedCategories.includes(c.category));

    let m3uResponse = '#EXTM3U\n';
    userChannels.forEach(c => {
        m3uResponse += `#EXTINF:-1 group-title="${c.category}",${c.name}\n${c.url}\n`;
    });

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
    res.send(m3uResponse);
});

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda aktif.`));
