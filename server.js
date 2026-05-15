require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Multer config for M3U upload
const upload = multer({ 
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(m3u|m3u8|txt)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Sadece M3U/M3U8/TXT dosyaları yüklenebilir!'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ==================== DATABASE ====================
const DB_PATH = path.join(__dirname, 'data', 'database.json');

function ensureDataDir() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const initialData = {
      channels: [],
      categories: [
        "Genel", "Spor", "Haber", "Sinema", "Dizi", 
        "Müzik", "Çocuk", "Belgesel", "Eğlence", "Ulusal"
      ],
      users: [],
      playlists: [],
      settings: {
        siteName: "IPTV Panel",
        maxChannelsPerPlaylist: 500
      }
    };
    // Admin kullanıcısını oluştur
    const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    initialData.users.push({
      id: uuidv4(),
      username: process.env.ADMIN_USERNAME || 'admin',
      email: 'admin@iptv.com',
      password: adminHash,
      role: 'admin',
      createdAt: new Date().toISOString(),
      isActive: true
    });
    fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
  }
}

function readDB() {
  ensureDataDir();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const token = req.cookies.token || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Geçersiz veya süresi dolmuş token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin yetkisi gerekiyor' });
  }
  next();
}

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'user-dashboard.html'));
});

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
  if (!user.isActive) return res.status(403).json({ error: 'Hesabınız devre dışı' });
  
  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Şifre hatalı' });
  
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.cookie('token', token, { httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ 
    success: true, 
    token, 
    user: { id: user.id, username: user.username, role: user.role, email: user.email }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  }
  if (username.length < 3) return res.status(400).json({ error: 'Kullanıcı adı en az 3 karakter olmalı' });
  if (password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  
  const db = readDB();
  
  if (db.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış' });
  }
  if (db.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
  }
  
  const hash = bcrypt.hashSync(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    email,
    password: hash,
    role: 'user',
    createdAt: new Date().toISOString(),
    isActive: true
  };
  
  db.users.push(newUser);
  writeDB(db);
  
  res.json({ success: true, message: 'Kayıt başarılı! Giriş yapabilirsiniz.' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ==================== ADMIN: CHANNEL ROUTES ====================
app.get('/api/channels', authenticateToken, (req, res) => {
  const db = readDB();
  const { search, category, page = 1, limit = 50 } = req.query;
  
  let channels = [...db.channels];
  
  if (search) {
    const s = search.toLowerCase();
    channels = channels.filter(c => 
      c.name.toLowerCase().includes(s) || 
      (c.group && c.group.toLowerCase().includes(s))
    );
  }
  if (category && category !== 'all') {
    channels = channels.filter(c => c.group === category);
  }
  
  const total = channels.length;
  const start = (page - 1) * limit;
  const paged = channels.slice(start, start + parseInt(limit));
  
  res.json({ 
    channels: paged, 
    total, 
    page: parseInt(page), 
    totalPages: Math.ceil(total / limit) 
  });
});

app.post('/api/channels', authenticateToken, requireAdmin, (req, res) => {
  const { name, url, logo, group, epgId } = req.body;
  
  if (!name || !url) {
    return res.status(400).json({ error: 'Kanal adı ve URL zorunlu' });
  }
  
  const db = readDB();
  const channel = {
    id: uuidv4(),
    name: name.trim(),
    url: url.trim(),
    logo: logo?.trim() || '',
    group: group?.trim() || 'Genel',
    epgId: epgId?.trim() || '',
    isActive: true,
    addedBy: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  db.channels.push(channel);
  
  // Kategori yoksa ekle
  if (channel.group && !db.categories.includes(channel.group)) {
    db.categories.push(channel.group);
  }
  
  writeDB(db);
  res.json({ success: true, channel });
});

app.put('/api/channels/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, url, logo, group, epgId, isActive } = req.body;
  
  const db = readDB();
  const idx = db.channels.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Kanal bulunamadı' });
  
  if (name) db.channels[idx].name = name.trim();
  if (url) db.channels[idx].url = url.trim();
  if (logo !== undefined) db.channels[idx].logo = logo.trim();
  if (group) {
    db.channels[idx].group = group.trim();
    if (!db.categories.includes(group.trim())) {
      db.categories.push(group.trim());
    }
  }
  if (epgId !== undefined) db.channels[idx].epgId = epgId.trim();
  if (isActive !== undefined) db.channels[idx].isActive = isActive;
  db.channels[idx].updatedAt = new Date().toISOString();
  
  writeDB(db);
  res.json({ success: true, channel: db.channels[idx] });
});

app.delete('/api/channels/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  
  const idx = db.channels.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Kanal bulunamadı' });
  
  db.channels.splice(idx, 1);
  
  // Playlist'lerden de kaldır
  db.playlists.forEach(p => {
    p.channelIds = p.channelIds.filter(cid => cid !== id);
  });
  
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/channels', authenticateToken, requireAdmin, (req, res) => {
  const { ids } = req.body;
  const db = readDB();
  
  if (ids && ids.length > 0) {
    db.channels = db.channels.filter(c => !ids.includes(c.id));
    db.playlists.forEach(p => {
      p.channelIds = p.channelIds.filter(cid => !ids.includes(cid));
    });
  } else {
    db.channels = [];
    db.playlists.forEach(p => { p.channelIds = []; });
  }
  
  writeDB(db);
  res.json({ success: true, message: `${ids ? ids.length : 'Tüm'} kanal silindi` });
});

// ==================== M3U IMPORT/EXPORT ====================
app.post('/api/channels/import', authenticateToken, requireAdmin, upload.single('m3uFile'), (req, res) => {
  try {
    let m3uContent = '';
    
    if (req.file) {
      m3uContent = fs.readFileSync(req.file.path, 'utf-8');
      fs.unlinkSync(req.file.path); // Temp dosyayı sil
    } else if (req.body.m3uUrl) {
      return res.status(400).json({ error: 'URL import henüz desteklenmiyor, dosya yükleyin' });
    } else if (req.body.m3uContent) {
      m3uContent = req.body.m3uContent;
    } else {
      return res.status(400).json({ error: 'M3U dosyası veya içerik gerekli' });
    }
    
    const channels = parseM3U(m3uContent);
    
    if (channels.length === 0) {
      return res.status(400).json({ error: 'Geçerli kanal bulunamadı' });
    }
    
    const db = readDB();
    let added = 0;
    let skipped = 0;
    
    channels.forEach(ch => {
      // Aynı URL'li kanal var mı kontrol et
      const exists = db.channels.find(c => c.url === ch.url);
      if (exists) {
        skipped++;
        return;
      }
      
      db.channels.push({
        id: uuidv4(),
        name: ch.name,
        url: ch.url,
        logo: ch.logo || '',
        group: ch.group || 'Genel',
        epgId: ch.epgId || '',
        isActive: true,
        addedBy: req.user.username,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      
      if (ch.group && !db.categories.includes(ch.group)) {
        db.categories.push(ch.group);
      }
      added++;
    });
    
    writeDB(db);
    res.json({ 
      success: true, 
      message: `${added} kanal eklendi, ${skipped} kanal atlandı (tekrar)`,
      added,
      skipped,
      total: db.channels.length
    });
  } catch (err) {
    console.error('M3U Import Error:', err);
    res.status(500).json({ error: 'Import sırasında hata: ' + err.message });
  }
});

function parseM3U(content) {
  const channels = [];
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);
  
  let current = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('#EXTINF:')) {
      current = {};
      
      // Kanal adını al
      const nameMatch = line.match(/,(.+)$/);
      current.name = nameMatch ? nameMatch[1].trim() : 'Bilinmeyen Kanal';
      
      // group-title
      const groupMatch = line.match(/group-title="([^"]*)"/);
      current.group = groupMatch ? groupMatch[1].trim() : 'Genel';
      
      // tvg-logo
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      current.logo = logoMatch ? logoMatch[1].trim() : '';
      
      // tvg-id
      const idMatch = line.match(/tvg-id="([^"]*)"/);
      current.epgId = idMatch ? idMatch[1].trim() : '';
      
      // tvg-name
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      if (tvgNameMatch && !current.name) {
        current.name = tvgNameMatch[1].trim();
      }
    } else if (line.startsWith('#')) {
      continue;
    } else if (current && (line.startsWith('http') || line.startsWith('rtsp') || line.startsWith('rtmp') || line.startsWith('mms'))) {
      current.url = line;
      channels.push(current);
      current = null;
    } else if (line.startsWith('http') || line.startsWith('rtsp') || line.startsWith('rtmp')) {
      channels.push({
        name: 'Kanal ' + (channels.length + 1),
        url: line,
        group: 'Genel',
        logo: '',
        epgId: ''
      });
    }
  }
  
  return channels;
}

