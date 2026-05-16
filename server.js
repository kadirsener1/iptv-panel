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
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key-2024';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// CORS & Headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Multer config
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ==================== DATABASE ====================
const DB_PATH = path.join(__dirname, 'data', 'database.json');

function ensureDataDir() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminHash = bcrypt.hashSync(adminPass, 10);

    const initialData = {
      channels: [],
      categories: ["Genel", "Spor", "Haber", "Sinema", "Dizi", "Muzik", "Cocuk", "Belgesel", "Eglence", "Ulusal"],
      users: [{
        id: uuidv4(),
        username: adminUser,
        email: 'admin@iptv.com',
        password: adminHash,
        role: 'admin',
        createdAt: new Date().toISOString(),
        isActive: true
      }],
      playlists: [],
      settings: { siteName: "IPTV Panel", maxChannelsPerPlaylist: 500 }
    };

    fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
    console.log(`Admin olusturuldu: ${adminUser} / ${adminPass}`);
  }
}

function readDB() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (err) {
    console.error('DB okuma hatasi:', err);
    return { channels: [], categories: [], users: [], playlists: [], settings: {} };
  }
}

function writeDB(data) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ==================== AUTH MIDDLEWARE ====================
function getToken(req) {
  // 1. Cookie'den
  if (req.cookies && req.cookies.token) return req.cookies.token;
  // 2. Authorization header'dan
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // 3. Query param'dan
  if (req.query && req.query.token) return req.query.token;
  return null;
}

function authenticateToken(req, res, next) {
  const token = getToken(req);
  console.log('Auth check - Token var mi:', !!token);

  if (!token) {
    return res.status(401).json({ error: 'Giris yapmaniz gerekiyor' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    console.log('Auth basarili:', decoded.username, decoded.role);
    next();
  } catch (err) {
    console.log('Token gecersiz:', err.message);
    return res.status(403).json({ error: 'Gecersiz veya suresi dolmus token' });
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
  console.log('Login istegi:', req.body);
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu' });
  }

  const db = readDB();
  const user = db.users.find(u => u.username === username);

  if (!user) {
    console.log('Kullanici bulunamadi:', username);
    return res.status(401).json({ error: 'Kullanici bulunamadi' });
  }

  if (!user.isActive) {
    return res.status(403).json({ error: 'Hesabiniz devre disi' });
  }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) {
    console.log('Sifre hatali:', username);
    return res.status(401).json({ error: 'Sifre hatali' });
  }

  const tokenPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

  // Cookie ayarla
  res.cookie('token', token, {
    httpOnly: false,
    secure: false,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });

  console.log('Login basarili:', username, user.role);

  res.json({
    success: true,
    token: token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      email: user.email
    }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Tum alanlar zorunlu' });
  }
  if (username.length < 3) return res.status(400).json({ error: 'Kullanici adi en az 3 karakter' });
  if (password.length < 6) return res.status(400).json({ error: 'Sifre en az 6 karakter' });

  const db = readDB();

  if (db.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Bu kullanici adi zaten alinmis' });
  }
  if (db.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Bu email zaten kayitli' });
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

  console.log('Yeni kullanici:', username);
  res.json({ success: true, message: 'Kayit basarili! Giris yapabilirsiniz.' });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ success: true });
});

// ==================== CHANNEL ROUTES ====================
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
  const p = parseInt(page);
  const l = parseInt(limit);
  const start = (p - 1) * l;
  const paged = channels.slice(start, start + l);

  res.json({
    channels: paged,
    total,
    page: p,
    totalPages: Math.ceil(total / l)
  });
});

app.post('/api/channels', authenticateToken, requireAdmin, (req, res) => {
  const { name, url, logo, group, epgId } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Kanal adi ve URL zorunlu' });
  }

  const db = readDB();
  const channel = {
    id: uuidv4(),
    name: name.trim(),
    url: url.trim(),
    logo: (logo || '').trim(),
    group: (group || 'Genel').trim(),
    epgId: (epgId || '').trim(),
    isActive: true,
    addedBy: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.channels.push(channel);

  if (channel.group && !db.categories.includes(channel.group)) {
    db.categories.push(channel.group);
  }

  writeDB(db);
  res.json({ success: true, channel });
});

