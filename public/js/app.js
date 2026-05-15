// ==================== IPTV PANEL - ORTAK UYGULAMA KODU ====================

const App = {
  user: null,
  baseUrl: window.location.origin,
  
  // ==================== API HELPER ====================
  async api(url, options = {}) {
    try {
      const defaultHeaders = { 'Content-Type': 'application/json' };
      
      // FormData gönderiliyorsa Content-Type ekleme (browser otomatik ayarlar)
      if (options.body instanceof FormData) {
        delete defaultHeaders['Content-Type'];
      }
      
      const res = await fetch(url, {
        ...options,
        headers: {
          ...defaultHeaders,
          ...options.headers
        }
      });
      
      // M3U export gibi text response'lar için
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('audio/mpegurl')) {
        return await res.text();
      }
      
      const data = await res.json();
      
      if (res.status === 401 || res.status === 403) {
        if (data.error === 'Geçersiz veya süresi dolmuş token' || data.error === 'Giriş yapmanız gerekiyor') {
          App.logout();
          return null;
        }
      }
      
      return data;
    } catch (err) {
      console.error('API Error:', err);
      App.toast('Sunucu bağlantı hatası!', 'error');
      return null;
    }
  },

  // ==================== AUTH ====================
  async checkAuth() {
    try {
      const data = await this.api('/api/auth/me');
      if (data && data.user) {
        this.user = data.user;
        return data.user;
      }
      return null;
    } catch {
      return null;
    }
  },

  async login(username, password) {
    const data = await this.api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    
    if (data && data.success) {
      this.user = data.user;
      return data;
    }
    return data;
  },

  async register(username, email, password) {
    return await this.api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password })
    });
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    document.cookie = 'token=; Max-Age=0; path=/';
    this.user = null;
    window.location.href = '/';
  },

  // ==================== TOAST NOTIFICATION ====================
  toast(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    
    const icons = {
      success: '✅',
      error: '❌',
      info: 'ℹ️',
      warning: '⚠️'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
    
    container.appendChild(toast);
    
    // Otomatik kaldır
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
    
    // Tıklayınca kaldır
    toast.addEventListener('click', () => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    });
  },

  // ==================== MODAL ====================
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  },

  closeAllModals() {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      m.classList.remove('active');
    });
    document.body.style.overflow = '';
  },

  // ==================== CLIPBOARD ====================
  copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        App.toast('Panoya kopyalandı!', 'success');
      }).catch(() => {
        App.fallbackCopy(text);
      });
    } else {
      App.fallbackCopy(text);
    }
  },

  fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      App.toast('Panoya kopyalandı!', 'success');
    } catch {
      App.toast('Kopyalama başarısız, manuel kopyalayın', 'warning');
    }
    document.body.removeChild(textarea);
  },

  // ==================== HTML ESCAPE ====================
  escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // ==================== DATE FORMAT ====================
  formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: '2-digit', 
      year: 'numeric'
    });
  },

  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  formatRelativeTime(dateStr) {
    if (!dateStr) return '-';
    const now = new Date();
    const date = new Date(dateStr);
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return 'Az önce';
    if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} saat önce`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} gün önce`;
    return App.formatDate(dateStr);
  },

  // ==================== FILE SIZE FORMAT ====================
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  // ==================== DEBOUNCE ====================
  debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // ==================== CONFIRM DIALOG ====================
  async confirm(message, title = 'Onay') {
    return new Promise((resolve) => {
      // Mevcut confirm modal varsa kullan
      let modal = document.getElementById('confirmModal');
      
      if (!modal) {
        // Yoksa oluştur
        modal = document.createElement('div');
        modal.id = 'confirmModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal" style="max-width:400px">
            <div class="modal-header">
              <h2 id="confirmTitle">⚠️ ${title}</h2>
              <button class="modal-close" id="confirmClose">&times;</button>
            </div>
            <div class="modal-body">
              <p id="confirmMessage" style="font-size:15px;color:var(--text-secondary)">${message}</p>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" id="confirmCancel">İptal</button>
              <button class="btn btn-danger" id="confirmOk">Evet, Onayla</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      } else {
        document.getElementById('confirmTitle').innerHTML = `⚠️ ${title}`;
        document.getElementById('confirmMessage').textContent = message;
      }
      
      modal.classList.add('active');
      
      const cleanup = (result) => {
        modal.classList.remove('active');
        resolve(result);
      };
      
      document.getElementById('confirmOk').onclick = () => cleanup(true);
      document.getElementById('confirmCancel').onclick = () => cleanup(false);
      document.getElementById('confirmClose').onclick = () => cleanup(false);
      modal.onclick = (e) => { if (e.target === modal) cleanup(false); };
    });
  },

  // ==================== SECTION / TAB NAVIGATION ====================
  showSection(sectionName, menuSelector = '.sidebar-menu a') {
    // Tüm section'ları gizle
    document.querySelectorAll('.section').forEach(s => {
      s.style.display = 'none';
    });
    
    // Hedef section'ı göster
    const target = document.getElementById('section-' + sectionName);
    if (target) {
      target.style.display = 'block';
    }
    
    // Menü aktifliğini güncelle
    document.querySelectorAll(menuSelector).forEach(a => {
      a.classList.remove('active');
    });
    const activeLink = document.querySelector(`[data-section="${sectionName}"]`);
    if (activeLink) {
      activeLink.classList.add('active');
    }
    
    // Mobil sidebar'ı kapat
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.remove('open');
  },

  // ==================== PAGINATION RENDERER ====================
  renderPagination(containerId, currentPage, totalPages, totalItems, onPageChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    if (totalPages <= 1) {
      container.innerHTML = totalItems > 0 
        ? `<span style="font-size:12px;color:var(--text-muted)">Toplam ${totalItems} kayıt</span>` 
        : '';
      return;
    }
    
    let html = '';
    
    // Önceki
    html += `<button ${currentPage <= 1 ? 'disabled' : ''} onclick="${onPageChange}(${currentPage - 1})">◀ Önceki</button>`;
    
    // Sayfa numaraları
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
        html += `<button class="${i === currentPage ? 'active' : ''}" onclick="${onPageChange}(${i})">${i}</button>`;
      } else if (Math.abs(i - currentPage) === 3) {
        html += `<span style="color:var(--text-muted);padding:0 4px">...</span>`;
      }
    }
    
    // Sonraki
    html += `<button ${currentPage >= totalPages ? 'disabled' : ''} onclick="${onPageChange}(${currentPage + 1})">Sonraki ▶</button>`;
    
    // Toplam bilgisi
    html += `<span style="font-size:12px;color:var(--text-muted);margin-left:12px">(${totalItems} kayıt)</span>`;
    
    container.innerHTML = html;
  },

  // ==================== TABLE HELPERS ====================
  renderChannelLogo(channel) {
    if (channel.logo) {
      return `<img src="${App.escHtml(channel.logo)}" class="channel-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="">
              <div class="channel-logo-placeholder" style="display:none">${App.escHtml(channel.name[0])}</div>`;
    }
    return `<div class="channel-logo-placeholder">${App.escHtml(channel.name ? channel.name[0] : '?')}</div>`;
  },

  renderBadge(text, type = 'info') {
    return `<span class="badge badge-${type}">${App.escHtml(text)}</span>`;
  },

  renderStatusBadge(isActive) {
    return isActive 
      ? '<span class="badge badge-success">Aktif</span>' 
      : '<span class="badge badge-danger">Pasif</span>';
  },

  renderM3uLinkBox(url) {
    return `<div class="m3u-link-box">
      <input type="text" value="${App.escHtml(url)}" readonly onclick="this.select()">
      <button class="btn btn-sm btn-primary" onclick="App.copyToClipboard('${App.escHtml(url)}')">📋</button>
    </div>`;
  },

  renderEmptyState(icon, title, description, actionHtml = '') {
    return `<div class="empty-state">
      <div class="icon">${icon}</div>
      <h3>${title}</h3>
      <p>${description}</p>
      ${actionHtml ? `<div class="mt-4">${actionHtml}</div>` : ''}
    </div>`;
  },

  renderLoading() {
    return `<div class="loading-spinner"><div class="spinner"></div></div>`;
  },

  // ==================== CHANNEL DATA ====================
  channels: {
    async getAll(params = {}) {
      const { search = '', category = 'all', page = 1, limit = 50 } = params;
      const query = `?search=${encodeURIComponent(search)}&category=${category}&page=${page}&limit=${limit}`;
      return await App.api(`/api/channels${query}`);
    },

    async create(channelData) {
      return await App.api('/api/channels', {
        method: 'POST',
        body: JSON.stringify(channelData)
      });
    },

    async update(id, channelData) {
      return await App.api(`/api/channels/${id}`, {
        method: 'PUT',
        body: JSON.stringify(channelData)
      });
    },

    async delete(id) {
      return await App.api(`/api/channels/${id}`, {
        method: 'DELETE'
      });
    },

    async bulkDelete(ids) {
      return await App.api('/api/channels', {
        method: 'DELETE',
        body: JSON.stringify({ ids })
      });
    },

    async importFile(file) {
      const formData = new FormData();
      formData.append('m3uFile', file);
      return await App.api('/api/channels/import', {
        method: 'POST',
        body: formData
      });
    },

    async importContent(m3uContent) {
      return await App.api('/api/channels/import', {
        method: 'POST',
        body: JSON.stringify({ m3uContent })
      });
    }
  },

  // ==================== CATEGORY DATA ====================
  categories: {
    async getAll() {
      return await App.api('/api/categories');
    },

    async create(name) {
      return await App.api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
    },

    async delete(name) {
      return await App.api(`/api/categories/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      });
    },

    async loadIntoSelect(selectId, includeAll = true) {
      const data = await App.categories.getAll();
      if (!data) return;
      const select = document.getElementById(selectId);
      if (!select) return;
      
      let html = includeAll ? '<option value="all">Tüm Kategoriler</option>' : '';
      html += (data.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
      select.innerHTML = html;
    }
  },

  // ==================== PLAYLIST DATA ====================
  playlists: {
    async getAll() {
      return await App.api('/api/playlists');
    },

    async create(name, channelIds) {
      return await App.api('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({ name, channelIds })
      });
    },

    async update(id, data) {
      return await App.api(`/api/playlists/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
    },

    async delete(id) {
      return await App.api(`/api/playlists/${id}`, {
        method: 'DELETE'
      });
    },

    async regenerateToken(id) {
      return await App.api(`/api/playlists/${id}/regenerate-token`, {
        method: 'POST'
      });
    }
  },

  // ==================== USER DATA (ADMIN) ====================
  users: {
    async getAll() {
      return await App.api('/api/users');
    },

    async update(id, data) {
      return await App.api(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
    },

    async delete(id) {
      return await App.api(`/api/users/${id}`, {
        method: 'DELETE'
      });
    }
  },

  // ==================== STATS (ADMIN) ====================
  stats: {
    async get() {
      return await App.api('/api/stats');
    }
  },

  // ==================== DRAG & DROP ====================
  setupDropZone(elementId, onFileDrop) {
    const dropZone = document.getElementById(elementId);
    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.borderColor = 'var(--primary)';
        dropZone.style.background = 'rgba(99, 102, 241, 0.05)';
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.borderColor = 'var(--border)';
        dropZone.style.background = '';
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0 && onFileDrop) {
        onFileDrop(files[0]);
      }
    });
  },

  // ==================== CHANNEL SELECTOR COMPONENT ====================
  createChannelSelector(containerId, channels, selectedIds, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const {
      searchInputId = null,
      categorySelectId = null,
      countDisplayId = null,
      onToggle = null
    } = options;

    function render(filteredChannels) {
      if (!filteredChannels || filteredChannels.length === 0) {
        container.innerHTML = `<div class="empty-state" style="padding:30px">
          <p style="color:var(--text-muted)">Kanal bulunamadı</p>
        </div>`;
        return;
      }

      container.innerHTML = filteredChannels.map(ch => `
        <label class="channel-selector-item">
          <input type="checkbox" 
                 value="${ch.id}" 
                 ${selectedIds.has(ch.id) ? 'checked' : ''} 
                 onchange="App._handleSelectorToggle('${containerId}', '${ch.id}')">
          <span class="ch-name">${App.escHtml(ch.name)}</span>
          <span class="ch-group badge badge-info">${App.escHtml(ch.group || 'Genel')}</span>
        </label>
      `).join('');

      updateCount();
    }

    function filter() {
      let filtered = [...channels];
      
      if (searchInputId) {
        const search = document.getElementById(searchInputId)?.value?.toLowerCase() || '';
        if (search) {
          filtered = filtered.filter(c => 
            c.name.toLowerCase().includes(search) || 
            (c.group && c.group.toLowerCase().includes(search))
          );
        }
      }
      
      if (categorySelectId) {
        const category = document.getElementById(categorySelectId)?.value || 'all';
        if (category !== 'all') {
          filtered = filtered.filter(c => c.group === category);
        }
      }
      
      render(filtered);
    }

    function updateCount() {
      if (countDisplayId) {
        const el = document.getElementById(countDisplayId);
        if (el) el.textContent = `${selectedIds.size} kanal seçili`;
      }
    }

    function selectAllVisible() {
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        selectedIds.add(cb.value);
      });
      updateCount();
    }

    function deselectAll() {
      selectedIds.clear();
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
      });
      updateCount();
    }

    // Store reference for toggle handler
    if (!App._selectorInstances) App._selectorInstances = {};
    App._selectorInstances[containerId] = { selectedIds, updateCount, onToggle };

    // Initial render
    filter();

    return { render, filter, selectAllVisible, deselectAll, updateCount };
  },

  _selectorInstances: {},
  
  _handleSelectorToggle(containerId, channelId) {
    const instance = App._selectorInstances[containerId];
    if (!instance) return;
    
    if (instance.selectedIds.has(channelId)) {
      instance.selectedIds.delete(channelId);
    } else {
      instance.selectedIds.add(channelId);
    }
    
    instance.updateCount();
    if (instance.onToggle) instance.onToggle(channelId);
  },

  // ==================== GLOBAL EVENT LISTENERS ====================
  initGlobalEvents() {
    // ESC tuşu modal kapatır
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        App.closeAllModals();
      }
    });

    // Modal overlay tıklama
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
        document.body.style.overflow = '';
      }
    });

    // Mobile sidebar toggle
    document.addEventListener('click', (e) => {
      const sidebar = document.querySelector('.sidebar');
      const toggle = document.querySelector('.mobile-toggle');
      if (sidebar && sidebar.classList.contains('open') && 
          !sidebar.contains(e.target) && 
          !toggle?.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  },

  // ==================== LOCAL STORAGE HELPERS ====================
  storage: {
    set(key, value) {
      try {
        localStorage.setItem(`iptv_${key}`, JSON.stringify(value));
      } catch (e) {
        console.warn('localStorage error:', e);
      }
    },

    get(key, defaultValue = null) {
      try {
        const item = localStorage.getItem(`iptv_${key}`);
        return item ? JSON.parse(item) : defaultValue;
      } catch {
        return defaultValue;
      }
    },

    remove(key) {
      localStorage.removeItem(`iptv_${key}`);
    }
  },

  // ==================== URL HELPERS ====================
  getPlaylistUrl(token) {
    return `${App.baseUrl}/playlist/${token}.m3u`;
  },

  // ==================== VALIDATION ====================
  validate: {
    required(value, fieldName) {
      if (!value || !value.trim()) {
        App.toast(`${fieldName} alanı zorunludur`, 'warning');
        return false;
      }
      return true;
    },

    minLength(value, min, fieldName) {
      if (value.length < min) {
        App.toast(`${fieldName} en az ${min} karakter olmalı`, 'warning');
        return false;
      }
      return true;
    },

    email(value) {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!re.test(value)) {
        App.toast('Geçerli bir email adresi girin', 'warning');
        return false;
      }
      return true;
    },

    url(value) {
      try {
        new URL(value);
        return true;
      } catch {
        App.toast('Geçerli bir URL girin', 'warning');
        return false;
      }
    },

    match(value1, value2, fieldName = 'Şifreler') {
      if (value1 !== value2) {
        App.toast(`${fieldName} eşleşmiyor`, 'warning');
        return false;
      }
      return true;
    }
  },

  // ==================== THEME ====================
  theme: {
    current: 'dark',
    
    toggle() {
      this.current = this.current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', this.current);
      App.storage.set('theme', this.current);
    },

    load() {
      this.current = App.storage.get('theme', 'dark');
      document.documentElement.setAttribute('data-theme', this.current);
    }
  },

  // ==================== EXPORT HELPERS ====================
  downloadFile(content, filename, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

// ==================== SLIDEOUT ANIMATION ====================
const style = document.createElement('style');
style.textContent = `
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);

// ==================== INIT GLOBAL EVENTS ====================
document.addEventListener('DOMContentLoaded', () => {
  App.initGlobalEvents();
  App.theme.load();
});

// Global erişim için window'a ekle
window.App = App;