// ==================== CATEGORIES ====================
app.get('/api/categories', authenticateToken, (req, res) => {
  const db = readDB();
  res.json({ categories: db.categories });
});

app.post('/api/categories', authenticateToken, requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Kategori adı zorunlu' });
  
  const db = readDB();
  if (db.categories.includes(name.trim())) {
    return res.status(400).json({ error: 'Bu kategori zaten var' });
  }
  
  db.categories.push(name.trim());
  writeDB(db);
  res.json({ success: true, categories: db.categories });
});

app.delete('/api/categories/:name', authenticateToken, requireAdmin, (req, res) => {
  const { name } = req.params;
  const db = readDB();
  
  db.categories = db.categories.filter(c => c !== name);
  // Kanalların kategorisini güncelle
  db.channels.forEach(ch => {
    if (ch.group === name) ch.group = 'Genel';
  });
  
  writeDB(db);
  res.json({ success: true, categories: db.categories });
});

// ==================== USER PLAYLIST ROUTES ====================
app.get('/api/playlists', authenticateToken, (req, res) => {
  const db = readDB();
  let playlists;
  
  if (req.user.role === 'admin') {
    playlists = db.playlists;
  } else {
    playlists = db.playlists.filter(p => p.userId === req.user.id);
  }
  
  // Kanal bilgilerini ekle
  playlists = playlists.map(p => ({
    ...p,
    channelCount: p.channelIds.length,
    m3uUrl: `${BASE_URL}/playlist/${p.token}.m3u`
  }));
  
  res.json({ playlists });
});