app.put('/api/channels/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const idx = db.channels.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Kanal bulunamadi' });

  const { name, url, logo, group, epgId, isActive } = req.body;
  if (name !== undefined) db.channels[idx].name = name.trim();
  if (url !== undefined) db.channels[idx].url = url.trim();
  if (logo !== undefined) db.channels[idx].logo = logo.trim();
  if (group !== undefined) {
    db.channels[idx].group = group.trim();
    if (!db.categories.includes(group.trim())) db.categories.push(group.trim());
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
  if (idx === -1) return res.status(404).json({ error: 'Kanal bulunamadi' });

  db.channels.splice(idx, 1);
  db.playlists.forEach(p => {
    p.channelIds = p.channelIds.filter(cid => cid !== id);
  });

  writeDB(db);
  res.json({ success: true });
});

app.post('/api/channels/bulk-delete', authenticateToken, requireAdmin, (req, res) => {
  const { ids } = req.body;
  const db = readDB();

  if (ids && ids.length > 0) {
    db.channels = db.channels.filter(c => !ids.includes(c.id));
    db.playlists.forEach(p => {
      p.channelIds = p.channelIds.filter(cid => !ids.includes(cid));
    });
  }

  writeDB(db);
  res.json({ success: true, message: `${ids ? ids.length : 0} kanal silindi` });
});

// ==================== M3U IMPORT ====================
app.post('/api/channels/import', authenticateToken, requireAdmin, upload.single('m3uFile'), (req, res) => {
  try {
    let m3uContent = '';

    if (req.file) {
      m3uContent = fs.readFileSync(req.file.path, 'utf-8');
      try { fs.unlinkSync(req.file.path); } catch (e) { }
    } else if (req.body.m3uContent) {
      m3uContent = req.body.m3uContent;
    } else {
      return res.status(400).json({ error: 'M3U dosyasi veya icerik gerekli' });
    }

    const channels = parseM3U(m3uContent);

    if (channels.length === 0) {
      return res.status(400).json({ error: 'Gecerli kanal bulunamadi' });
    }

    const db = readDB();
    let added = 0, skipped = 0;

    channels.forEach(ch => {
      const exists = db.channels.find(c => c.url === ch.url);
      if (exists) { skipped++; return; }

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
    console.log(`M3U Import: ${added} eklendi, ${skipped} atlandi`);
    res.json({ success: true, message: `${added} kanal eklendi, ${skipped} atlandi`, added, skipped, total: db.channels.length });
  } catch (err) {
    console.error('Import hatasi:', err);
    res.status(500).json({ error: 'Import hatasi: ' + err.message });
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
      const nameMatch = line.match(/,(.+)$/);
      current.name = nameMatch ? nameMatch[1].trim() : 'Bilinmeyen';
      const groupMatch = line.match(/group-title="([^"]*)"/);
      current.group = groupMatch ? groupMatch[1].trim() : 'Genel';
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      current.logo = logoMatch ? logoMatch[1].trim() : '';
      const idMatch = line.match(/tvg-id="([^"]*)"/);
      current.epgId = idMatch ? idMatch[1].trim() : '';
    } else if (!line.startsWith('#') && (line.startsWith('http') || line.startsWith('rtsp') || line.startsWith('rtmp'))) {
      if (current) {
        current.url = line;
        channels.push(current);
        current = null;
      } else {
        channels.push({ name: 'Kanal ' + (channels.length + 1), url: line, group: 'Genel', logo: '', epgId: '' });
      }
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
  if (!name) return res.status(400).json({ error: 'Kategori adi zorunlu' });

  const db = readDB();
  if (db.categories.includes(name.trim())) {
    return res.status(400).json({ error: 'Bu kategori zaten var' });
  }
  db.categories.push(name.trim());
  writeDB(db);
  res.json({ success: true, categories: db.categories });
});

app.delete('/api/categories/:name', authenticateToken, requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const db = readDB();
  db.categories = db.categories.filter(c => c !== name);
  db.channels.forEach(ch => { if (ch.group === name) ch.group = 'Genel'; });
  writeDB(db);
  res.json({ success: true });
});

// ==================== PLAYLISTS ====================
app.get('/api/playlists', authenticateToken, (req, res) => {
  const db = readDB();
  let playlists = req.user.role === 'admin'
    ? db.playlists
    : db.playlists.filter(p => p.userId === req.user.id);

  playlists = playlists.map(p => ({
    ...p,
    channelCount: p.channelIds ? p.channelIds.length : 0,
    m3uUrl: `${BASE_URL}/playlist/${p.token}.m3u`
  }));

  res.json({ playlists });
});

