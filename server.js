const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'iptv-super-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: 'uploads/', fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(m3u|m3u8|txt)$/)) {
        cb(null, true);
    } else {
        cb(new Error('Sadece M3U/M3U8/TXT dosyaları yüklenebilir'));
    }
}});

// Data dizinini oluştur
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// JSON dosya yardımcıları
function readJSON(file) {
    const filepath = path.join(__dirname, 'data', file);
    if (!fs.existsSync(filepath)) {
        fs.writeFileSync(filepath, JSON.stringify([], null, 2));
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch {
        return [];
    }
}

function writeJSON(file, data) {
    const filepath = path.join(__dirname, 'data', file);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// Admin bilgisini başlat
function initAdmin() {
    const filepath = path.join(__dirname, 'data', 'admin.json');
    if (!fs.existsSync(filepath)) {
        const hash = bcrypt.hashSync('admin123', 10);
        fs.writeFileSync(filepath, JSON.stringify({
            username: 'admin',
            password: hash
        }, null, 2));
    }
}
initAdmin();

// ==================== AUTH MIDDLEWARE ====================

function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    res.status(401).json({ error: 'Admin girişi gerekli' });
}

function requireUser(req, res, next) {
    if (req.session && req.session.userId) return next();
    res.status(401).json({ error: 'Giriş yapmanız gerekli' });
}

// ==================== AUTH ROUTES ====================

// Admin giriş
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const admin = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'admin.json'), 'utf8'));
    
    if (username === admin.username && bcrypt.compareSync(password, admin.password)) {
        req.session.isAdmin = true;
        req.session.username = 'admin';
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre' });
    }
});

// Admin şifre değiştir
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const adminPath = path.join(__dirname, 'data', 'admin.json');
    const admin = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
    
    if (!bcrypt.compareSync(currentPassword, admin.password)) {
        return res.status(400).json({ error: 'Mevcut şifre hatalı' });
    }
    
    admin.password = bcrypt.hashSync(newPassword, 10);
    fs.writeFileSync(adminPath, JSON.stringify(admin, null, 2));
    res.json({ success: true, message: 'Şifre değiştirildi' });
});

// Kullanıcı kayıt
app.post('/api/register', (req, res) => {
    const { username, password, email } = req.body;
    
    if (!username || !password || !email) {
        return res.status(400).json({ error: 'Tüm alanları doldurun' });
    }
    
    const users = readJSON('users.json');
    
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Bu kullanıcı adı zaten mevcut' });
    }
    
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı' });
    }
    
    const user = {
        id: uuidv4(),
        username,
        email,
        password: bcrypt.hashSync(password, 10),
        token: uuidv4(),
        createdAt: new Date().toISOString(),
        active: true
    };
    
    users.push(user);
    writeJSON('users.json', users);
    
    res.json({ success: true, message: 'Kayıt başarılı' });
});

// Kullanıcı giriş
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = readJSON('users.json');
    const user = users.find(u => u.username === username);
    
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre' });
    }
    
    if (!user.active) {
        return res.status(403).json({ error: 'Hesabınız devre dışı bırakılmış' });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.userToken = user.token;
    
    res.json({ success: true, username: user.username, token: user.token });
});

// Çıkış
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Oturum kontrolü
app.get('/api/session', (req, res) => {
    if (req.session.isAdmin) {
        return res.json({ loggedIn: true, isAdmin: true, username: 'admin' });
    }
    if (req.session.userId) {
        return res.json({ loggedIn: true, isAdmin: false, username: req.session.username, token: req.session.userToken });
    }
    res.json({ loggedIn: false });
});

// ==================== CHANNEL ROUTES (ADMIN) ====================

// Tüm kanalları getir
app.get('/api/channels', (req, res) => {
    const channels = readJSON('channels.json');
    res.json(channels);
});

// Kategorileri getir
app.get('/api/categories', (req, res) => {
    const channels = readJSON('channels.json');
    const categories = [...new Set(channels.map(c => c.category))].filter(Boolean).sort();
    res.json(categories);
});

// Kanal ekle
app.post('/api/channels', requireAdmin, (req, res) => {
    const { name, url, category, logo, epgId } = req.body;
    
    if (!name || !url) {
        return res.status(400).json({ error: 'Kanal adı ve URL gerekli' });
    }
    
    const channels = readJSON('channels.json');
    const channel = {
        id: uuidv4(),
        name,
        url,
        category: category || 'Genel',
        logo: logo || '',
        epgId: epgId || '',
        addedAt: new Date().toISOString()
    };
    
    channels.push(channel);
    writeJSON('channels.json', channels);
    
    res.json({ success: true, channel });
});