app.post('/api/playlists', authenticateToken, (req, res) => {
  const { name, channelIds } = req.body;
  
  if (!name) return res.status(400).json({ error: 'Playlist adı zorunlu' });
  
  const db = readDB();
  const token = uuidv4().replace(/-/g, '');
  
  const playlist = {
    id: uuidv4(),
    userId: req.user.id,
    username: req.user.username,
    name: name.trim(),
    channelIds: channelIds || [],
    token,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessed: null,
    accessCount: 0
  };
  
  db.playlists.push(playlist);
  writeDB(db);
  
  res.json({ 
    success: true, 
    playlist: {
      ...playlist,
      m3uUrl: `${BASE_URL}/playlist/${token}.m3u`
    }
  });
});

app.put('/api/playlists/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, channelIds } = req.body;
  
  const db = readDB();
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadı' });
  
  // Sadece kendi playlist'ini düzenleyebilir (admin hariç)
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }
  
  if (name) db.playlists[idx].name = name.trim();
  if (channelIds !== undefined) db.playlists[idx].channelIds = channelIds;
  db.playlists[idx].updatedAt = new Date().toISOString();
  
  writeDB(db);
  res.json({ 
    success: true, 
    playlist: {
      ...db.playlists[idx],
      m3uUrl: `${BASE_URL}/playlist/${db.playlists[idx].token}.m3u`
    }
  });
});

app.delete('/api/playlists/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadı' });
  
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }
  
  db.playlists.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

