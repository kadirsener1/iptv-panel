const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- GARANTİLİ DOSYA YOLU KONTROLÜ ---
let DATA_DIR = path.join(__dirname, 'data');

// Eğer Render diski aktifse ve tanımlıysa onu kullan, hata verirse yerel klasöre dön
if (process.env.DISK_PATH) {
    try {
        if (!fs.existsSync(process.env.DISK_PATH)) {
            fs.mkdirSync(process.env.DISK_PATH, { recursive: true });
        }
        DATA_DIR = process.env.DISK_PATH;
    } catch (e) {
        console.log("Render disk yoluna erişilemedi, yerel klasör kullanılacak.");
    }
}

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(CHANNELS_FILE)) fs.writeFileSync(CHANNELS_FILE, '[]', 'utf8');

const readData = (file) => {
    try {
        const content = fs.readFileSync(file, 'utf8');
        return JSON.parse(content || '[]');
    } catch (e) {
        return [];
    }
};

const writeData = (file, data) => {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("Dosya yazma hatası:", e);
    }
};
// ... Kodun geri kalanı aynı kalacak

const writeData = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

// --- MIDDLEWARES (ARA YAZILIMLAR) ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Güvenli oturum yönetimi
app.use(session({
    secret: 'iptv-panel-guvenli-anahtar-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24, // 1 Gün aktif kalır
        secure: false // Render HTTPs yönlendirmesini kendisi yaptığı için false kalabilir
    }
}));

// Giriş kontrolü gerektiren rotalar için koruma
const authRequired = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Lütfen önce giriş yapın.' });
    }
    next();
};

// Sadece adminlerin girebileceği rotalar için koruma
const adminRequired = (req, res, next) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok. Admin olmalısınız.' });
    }
    next();
};

// --- KULLANICI YÖNETİMİ API'LERİ ---

// Kayıt Olma Rotası (Sistemdeki İLK kayıt otomatik ADMIN olur)
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre boş bırakılamaz.' });

        const users = readData(USERS_FILE);
        
        // Kullanıcı adı kontrolü
        if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
            return res.status(400).json({ error: 'Bu kullanıcı adı zaten sistemde mevcut.' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Eğer veritabanında hiç kullanıcı yoksa bu ilk kişidir ve otomatik admin yapılır
        const isFirstUser = users.length === 0;

        const newUser = {
            id: uuidv4(),
            username: username.trim(),
            password: hashedPassword,
            isAdmin: isFirstUser, 
            allowedCategories: [],
            token: uuidv4().substring(0, 8) // M3U linki için benzersiz kısa token
        };
        
        users.push(newUser);
        writeData(USERS_FILE, users);
        
        res.json({ 
            success: true, 
            message: isFirstUser ? 'İlk kullanıcı (Admin) başarıyla oluşturuldu.' : 'Kullanıcı kaydı başarıyla tamamlandı.' 
        });
    } catch (error) {
        res.status(500).json({ error: 'Kayıt sırasında sistemsel bir hata oluştu.' });
    }
});

// Giriş Yapma Rotası
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = readData(USERS_FILE);
        
        const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: 'Hatalı kullanıcı adı veya şifre girdiniz.' });
        }
        
        // Oturum verilerini kaydetme
        req.session.user = { 
            id: user.id, 
            username: user.username, 
            isAdmin: user.isAdmin, 
            token: user.token 
        };
        
        res.json({ success: true, isAdmin: user.isAdmin });
    } catch (error) {
        res.status(500).json({ error: 'Giriş işlemi sırasında hata oluştu.' });
    }
});

// Çıkış Yapma Rotası
app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Oturum Açmış Mevcut Kullanıcı Bilgisini Döndürür
app.get('/api/me', authRequired, (req, res) => {
    res.json(req.session.user);
});

// --- ADMIN KANAL YÖNETİMİ API'LERİ ---

// Tüm Kanalları Listele (Sadece Admin)
app.get('/api/admin/channels', adminRequired, (req, res) => {
    res.json(readData(CHANNELS_FILE));
});

// Manuel Tekil Kanal Ekle (Sadece Admin)
app.post('/api/admin/channels', adminRequired, (req, res) => {
    const { name, url, category } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Kanal adı ve URL girmek zorunludur.' });

    const channels = readData(CHANNELS_FILE);
    const newChannel = { 
        id: uuidv4(), 
        name: name.trim(), 
        url: url.trim(), 
        category: category ? category.trim() : 'Genel' 
    };
    
    channels.push(newChannel);
    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, channel: newChannel });
});