// Kanal güncelle
app.put('/api/channels/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { name, url, category, logo, epgId } = req.body;
    
    const channels = readJSON('channels.json');
    const index = channels.findIndex(c => c.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Kanal bulunamadı' });
    }
    
    channels[index] = {
        ...channels[index],
        name: name || channels[index].name,
        url: url || channels[index].url,
        category: category || channels[index].category,
        logo: logo !== undefined ? logo : channels[index].logo,
        epgId: epgId !== undefined ? epgId : channels[index].epgId,
        updatedAt: new Date().toISOString()
    };
    
    writeJSON('channels.json', channels);
    res.json({ success: true, channel: channels[index] });
});

// Kanal sil
app.delete('/api/channels/:id', requireAdmin, (req, res) => {
    const channels = readJSON('channels.json');
    const filtered = channels.filter(c => c.id !== req.params.id);
    
    if (filtered.length === channels.length) {
        return res.status(404).json({ error: 'Kanal bulunamadı' });
    }
    
    writeJSON('channels.json', filtered);
    res.json({ success: true });
});

// Toplu sil
app.post('/api/channels/bulk-delete', requireAdmin, (req, res) => {
    const { ids } = req.body;
    const channels = readJSON('channels.json');
    const filtered = channels.filter(c => !ids.includes(c.id));
    writeJSON('channels.json', filtered);
    res.json({ success: true, deleted: channels.length - filtered.length });
});

// Kategori toplu güncelle
app.post('/api/channels/bulk-category', requireAdmin, (req, res) => {
    const { ids, category } = req.body;
    const channels = readJSON('channels.json');
    channels.forEach(c => {
        if (ids.includes(c.id)) c.category = category;
    });
    writeJSON('channels.json', channels);
    res.json({ success: true });
});

// ==================== M3U IMPORT (ADMIN) ====================

// M3U dosyasından import
app.post('/api/import/file', requireAdmin, upload.single('m3ufile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya seçilmedi' });
    }
    
    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        const imported = parseM3U(content);
        
        const channels = readJSON('channels.json');
        const newChannels = imported.map(ch => ({
            id: uuidv4(),
            name: ch.name,
            url: ch.url,
            category: ch.category || req.body.defaultCategory || 'İçe Aktarılan',
            logo: ch.logo || '',
            epgId: ch.epgId || '',
            addedAt: new Date().toISOString()
        }));
        
        channels.push(...newChannels);
        writeJSON('channels.json', channels);
        
        // Geçici dosyayı sil
        fs.unlinkSync(req.file.path);
        
        res.json({ success: true, imported: newChannels.length });
    } catch (err) {
        res.status(500).json({ error: 'Dosya işlenirken hata: ' + err.message });
    }
});

// M3U URL'den import
app.post('/api/import/url', requireAdmin, async (req, res) => {
    const { url, defaultCategory } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL gerekli' });
    }
    
    try {
        const response = await fetch(url);
        const content = await response.text();
        const imported = parseM3U(content);
        
        const channels = readJSON('channels.json');
        const newChannels = imported.map(ch => ({
            id: uuidv4(),
            name: ch.name,
            url: ch.url,
            category: ch.category || defaultCategory || 'İçe Aktarılan',
            logo: ch.logo || '',
            epgId: ch.epgId || '',
            addedAt: new Date().toISOString()
        }));
        
        channels.push(...newChannels);
        writeJSON('channels.json', channels);
        
        res.json({ success: true, imported: newChannels.length });
    } catch (err) {
        res.status(500).json({ error: 'URL işlenirken hata: ' + err.message });
    }
});

// M3U metinden import
app.post('/api/import/text', requireAdmin, (req, res) => {
    const { content, defaultCategory } = req.body;
    
    if (!content) {
        return res.status(400).json({ error: 'M3U içeriği gerekli' });
    }
    
    try {
        const imported = parseM3U(content);
        
        const channels = readJSON('channels.json');
        const newChannels = imported.map(ch => ({
            id: uuidv4(),
            name: ch.name,
            url: ch.url,
            category: ch.category || defaultCategory || 'İçe Aktarılan',
            logo: ch.logo || '',
            epgId: ch.epgId || '',
            addedAt: new Date().toISOString()
        }));
        
        channels.push(...newChannels);
        writeJSON('channels.json', channels);
        
        res.json({ success: true, imported: newChannels.length });
    } catch (err) {
        res.status(500).json({ error: 'İçerik işlenirken hata: ' + err.message });
    }
});