// Playlist token yenileme
app.post('/api/playlists/:id/regenerate-token', authenticateToken, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadı' });
  
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }
  
  const newToken = uuidv4().replace(/-/g, '');
  db.playlists[idx].token = newToken;
  db.playlists[idx].updatedAt = new Date().toISOString();
  
  writeDB(db);
  res.json({ 
    success: true, 
    m3uUrl: `${BASE_URL}/playlist/${newToken}.m3u` 
  });
});

// ==================== PUBLIC M3U ENDPOINT ====================
app.get('/playlist/:token.m3u', (req, res) => {
  const { token } = req.params;
  const db = readDB();
  
  const playlist = db.playlists.find(p => p.token === token && p.isActive);
  if (!playlist) {
    return res.status(404).send('#EXTM3U\n# Playlist bulunamadı veya devre dışı');
  }
  
  // Erişim sayacı
  const idx = db.playlists.findIndex(p => p.token === token);
  db.playlists[idx].lastAccessed = new Date().toISOString();
  db.playlists[idx].accessCount = (db.playlists[idx].accessCount || 0) + 1;
  writeDB(db);
  
  // M3U oluştur
  const activeChannels = db.channels.filter(c => 
    playlist.channelIds.includes(c.id) && c.isActive
  );
  
  let m3u = '#EXTM3U\n';
  activeChannels.forEach(ch => {
    let extinf = `#EXTINF:-1`;
    if (ch.epgId) extinf += ` tvg-id="${ch.epgId}"`;
    if (ch.name) extinf += ` tvg-name="${ch.name}"`;
    if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
    if (ch.group) extinf += ` group-title="${ch.group}"`;
    extinf += `,${ch.name}`;
    
    m3u += extinf + '\n';
    m3u += ch.url + '\n';
  });
  
  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${playlist.name}.m3u"`);
  res.send(m3u);
});

// ==================== ADMIN: USER MANAGEMENT ====================
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  const users = db.users.map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    playlistCount: db.playlists.filter(p => p.userId === u.id).length
  }));
  res.json({ users });
});

app.put('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { isActive, role } = req.body;
  
  const db = readDB();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  
  if (isActive !== undefined) db.users[idx].isActive = isActive;
  if (role) db.users[idx].role = role;
  
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin kullanıcı silinemez' });
  
  db.users = db.users.filter(u => u.id !== id);
  db.playlists = db.playlists.filter(p => p.userId !== id);
  
  writeDB(db);
  res.json({ success: true });
});

// ==================== ADMIN: STATS ====================
app.get('/api/stats', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  
  const categoryStats = {};
  db.channels.forEach(ch => {
    const g = ch.group || 'Genel';
    categoryStats[g] = (categoryStats[g] || 0) + 1;
  });
  
  res.json({
    totalChannels: db.channels.length,
    activeChannels: db.channels.filter(c => c.isActive).length,
    totalUsers: db.users.filter(u => u.role === 'user').length,
    totalPlaylists: db.playlists.length,
    categories: db.categories.length,
    categoryStats,
    recentPlaylists: db.playlists
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5)
      .map(p => ({ name: p.name, username: p.username, channelCount: p.channelIds.length }))
  });
});

// ==================== EXPORT ALL CHANNELS ====================
app.get('/api/channels/export/m3u', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  
  let m3u = '#EXTM3U\n';
  db.channels.filter(c => c.isActive).forEach(ch => {
    let extinf = `#EXTINF:-1`;
    if (ch.epgId) extinf += ` tvg-id="${ch.epgId}"`;
    if (ch.name) extinf += ` tvg-name="${ch.name}"`;
    if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
    if (ch.group) extinf += ` group-title="${ch.group}"`;
    extinf += `,${ch.name}`;
    m3u += extinf + '\n' + ch.url + '\n';
  });
  
  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', 'attachment; filename="all-channels.m3u"');
  res.send(m3u);
});

// ==================== START SERVER ====================
ensureDataDir();
app.listen(PORT, () => {
  console.log(`🚀 IPTV Panel running on port ${PORT}`);
  console.log(`📺 Admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
});