// Kanal Sil (Sadece Admin)
app.delete('/api/admin/channels/:id', adminRequired, (req, res) => {
    let channels = readData(CHANNELS_FILE);
    const initialLength = channels.length;
    channels = channels.filter(c => c.id !== req.params.id);
    
    if (channels.length === initialLength) return res.status(404).json({ error: 'Kanal bulunamadı.' });

    writeData(CHANNELS_FILE, channels);
    res.json({ success: true });
});

// Toplu M3U Metni Import Etme (Sadece Admin)
app.post('/api/admin/import-m3u', adminRequired, (req, res) => {
    const { m3uContent } = req.body;
    if (!m3uContent || m3uContent.trim() === "") return res.status(400).json({ error: 'M3U içeriği boş olamaz.' });

    const channels = readData(CHANNELS_FILE);
    const lines = m3uContent.split('\n');
    let currentChannel = {};
    let importCount = 0;

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            // group-title parametresini yakala (Kategori belirlemek için)
            const groupMatch = line.match(/group-title="([^"]+)"/);
            currentChannel.category = groupMatch ? groupMatch[1].trim() : 'M3U Import';
            
            // Virgülden sonraki kanal ismini yakala
            const nameParts = line.split(',');
            currentChannel.name = nameParts[nameParts.length - 1].trim();
        } else if (line.startsWith('http')) {
            currentChannel.url = line;
            currentChannel.id = uuidv4();
            
            if (currentChannel.name && currentChannel.url) {
                channels.push({ ...currentChannel });
                importCount++;
            }
            currentChannel = {}; // Bir sonraki kanal için objeyi sıfırla
        }
    });

    writeData(CHANNELS_FILE, channels);
    res.json({ success: true, count: importCount });
});

// --- NORMAL ÜYE / KULLANICI PANEL API'LERİ ---

// Sistemdeki tüm eşsiz kategorileri çek (Kullanıcının kutucukları seçmesi için)
app.get('/api/user/categories', authRequired, (req, res) => {
    const channels = readData(CHANNELS_FILE);
    const categories = [...new Set(channels.map(c => c.category))];
    res.json(categories);
});

// Kullanıcının seçtiği ve izin verdiği kategorileri kaydet
app.post('/api/user/my-categories', authRequired, (req, res) => {
    const { categories } = req.body; // Gönderilen array veri formatı: ["Spor", "Sinema"]
    if (!Array.isArray(categories)) return res.status(400).json({ error: 'Geçersiz veri formatı.' });

    const users = readData(USERS_FILE);
    const userIndex = users.findIndex(u => u.id === req.session.user.id);
    
    if (userIndex !== -1) {
        users[userIndex].allowedCategories = categories;
        writeData(USERS_FILE, users);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Kullanıcı kaydı bulunamadı.' });
    }
});

// Kullanıcının hali hazırda seçmiş olduğu kategorileri yükle
app.get('/api/user/my-categories', authRequired, (req, res) => {
    const users = readData(USERS_FILE);
    const user = users.find(u => u.id === req.session.user.id);
    res.json(user ? user.allowedCategories : []);
});

// --- CANLI ÇIKTI: IPTV PROGRAMLARI İÇİN M3U BAĞLANTISI ---
// Bu rota şifresiz ve herkese açıktır, doğrulamayı token parametresi üzerinden yapar.
app.get('/get-m3u/:token', (req, res) => {
    const { token } = req.params;
    const users = readData(USERS_FILE);
    const user = users.find(u => u.token === token);
    
    if (!user) {
        return res.status(404).send('#EXTM3U\n#EXTINF:-1, Gecersiz veya iptal edilmis M3U linki.');
    }

    const channels = readData(CHANNELS_FILE);
    
    // Sadece kullanıcının izin verdiği/seçtiği kategorilerdeki kanalları filtrele
    const userChannels = channels.filter(c => user.allowedCategories.includes(c.category));

    let m3uResponse = '#EXTM3U\n';
    userChannels.forEach(c => {
        m3uResponse += `#EXTINF:-1 group-title="${c.category}",${c.name}\n${c.url}\n`;
    });

    // Tarayıcıya ve IPTV oynatıcılara bunun bir M3U dosyası olduğunu bildiren başlıklar
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="iptv_playlist.m3u"');
    res.send(m3uResponse);
});

// Sunucuyu ayağa kaldır
app.listen(PORT, () => {
    console.log(`=== IPTV PORTAL AKTİF ===`);
    console.log(`Port: ${PORT}`);
    console.log(`Veri Depolama Klasörü: ${DATA_DIR}`);
});