// M3U Parser
function parseM3U(content) {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    const channels = [];
    let current = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('#EXTINF:')) {
            current = {};
            
            // Kanal adı
            const nameMatch = line.match(/,(.+)$/);
            current.name = nameMatch ? nameMatch[1].trim() : 'Bilinmeyen Kanal';
            
            // group-title
            const groupMatch = line.match(/group-title="([^"]*)"/i);
            current.category = groupMatch ? groupMatch[1] : '';
            
            // tvg-logo
            const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
            current.logo = logoMatch ? logoMatch[1] : '';
            
            // tvg-id
            const idMatch = line.match(/tvg-id="([^"]*)"/i);
            current.epgId = idMatch ? idMatch[1] : '';
            
        } else if (current && !line.startsWith('#')) {
            current.url = line;
            channels.push(current);
            current = null;
        }
    }
    
    return channels;
}

// ==================== M3U EXPORT / PLAYLIST ====================

// Kullanıcı için M3U oluştur (token ile)
app.get('/api/playlist/:token', (req, res) => {
    const { token } = req.params;
    const categories = req.query.categories ? req.query.categories.split(',') : null;
    
    const users = readJSON('users.json');
    const user = users.find(u => u.token === token && u.active);
    
    if (!user) {
        return res.status(403).send('Geçersiz veya devre dışı token');
    }
    
    const channels = readJSON('channels.json');
    let filtered = channels;
    
    if (categories && categories.length > 0 && categories[0] !== '') {
        filtered = channels.filter(c => categories.includes(c.category));
    }
    
    const m3u = generateM3U(filtered);
    
    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Content-Disposition', 'inline; filename="playlist.m3u"');
    res.send(m3u);
});

// İndirmek için M3U oluştur
app.post('/api/generate-m3u', requireUser, (req, res) => {
    const { categories } = req.body;
    const channels = readJSON('channels.json');
    
    let filtered = channels;
    if (categories && categories.length > 0) {
        filtered = channels.filter(c => categories.includes(c.category));
    }
    
    const m3u = generateM3U(filtered);
    
    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
    res.send(m3u);
});

// Admin tüm kanalları M3U olarak export
app.get('/api/export/m3u', requireAdmin, (req, res) => {
    const channels = readJSON('channels.json');
    const m3u = generateM3U(channels);
    
    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Content-Disposition', 'attachment; filename="all-channels.m3u"');
    res.send(m3u);
});

function generateM3U(channels) {
    let m3u = '#EXTM3U\n';
    
    channels.forEach(ch => {
        let extinf = '#EXTINF:-1';
        if (ch.epgId) extinf += ` tvg-id="${ch.epgId}"`;
        if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
        if (ch.category) extinf += ` group-title="${ch.category}"`;
        extinf += `,${ch.name}`;
        
        m3u += extinf + '\n';
        m3u += ch.url + '\n';
    });
    
    return m3u;
}

// ==================== USER MANAGEMENT (ADMIN) ====================

app.get('/api/users', requireAdmin, (req, res) => {
    const users = readJSON('users.json');
    const safe = users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        token: u.token,
        active: u.active,
        createdAt: u.createdAt
    }));
    res.json(safe);
});

app.put('/api/users/:id/toggle', requireAdmin, (req, res) => {
    const users = readJSON('users.json');
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    
    user.active = !user.active;
    writeJSON('users.json', users);
    res.json({ success: true, active: user.active });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const users = readJSON('users.json');
    const filtered = users.filter(u => u.id !== req.params.id);
    writeJSON('users.json', filtered);
    res.json({ success: true });
});

app.put('/api/users/:id/regenerate-token', requireAdmin, (req, res) => {
    const users = readJSON('users.json');
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    
    user.token = uuidv4();
    writeJSON('users.json', users);
    res.json({ success: true, token: user.token });
});

// ==================== STATS ====================

app.get('/api/stats', requireAdmin, (req, res) => {
    const channels = readJSON('channels.json');
    const users = readJSON('users.json');
    const categories = [...new Set(channels.map(c => c.category))].filter(Boolean);
    
    res.json({
        totalChannels: channels.length,
        totalCategories: categories.length,
        totalUsers: users.length,
        activeUsers: users.filter(u => u.active).length
    });
});

// ==================== PAGE ROUTES ====================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║       IPTV Yönetim Paneli Başlatıldı     ║
║                                          ║
║  🌐 http://localhost:${PORT}               ║
║                                          ║
║  👑 Admin: admin / admin123              ║
║                                          ║
╚══════════════════════════════════════════╝
    `);
});