app.post('/api/playlists', authenticateToken, (req, res) => {
  const { name, channelIds } = req.body;
  if (!name) return res.status(400).json({ error: 'Playlist adi zorunlu' });

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
    playlist: { ...playlist, m3uUrl: `${BASE_URL}/playlist/${token}.m3u` }
  });
});

app.put('/api/playlists/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, channelIds } = req.body;
  const db = readDB();
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadi' });
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }

  if (name) db.playlists[idx].name = name.trim();
  if (channelIds !== undefined) db.playlists[idx].channelIds = channelIds;
  db.playlists[idx].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json({
    success: true,
    playlist: { ...db.playlists[idx], m3uUrl: `${BASE_URL}/playlist/${db.playlists[idx].token}.m3u` }
  });
});

app.delete('/api/playlists/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadi' });
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }

  db.playlists.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/playlists/:id/regenerate-token', authenticateToken, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const idx = db.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist bulunamadi' });
  if (req.user.role !== 'admin' && db.playlists[idx].userId !== req.user.id) {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }

  const newToken = uuidv4().replace(/-/g, '');
  db.playlists[idx].token = newToken;
  db.playlists[idx].updatedAt = new Date().toISOString();
  writeDB(db);

  res.json({ success: true, m3uUrl: `${BASE_URL}/playlist/${newToken}.m3u` });
});

// ==================== PUBLIC M3U ENDPOINT ====================
app.get('/playlist/:token.m3u', (req, res) => {
  const { token } = req.params;
  const db = readDB();

  const playlist = db.playlists.find(p => p.token === token && p.isActive);
  if (!playlist) {
    return res.status(404).type('text/plain').send('#EXTM3U\n# Playlist bulunamadi');
  }

  // Erisim sayaci
  const idx = db.playlists.findIndex(p => p.token === token);
  if (idx !== -1) {
    db.playlists[idx].lastAccessed = new Date().toISOString();
    db.playlists[idx].accessCount = (db.playlists[idx].accessCount || 0) + 1;
    writeDB(db);
  }

  const activeChannels = db.channels.filter(c =>
    playlist.channelIds.includes(c.id) && c.isActive
  );

  let m3u = '#EXTM3U\n';
  activeChannels.forEach(ch => {
    let extinf = '#EXTINF:-1';
    if (ch.epgId) extinf += ` tvg-id="${ch.epgId}"`;
    extinf += ` tvg-name="${ch.name}"`;
    if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
    if (ch.group) extinf += ` group-title="${ch.group}"`;
    extinf += `,${ch.name}`;
    m3u += extinf + '\n' + ch.url + '\n';
  });

  res.setHeader('Content-Type', 'audio/mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${playlist.name}.m3u"`);
  res.send(m3u);
});

// ==================== USERS (ADMIN) ====================
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
  if (idx === -1) return res.status(404).json({ error: 'Kullanici bulunamadi' });

  if (isActive !== undefined) db.users[idx].isActive = isActive;
  if (role) db.users[idx].role = role;
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin silinemez' });

  db.users = db.users.filter(u => u.id !== id);
  db.playlists = db.playlists.filter(p => p.userId !== id);
  writeDB(db);
  res.json({ success: true });
});

// ==================== STATS ====================
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
    categoryStats
  });
});

// ==================== EXPORT ====================
app.get('/api/channels/export/m3u', authenticateToken, requireAdmin, (req, res) => {
  const db = readDB();
  let m3u = '#EXTM3U\n';
  db.channels.filter(c => c.isActive).forEach(ch => {
    let extinf = '#EXTINF:-1';
    if (ch.epgId) extinf += ` tvg-id="${ch.epgId}"`;
    extinf += ` tvg-name="${ch.name}"`;
    if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
    if (ch.group) extinf += ` group-title="${ch.group}"`;
    extinf += `,${ch.name}`;
    m3u += extinf + '\n' + ch.url + '\n';
  });

  res.setHeader('Content-Type', 'audio/mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="all-channels.m3u"');
  res.send(m3u);
});

// ==================== START ====================
ensureDataDir();
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`IPTV Panel baslatildi: http://localhost:${PORT}`);
  console.log(`Admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log('='.repeat(50));
});
