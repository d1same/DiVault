const state = { user: null, notes: [], assets: [], clients: [], categories: [], counts: {}, section: 'notes:all', panel: '', settingsHtml: '', q: '', clientId: localStorage.getItem('divault_client_id') || localStorage.getItem('qv_client_id') || '', includeArchive: false, active: null, activeExtra: null, editingNote: false, newNoteMode: 'full', pendingAttachments: [], selectionMode: false, selectedNoteIds: new Set(), noteLayout: localStorage.getItem('divault_note_layout') || 'cards', noteSort: localStorage.getItem('divault_note_sort') || 'updated_desc', noteFocus: localStorage.getItem('divault_note_focus') === '1', notePaneWidth: Number(localStorage.getItem('divault_note_pane_width') || 300), theme: localStorage.getItem('divault_theme') || localStorage.getItem('qv_theme') || 'soft', loginMfa: false, lastSyncedAt: null, syncTimer: null, syncing: false, desktop: false, setupMode: 'local' };
const app = document.querySelector('#app');

function applyTheme() {
  const darkThemes = new Set(['dark', 'moss', 'midnight', 'black']);
  const resolved = darkThemes.has(state.theme) ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = state.theme;
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('divault_theme', theme);
  applyTheme();
}

applyTheme();

const api = async (path, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = getCookie('divault_csrf') || getCookie('qv_csrf');
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  }
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers,
    ...options,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res;
};

function getCookie(name) {
  const prefix = `${name}=`;
  const row = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
  return row ? row.slice(prefix.length) : '';
}

const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brandMark = (alt = 'DiVault') => `<img src="/assets/divault-logo.svg" alt="${esc(alt)}">`;
const toast = message => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
};

function cleanFrontMatterValue(value = '') {
  const trimmed = String(value).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function markdownFileTitle(fileName) {
  return fileName.replace(/\.md$/i, '') || 'Imported note';
}

function formatDateTime(value) {
  if (!value) return 'unknown time';
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function deviceNameFromUserAgent(userAgent = '') {
  const ua = String(userAgent);
  const browser = ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome/') ? 'Chrome' : ua.includes('Firefox/') ? 'Firefox' : ua.includes('Safari/') ? 'Safari' : 'Browser';
  const os = ua.includes('Android') ? 'Android' : ua.includes('Windows') ? 'Windows' : ua.includes('iPhone') || ua.includes('iPad') ? 'iOS' : ua.includes('Mac OS X') ? 'macOS' : ua.includes('Linux') ? 'Linux' : 'Unknown device';
  return `${browser} on ${os}`;
}

function groupedSessionsHtml(sessions = []) {
  const groups = new Map();
  sessions.forEach(session => {
    const ip = session.ip || 'unknown IP';
    const device = deviceNameFromUserAgent(session.user_agent);
    const key = `${ip}|${device}`;
    const group = groups.get(key) || { ip, device, sessions: [], latest: session.created_at };
    group.sessions.push(session);
    if (String(session.created_at || '') > String(group.latest || '')) group.latest = session.created_at;
    groups.set(key, group);
  });
  return [...groups.values()].map(group => `<div class="user-row"><span><b>${esc(group.device)}</b><br><span class="small muted">${esc(group.ip)} · ${formatDateTime(group.latest)}${group.sessions.length > 1 ? ` · ${group.sessions.length} sessions` : ''}</span></span><button class="btn danger" data-session-ids="${esc(group.sessions.map(s => s.id).join(','))}">Revoke</button></div>`).join('') || '<p class="small muted">No active sessions.</p>';
}

function auditRowsHtml(auditRows = []) {
  return auditRows.slice(0, 12).map(a => `<div class="audit-row"><span>${esc(a.action)}<br><span class="small muted">${formatDateTime(a.created_at)}</span></span><span class="small muted">${esc(a.email || 'system')}${a.ip ? `<br>${esc(a.ip)}` : ''}</span></div>`).join('') || '<p class="small muted">No events yet.</p>';
}

async function buildMarkdownImportPayload(files) {
  const markdownFiles = [...files].filter(file => file.name.toLowerCase().endsWith('.md'));
  if (!markdownFiles.length) throw new Error('Choose one or more Markdown files');
  const notes = [];
  for (const file of markdownFiles) {
    const raw = await file.text();
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const meta = {};
    let body = raw;
    if (match) {
      body = match[2];
      match[1].split(/\r?\n/).forEach(line => {
        const field = line.match(/^([^:]+):\s*(.*)$/);
        if (field) meta[field[1].trim()] = cleanFrontMatterValue(field[2]);
      });
    }
    const sourcePath = file.webkitRelativePath || file.name;
    const pathParts = sourcePath.split('/').filter(Boolean);
    if (pathParts.length > 2) pathParts.shift();
    pathParts.pop();
    notes.push({
      title: meta.title || markdownFileTitle(file.name),
      body: body.trim(),
      type: 'text',
      section: 'All',
      category_path: pathParts,
      tags: meta.tags ? meta.tags.split(',').map(tag => tag.trim()).filter(Boolean) : [],
      created_at: meta.created || null,
      updated_at: meta.updated || null,
      source: 'markdown-front-matter',
      source_file: sourcePath
    });
  }
  return { source: 'markdown-front-matter', generated_at: new Date().toISOString(), notes };
}

function setupAccessibleModal(modal, initialFocusSelector = '[data-close], button, input, textarea, select, a[href]') {
  const previousFocus = document.activeElement;
  const panel = modal.querySelector('.editor-panel') || modal;
  const title = panel.querySelector('h2');
  const titleId = title ? `dialog-title-${Date.now()}-${Math.random().toString(36).slice(2)}` : '';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  if (title && titleId) {
    title.id = titleId;
    modal.setAttribute('aria-labelledby', titleId);
  }
  const originalRemove = modal.remove.bind(modal);
  const close = () => modal.remove();
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKeydown = e => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll(focusableSelector)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  modal.remove = () => {
    document.removeEventListener('keydown', onKeydown);
    originalRemove();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  modal.querySelector('[data-close]')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKeydown);
  setTimeout(() => (modal.querySelector(initialFocusSelector) || modal.querySelector(focusableSelector))?.focus(), 0);
  return close;
}

function promptDialog({ title, message, type = 'text', placeholder = '', required = false, confirmText = 'Continue' }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'editor';
    modal.innerHTML = `<section class="editor-panel small-panel">
      <div class="topbar"><div><h2>${esc(title)}</h2><p class="muted small">${esc(message)}</p></div><button class="btn ghost" type="button" data-close>Cancel</button></div>
      <form class="stack" id="promptForm">
        <label class="field"><span>${esc(title)}</span><input name="value" type="${esc(type)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}></label>
        <div class="btn-row"><button class="btn primary">${esc(confirmText)}</button><button class="btn ghost" type="button" data-cancel>Cancel</button></div>
      </form>
    </section>`;
    document.body.appendChild(modal);
    setupAccessibleModal(modal, 'input[name="value"]');
    let settled = false;
    const remove = modal.remove.bind(modal);
    modal.remove = () => { if (!settled) { settled = true; resolve(null); } remove(); };
    modal.querySelector('[data-cancel]').addEventListener('click', () => modal.remove());
    modal.querySelector('#promptForm').addEventListener('submit', e => {
      e.preventDefault();
      const value = new FormData(e.target).get('value') || '';
      settled = true;
      remove();
      resolve(String(value));
    });
  });
}

function confirmDialog({ title, message, confirmText = 'Continue' }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'editor confirm-dialog';
    modal.innerHTML = `<section class="editor-panel small-panel">
      <div class="topbar"><div><h2>${esc(title)}</h2><p class="muted small">${esc(message)}</p></div><button class="btn ghost" type="button" data-close>Cancel</button></div>
      <div class="btn-row"><button class="btn danger" type="button" data-confirm>${esc(confirmText)}</button><button class="btn ghost" type="button" data-cancel>Cancel</button></div>
    </section>`;
    document.body.appendChild(modal);
    setupAccessibleModal(modal, '[data-confirm]');
    let settled = false;
    const remove = modal.remove.bind(modal);
    modal.remove = () => { if (!settled) { settled = true; resolve(false); } remove(); };
    modal.querySelector('[data-cancel]').addEventListener('click', () => modal.remove());
    modal.querySelector('[data-confirm]').addEventListener('click', () => { settled = true; remove(); resolve(true); });
  });
}

function alertDialog({ title, message, confirmText = 'OK' }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'editor confirm-dialog';
    modal.innerHTML = `<section class="editor-panel small-panel">
      <div class="topbar"><div><h2>${esc(title)}</h2><p class="muted small">${esc(message)}</p></div><button class="btn ghost" type="button" data-close>Close</button></div>
      <div class="btn-row"><button class="btn primary" type="button" data-confirm>${esc(confirmText)}</button></div>
    </section>`;
    document.body.appendChild(modal);
    setupAccessibleModal(modal, '[data-confirm]');
    const remove = modal.remove.bind(modal);
    modal.remove = () => { remove(); resolve(true); };
    modal.querySelector('[data-confirm]').addEventListener('click', () => modal.remove());
  });
}

async function runUserAction(action, fallback = 'Action failed') {
  try {
    return await action();
  } catch (err) {
    toast(err.message || fallback);
    return null;
  }
}

function clearSensitiveLocalData() {
  [
    'divault_emergency_snapshot', 'qv_emergency_snapshot',
    'divault_pending_notes', 'qv_pending_notes',
    'divault_draft_note', 'qv_draft_note',
    'divault_note_draft', 'qv_note_draft'
  ].forEach(key => localStorage.removeItem(key));
}

function canAdminSettings() {
  return state.user?.role === 'owner' || state.user?.role === 'admin';
}

const codeTypes = {
  code: { label: 'Code', fence: 'text', extension: 'txt' },
};

const themePresets = [
  { key: 'light', label: 'Clean light', note: 'Default bright workspace' },
  { key: 'soft', label: 'Soft neutral', note: 'Warm low-contrast middle ground' },
  { key: 'ocean', label: 'Ocean focus', note: 'Cool blue-green accents' },
  { key: 'colorblind', label: 'Color-safe', note: 'Blue/orange accessible contrast' },
  { key: 'moss', label: 'Moss dusk', note: 'Muted charcoal, green, and amber' },
  { key: 'dark', label: 'Dark terminal', note: 'Low-glare dark mode' },
  { key: 'midnight', label: 'Midnight ember', note: 'Near-black warm amber' },
  { key: 'black', label: 'True black', note: 'OLED black with green text' }
];

const categoryIconPresets = [
  ['folder', 'Folder'], ['settings', 'Configuration'], ['lock', 'Passwords'], ['receipt', 'Records'],
  ['pin', 'Pinned'], ['tools', 'Tools'], ['globe', 'Web'], ['monitor', 'Devices'],
  ['signal', 'Network'], ['home', 'Home'], ['user', 'People'], ['calendar', 'Calendar'],
  ['check', 'Tasks'], ['bolt', 'Urgent'], ['camera', 'Photos'], ['note', 'Notes'],
  ['key', 'Keys'], ['shield', 'Security'], ['database', 'Database'], ['server', 'Servers'],
  ['cloud', 'Cloud'], ['wifi', 'Wi-Fi'], ['phone', 'Mobile'], ['laptop', 'Laptop'],
  ['book', 'Docs'], ['bookmark', 'Saved'], ['briefcase', 'Work'], ['card', 'Billing'],
  ['dollar', 'Finance'], ['alert', 'Alerts'], ['mapPin', 'Locations'], ['box', 'Inventory'],
  ['tag', 'Tags'], ['mail', 'Email'], ['terminal', 'Terminal'], ['wrench', 'Maintenance']
];
const legacyCategoryIcons = { '📁': 'folder', '⚙': 'settings', '🔐': 'lock', '🧾': 'receipt', '📌': 'pin', '🛠': 'tools', '🌐': 'globe', '💻': 'monitor', '📡': 'signal', '🏠': 'home', '👤': 'user', '📅': 'calendar', '✅': 'check', '⚡': 'bolt', '📷': 'camera', '📝': 'note' };

const icon = name => ({
  paragraph: '<svg viewBox="0 0 24 24"><path d="M10 4h9M10 4v16M14 4v16M6 4h4v8H6a4 4 0 0 1 0-8Z"/></svg>',
  table: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 10h16M10 5v14"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>',
  secret: '<svg viewBox="0 0 24 24"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6zM12 14v2"/></svg>',
  draw: '<svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20ZM14 7l3 3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M9 13h6M9 17h6"/></svg>',
  bold: '<svg viewBox="0 0 24 24"><path d="M8 5h5a3.5 3.5 0 0 1 0 7H8zM8 12h6a3.5 3.5 0 0 1 0 7H8z"/></svg>',
  italic: '<svg viewBox="0 0 24 24"><path d="M10 5h8M6 19h8M14 5l-4 14"/></svg>',
  underline: '<svg viewBox="0 0 24 24"><path d="M7 5v6a5 5 0 0 0 10 0V5M5 21h14"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
  inlineCode: '<svg viewBox="0 0 24 24"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M13 6l-2 12"/></svg>',
  heading: '<svg viewBox="0 0 24 24"><path d="M5 5v14M15 5v14M5 12h10M19 19V9l-3 2"/></svg>',
  bullet: '<svg viewBox="0 0 24 24"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
  numbered: '<svg viewBox="0 0 24 24"><path d="M10 7h10M10 12h10M10 17h10M4 6h2v4M4 14h2a1 1 0 0 1 0 2H4v2h3"/></svg>',
  checklist: '<svg viewBox="0 0 24 24"><path d="m4 7 2 2 4-4M12 8h8M4 16l2 2 4-4M12 17h8"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M8 10H5a4 4 0 0 0 4 4v4a7 7 0 0 1-7-7V6h6zM20 10h-3a4 4 0 0 0 4 4v4a7 7 0 0 1-7-7V6h6z"/></svg>'
  , undo: '<svg viewBox="0 0 24 24"><path d="M9 7 5 11l4 4M5 11h9a5 5 0 0 1 0 10h-1"/></svg>'
  , redo: '<svg viewBox="0 0 24 24"><path d="m15 7 4 4-4 4M19 11h-9a5 5 0 0 0 0 10h1"/></svg>'
  , trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>'
  , selectAll: '<svg viewBox="0 0 24 24"><path d="M4 5h12v12H4zM8 11l2 2 4-5M18 7h2v13H7v-2"/></svg>'
  , selectNone: '<svg viewBox="0 0 24 24"><path d="M4 5h12v12H4zM7 8l6 6M13 8l-6 6M18 7h2v13H7v-2"/></svg>'
  , quick: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'
  , folder: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z"/></svg>'
  , settings: '<svg viewBox="0 0 24 24"><path d="M4 8h10M18 8h2M4 16h2M10 16h10M14 5v6M10 13v6"/></svg>'
  , lock: '<svg viewBox="0 0 24 24"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z"/></svg>'
  , receipt: '<svg viewBox="0 0 24 24"><path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1zM9 8h6M9 12h6M9 16h4"/></svg>'
  , pin: '<svg viewBox="0 0 24 24"><path d="m15 4 5 5-4 1-4 7-2-2-5 5 5-5-2-2 7-4z"/></svg>'
  , tools: '<svg viewBox="0 0 24 24"><path d="M14 7a5 5 0 0 0 6 6l-7 7a2 2 0 0 1-3-3l7-7a5 5 0 0 1-3-3ZM4 4l5 5"/></svg>'
  , globe: '<svg viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
  , monitor: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4zM9 21h6M12 16v5"/></svg>'
  , signal: '<svg viewBox="0 0 24 24"><path d="M5 12a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0M11 18a2 2 0 0 1 2 0"/></svg>'
  , home: '<svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8M5 10v10h14V10M9 20v-6h6v6"/></svg>'
  , user: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0"/></svg>'
  , calendar: '<svg viewBox="0 0 24 24"><path d="M5 5h14v16H5zM8 3v4M16 3v4M5 10h14"/></svg>'
  , check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'
  , bolt: '<svg viewBox="0 0 24 24"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg>'
  , camera: '<svg viewBox="0 0 24 24"><path d="M4 7h4l2-2h4l2 2h4v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>'
  , note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6zM14 3v5h4M9 13h6M9 17h6"/></svg>'
  , cards: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>'
  , list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>'
  , sort: '<svg viewBox="0 0 24 24"><path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3"/></svg>'
  , focus: '<svg viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4M9 9h6v6H9z"/></svg>'
  , logout: '<svg viewBox="0 0 24 24"><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/></svg>'
  , clearFormat: '<svg viewBox="0 0 24 24"><path d="M5 5h12M11 5 7 19M15 19H5M15 11l5 5M20 11l-5 5"/></svg>'
  , key: '<svg viewBox="0 0 24 24"><path d="M14 10a5 5 0 1 1-2-4l7 7-2 2-2-2-2 2-2-2M7 10h.01"/></svg>'
  , shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6zM9 12l2 2 4-4"/></svg>'
  , database: '<svg viewBox="0 0 24 24"><path d="M5 6c0-2 14-2 14 0v12c0 2-14 2-14 0zM5 6c0 2 14 2 14 0M5 12c0 2 14 2 14 0"/></svg>'
  , server: '<svg viewBox="0 0 24 24"><path d="M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6"/></svg>'
  , cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11.5-1.8A5 5 0 0 0 7 18Z"/></svg>'
  , wifi: '<svg viewBox="0 0 24 24"><path d="M4 9a12 12 0 0 1 16 0M7 12a8 8 0 0 1 10 0M10 15a4 4 0 0 1 4 0M12 19h.01"/></svg>'
  , phone: '<svg viewBox="0 0 24 24"><path d="M8 3h8v18H8zM11 18h2"/></svg>'
  , laptop: '<svg viewBox="0 0 24 24"><path d="M5 5h14v10H5zM3 19h18l-2-4H5z"/></svg>'
  , book: '<svg viewBox="0 0 24 24"><path d="M5 4h10a4 4 0 0 1 4 4v12H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"/></svg>'
  , bookmark: '<svg viewBox="0 0 24 24"><path d="M7 4h10v17l-5-3-5 3z"/></svg>'
  , briefcase: '<svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM9 7V5h6v2M4 12h16"/></svg>'
  , card: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 10h16M7 15h4"/></svg>'
  , dollar: '<svg viewBox="0 0 24 24"><path d="M12 3v18M16 7a4 4 0 0 0-4-2H9.5a2.5 2.5 0 0 0 0 5H14a2.5 2.5 0 0 1 0 5h-3a4 4 0 0 1-4-2"/></svg>'
  , alert: '<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20zM12 9v5M12 17h.01"/></svg>'
  , mapPin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-5 7-11a7 7 0 1 0-14 0c0 6 7 11 7 11ZM12 10h.01"/></svg>'
  , box: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10"/></svg>'
  , tag: '<svg viewBox="0 0 24 24"><path d="M4 12V5h7l9 9-7 7zM8 8h.01"/></svg>'
  , mail: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 7l8 6 8-6"/></svg>'
  , terminal: '<svg viewBox="0 0 24 24"><path d="m4 7 5 5-5 5M11 17h9"/></svg>'
  , wrench: '<svg viewBox="0 0 24 24"><path d="M14 7a5 5 0 0 0 6 6l-7 7a2 2 0 0 1-3-3l7-7a5 5 0 0 1-3-3Z"/></svg>'
}[name] || '');

function toolIcon(name, label) {
  return `<span class="tool-icon" aria-hidden="true">${icon(name)}</span><span class="sr-only">${esc(label)}</span>`;
}

async function boot() {
  loadEmergencySnapshot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let bootInfo;
  try {
    bootInfo = await api('/bootstrap');
  } catch (err) {
    return renderOfflineVault(err);
  }
  state.desktop = Boolean(bootInfo.desktop);
  if (bootInfo.needsSetup) return renderSetup();
  try {
    const me = await api('/me');
      state.user = me.user;
      await loadAll();
      renderApp();
      startSyncLoop();
  } catch {
    renderLogin();
  }
}

function renderSetup() {
  const desktopChoice = state.desktop ? `<div class="onboarding-choice" role="group" aria-label="Desktop setup mode">
      <button class="setup-choice ${state.setupMode === 'local' ? 'active' : ''}" type="button" data-setup-mode="local"><b>Standalone vault</b><span>Create a private vault on this computer.</span></button>
      <button class="setup-choice ${state.setupMode === 'server' ? 'active' : ''}" type="button" data-setup-mode="server"><b>Connect to server</b><span>Use an existing DiVault server so devices can sync through it.</span></button>
    </div>` : '';
  const localSetup = `<div class="setup-panel ${state.setupMode === 'local' ? '' : 'hidden'}" data-setup-panel="local">
    <form class="stack" id="setupForm">
      <label class="field"><span>Name</span><input name="name" autocomplete="name" required></label>
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="field"><span>Confirm password</span><input name="password_confirm" type="password" autocomplete="new-password" minlength="10" required></label>
      <button class="btn primary">Create owner</button>
    </form>
    <details class="details-panel"><summary>Restore from backup</summary><form class="stack inline-note-blocks" id="setupRestoreForm"><p class="small muted">Use this on a fresh install to restore a DiVault full backup ZIP before creating a new owner account.</p><label class="field"><span>Backup ZIP</span><input name="backup" type="file" accept=".zip,application/zip" required></label><label class="field"><span>Backup passphrase</span><input name="passphrase" type="password" placeholder="Leave blank if none"></label><button class="btn danger">Restore backup</button></form></details>
    <p class="small muted">Standalone vaults stay on this computer. Connect to a server when you want multiple devices to sync.</p>
  </div>`;
  const serverSetup = state.desktop ? `<div class="setup-panel ${state.setupMode === 'server' ? '' : 'hidden'}" data-setup-panel="server">
    <form class="stack" id="desktopServerForm">
      <label class="field"><span>DiVault server URL</span><input name="server_url" type="url" placeholder="https://notes.example.com" autocomplete="url" required></label>
      <button class="btn primary">Connect to server</button>
    </form>
    <p class="small muted">The desktop app will remember this URL and open it on future launches. Create your account on that server if it is new.</p>
  </div>` : '';
  app.innerHTML = authShell(state.desktop ? 'Set up DiVault' : 'Create your owner account', state.desktop ? 'Choose standalone local use or connect to your server.' : 'Use a strong password. You will type it twice.', `
    ${desktopChoice}
    <div class="card stack setup-theme"><h3>Color theme</h3>${themePresetPicker()}</div>
    ${localSetup}
    ${serverSetup}`);
  bindThemeControls(document);
  document.querySelectorAll('[data-setup-mode]').forEach(button => button.addEventListener('click', () => {
    state.setupMode = button.dataset.setupMode;
    renderSetup();
  }));
  document.querySelector('#desktopServerForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const res = await api('/desktop/server', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Server saved');
      window.location.href = res.server_url;
    } catch (err) { toast(err.message); }
  });
  document.querySelector('#setupForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (data.password !== data.password_confirm) return toast('Passwords do not match');
    await api('/setup', { method: 'POST', body: data });
    toast('Owner created');
    renderLogin();
  });
  document.querySelector('#setupRestoreForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    if (!form.get('backup')?.name) return toast('Choose a backup ZIP first');
    try {
      const res = await api('/setup/restore', { method: 'POST', body: form });
      toast(res.message || 'Backup restored');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) { toast(err.message); }
  });
}

function renderLogin() {
  app.innerHTML = authShell('Welcome back', 'Quick notes, client docs, files, and hidden secrets.', `
    <form class="stack" id="loginForm">
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      ${state.loginMfa ? `<label class="field"><span>2FA code</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="000000"></label><label class="field"><span>Recovery code</span><input name="recovery_code" autocomplete="one-time-code" placeholder="XXXXX-XXXXX"></label>` : ''}
      <button class="btn primary">${state.loginMfa ? 'Verify and sign in' : 'Continue'}</button>
      <p class="small muted">Passkey/biometric login foundation is reserved for the HTTPS domain and can be enabled after WebAuthn credential enrollment is completed.</p>
    </form>`);
  document.querySelector('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      if (!state.loginMfa) {
        const check = await api('/login/check', { method: 'POST', body: data });
        if (check.mfa_required) {
          state.loginMfa = true;
          renderLogin();
          document.querySelector('input[name="email"]').value = data.email || '';
          document.querySelector('input[name="password"]').value = data.password || '';
          toast('Enter your 2FA code');
          return;
        }
      }
      const res = await api('/login', { method: 'POST', body: data });
      state.loginMfa = false;
      state.user = res.user;
      await loadAll();
      renderApp();
      startSyncLoop();
    } catch (err) { toast(err.message); }
  });
}

function authShell(title, subtitle, body) {
  return `<section class="auth-card">
    <div class="brand"><div class="brand-mark">${brandMark()}</div><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>
    ${body}
  </section>`;
}

async function loadAll() {
  const [clients, categories, counts] = await Promise.all([api('/clients'), api('/categories'), api('/asset-counts').catch(() => ({ counts: {} }))]);
  state.clients = clients.clients;
  state.categories = categories.categories;
  if (state.clientId && !state.clients.some(client => String(client.id) === String(state.clientId))) {
    state.clientId = '';
    localStorage.removeItem('divault_client_id');
    localStorage.removeItem('qv_client_id');
  }
  if (!state.section || ['Inbox', 'Personal', 'Projects', 'Vault', 'Archive', 'Trash'].includes(state.section)) state.section = 'notes:all';
  state.counts = counts.counts || {};
  await loadCurrentSection();
  state.lastSyncedAt = new Date();
  const syncedPending = await syncPendingNotes();
  if (syncedPending) await loadCurrentSection();
  await saveEmergencySnapshot();
}

async function saveEmergencySnapshot() {
  const passphrase = sessionStorage.getItem('divault_emergency_passphrase');
  if (!passphrase) return;
  try { await createEncryptedEmergencySnapshot(passphrase); } catch {}
}

async function createEncryptedEmergencySnapshot(passphrase) {
  const exported = await api('/export');
  const snapshot = { ...exported, categories: state.categories, saved_at: new Date().toISOString(), pending_notes: loadPendingNotes() };
  localStorage.setItem('divault_emergency_snapshot', JSON.stringify(await encryptJson(snapshot, passphrase)));
  sessionStorage.setItem('divault_emergency_passphrase', passphrase);
  return snapshot;
}

function loadEmergencySnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem('divault_emergency_snapshot') || 'null');
    if (snapshot && !snapshot.encrypted) {
      localStorage.removeItem('divault_emergency_snapshot');
      return null;
    }
    return snapshot;
  } catch { return null; }
}

async function unlockEmergencySnapshot(passphrase) {
  const snapshot = loadEmergencySnapshot();
  if (!snapshot) return null;
  return decryptJson(snapshot, passphrase);
}

async function encryptJson(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePassphraseKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { encrypted: true, version: 1, kdf: 'PBKDF2-SHA256', iterations: 250000, cipher: 'AES-GCM', saved_at: value.saved_at, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(encrypted) };
}

async function decryptJson(envelope, passphrase) {
  const key = await derivePassphraseKey(passphrase, base64ToBytes(envelope.salt));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.data));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function derivePassphraseKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

function loadPendingNotes() {
  try { return JSON.parse(localStorage.getItem('divault_pending_notes') || '[]'); } catch { return []; }
}

function savePendingNotes(notes) {
  localStorage.setItem('divault_pending_notes', JSON.stringify(notes));
}

function addPendingNote(note) {
  const notes = loadPendingNotes();
  notes.unshift({ ...note, local_id: crypto.randomUUID?.() || String(Date.now()), created_at: new Date().toISOString() });
  savePendingNotes(notes);
}

async function syncPendingNotes() {
  const pending = loadPendingNotes();
  if (!pending.length || !state.user) return 0;
  const remaining = [];
  for (const note of pending) {
    try {
      await api('/notes', { method: 'POST', body: { title: note.title || 'Offline note', body: note.body || '', type: 'text', section: 'All', category_id: note.category_id || '', category: '', tags: 'offline-capture', client_id: '' } });
    } catch {
      remaining.push(note);
    }
  }
  savePendingNotes(remaining);
  const synced = pending.length - remaining.length;
  if (synced) toast(`Synced ${synced} offline note${synced === 1 ? '' : 's'}`);
  return synced;
}

async function downloadEmergencySnapshot() {
  const envelope = loadEmergencySnapshot();
  let snapshot = { saved_at: new Date().toISOString(), notes: [], pending_notes: loadPendingNotes() };
  if (envelope) {
    const passphrase = await promptDialog({ title: 'Emergency snapshot passphrase', message: 'Enter the passphrase to download decrypted emergency JSON.', type: 'password', required: true });
    if (passphrase === null) return;
    try {
      snapshot = await unlockEmergencySnapshot(passphrase);
    } catch {
      toast('Could not unlock emergency snapshot');
      return;
    }
  }
  snapshot.pending_notes = loadPendingNotes();
  downloadText(JSON.stringify(snapshot, null, 2), `divault-emergency-${new Date().toISOString().slice(0, 10)}.json`);
}

function renderOfflineVault(err, unlockedSnapshot = null) {
  const snapshot = loadEmergencySnapshot();
  const pending = loadPendingNotes();
  const notes = unlockedSnapshot?.notes || [];
  app.innerHTML = `<section class="offline-shell">
    <div class="brand"><div class="brand-mark">${brandMark()}</div><div><h1>DiVault Offline</h1><p class="muted">Server is unreachable. You can still export this device's last synced snapshot or capture a local pending note.</p></div></div>
    <div class="card stack">
      <div class="btn-row"><button class="btn primary" id="retryOnline">Retry server</button><button class="btn" id="downloadSnapshot">Download emergency JSON</button></div>
      <p class="small muted">Encrypted local snapshot: ${snapshot?.saved_at ? esc(new Date(snapshot.saved_at).toLocaleString()) : 'none on this device'}. Pending offline notes: ${pending.length}.</p>
      ${snapshot && !unlockedSnapshot ? `<form id="unlockSnapshotForm" class="btn-row"><input name="passphrase" type="password" placeholder="Emergency snapshot passphrase" autocomplete="current-password" required><button class="btn">Unlock offline snapshot</button></form>` : ''}
      ${unlockedSnapshot ? '<p class="pill">Emergency snapshot unlocked for this view.</p>' : ''}
      <p class="small muted">Offline pending notes are unencrypted local-only drafts until they sync to the server.</p>
      <form id="offlineNoteForm" class="stack">
        <input name="title" placeholder="Offline note title">
        <textarea name="body" placeholder="Capture a note locally until the server comes back"></textarea>
        <button class="btn primary">Save offline note</button>
      </form>
    </div>
    <div class="grid">${[...(pending.map(n => ({ ...n, title: `${n.title || 'Offline note'} (pending, unencrypted local-only draft)` }))), ...(notes.slice(0, 50))].map(note => `<article class="card note-card"><h2>${esc(note.title || 'Note')}</h2><p class="note-body">${esc(stripHiddenSecretLines(note.body || ''))}</p><div class="small muted">${esc(note.updated_at || note.created_at || '')}</div></article>`).join('')}</div>
  </section>`;
  document.querySelector('#retryOnline').addEventListener('click', () => location.reload());
  document.querySelector('#downloadSnapshot').addEventListener('click', downloadEmergencySnapshot);
  document.querySelector('#unlockSnapshotForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      renderOfflineVault(err, await unlockEmergencySnapshot(new FormData(e.target).get('passphrase')));
    } catch { toast('Could not unlock emergency snapshot'); }
  });
  document.querySelector('#offlineNoteForm').addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    addPendingNote({ title: data.title || 'Offline note', body: data.body || '', section: 'All' });
    toast('Saved offline on this device');
    renderOfflineVault(err);
  });
}

function syncLabel() {
  if (!navigator.onLine) return 'Offline';
  if (state.syncing) return 'Syncing...';
  if (!state.lastSyncedAt) return 'Sync ready';
  return `Synced ${state.lastSyncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function updateSyncStatus() {
  document.querySelectorAll('[data-sync-status]').forEach(el => {
    el.textContent = syncLabel();
    el.classList.toggle('offline', !navigator.onLine);
    el.classList.toggle('syncing', state.syncing);
  });
}

async function refreshFromServer({ quiet = true } = {}) {
  if (!state.user || state.panel || document.querySelector('.editor') || document.querySelector('[data-inline-editor]') || state.syncing) return;
  state.syncing = true;
  updateSyncStatus();
  try {
    await loadAll();
    renderApp();
    if (!quiet) toast('Synced');
  } catch (err) {
    if (!quiet) toast(err.message || 'Sync failed');
  } finally {
    state.syncing = false;
    updateSyncStatus();
  }
}

function startSyncLoop() {
  if (state.syncTimer) return;
  window.addEventListener('beforeunload', e => {
    if (!hasUnsavedEditorChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('focus', () => refreshFromServer());
  window.addEventListener('online', () => refreshFromServer({ quiet: false }));
  window.addEventListener('offline', updateSyncStatus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromServer(); });
  state.syncTimer = setInterval(() => refreshFromServer(), 30000);
}

async function loadCurrentSection() {
  if (isNoteSection(state.section)) {
    state.notes = (await loadNotes()).notes;
    return;
  }
  state.assets = (await loadAssets()).assets;
}

async function loadNotes() {
  const params = new URLSearchParams();
  params.set('view', noteView());
  const categoryId = activeNoteCategoryId();
  if (categoryId) params.set('category_id', categoryId);
  const query = parseNoteSearch(state.q);
  if (query.text) params.set('q', query.text);
  params.set('sort', currentNoteSort());
  query.filters.forEach(filter => params.set(filter, '1'));
  return api('/notes?' + params);
}

function parseNoteSearch(value) {
  const filters = new Set();
  const text = String(value || '').split(/\s+/).filter(Boolean).filter(part => {
    const normalized = part.toLowerCase();
    if (normalized === 'has:file' || normalized === 'has:files') { filters.add('has_file'); return false; }
    if (normalized === 'has:secret' || normalized === 'has:secrets') { filters.add('has_secret'); return false; }
    if (normalized === 'has:code') { filters.add('has_code'); return false; }
    return true;
  }).join(' ');
  return { text, filters: [...filters] };
}

async function loadAssets() {
  const params = new URLSearchParams({ type: state.section });
  if (state.q) params.set('q', state.q);
  if (state.clientId) params.set('client_id', state.clientId);
  if (state.includeArchive) params.set('include_archive', '1');
  return api('/assets?' + params);
}

function isNoteSection(section) {
  return String(section || '').startsWith('notes:');
}

function noteLayoutStorageKey(section = state.section) {
  return `divault_note_layout:${section || 'notes:all'}`;
}

function currentNoteLayout() {
  return localStorage.getItem(noteLayoutStorageKey()) || state.noteLayout || 'cards';
}

function setCurrentNoteLayout(layout) {
  state.noteLayout = layout === 'list' ? 'list' : 'cards';
  localStorage.setItem(noteLayoutStorageKey(), state.noteLayout);
  localStorage.setItem('divault_note_layout', state.noteLayout);
}

function currentNoteSort() {
  const allowed = new Set(['updated_desc', 'updated_asc', 'created_desc', 'created_asc', 'title_asc', 'title_desc']);
  return allowed.has(state.noteSort) ? state.noteSort : 'updated_desc';
}

function recentNotes() {
  try { return JSON.parse(localStorage.getItem('divault_recent_notes') || '[]').filter(item => item?.id); }
  catch { return []; }
}

function rememberRecentNote(note) {
  if (!note?.id) return;
  const next = [{ id: Number(note.id), title: note.title || 'Untitled note' }, ...recentNotes().filter(item => Number(item.id) !== Number(note.id))].slice(0, 5);
  localStorage.setItem('divault_recent_notes', JSON.stringify(next));
}

function noteView() {
  if (state.section === 'notes:archive') return 'archive';
  if (state.section === 'notes:trash') return 'trash';
  if (state.section === 'notes:quick') return 'quick';
  return 'all';
}

function activeNoteCategoryId() {
  const match = String(state.section || '').match(/^notes:cat:(\d+)$/);
  return match ? match[1] : '';
}

function sectionLabel(section) {
  if (section === 'notes:all') return 'All';
  if (section === 'notes:quick') return 'Quick notes';
  if (section === 'notes:archive') return 'Archive';
  if (section === 'notes:trash') return 'Recycle bin';
  const noteCategoryId = String(section || '').match(/^notes:cat:(\d+)$/)?.[1];
  if (noteCategoryId) return state.categories.find(c => String(c.id) === noteCategoryId)?.name || 'Category';
  const category = state.categories.find(c => c.slug === section);
  if (category) return category.name;
  return section;
}

function renderApp() {
  const panelOpen = Boolean(state.panel);
  app.innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">${state.user.avatar_data ? `<img src="${esc(state.user.avatar_data)}" alt="">` : brandMark()}</div><div class="brand-text"><h2>DiVault</h2><div class="small muted">${esc(state.user.name)} · ${esc(state.user.role)}</div></div><button class="sidebar-collapse" id="sidebarCollapse" type="button" aria-label="Collapse sidebar" title="Collapse sidebar">‹</button><button class="menu-toggle" id="menuToggle" type="button" aria-label="Open navigation" aria-expanded="false">☰</button></div>
      <nav class="nav">${renderNavGroups()}</nav>
      <div class="sidebar-footer">
        <button class="sync-pill sidebar-sync" data-sync-status type="button" id="syncBtn">${esc(syncLabel())}</button>
        <button class="btn sidebar-action icon-only-btn" id="settingsBtn" aria-label="Settings" title="Settings">${toolIcon('settings', 'Settings')}</button>
        <button class="btn ghost sidebar-action icon-only-btn" id="logoutBtn" aria-label="Log out" title="Log out">${toolIcon('logout', 'Log out')}</button>
      </div>
    </aside>
    <button class="sidebar-backdrop" id="sidebarBackdrop" type="button" aria-label="Close navigation"></button>
    <main class="main">
      ${renderTopbar(panelOpen)}
      ${renderFilterBar(panelOpen)}
      <section id="contentArea">${renderMainContent()}</section>
    </main>
  </div>`;
  bindApp();
}

function renderFilterBar(panelOpen) {
  if (panelOpen) return '';
  if (isNoteSection(state.section)) {
    return `<div class="filterbar notes-filter"><div class="filter-actions filter-actions-left">${state.notes.length && !state.selectionMode ? '<button class="btn" type="button" id="startSelectNotes">Select</button>' : ''}${renderNoteLayoutToggle()}${renderNoteSortSelect()}${state.section === 'notes:trash' ? '<button class="btn danger" id="emptyTrashBtn" type="button">Empty recycle bin</button>' : ''}</div><input class="search" id="search" aria-label="Search notes. Press Q to focus search." title="Press Q to search" placeholder="Search ${esc(sectionLabel(state.section))}...  Q" value="${esc(state.q)}"><div class="filter-actions note-filter-actions"><button class="btn ghost icon-only-btn" id="shortcutsHelpBtn" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button><button class="btn primary icon-only-btn action-fab" id="quickNotesBtn" type="button" aria-label="Quick notes" title="Quick notes (K)">${toolIcon('quick', 'Quick notes')}</button><button class="btn primary icon-only-btn action-fab" id="newBtn" aria-label="New note" title="New full note (N or +)">+</button></div></div>`;
  }
  return `<div class="filterbar"><select id="clientFilter" aria-label="Organization"><option value="">All organizations</option>${state.clients.map(c => `<option value="${c.id}" ${String(c.id) === String(state.clientId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input class="search" id="search" aria-label="Search. Press Q to focus search." title="Press Q to search" placeholder="Search ${esc(sectionLabel(state.section))}...  Q" value="${esc(state.q)}"><label class="checkline"><input type="checkbox" id="includeArchive" ${state.includeArchive ? 'checked' : ''}> Include archive</label></div>`;
}

function renderTopbar(panelOpen) {
  if (!panelOpen && isNoteSection(state.section)) return '';
  return `<div class="topbar"><div>${topbarKicker()}<h1>${esc(panelTitle())}</h1>${topbarSubtitle()}</div><div class="topbar-actions"><button class="btn primary icon-only-btn action-fab" id="quickNotesBtn" type="button" aria-label="Quick notes" title="Quick notes (K)">${toolIcon('quick', 'Quick notes')}</button><button class="btn primary icon-only-btn action-fab" id="newBtn" aria-label="New note" title="New full note (N or +)">+</button></div></div>`;
}

function panelTitle() {
  if (state.panel === 'categories') return 'Categories';
  if (state.panel === 'settings') return 'Settings';
  return sectionLabel(state.section);
}

function topbarContext() {
  if (state.panel === 'categories') return 'Notes';
  if (state.panel === 'settings') return 'DiVault';
  return isNoteSection(state.section) ? 'Notes' : `${activeClientName()} / ${panelTitle()}`;
}

function panelSubtitle() {
  if (state.panel === 'categories') return 'Create, nest, and clean up categories without leaving this view.';
  if (state.panel === 'settings') return 'Account, security, data, and admin tools in one place.';
  return isNoteSection(state.section) ? 'Capture fast now. Organize calmly later.' : 'Track client documentation, assets, credentials, and procedures.';
}

function topbarKicker() {
  return isNoteSection(state.section) && !state.panel ? '' : `<div class="breadcrumb">${esc(topbarContext())}</div>`;
}

function topbarSubtitle() {
  return isNoteSection(state.section) && !state.panel ? '' : `<p class="muted">${esc(panelSubtitle())}</p>`;
}

function renderMainContent() {
  if (state.panel === 'categories') return renderCategoryManagerPanel();
  if (state.panel === 'settings') return `<section class="inline-panel card" id="settingsPanel">${state.settingsHtml || '<p class="muted">Loading settings...</p>'}</section>`;
  return isNoteSection(state.section) ? renderNotesWorkspace() : renderAssetTable();
}

function renderNavGroups() {
  const recent = recentNotes();
  const recentGroup = recent.length ? `<div class="nav-group recent-nav"><div class="nav-heading">Recent</div>${recent.map(note => `<button data-recent-note="${note.id}" title="${esc(note.title)}"><span class="nav-icon">${icon('note')}</span><span class="nav-label">${esc(note.title)}</span></button>`).join('')}</div>` : '';
  const noteGroups = `${recentGroup}<div class="nav-group"><div class="nav-heading">Categories<button class="mini-add" id="addCategoryBtn" type="button" aria-label="Manage note categories">Manage</button></div>
    ${renderNavButton('notes:all', 'All', state.counts['notes:all'] ?? 0, '')}
    ${renderNavButton('notes:quick', 'Quick notes', state.counts['notes:quick'] ?? 0, '')}
    ${renderCategoryTree(null, 'notes')}
    <div class="nav-utility-group">
      ${renderNavButton('notes:archive', 'Archive', state.counts['notes:archive'] ?? 0)}
      ${renderNavButton('notes:trash', 'Recycle bin', state.counts['notes:trash'] ?? 0)}
    </div>
  </div>`;
  return noteGroups;
}

function renderNavButton(key, label, count = 0, dropCategoryId = undefined) {
  const drop = dropCategoryId !== undefined ? `data-drop-category-id="${dropCategoryId}"` : '';
  const category = key.startsWith('notes:cat:') ? state.categories.find(c => String(c.id) === key.replace('notes:cat:', '')) : null;
  const icon = category?.icon || (key === 'notes:all' ? 'folder' : key === 'notes:quick' ? 'quick' : key === 'notes:archive' ? 'receipt' : key === 'notes:trash' ? 'trash' : 'folder');
  return `<button data-section="${esc(key)}" ${drop} class="${state.section === key ? 'active' : ''}" title="${esc(label)}"><span class="nav-icon">${renderCategoryIcon(icon)}</span><span class="nav-label">${esc(label)}</span><span class="nav-count">${count}</span></button>`;
}

function renderCategoryIcon(value) {
  const key = legacyCategoryIcons[value] || value || 'folder';
  return icon(key) || esc(String(value || '').slice(0, 2));
}

function renderCategoryTree(parentId = null, mode = 'notes', depth = 0) {
  const items = state.categories.filter(c => String(c.parent_id || '') === String(parentId || ''));
  if (!items.length && parentId === null) return '<p class="empty-nav">Add your first category.</p>';
  return items.map(c => {
    const key = mode === 'notes' ? `notes:cat:${c.id}` : c.slug;
    const count = mode === 'notes' ? (state.counts[`notes:cat:${c.id}`] ?? 0) : (state.counts[c.slug] ?? 0);
    return `<div class="nav-tree-item" style="--depth:${depth}">${renderNavButton(key, c.name, count, mode === 'notes' ? c.id : null)}${renderCategoryTree(c.id, mode, depth + 1)}</div>`;
  }).join('');
}

function categoryOptions(selectedId = '', parentId = null, depth = 0) {
  return state.categories.filter(c => String(c.parent_id || '') === String(parentId || '')).map(c => {
    const label = `${'-- '.repeat(depth)}${c.name}`;
    return `<option value="${c.id}" ${String(selectedId || '') === String(c.id) ? 'selected' : ''}>${esc(label)}</option>${categoryOptions(selectedId, c.id, depth + 1)}`;
  }).join('');
}

function selectedVisibleNoteIds() {
  const visible = new Set(state.notes.map(note => Number(note.id)));
  return [...state.selectedNoteIds].filter(id => visible.has(Number(id)));
}

function activeClientName() {
  if (!state.clientId) return 'All organizations';
  return state.clients.find(c => String(c.id) === String(state.clientId))?.name || 'Organization';
}

function renderNotes() {
  if (!state.notes.length) return `<div class="empty card"><h2>No notes here yet</h2><p>Tap + to capture a quick thought, photo, file, password, checklist, or client note.</p></div>`;
  const titleOnly = Boolean(state.active) && currentNoteLayout() === 'list';
  const privateList = state.noteFocus && Boolean(state.active);
  return state.notes.map(note => `<article class="card note-card ${titleOnly ? 'title-only' : ''} ${state.active && Number(state.active.id) === Number(note.id) ? 'active' : ''} ${state.selectedNoteIds.has(Number(note.id)) ? 'selected' : ''}" draggable="true" data-note-id="${note.id}" data-open-card="${note.id}" tabindex="0" role="button" aria-label="Open ${esc(note.title || 'note')}">
    <div class="note-title-row">${state.selectionMode ? `<label class="note-select"><input type="checkbox" data-select-note="${note.id}" ${state.selectedNoteIds.has(Number(note.id)) ? 'checked' : ''} aria-label="Select ${esc(note.title)}"><span class="sr-only">Select ${esc(note.title)}</span></label>` : ''}<button data-open="${note.id}"><h2>${privateList && !(state.active && Number(state.active.id) === Number(note.id)) ? 'Hidden note' : `${Number(note.pinned) ? '★ ' : ''}${esc(note.title)}`}</h2></button></div>
    ${titleOnly || privateList ? '' : `
    <div class="pill-row">
      ${note.category_name ? `<span class="pill">${esc(note.category_name)}</span>` : ''}
      ${note.client_name ? `<span class="pill">${esc(note.client_name)}</span>` : ''}
      ${note.tags ? esc(note.tags).split(',').slice(0,3).map(t => `<span class="pill">#${t.trim()}</span>`).join('') : ''}
      ${Number(note.secret_count) ? `<span class="pill secret">${note.secret_count} hidden</span>` : ''}
      ${Number(note.file_count) ? `<span class="pill file">${note.file_count} file</span>` : ''}
    </div>
    <div class="small muted">${esc(note.updated_at)}</div>
    `}
  </article>`).join('');
}

function renderNoteLayoutToggle() {
  if (!state.notes.length) return '';
  const layout = currentNoteLayout();
  return `<div class="note-layout-toggle" role="group" aria-label="Note view">
    <button class="btn ghost icon-only-btn ${layout === 'cards' ? 'active' : ''}" type="button" data-note-layout="cards" aria-label="Cards view" title="Cards view for ${esc(sectionLabel(state.section))}">${toolIcon('cards', 'Cards view')}</button>
    <button class="btn ghost icon-only-btn ${layout === 'list' ? 'active' : ''}" type="button" data-note-layout="list" aria-label="List view" title="List view for ${esc(sectionLabel(state.section))}">${toolIcon('list', 'List view')}</button>
  </div>`;
}

function renderNoteSortSelect() {
  return `<label class="note-sort-control" title="Sort notes">${toolIcon('sort', 'Sort notes')}<select id="noteSort" aria-label="Sort notes">
    <option value="updated_desc" ${currentNoteSort() === 'updated_desc' ? 'selected' : ''}>Updated newest</option>
    <option value="updated_asc" ${currentNoteSort() === 'updated_asc' ? 'selected' : ''}>Updated oldest</option>
    <option value="created_desc" ${currentNoteSort() === 'created_desc' ? 'selected' : ''}>Created newest</option>
    <option value="created_asc" ${currentNoteSort() === 'created_asc' ? 'selected' : ''}>Created oldest</option>
    <option value="title_asc" ${currentNoteSort() === 'title_asc' ? 'selected' : ''}>A to Z</option>
    <option value="title_desc" ${currentNoteSort() === 'title_desc' ? 'selected' : ''}>Z to A</option>
  </select></label>`;
}

function showShortcutsHelp() {
  alertDialog({ title: 'Keyboard shortcuts', message: 'Q: search notes\nK: quick note\nN or +: new full note\nEsc: close dialogs\nFocus mode: use the Focus button in the note editor.' });
}

function renderBulkNoteActions() {
  if (!state.notes.length) return '';
  const selectedCount = selectedVisibleNoteIds().length;
  const trashView = state.section === 'notes:trash';
  if (!state.selectionMode) return '';
  return `<div class="bulk-note-actions card ${selectedCount ? 'has-selection' : ''}">
    <span class="small muted">${selectedCount ? `${selectedCount} selected` : 'Select notes for bulk actions or drag selected notes into a category.'}</span>
    <button class="btn ghost bulk-icon-btn" type="button" id="selectAllNotes">${toolIcon('selectAll', 'Select all')}<span>Select all</span></button>
    ${selectedCount ? `<button class="btn ghost bulk-icon-btn" type="button" id="selectNoNotes">${toolIcon('selectNone', 'Select none')}<span>Select none</span></button>` : ''}
    <button class="btn ghost" type="button" id="clearSelectedNotes">Done</button>
    ${selectedCount && !trashView ? `<select id="bulkMoveCategory" aria-label="Move selected notes"><option value="">Move to All</option>${categoryOptions()}</select><button class="btn" type="button" id="bulkMoveNotes">Move</button><button class="btn" type="button" id="bulkArchiveNotes">Archive</button><span class="bulk-danger-zone"><button class="btn danger icon-only-btn" type="button" id="bulkTrashNotes" aria-label="Recycle selected notes" title="Recycle selected notes">${toolIcon('trash', 'Recycle selected notes')}</button></span>` : ''}
    ${selectedCount && trashView ? '<button class="btn primary" type="button" id="bulkRestoreNotes">Restore</button><button class="btn danger" type="button" id="bulkPermanentDeleteNotes">Delete forever</button>' : ''}
  </div>`;
}

function renderNotesWorkspace() {
  const editorOpen = Boolean(state.active);
  const listView = currentNoteLayout() === 'list';
  const paneWidth = Math.min(520, Math.max(220, Number(state.notePaneWidth) || 300));
  return `<div class="notes-workspace ${editorOpen ? 'editor-open' : ''} ${listView ? 'list-view' : ''} ${editorOpen && state.noteFocus ? 'focus-mode' : ''}" style="--note-pane-width: ${paneWidth}px;">
    <div class="notes-list-pane">
      ${renderBulkNoteActions()}
      <div class="grid notes-grid" id="notesGrid">${renderNotes()}</div>
    </div>
    ${editorOpen ? '<button class="note-pane-resizer" id="notePaneResizer" type="button" aria-label="Resize notes list" title="Drag to resize notes list"></button>' : ''}
    <div class="inline-editor-slot" id="inlineEditorSlot">
      ${editorOpen ? renderInlineEditor() : `<div class="cli-placeholder card"><div class="terminal-dots"><span></span><span></span><span></span></div><p class="terminal-path">divault ~/notes</p><h2>Choose a note or start from the toolbar</h2><p class="muted">Quick note (K) is for fast plain text. Full note (+ or N) adds blocks, files, code, drawings, and secrets. Press Q anytime to search.</p></div>`}
    </div>
  </div>`;
}

function renderInlineEditor() {
  const id = state.active?.id ? Number(state.active.id) : null;
  const note = state.activeExtra?.note || state.active || emptyDraftNote();
  const visibleBody = stripHiddenSecretLines(note.body || '');
  const hiddenMarkers = collectHiddenSecretLines(note.body || '');
  const editing = state.editingNote || !id;
  const hasInlineSecrets = String(visibleBody || '').split(/\r?\n/).some(line => lockedLinePattern().test(line) || secretLinePattern().test(line));
  const quickMode = ((!id && state.newNoteMode === 'quick') || (id && state.section === 'notes:quick' && !note.category_id)) && !hasInlineSecrets;
  if (!editing) return renderReadOnlyNote(note, visibleBody, id);
  const focusLabel = state.noteFocus ? 'Show notes' : 'Focus';
  const editorActions = `<div class="btn-row note-top-actions"><button class="btn ghost icon-only-btn" data-editor-command="undo" type="button" aria-label="Undo" title="Undo">${toolIcon('undo', 'Undo')}</button><button class="btn ghost icon-only-btn" data-editor-command="redo" type="button" aria-label="Redo" title="Redo">${toolIcon('redo', 'Redo')}</button><button type="button" class="btn ghost icon-only-btn ${state.noteFocus ? 'active' : ''}" id="focusNoteBtn" aria-label="${focusLabel}" title="${focusLabel}">${toolIcon('focus', focusLabel)}</button>${id ? `<button type="button" class="btn" id="archiveNote">Archive</button><button type="button" class="btn danger" id="deleteNote">Recycle</button>` : ''}<button class="btn primary" form="noteForm" type="submit">Save</button><button class="btn ghost" data-close-inline type="button">Back</button></div>`;
  return `<section class="editor-panel note-editor-panel inline-note-editor" data-inline-editor data-editing="1" data-is-new-note="${id ? '0' : '1'}">
    <div class="topbar editor-topbar terminal-topbar"><div><p class="terminal-path">divault ~/notes/${id || (quickMode ? 'quick' : 'new')}</p><h2>${quickMode ? 'Quick note' : (id ? 'Edit note' : 'New note')}</h2></div>${editorActions}</div>
    <form id="noteForm" class="note-editor-form">
      <div class="note-main">
        <input class="note-title-input" name="title" value="${esc(note.title)}" placeholder="${quickMode ? 'Quick note title' : 'Untitled note'}" aria-label="Note title">
        ${quickMode ? `<div class="editor-toolbar block-add-toolbar" aria-label="Quick note actions"><button type="button" class="tool-chip" data-photo-help title="Attach photo or file" aria-label="Attach photo or file">${toolIcon('file', 'Attach photo or file')}</button></div>` : `<div class="editor-toolbar block-add-toolbar" aria-label="Add note section">
          <button type="button" class="tool-chip" data-add-block="paragraph" title="Paragraph" aria-label="Add paragraph">${toolIcon('paragraph', 'Paragraph')}</button>
          <button type="button" class="tool-chip" data-add-block="table" title="Table" aria-label="Add table">${toolIcon('table', 'Table')}</button>
          <button type="button" class="tool-chip" data-add-block="code" title="Code block" aria-label="Add code block">${toolIcon('code', 'Code block')}</button>
          <button type="button" class="tool-chip secret-tool" data-add-block="secret" title="Secret block" aria-label="Add secret block">${toolIcon('secret', 'Secret block')}</button>
          <button type="button" class="tool-chip" data-add-block="drawing" title="Drawing canvas" aria-label="Add drawing canvas">${toolIcon('draw', 'Drawing')}</button>
          <button type="button" class="tool-chip" data-photo-help title="Attach photo or file" aria-label="Attach photo or file">${toolIcon('file', 'Attach photo or file')}</button>
        </div>`}
        <input type="hidden" name="category_id" value="${esc(quickMode ? '' : (note.category_id || activeNoteCategoryId()))}">
        <input type="hidden" name="client_id" value="${esc(note.client_id || '')}">
        <input type="hidden" name="tags" value="${esc(note.tags || '')}">
        <input type="hidden" name="category" value="${esc(note.category || '')}">
        <input type="hidden" name="section" value="All">
        <input type="hidden" name="type" value="${esc(note.type || 'text')}">
        <input type="hidden" name="body" id="noteBodySerialized" value="${esc(visibleBody)}">
        ${quickMode ? `<textarea class="quick-note-body" name="body" data-simple-body placeholder="Type the quick note here. No formatting, no blocks, just text.">${esc(visibleBody)}</textarea>` : `<div class="block-editor" data-block-editor>${renderEditorBlocks(parseBodyToBlocks(visibleBody))}</div>`}
        <input type="hidden" name="existing_secret_markers" value="${esc(hiddenMarkers.join('\n'))}">
        <input id="fileInput" class="hidden" type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json,.zip,.doc,.docx,.xls,.xlsx">
        <div id="pendingAttachments">${renderPendingAttachments()}</div>
        ${renderNoteExtras(visibleBody, note.title || 'note', state.activeExtra || {})}
        <p class="small muted editor-sync">Saved notes sync through the server on every device.</p>
      </div>
        ${id ? renderVersionPanel(id) : ''}
    </form>
  </section>`;
}

function renderReadOnlyNote(note, visibleBody, id) {
  const recycleIcon = `<button class="btn danger icon-only-btn" data-trash-note-readonly type="button" aria-label="Recycle" title="Recycle">${toolIcon('trash', 'Recycle')}</button>`;
  const recoveryActions = Number(note.deleted) ? '<button class="btn primary" data-restore-note type="button">Restore</button><button class="btn danger" data-permanent-delete-note type="button">Delete forever</button>' : (Number(note.archived) ? '<button class="btn primary" data-restore-note type="button">Restore</button>' : `<button class="btn" data-archive-note-readonly type="button">Archive</button>${recycleIcon}`);
  const focusLabel = state.noteFocus ? 'Show notes' : 'Focus';
  return `<section class="editor-panel note-editor-panel inline-note-editor readonly-note" data-inline-editor data-editing="0">
    <div class="topbar editor-topbar terminal-topbar"><div><p class="terminal-path">divault ~/notes/${id}</p><h2>${esc(note.title || 'Untitled note')}</h2></div><div class="btn-row"><button class="btn ghost icon-only-btn ${state.noteFocus ? 'active' : ''}" id="focusNoteBtn" type="button" aria-label="${focusLabel}" title="${focusLabel}">${toolIcon('focus', focusLabel)}</button>${recoveryActions}<button class="btn primary" data-edit-note type="button">Edit</button><button class="btn ghost" data-close-inline type="button">Back</button></div></div>
    <div class="note-read-body">${renderReadableBlocks(parseBodyToBlocks(visibleBody))}</div>
    ${renderNoteExtras(visibleBody, note.title || 'note', state.activeExtra || {})}
    ${renderVersionPanel(id)}
  </section>`;
}

function renderNoteExtras(body, title, extra = {}) {
  const codeBlocks = renderCodeBlocks(body, title);
  const secrets = renderSecrets(extra.secrets || []);
  const files = renderFiles(extra.files || []);
  if (!codeBlocks && !secrets && !files) return '';
  const count = parseCodeBlocks(body).length + (extra.secrets || []).length + (extra.files || []).length;
  return `<details class="details-panel note-support-panel">
    <summary>Note extras${count ? ` (${count})` : ''}</summary>
    <div class="inline-note-blocks">
      <div id="codeBlocks">${codeBlocks}</div>
      <div id="secretBlocks">${secrets}</div>
      <div id="fileBlocks">${files}</div>
    </div>
  </details>`;
}

function renderVersionPanel(noteId) {
  const versions = state.activeExtra?.versions || [];
  return `<details class="details-panel version-panel"><summary>Versions</summary><div id="versionPreview"></div>${versions.length ? versions.map(v => `<div class="version-row"><span><b>${esc(v.title)}</b><br><span class="small muted">${esc(v.created_at)}</span></span><span class="btn-row"><button class="btn ghost" type="button" data-preview-version="${v.id}" data-note-id="${noteId}">Preview</button><button class="btn ghost" type="button" data-restore-version="${v.id}" data-note-id="${noteId}">Restore</button></span></div>`).join('') : '<p class="small muted">No previous versions yet.</p>'}</details>`;
}

function renderReadableBlocks(blocks) {
  return blocks.map(block => {
    if (block.type === 'paragraph') return `<div class="read-block rich-output">${sanitizeRichHtml(block.text || '').replace(/\n/g, '<br>')}</div>`;
    if (block.type === 'heading') return `<h${Math.min(5, Math.max(1, Number(block.level || 2)))}>${esc(block.text || '')}</h${Math.min(5, Math.max(1, Number(block.level || 2)))}>`;
    if (block.type === 'bullet') return `<ul>${listLines(block.text).map(line => `<li>${esc(line)}</li>`).join('')}</ul>`;
    if (block.type === 'numbered') return `<ol>${listLines(block.text).map(line => `<li>${esc(line)}</li>`).join('')}</ol>`;
    if (block.type === 'checklist') return `<div class="read-check">${block.checked ? '☑' : '☐'} ${esc(block.text || '')}</div>`;
    if (block.type === 'quote') return `<blockquote>${esc(block.text || '').replace(/\n/g, '<br>')}</blockquote>`;
    if (block.type === 'table') return `<div class="table-editor-grid readonly-table">${renderReadOnlyTable(block.rows)}</div>`;
    if (block.type === 'code') return renderReadableCode(block.text || '');
    if (block.type === 'secret') return renderInlineSecret(block.label, block.value);
    if (block.type === 'drawing' && block.dataUrl) return `<img class="read-drawing" src="${esc(block.dataUrl)}" alt="Drawing">`;
    return '';
  }).join('');
}

function renderReadableCode(code) {
  const text = String(code || '');
  const lines = text.split('\n');
  const numbers = Array.from({ length: Math.max(1, lines.length) }, (_, index) => index + 1).join('\n');
  return `<div class="read-code-shell"><div class="code-view-topbar"><span>${lines.length} line${lines.length === 1 ? '' : 's'}</span><button class="btn ghost" type="button" data-copy-readable-code data-code="${esc(text)}">Copy</button></div><pre class="read-code"><span class="code-line-numbers" aria-hidden="true">${numbers}</span><code>${esc(text)}</code></pre></div>`;
}

function renderInlineSecret(label, value) {
  const id = `inline-secret-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  return `<div class="inline-secret-read" data-inline-secret-read><b>🔒 ${esc(label || 'Secret')}</b><span class="secret-value" id="${id}" data-secret-mask>••••••••••</span><div class="btn-row"><button type="button" class="icon-action" data-inline-secret-reveal="${id}" data-secret-value="${esc(value || '')}" title="Reveal" aria-label="Reveal secret">👁</button><button type="button" class="icon-action" data-inline-secret-copy data-secret-value="${esc(value || '')}" title="Copy" aria-label="Copy secret">⧉</button></div></div>`;
}

function bindApp() {
  bindThemeControls();
  bindGlobalShortcuts();
  document.querySelector('#menuToggle')?.addEventListener('click', () => toggleMobileMenu());
  document.querySelector('#sidebarCollapse')?.addEventListener('click', () => toggleDesktopSidebar());
  restoreDesktopSidebarState();
  document.querySelector('#sidebarBackdrop')?.addEventListener('click', () => toggleMobileMenu(false));
  document.querySelectorAll('[data-section]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    state.section = btn.dataset.section;
    state.panel = '';
    localStorage.setItem('divault_section', state.section);
    state.q = '';
    state.active = null;
    state.activeExtra = null;
    state.editingNote = false;
    state.selectionMode = false;
    state.selectedNoteIds.clear();
    toggleMobileMenu(false);
    await loadCurrentSection();
    renderApp();
  }));
  bindNoteDropTargets();
  document.querySelector('#quickNotesBtn')?.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    if (state.panel || !['notes:all', 'notes:quick'].includes(state.section)) {
      state.section = 'notes:all';
      state.panel = '';
      state.q = '';
      await loadCurrentSection();
      renderApp();
    }
    openEditor(null, { mode: 'quick' });
  });
  document.querySelector('#newBtn')?.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    if (state.panel || !isNoteSection(state.section)) {
      state.section = 'notes:all';
      state.panel = '';
      state.q = '';
      await loadCurrentSection();
      renderApp();
    }
    openEditor(null, { mode: 'full' });
  });
  document.querySelector('#logoutBtn')?.addEventListener('click', () => runUserAction(async () => {
    toggleMobileMenu(false);
    await api('/logout', { method: 'POST' });
    clearSensitiveLocalData();
    state.user = null;
    state.notes = [];
    state.assets = [];
    renderLogin();
  }, 'Logout failed'));
  document.querySelector('#settingsBtn')?.addEventListener('click', () => { toggleMobileMenu(false); openSettings(); });
  document.querySelector('#addCategoryBtn')?.addEventListener('click', () => { toggleMobileMenu(false); openCategoryManager(); });
  document.querySelectorAll('[data-recent-note]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    state.panel = '';
    toggleMobileMenu(false);
    openEditor(Number(btn.dataset.recentNote));
  }));
  document.querySelector('#clientFilter')?.addEventListener('change', async e => {
    state.clientId = e.target.value;
    localStorage.setItem('divault_client_id', state.clientId);
    await loadCurrentSection();
    renderApp();
  });
  document.querySelector('#includeArchive')?.addEventListener('change', async e => {
    state.includeArchive = e.target.checked;
    await loadCurrentSection();
    renderApp();
  });
  document.querySelector('#noteSort')?.addEventListener('change', async e => {
    state.noteSort = e.target.value;
    localStorage.setItem('divault_note_sort', state.noteSort);
    state.active = null;
    state.activeExtra = null;
    state.editingNote = false;
    state.selectionMode = false;
    state.selectedNoteIds.clear();
    await loadCurrentSection();
    renderApp();
  });
  document.querySelector('#shortcutsHelpBtn')?.addEventListener('click', showShortcutsHelp);
  document.querySelector('#syncBtn')?.addEventListener('click', () => refreshFromServer({ quiet: false }));
  document.querySelector('#emptyTrashBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Empty recycle bin?', message: 'This permanently deletes every note in the recycle bin.', confirmText: 'Empty recycle bin' })) return;
    await runUserAction(async () => {
      await api('/trash/notes', { method: 'DELETE' });
      toast('Recycle bin emptied');
      await loadAll();
      renderApp();
    }, 'Empty recycle bin failed');
  });
  document.querySelector('#search')?.addEventListener('input', debounce(async e => {
    state.q = e.target.value;
    state.active = null;
    state.activeExtra = null;
    state.editingNote = false;
    state.selectionMode = false;
    state.selectedNoteIds.clear();
    await loadCurrentSection();
    document.querySelector('#contentArea').innerHTML = isNoteSection(state.section) ? renderNotesWorkspace() : renderAssetTable();
    bindContentActions();
  }, 240));
  bindContentActions();
}

function bindGlobalShortcuts() {
  if (window.__divaultShortcutsBound) return;
  window.__divaultShortcutsBound = true;
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    const typing = active?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (typing) return;
    const key = event.key.toLowerCase();
    if (key === 'q') {
      const search = document.querySelector('#search');
      if (!search) return;
      event.preventDefault();
      search.focus({ preventScroll: true });
      search.select?.();
    }
    if (key === 'k') {
      const quick = document.querySelector('#quickNotesBtn');
      if (!quick) return;
      event.preventDefault();
      quick.click();
    }
    if (key === 'n' || event.key === '+') {
      const full = document.querySelector('#newBtn');
      if (!full) return;
      event.preventDefault();
      full.click();
    }
  });
}

function toggleDesktopSidebar(force) {
  const collapsed = typeof force === 'boolean' ? force : !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('divault_sidebar_collapsed', collapsed ? '1' : '0');
  const btn = document.querySelector('#sidebarCollapse');
  if (btn) {
    btn.textContent = collapsed ? '›' : '‹';
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
}

function restoreDesktopSidebarState() {
  toggleDesktopSidebar(localStorage.getItem('divault_sidebar_collapsed') === '1');
}

function toggleMobileMenu(force) {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.querySelector('#sidebarBackdrop');
  const toggle = document.querySelector('#menuToggle');
  if (!sidebar || !backdrop || !toggle) return;
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}

function bindContentActions() {
  bindCategoryPanel(document.querySelector('#categoryPanel'));
  bindSettingsPanel(document.querySelector('#settingsPanel'));
  bindNotePaneResize();
  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    openEditor(Number(el.dataset.open));
  }));
  document.querySelectorAll('[data-open-card]').forEach(card => card.addEventListener('click', async e => {
    if (e.target.closest('button, input, label, a, select, textarea')) return;
    if (!await confirmDiscardUnsaved()) return;
    openEditor(Number(card.dataset.openCard));
  }));
  document.querySelectorAll('[data-open-card]').forEach(card => card.addEventListener('keydown', async e => {
    if (!['Enter', ' '].includes(e.key)) return;
    if (e.target.closest('button, input, label, a, select, textarea')) return;
    e.preventDefault();
    if (!await confirmDiscardUnsaved()) return;
    openEditor(Number(card.dataset.openCard));
  }));
  document.querySelectorAll('[data-copy-readable-code]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    await navigator.clipboard.writeText(btn.dataset.code || '');
    toast('Code copied');
  }));
  document.querySelectorAll('[data-note-layout]').forEach(btn => btn.addEventListener('click', () => {
    setCurrentNoteLayout(btn.dataset.noteLayout);
    updateNoteLayoutToggleState();
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  }));
  document.querySelectorAll('[data-select-note]').forEach(input => input.addEventListener('click', e => e.stopPropagation()));
  document.querySelectorAll('[data-select-note]').forEach(input => input.addEventListener('change', e => {
    const id = Number(e.target.dataset.selectNote);
    if (e.target.checked) state.selectedNoteIds.add(id);
    else state.selectedNoteIds.delete(id);
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  }));
  document.querySelector('#startSelectNotes')?.addEventListener('click', () => {
    state.selectionMode = true;
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  document.querySelector('#selectAllNotes')?.addEventListener('click', () => {
    state.selectionMode = true;
    state.notes.forEach(note => state.selectedNoteIds.add(Number(note.id)));
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  document.querySelector('#selectNoNotes')?.addEventListener('click', () => {
    state.selectedNoteIds.clear();
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  document.querySelector('#clearSelectedNotes')?.addEventListener('click', () => {
    state.selectionMode = false;
    state.selectedNoteIds.clear();
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  document.querySelector('#bulkMoveNotes')?.addEventListener('click', () => bulkMoveSelectedNotes(document.querySelector('#bulkMoveCategory')?.value || ''));
  document.querySelector('#bulkArchiveNotes')?.addEventListener('click', () => bulkNoteAction('archive'));
  document.querySelector('#bulkTrashNotes')?.addEventListener('click', () => bulkNoteAction('trash'));
  document.querySelector('#bulkRestoreNotes')?.addEventListener('click', () => bulkNoteAction('restore'));
  document.querySelector('#bulkPermanentDeleteNotes')?.addEventListener('click', () => bulkNoteAction('permanent'));
  document.querySelectorAll('[data-preview-version]').forEach(btn => btn.addEventListener('click', () => previewVersion(Number(btn.dataset.noteId), Number(btn.dataset.previewVersion))));
  document.querySelectorAll('[data-restore-version]').forEach(btn => btn.addEventListener('click', () => restoreVersion(Number(btn.dataset.noteId), Number(btn.dataset.restoreVersion))));
  document.querySelectorAll('[data-preview-file]').forEach(btn => btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.fileName || 'File preview', btn.dataset.fileMime || '')));
  document.querySelector('[data-inline-editor]') && bindInlineEditor(document.querySelector('[data-inline-editor]'));
  document.querySelectorAll('[data-note-id]').forEach(card => {
    card.addEventListener('dragstart', e => {
      const id = Number(card.dataset.noteId);
      const ids = state.selectedNoteIds.has(id) ? selectedVisibleNoteIds() : [id];
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.setData('application/x-divault-note-ids', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('[data-asset]').forEach(el => el.addEventListener('click', () => openAssetEditor(Number(el.dataset.asset))));
  document.querySelectorAll('[data-archive-asset]').forEach(el => el.addEventListener('click', async () => {
    await runUserAction(async () => {
      await api(`/assets/${el.dataset.archiveAsset}`, { method: 'DELETE' });
      toast('Archived');
      await loadAll();
      renderApp();
    }, 'Archive failed');
  }));
}

function updateNoteLayoutToggleState() {
  const layout = currentNoteLayout();
  document.querySelectorAll('[data-note-layout]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.noteLayout === layout);
  });
}

function bindNotePaneResize() {
  const handle = document.querySelector('#notePaneResizer');
  const workspace = document.querySelector('.notes-workspace.editor-open');
  if (!handle || !workspace || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('resizing-note-pane');
    const rect = workspace.getBoundingClientRect();
    const max = Math.min(560, Math.max(260, rect.width - 460));
    const move = e => {
      const width = Math.min(max, Math.max(220, Math.round(e.clientX - rect.left)));
      state.notePaneWidth = width;
      localStorage.setItem('divault_note_pane_width', String(width));
      workspace.style.setProperty('--note-pane-width', `${width}px`);
    };
    const done = () => {
      document.body.classList.remove('resizing-note-pane');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  });
}

function bindNoteDropTargets() {
  document.querySelectorAll('[data-drop-category-id]').forEach(target => {
    target.addEventListener('dragover', e => {
      e.preventDefault();
      target.classList.add('drop-ready');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-ready'));
    target.addEventListener('drop', async e => {
      e.preventDefault();
      target.classList.remove('drop-ready');
      const ids = droppedNoteIds(e);
      if (!ids.length) return;
      await runUserAction(() => moveNotesToCategory(ids, target.dataset.dropCategoryId || ''), 'Move failed');
    });
  });
}

function droppedNoteIds(event) {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData('application/x-divault-note-ids') || '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed.map(Number).filter(Boolean);
  } catch {}
  const id = Number(event.dataTransfer.getData('text/plain'));
  return id ? [id] : [];
}

async function moveNoteToCategory(id, categoryId) {
  await moveNotesToCategory([id], categoryId);
}

async function moveNotesToCategory(ids, categoryId) {
  for (const id of ids) {
  const details = await api('/notes/' + id);
  const note = details.note;
  await api('/notes', { method: 'POST', body: { id, title: note.title, body: note.body, type: note.type, section: 'All', category_id: categoryId, category: note.category || '', tags: note.tags || '', client_id: note.client_id || '' } });
  }
  state.selectedNoteIds.clear();
  toast(`Moved ${ids.length} note${ids.length === 1 ? '' : 's'} to ${categoryId ? sectionLabel(`notes:cat:${categoryId}`) : 'All'}`);
  await loadAll();
  renderApp();
}

function renderAssetTable() {
  const rows = state.assets;
  if (!rows.length) return `<div class="empty card"><h2>No ${esc(sectionLabel(state.section))}</h2><p>Create the first record for this documentation section.</p></div>`;
  return `<div class="table-wrap"><table class="asset-table"><thead><tr>${assetColumns().map(c => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(row => `<tr>${assetColumns().map(c => `<td>${formatAssetCell(row, c.key)}</td>`).join('')}<td class="row-actions"><button class="icon-btn" data-asset="${row.id}" title="Edit">edit</button><button class="icon-btn" data-archive-asset="${row.id}" title="Archive">archive</button></td></tr>`).join('')}</tbody></table></div>`;
}

function assetColumns() {
  return [{ key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }, { key: 'asset_type', label: 'Type' }, { key: 'os', label: 'OS' }, { key: 'primary_ip', label: 'Primary IP' }, { key: 'serial_number', label: 'Serial Number' }, { key: 'expires_at', label: 'Expires' }, { key: 'location', label: 'Location' }, { key: 'contact', label: 'Contact' }];
}

function formatAssetCell(row, key) {
  const value = row[key] || '';
  if (key === 'name') return `<button class="link-button" data-asset="${row.id}">${esc(value)}</button>`;
  if (key === 'expires_at' && value) return `<span class="${new Date(value) < new Date() ? 'expired' : ''}">${esc(value)}</span>`;
  return esc(value);
}

function themeButton() {
  return `<button class="theme-button" type="button" data-theme-toggle aria-label="Toggle theme">${document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark'}</button>`;
}

function themePresetPicker() {
  return `<div class="theme-presets">${themePresets.map(theme => `<button type="button" class="theme-preset ${state.theme === theme.key ? 'active' : ''}" data-theme-preset="${theme.key}"><span class="theme-swatch theme-${theme.key}"></span><b>${esc(theme.label)}</b><small>${esc(theme.note)}</small></button>`).join('')}</div>`;
}

function bindThemeControls(root = document) {
  root.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
      document.querySelectorAll('[data-theme-toggle]').forEach(other => { other.textContent = state.theme === 'dark' ? 'Light' : 'Dark'; });
    });
  });
  root.querySelectorAll('[data-theme-preset]').forEach(button => button.addEventListener('click', () => {
    setTheme(button.dataset.themePreset);
    document.querySelectorAll('[data-theme-preset]').forEach(other => other.classList.toggle('active', other.dataset.themePreset === state.theme));
  }));
}

function parseBodyToBlocks(body) {
  const text = String(body || '').trim();
  if (!text) return [{ type: 'paragraph', text: '' }];
  const blocks = [];
  const pattern = /```([\w+-]*)\n([\s\S]*?)```|\$\$\n?([\s\S]*?)\n?\$\$/g;
  let last = 0;
  let match;
  const pushPlain = value => {
    String(value || '').split(/\n{2,}/).map(part => part.trim()).filter(Boolean).forEach(part => {
      const lines = part.split(/\r?\n/);
      if (lines.length === 1 && /^#{1,5}\s+/.test(part)) {
        const heading = part.match(/^(#{1,5})\s+(.+)$/);
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      }
      else if (lines.every(line => /^- \[[ xX]\]\s+/.test(line))) lines.forEach(line => blocks.push({ type: 'checklist', checked: /^- \[[xX]\]/.test(line), text: line.replace(/^- \[[ xX]\]\s+/, '') }));
      else if (lines.every(line => /^-\s+/.test(line))) blocks.push({ type: 'bullet', text: lines.map(line => line.replace(/^-\s+/, '')).join('\n') });
      else if (lines.every(line => /^\d+\.\s+/.test(line))) blocks.push({ type: 'numbered', text: lines.map(line => line.replace(/^\d+\.\s+/, '')).join('\n') });
      else if (lines.every(line => /^>\s?/.test(line))) blocks.push({ type: 'quote', text: lines.map(line => line.replace(/^>\s?/, '')).join('\n') });
      else if (lines.length === 1 && /^-{3,}$/.test(part)) blocks.push({ type: 'hr' });
      else if (lines.length >= 2 && lines.every(line => /^\|.*\|$/.test(line))) blocks.push({ type: 'table', rows: parseMarkdownTable(part) });
      else if (lines.length === 1 && (lockedLinePattern().test(part) || secretLinePattern().test(part))) {
        const secret = part.match(lockedLinePattern()) || part.match(secretLinePattern());
        blocks.push({ type: 'secret', label: secret[1], value: secret[2] });
      } else if (lines.length === 1 && /^!\[drawing\]\(data:image\/png;base64,/.test(part)) {
        blocks.push({ type: 'drawing', dataUrl: part.replace(/^!\[drawing\]\((.+)\)$/, '$1') });
      } else {
        blocks.push({ type: 'paragraph', text: part });
      }
    });
  };
  while ((match = pattern.exec(text))) {
    pushPlain(text.slice(last, match.index));
    if (match[0].startsWith('```')) {
      const lang = match[1] || 'text';
      const value = match[2].replace(/\n$/, '');
      blocks.push({ type: 'code', lang, text: value });
    }
    else blocks.push({ type: 'math', text: (match[3] || '').trim() });
    last = pattern.lastIndex;
  }
  pushPlain(text.slice(last));
  return blocks.length ? blocks : [{ type: 'paragraph', text: '' }];
}

function renderEditorBlocks(blocks) {
  return blocks.map(block => renderEditorBlock(block)).join('');
}

function blockMoveControls() {
  return '<div class="block-move-controls"><button type="button" class="icon-action" data-move-block="up" title="Move section up" aria-label="Move section up">↑</button><button type="button" class="icon-action" data-move-block="down" title="Move section down" aria-label="Move section down">↓</button></div>';
}

function renderEditorBlock(block) {
  const id = crypto.randomUUID?.() || `block-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (block.type === 'heading') return `<div class="editor-block heading-block" data-block="heading" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><select data-heading-level>${[1,2,3,4,5].map(level => `<option value="${level}" ${Number(block.level || 1) === level ? 'selected' : ''}>H${level}</option>`).join('')}</select><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div><input data-block-title value="${esc(block.text || '')}" placeholder="Heading"></div>`;
  if (block.type === 'checklist') return `<div class="editor-block checklist-block" data-block="checklist" data-block-id="${id}">${blockMoveControls()}<input type="checkbox" data-block-checked ${block.checked ? 'checked' : ''}><input data-block-text value="${esc(block.text || '')}" placeholder="Checklist item"></div>`;
  if (block.type === 'bullet') return `<div class="editor-block list-editor-block" data-block="bullet" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Bullet list</b><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div><textarea data-block-text placeholder="One item per line">${esc(block.text || '')}</textarea></div>`;
  if (block.type === 'numbered') return `<div class="editor-block list-editor-block" data-block="numbered" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Numbered list</b><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div><textarea data-block-text placeholder="One item per line">${esc(block.text || '')}</textarea></div>`;
  if (block.type === 'quote') return `<div class="editor-block quote-editor-block" data-block="quote" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Quote</b><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div><textarea data-block-text placeholder="Quoted text">${esc(block.text || '')}</textarea></div>`;
  if (block.type === 'hr') return `<div class="editor-block hr-editor-block" data-block="hr" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Divider</b><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div><div class="editor-divider"></div></div>`;
  if (block.type === 'table') return `<div class="editor-block table-editor-block" data-block="table" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Table</b><div class="btn-row"><button type="button" class="btn ghost" data-add-table-row>Add row</button><button type="button" class="btn ghost" data-add-table-col>Add column</button><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div></div>${renderTableGrid(block.rows)}</div>`;
  if (block.type === 'code') return `<div class="editor-block code-editor-block" data-block="code" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Code</b><div class="btn-row"><button type="button" class="btn ghost" data-copy-code-editor>Copy</button><button type="button" class="btn ghost" data-expand-code-editor>Expand</button><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div></div><div class="code-edit-shell"><pre class="code-line-numbers" aria-hidden="true">1</pre><textarea data-block-code spellcheck="false" placeholder="Paste any code here">${esc(block.text || '')}</textarea></div></div>`;
  if (block.type === 'math') return `<div class="editor-block math-block" data-block="math" data-block-id="${id}">${blockMoveControls()}<div class="inline-block-heading">LaTeX math</div><textarea data-block-math spellcheck="false" placeholder="E = mc^2">${esc(block.text || '')}</textarea></div>`;
  if (block.type === 'secret') return `<div class="editor-block secret-editor-block" data-block="secret" data-block-id="${id}">${blockMoveControls()}<label class="field compact-field"><span>Secret label</span><input data-secret-label list="secretLabelSuggestions" value="${esc(block.label || '')}" placeholder="Password label, API key, token..."></label><datalist id="secretLabelSuggestions"><option value="Password"><option value="WordPress admin password"><option value="Token"><option value="API Key"><option value="Secret"><option value="Key"></datalist><label class="field compact-field"><span>Secret value</span><input data-secret-value type="password" value="${esc(block.value || '')}" placeholder="Paste a password or generate one"></label><button type="button" class="btn ghost" data-generate-secret>Generate</button><button type="button" class="icon-action" data-toggle-secret title="Reveal secret">👁</button><button type="button" class="icon-action" data-copy-inline-editor-secret title="Copy secret">⧉</button><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div>`;
  if (block.type === 'drawing') return `<div class="editor-block drawing-block" data-block="drawing" data-block-id="${id}">${blockMoveControls()}<div class="block-row"><b>Drawing</b><div class="btn-row"><button type="button" class="btn ghost" data-expand-drawing>Expand</button><button type="button" class="btn ghost" data-clear-drawing>Clear</button><button type="button" class="icon-action" data-remove-block title="Remove block">×</button></div></div><canvas width="1100" height="520" data-drawing-canvas></canvas><input type="hidden" data-drawing-data value="${esc(block.dataUrl || '')}"></div>`;
  return `<div class="editor-block paragraph-editor-block" data-block="paragraph" data-block-id="${id}">${blockMoveControls()}<button type="button" class="icon-action paragraph-remove-block" data-remove-block title="Remove paragraph" aria-label="Remove paragraph">×</button><div class="paragraph-toolbar" aria-label="Paragraph formatting"><button type="button" class="tool-chip" data-rich-command="bold" title="Bold">${toolIcon('bold', 'Bold')}</button><button type="button" class="tool-chip" data-rich-command="italic" title="Italic">${toolIcon('italic', 'Italic')}</button><button type="button" class="tool-chip" data-rich-command="underline" title="Underline">${toolIcon('underline', 'Underline')}</button><button type="button" class="tool-chip" data-rich-command="link" title="Link">${toolIcon('link', 'Link')}</button><button type="button" class="tool-chip" data-rich-command="inline-code" title="Inline code">${toolIcon('inlineCode', 'Inline code')}</button><select class="heading-picker" data-rich-heading title="Heading level" aria-label="Heading level"><option value="P">Normal</option>${[1,2,3,4,5].map(level => `<option value="H${level}">H${level}</option>`).join('')}</select><button type="button" class="tool-chip" data-rich-command="bullet" title="Bullet list">${toolIcon('bullet', 'Bullet list')}</button><button type="button" class="tool-chip" data-rich-command="numbered" title="Numbered list">${toolIcon('numbered', 'Numbered list')}</button><button type="button" class="tool-chip" data-rich-command="checklist" title="Checklist">${toolIcon('checklist', 'Checklist')}</button><button type="button" class="tool-chip" data-rich-command="quote" title="Quote">${toolIcon('quote', 'Quote')}</button><button type="button" class="tool-chip" data-rich-command="clear-format" title="Clear formatting" aria-label="Clear formatting">${toolIcon('clearFormat', 'Clear formatting')}</button></div><div class="rich-text" data-rich-text contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Write a paragraph...">${richHtmlFromStored(block.text || '')}</div></div>`;
}

function bindBlockEditor(modal) {
  const editor = modal.querySelector('[data-block-editor]');
  editor.addEventListener('focusin', e => e.target.closest('[data-block]')?.classList.add('active'));
  editor.addEventListener('focusout', e => e.target.closest('[data-block]')?.classList.remove('active'));
  editor.addEventListener('input', e => {
    if (e.target.matches('[data-block-code]')) syncCodeLineNumbers(e.target);
    refreshSerializedBodyAndPreviews(modal);
  });
  editor.addEventListener('change', e => {
    if (e.target.matches('[data-rich-heading]')) return applyRichHeading(modal, e.target);
    refreshSerializedBodyAndPreviews(modal);
  });
  editor.addEventListener('click', async e => {
    const richCommand = e.target.closest('[data-rich-command]');
    if (richCommand) applyRichCommand(modal, richCommand.dataset.richCommand);
    const moveBtn = e.target.closest('[data-move-block]');
    if (moveBtn) {
      const block = moveBtn.closest('[data-block]');
      const direction = moveBtn.dataset.moveBlock;
      if (direction === 'up' && block?.previousElementSibling) editor.insertBefore(block, block.previousElementSibling);
      if (direction === 'down' && block?.nextElementSibling) editor.insertBefore(block.nextElementSibling, block);
      block?.classList.add('active');
      refreshSerializedBodyAndPreviews(modal);
    }
    if (e.target.closest('[data-remove-block]')) {
      e.target.closest('[data-block]')?.remove();
      if (!editor.querySelector('[data-block]')) addEditorBlock(modal, 'paragraph');
      refreshSerializedBodyAndPreviews(modal);
    }
    if (e.target.closest('[data-toggle-secret]')) {
      const input = e.target.closest('[data-block]').querySelector('[data-secret-value]');
      input.type = input.type === 'password' ? 'text' : 'password';
    }
    if (e.target.closest('[data-copy-inline-editor-secret]')) {
      const value = e.target.closest('[data-block]')?.querySelector('[data-secret-value]')?.value || '';
      if (value) navigator.clipboard.writeText(value).then(() => toast('Secret copied')).catch(() => toast('Copy failed'));
    }
    if (e.target.closest('[data-generate-secret]')) {
      const block = e.target.closest('[data-block]');
      const input = block.querySelector('[data-secret-value]');
      input.value = generatePassword();
      input.type = 'password';
      refreshSerializedBodyAndPreviews(modal);
    }
    if (e.target.closest('[data-clear-drawing]')) {
      const block = e.target.closest('[data-block]');
      const button = e.target.closest('[data-clear-drawing]');
      if (!block || block.dataset.clearPending === '1') return;
      block.dataset.clearPending = '1';
      button.disabled = true;
      const confirmed = await confirmDialog({ title: 'Clear drawing?', message: 'This clears the drawing canvas. You cannot undo this after saving.', confirmText: 'Clear drawing' });
      block.dataset.clearPending = '0';
      button.disabled = false;
      if (!confirmed) return;
      const canvas = block.querySelector('[data-drawing-canvas]');
      resetDrawingCanvas(canvas);
      block.querySelector('[data-drawing-data]').value = '';
      refreshSerializedBodyAndPreviews(modal);
    }
    if (e.target.closest('[data-expand-drawing]')) {
      const block = e.target.closest('[data-block]');
      const expanded = block.classList.toggle('expanded');
      e.target.closest('[data-expand-drawing]').textContent = expanded ? 'Done' : 'Expand';
      block.querySelector('[data-drawing-canvas]')?.focus();
    }
    if (e.target.closest('[data-expand-code-editor]')) {
      const block = e.target.closest('[data-block]');
      openCodePreview(block.querySelector('[data-block-code]')?.value || '', 'Code');
    }
    if (e.target.closest('[data-copy-code-editor]')) {
      const block = e.target.closest('[data-block]');
      await navigator.clipboard.writeText(block.querySelector('[data-block-code]')?.value || '');
      toast('Code copied');
    }
    if (e.target.closest('[data-add-table-row]')) {
      const block = e.target.closest('[data-block]');
      const rows = tableRowsFromBlock(block);
      const colCount = Math.max(1, rows[0]?.length || 2);
      rows.push(Array.from({ length: colCount }, () => ''));
      renderTableRowsIntoBlock(block, rows);
      refreshSerializedBodyAndPreviews(modal);
    }
    if (e.target.closest('[data-add-table-col]')) {
      const block = e.target.closest('[data-block]');
      const rows = tableRowsFromBlock(block);
      rows.forEach((row, index) => row.push(index === 0 ? 'Column' : ''));
      renderTableRowsIntoBlock(block, rows);
      refreshSerializedBodyAndPreviews(modal);
    }
    const removeRow = e.target.closest('[data-remove-table-row]');
    if (removeRow) {
      const block = e.target.closest('[data-block]');
      const rows = tableRowsFromBlock(block);
      rows.splice(Number(removeRow.dataset.removeTableRow) + 1, 1);
      if (rows.length < 2) rows.push(Array.from({ length: rows[0]?.length || 1 }, () => ''));
      renderTableRowsIntoBlock(block, rows);
      refreshSerializedBodyAndPreviews(modal);
    }
    const removeCol = e.target.closest('[data-remove-table-col]');
    if (removeCol) {
      const block = e.target.closest('[data-block]');
      const rows = tableRowsFromBlock(block);
      const colIndex = Number(removeCol.dataset.removeTableCol);
      if ((rows[0]?.length || 0) > 1) rows.forEach(row => row.splice(colIndex, 1));
      renderTableRowsIntoBlock(block, rows);
      refreshSerializedBodyAndPreviews(modal);
    }
  });
  editor.querySelectorAll('.paragraph-toolbar').forEach(toolbar => toolbar.addEventListener('mousedown', e => {
    if (e.target.closest('button')) e.preventDefault();
  }));
  editor.querySelectorAll('[data-block-code]').forEach(syncCodeLineNumbers);
  editor.querySelectorAll('[data-block-code]').forEach(textarea => {
    textarea.addEventListener('input', () => syncCodeLineNumbers(textarea));
    textarea.addEventListener('scroll', () => {
      const gutter = textarea.closest('.code-edit-shell')?.querySelector('.code-line-numbers');
      if (gutter) gutter.scrollTop = textarea.scrollTop;
    });
  });
  editor.querySelectorAll('[data-drawing-canvas]').forEach(canvas => bindDrawingCanvas(canvas, modal));
}

function syncCodeLineNumbers(textarea) {
  const gutter = textarea.closest('.code-edit-shell')?.querySelector('.code-line-numbers');
  if (!gutter) return;
  const count = Math.max(1, String(textarea.value || '').split('\n').length);
  gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
}

function addEditorBlock(modal, type) {
  const editor = modal.querySelector('[data-block-editor]');
  const block = newEditorBlock(type);
  editor.insertAdjacentHTML('beforeend', renderEditorBlock(block));
  const added = editor.lastElementChild;
  if (type === 'drawing') bindDrawingCanvas(added.querySelector('[data-drawing-canvas]'), modal);
  if (type === 'code') syncCodeLineNumbers(added.querySelector('[data-block-code]'));
  refreshSerializedBodyAndPreviews(modal);
  added.querySelector('[contenteditable], textarea, input:not([type="hidden"]), select')?.focus();
}

function serializeEditorBlocks(modal) {
  return [...modal.querySelectorAll('[data-block]')].map(block => {
    const type = block.dataset.block;
    if (type === 'heading') return '#'.repeat(Math.min(5, Number(block.querySelector('[data-heading-level]')?.value || 1))) + ' ' + (block.querySelector('[data-block-title]')?.value || '').trim();
    if (type === 'checklist') return `- [${block.querySelector('[data-block-checked]')?.checked ? 'x' : ' '}] ${(block.querySelector('[data-block-text]')?.value || '').trim()}`;
    if (type === 'bullet') return listLines(block.querySelector('[data-block-text]')?.value || '').map(line => `- ${line}`).join('\n');
    if (type === 'numbered') return listLines(block.querySelector('[data-block-text]')?.value || '').map((line, index) => `${index + 1}. ${line}`).join('\n');
    if (type === 'quote') return listLines(block.querySelector('[data-block-text]')?.value || '').map(line => `> ${line}`).join('\n');
    if (type === 'hr') return '---';
    if (type === 'table') return serializeTableBlock(block);
    if (type === 'code') return `\`\`\`text\n${block.querySelector('[data-block-code]')?.value || ''}\n\`\`\``;
    if (type === 'math') return `$$\n${block.querySelector('[data-block-math]')?.value || ''}\n$$`;
    if (type === 'secret') {
      const value = (block.querySelector('[data-secret-value]')?.value || '').trim();
      return value ? `🔒 ${block.querySelector('[data-secret-label]')?.value || 'Password'}: ${value}` : '';
    }
    if (type === 'drawing') {
      const data = block.querySelector('[data-drawing-data]')?.value || '';
      return data ? `![drawing](${data})` : '';
    }
    return sanitizeRichHtml(block.querySelector('[data-rich-text]')?.innerHTML || '').trim();
  }).filter(Boolean).join('\n\n');
}

function newEditorBlock(type) {
  if (type === 'code') return { type: 'code', lang: 'text', text: '' };
  if (type === 'math') return { type: 'math', text: '' };
  if (type === 'secret') return { type: 'secret', label: '', value: '' };
  if (type === 'drawing') return { type: 'drawing', dataUrl: '' };
  if (type === 'heading-1' || type === 'heading') return { type: 'heading', level: 1, text: '' };
  if (type === 'heading-2') return { type: 'heading', level: 2, text: '' };
  if (type === 'heading-3') return { type: 'heading', level: 3, text: '' };
  if (type === 'checklist') return { type: 'checklist', text: '', checked: false };
  if (type === 'bullet') return { type: 'bullet', text: '' };
  if (type === 'numbered') return { type: 'numbered', text: '' };
  if (type === 'quote') return { type: 'quote', text: '' };
  if (type === 'hr') return { type: 'hr' };
  if (type === 'table') return { type: 'table', rows: [['Column', 'Column'], ['Value', 'Value']] };
  return { type: 'paragraph', text: '' };
}

function listLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function parseMarkdownTable(value) {
  const rows = String(value || '').split(/\r?\n/).filter(line => /^\|.*\|$/.test(line)).map(line => line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
  return rows.filter(row => !row.every(cell => /^:?-{3,}:?$/.test(cell))).slice(0, 20);
}

function renderTableGrid(rows = [['Column', 'Column'], ['Value', 'Value']]) {
  const safeRows = rows.length ? rows : [['Column', 'Column'], ['Value', 'Value']];
  const colCount = Math.max(1, ...safeRows.map(row => row.length));
  const normalized = safeRows.map(row => Array.from({ length: colCount }, (_, index) => row[index] || ''));
  return `<div class="table-editor-grid"><table><thead><tr><th class="table-row-control"></th>${normalized[0].map((cell, index) => `<th class="table-data-cell"><div class="table-cell-wrap"><input data-table-cell value="${esc(cell)}" placeholder="Column"><button type="button" class="table-delete" data-remove-table-col="${index}" title="Remove column ${index + 1}" aria-label="Remove column ${index + 1}">×</button></div></th>`).join('')}</tr></thead><tbody>${normalized.slice(1).map((row, rowIndex) => `<tr><td class="table-row-control"><button type="button" class="table-delete" data-remove-table-row="${rowIndex}" title="Remove row ${rowIndex + 1}" aria-label="Remove row ${rowIndex + 1}">×</button></td>${row.map(cell => `<td class="table-data-cell"><input data-table-cell value="${esc(cell)}" placeholder="Value"></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function tableRowsFromBlock(block) {
  return [...block.querySelectorAll('tr')].map(row => [...row.querySelectorAll('.table-data-cell [data-table-cell]')].map(input => input.value.trim()));
}

function renderTableRowsIntoBlock(block, rows) {
  const grid = block.querySelector('.table-editor-grid');
  if (grid) grid.outerHTML = renderTableGrid(rows);
}

function renderReadOnlyTable(rows = [['Column', 'Column'], ['Value', 'Value']]) {
  const safeRows = rows.length ? rows : [['Column', 'Column'], ['Value', 'Value']];
  const colCount = Math.max(1, ...safeRows.map(row => row.length));
  const normalized = safeRows.map(row => Array.from({ length: colCount }, (_, index) => row[index] || ''));
  return `<table><thead><tr>${normalized[0].map(cell => `<th>${esc(cell)}</th>`).join('')}</tr></thead><tbody>${normalized.slice(1).map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function richHtmlFromStored(value) {
  const text = String(value || '');
  if (/<\/?(?:b|strong|i|em|u|a|code|h[1-5]|ul|ol|li|blockquote|div|p|br|span)\b/i.test(text)) return sanitizeRichHtml(text);
  return esc(text).replace(/\n/g, '<br>');
}

function sanitizeRichHtml(value) {
  const template = document.createElement('template');
  template.innerHTML = String(value || '');
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A', 'CODE', 'H1', 'H2', 'H3', 'H4', 'H5', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'DIV', 'P', 'BR', 'SPAN']);
  template.content.querySelectorAll('*').forEach(el => {
    if (!allowed.has(el.tagName)) {
      el.replaceWith(document.createTextNode(el.textContent || ''));
      return;
    }
    [...el.attributes].forEach(attr => {
      const keepHref = el.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:|tel:)/i.test(attr.value);
      const keepStyle = el.tagName === 'SPAN' && attr.name === 'style' && /^color\s*:/i.test(attr.value);
      if (!keepHref && !keepStyle) el.removeAttribute(attr.name);
    });
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return template.innerHTML;
}

function serializeTableBlock(block) {
  const rows = tableRowsFromBlock(block);
  if (!rows.length) return '';
  const headers = rows[0].map(cell => cell || 'Column');
  const divider = headers.map(() => '---');
  const body = rows.slice(1).filter(row => row.some(Boolean));
  return [headers, divider, ...body].map(row => `| ${row.join(' | ')} |`).join('\n');
}

function secretLinePattern() {
  return /^\s*(?:🔒\s*)?([^:\r\n]{0,80}(?:\b(?:password|pwd|pass|secret|token|key)\b|api\s*key)[^:\r\n]{0,80})\s*:\s*(.+)$/i;
}

function lockedLinePattern() {
  return /^\s*🔒\s*([^:\r\n]{1,80})\s*:\s*(.+)$/;
}

function refreshSerializedBodyAndPreviews(modal) {
  const body = serializeEditorBlocks(modal);
  const bodyField = modal.querySelector('#noteBodySerialized');
  if (bodyField) bodyField.value = body;
  const codeList = modal.querySelector('#codeBlocks');
  if (codeList) {
    codeList.innerHTML = renderCodeBlocks(body, modal.querySelector('input[name="title"]')?.value || 'note');
    bindCodeBlockActions(modal);
  }
}

function activeTextInput(modal) {
  const active = modal.querySelector('[data-block].active textarea, [data-block].active input:not([type="hidden"]), textarea:focus, input:focus');
  return active && ['TEXTAREA', 'INPUT'].includes(active.tagName) ? active : null;
}

function activeRichText(modal) {
  const selection = window.getSelection();
  const selectedNode = selection?.anchorNode?.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection?.anchorNode;
  const selectedEditor = selectedNode?.closest?.('[data-rich-text]');
  if (selectedEditor && modal.contains(selectedEditor)) return selectedEditor;
  const focused = document.activeElement?.closest?.('[data-rich-text]');
  if (focused && modal.contains(focused)) return focused;
  const first = modal.querySelector('[data-rich-text]');
  first?.focus();
  return first;
}

async function applyRichCommand(modal, command) {
  const editor = activeRichText(modal);
  if (!editor) return toast('Click inside the note text first');
  editor.focus();
  if (command === 'bold') document.execCommand('bold');
  if (command === 'italic') document.execCommand('italic');
  if (command === 'underline') document.execCommand('underline');
  if (command === 'bullet') document.execCommand('insertUnorderedList');
  if (command === 'numbered') document.execCommand('insertOrderedList');
  if (command === 'heading') document.execCommand('formatBlock', false, 'H2');
  if (command === 'quote') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
  if (command === 'checklist') document.execCommand('insertText', false, '☐ ');
  if (command === 'clear-format') {
    document.execCommand('removeFormat');
    document.execCommand('unlink');
    document.execCommand('formatBlock', false, 'P');
  }
  if (command === 'link') {
    const href = await promptDialog({ title: 'Add link', message: 'Paste the URL for the selected text.', placeholder: 'https://example.com', confirmText: 'Link' });
    if (href) document.execCommand('createLink', false, href);
  }
  if (command === 'inline-code') wrapSelectionHtml('code');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  refreshSerializedBodyAndPreviews(modal);
}

function applyRichHeading(modal, select) {
  const editor = select.closest('[data-block]')?.querySelector('[data-rich-text]') || activeRichText(modal);
  if (!editor) return toast('Click inside the note text first');
  const tag = /^(?:P|H[1-5])$/.test(select.value) ? select.value : 'P';
  editor.focus();
  document.execCommand('formatBlock', false, tag);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  refreshSerializedBodyAndPreviews(modal);
}

function wrapSelectionHtml(tag) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const wrapper = document.createElement(tag);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  selection.addRange(nextRange);
}

async function applyInlineFormat(modal, format) {
  if (format === 'undo' || format === 'redo') return document.execCommand(format);
  const field = activeTextInput(modal);
  if (!field) return toast('Select text in a block first');
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  const selected = field.value.slice(start, end) || (format === 'link' ? 'link text' : 'text');
  let wrapped = selected;
  if (format === 'bold') wrapped = `**${selected}**`;
  if (format === 'italic') wrapped = `*${selected}*`;
  if (format === 'underline') wrapped = `<u>${selected}</u>`;
  if (format === 'strike') wrapped = `~~${selected}~~`;
  if (format === 'highlight') wrapped = `==${selected}==`;
  if (format === 'sup') wrapped = `<sup>${selected}</sup>`;
  if (format === 'sub') wrapped = `<sub>${selected}</sub>`;
  if (format === 'inline-code') wrapped = `\`${selected}\``;
  if (format === 'link') wrapped = `[${selected}](https://)`;
  if (format === 'color') {
    const color = await promptDialog({ title: 'Text color', message: 'Enter a CSS color like #635bff, red, or rgb(99,91,255).', placeholder: '#635bff', confirmText: 'Apply' });
    if (!color) return;
    wrapped = `<span style="color:${safeInlineColor(color)}">${selected}</span>`;
  }
  field.value = field.value.slice(0, start) + wrapped + field.value.slice(end);
  field.focus();
  field.setSelectionRange(start, start + wrapped.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function safeInlineColor(value) {
  return String(value || '').trim().replace(/[^#(),.%\sa-zA-Z0-9-]/g, '').slice(0, 40) || '#635bff';
}

function bindDrawingCanvas(canvas, modal) {
  if (!canvas || canvas.dataset.bound) return;
  canvas.dataset.bound = '1';
  const block = canvas.closest('[data-block]');
  const dataField = block.querySelector('[data-drawing-data]');
  const ctx = canvas.getContext('2d');
  if (!ctx || !dataField) return;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#000000';
  if (dataField.value) {
    const image = new Image();
    image.onload = () => {
      resetDrawingCanvas(canvas);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#000000';
    };
    image.src = dataField.value;
  } else {
    resetDrawingCanvas(canvas);
  }
  let drawing = false;
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  };
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    drawing = true;
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    const p = point(event);
    if (!p) return;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    event.preventDefault();
    const p = point(event);
    if (!p) return;
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const stop = () => {
    if (!drawing) return;
    drawing = false;
    try {
      dataField.value = canvas.toDataURL('image/png');
    } catch {
      toast('Drawing could not be saved on this device');
      return;
    }
    refreshSerializedBodyAndPreviews(modal);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
}

function resetDrawingCanvas(canvas) {
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
}

function generatePassword(length = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => chars[value % chars.length]).join('');
}

async function openEditor(id = null, options = {}) {
  state.pendingAttachments = [];
  state.newNoteMode = id ? 'full' : (options.mode || 'full');
  if (!id) clearDraftNote();
  state.active = id ? state.notes.find(n => Number(n.id) === id) : emptyDraftNote();
  state.activeExtra = id ? await api('/notes/' + id) : { files: [], secrets: [], versions: [] };
  if (id && state.activeExtra?.note) {
    state.active = state.notes.find(n => Number(n.id) === id) || state.activeExtra.note;
    rememberRecentNote(state.activeExtra.note);
  }
  state.editingNote = !id;
  const content = document.querySelector('#contentArea');
  if (content) {
    content.innerHTML = renderNotesWorkspace();
    bindContentActions();
    const editor = content.querySelector('[data-inline-editor]');
    setTimeout(() => editor?.querySelector('input[name="title"]')?.focus({ preventScroll: true }), 0);
  }
}

async function closeInlineEditor() {
  if (!await confirmDiscardUnsaved()) return;
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  const content = document.querySelector('#contentArea');
  if (!content) return;
  content.innerHTML = renderNotesWorkspace();
  bindContentActions();
}

function toggleNoteFocus() {
  state.noteFocus = !state.noteFocus;
  localStorage.setItem('divault_note_focus', state.noteFocus ? '1' : '0');
  document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
  bindContentActions();
}

function bindInlineEditor(modal) {
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  const id = state.active?.id ? Number(state.active.id) : null;
  modal.querySelector('[data-close-inline]')?.addEventListener('click', closeInlineEditor);
  modal.querySelector('#focusNoteBtn')?.addEventListener('click', toggleNoteFocus);
  modal.querySelector('[data-edit-note]')?.addEventListener('click', () => {
    state.editingNote = true;
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  if (modal.dataset.editing !== '1') {
    modal.querySelector('[data-archive-note-readonly]')?.addEventListener('click', () => archiveCurrentNote(id));
    modal.querySelector('[data-trash-note-readonly]')?.addEventListener('click', () => trashCurrentNote(id));
    modal.querySelector('[data-restore-note]')?.addEventListener('click', () => restoreCurrentNote(id));
    modal.querySelector('[data-permanent-delete-note]')?.addEventListener('click', () => permanentlyDeleteCurrentNote(id));
    bindCodeBlockActions(modal);
    bindSecretActions(modal);
    return;
  }
  modal.querySelectorAll('[data-photo-help]').forEach(btn => btn.addEventListener('click', () => {
    modal.querySelector('#fileInput')?.click();
  }));
  modal.addEventListener('paste', async e => {
    const files = pastedAttachmentFiles(e);
    if (!files.length) return;
    e.preventDefault();
    await handleAttachmentFiles(modal, id, files, 'Pasted');
  });
  modal.addEventListener('dragover', e => {
    if (![...(e.dataTransfer?.items || [])].some(item => item.kind === 'file')) return;
    e.preventDefault();
    modal.classList.add('drop-ready');
  });
  modal.addEventListener('dragleave', e => {
    if (!modal.contains(e.relatedTarget)) modal.classList.remove('drop-ready');
  });
  modal.addEventListener('drop', async e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    modal.classList.remove('drop-ready');
    await handleAttachmentFiles(modal, id, files, 'Dropped');
  });
  const titleField = modal.querySelector('input[name="title"]');
  const simpleBody = modal.querySelector('[data-simple-body]');
  if (simpleBody) {
    simpleBody.addEventListener('input', () => {
      const bodyField = modal.querySelector('#noteBodySerialized');
      if (bodyField) bodyField.value = simpleBody.value;
    });
  } else {
    bindBlockEditor(modal);
    refreshSerializedBodyAndPreviews(modal);
  }
  modal.querySelector('.editor-toolbar')?.addEventListener('mousedown', e => {
    if (e.target.closest('button')) e.preventDefault();
  });
  modal.querySelectorAll('[data-add-block]').forEach(btn => btn.addEventListener('click', () => addEditorBlock(modal, btn.dataset.addBlock)));
  modal.querySelectorAll('[data-format]').forEach(btn => btn.addEventListener('click', () => applyInlineFormat(modal, btn.dataset.format)));
  modal.querySelectorAll('[data-editor-command]').forEach(btn => btn.addEventListener('click', () => applyInlineFormat(modal, btn.dataset.editorCommand)));
  if (!simpleBody) bindCodeBlockActions(modal);
  modal.querySelector('#noteForm').addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      if (data.existing_secret_markers) data.body = [data.body, data.existing_secret_markers].filter(Boolean).join('\n');
      delete data.existing_secret_markers;
      if (id) data.id = id;
      const saved = await api('/notes', { method: 'POST', body: data });
      if (!id) clearDraftNote();
      const savedId = Number(saved.id || id);
      if (savedId && state.pendingAttachments.length) {
        await uploadAttachments(savedId, state.pendingAttachments);
        state.pendingAttachments = [];
      }
      toast('Saved');
      state.notes = (await loadNotes()).notes;
      state.active = state.notes.find(n => Number(n.id) === savedId) || null;
      state.activeExtra = savedId ? await api('/notes/' + savedId) : null;
      state.editingNote = false;
      modal.dataset.dirtyBaseline = editorDirtySignature(modal);
      document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
      bindContentActions();
    }, 'Save failed');
  });
  if (!id) clearDraftNote();
  modal.querySelector('#deleteNote')?.addEventListener('click', async () => {
    await trashCurrentNote(id);
  });
  modal.querySelector('#archiveNote')?.addEventListener('click', async () => {
    await archiveCurrentNote(id);
  });
  modal.querySelector('#fileInput')?.addEventListener('change', async () => {
    const input = modal.querySelector('#fileInput');
    const files = [...(input?.files || [])];
    if (input) input.value = '';
    if (!files.length) return toast('Choose a file first');
    await handleAttachmentFiles(modal, id, files, 'Selected');
  });
  modal.addEventListener('click', e => {
    const remove = e.target.closest('[data-remove-pending-attachment]');
    if (!remove) return;
    state.pendingAttachments.splice(Number(remove.dataset.removePendingAttachment), 1);
    modal.querySelector('#pendingAttachments').innerHTML = renderPendingAttachments();
  });
  bindSecretActions(modal);
  modal.dataset.dirtyBaseline = editorDirtySignature(modal);
  (titleField.value ? (simpleBody || modal.querySelector('[data-block-text], [data-block-title], [data-block-code], [data-block-math], [data-rich-text]')) : titleField)?.focus();
}

function editorDirtySignature(modal = document.querySelector('[data-inline-editor][data-editing="1"]')) {
  if (!modal) return '';
  const form = modal.querySelector('#noteForm');
  if (!form) return '';
  const data = Object.fromEntries(new FormData(form));
  return JSON.stringify({ title: data.title || '', body: data.body || '', category_id: data.category_id || '', attachments: state.pendingAttachments.map(file => `${file.name}:${file.size}:${file.type}`).join('|') });
}

function hasUnsavedEditorChanges() {
  const modal = document.querySelector('[data-inline-editor][data-editing="1"]');
  return !!modal && modal.dataset.dirtyBaseline !== editorDirtySignature(modal);
}

async function confirmDiscardUnsaved() {
  if (!hasUnsavedEditorChanges()) return true;
  return await confirmDialog({ title: 'Discard unsaved changes?', message: 'This note has unsaved edits or queued attachments.', confirmText: 'Discard' });
}

async function handleAttachmentFiles(modal, noteId, files, actionLabel = 'Added') {
  await runUserAction(async () => {
    if (!files.length) return;
    if (!noteId) {
      state.pendingAttachments.push(...files);
      modal.querySelector('#pendingAttachments').innerHTML = renderPendingAttachments();
      toast(`${actionLabel} ${files.length} attachment${files.length === 1 ? '' : 's'}. Save to upload.`);
      return;
    }
    await uploadAttachments(noteId, files);
    toast(`${actionLabel} ${files.length} file${files.length === 1 ? '' : 's'}`);
    openEditor(noteId);
  }, 'Upload failed');
}

function pastedAttachmentFiles(event) {
  const items = [...(event.clipboardData?.items || [])];
  const files = items.map(item => item.kind === 'file' ? item.getAsFile() : null).filter(Boolean);
  return files.map((file, index) => {
    const hasName = file.name && file.name !== 'image.png';
    const extension = extensionFromMime(file.type) || 'png';
    const name = hasName ? file.name : `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}-${index + 1}.${extension}`;
    return new File([file], name, { type: file.type || 'application/octet-stream', lastModified: Date.now() });
  });
}

function extensionFromMime(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'text/plain': 'txt' };
  return map[String(mime || '').toLowerCase()] || '';
}

function bindSecretActions(root) {
  root.querySelectorAll('[data-inline-secret-reveal]').forEach(btn => btn.addEventListener('click', () => {
    const target = root.querySelector(`#${CSS.escape(btn.dataset.inlineSecretReveal)}`);
    if (!target) return;
    target.textContent = btn.dataset.secretValue || '';
    setTimeout(() => { target.textContent = '••••••••••'; }, 30000);
  }));
  root.querySelectorAll('[data-inline-secret-copy]').forEach(btn => btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(btn.dataset.secretValue || '');
    toast('Secret copied');
  }));
  root.querySelectorAll('[data-secret]').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.secret-row');
    const value = await api(`/secrets/${btn.dataset.secret}/reveal`, { method: 'POST', body: {} });
    row.querySelector('.secret-value').textContent = value.value;
    setTimeout(() => row.querySelector('.secret-value').textContent = '••••••••••', 30000);
  }));
  root.querySelectorAll('[data-copy-secret]').forEach(btn => btn.addEventListener('click', async () => {
    const value = await api(`/secrets/${btn.dataset.copySecret}/reveal`, { method: 'POST', body: {} });
    await navigator.clipboard.writeText(value.value);
    toast('Copied hidden value');
  }));
}

function nextReviewNoteId(id) {
  const ids = state.notes.map(note => Number(note.id));
  const index = ids.indexOf(Number(id));
  if (index === -1) return null;
  return ids[index + 1] || ids[index - 1] || null;
}

async function reloadNotesAfterAction(message, { advanceFromId = null } = {}) {
  const nextId = advanceFromId ? nextReviewNoteId(advanceFromId) : null;
  toast(message);
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  await loadAll();
  if (nextId && state.notes.some(note => Number(note.id) === Number(nextId))) {
    state.active = state.notes.find(note => Number(note.id) === Number(nextId));
    state.activeExtra = await api('/notes/' + nextId);
    renderApp();
    return;
  }
  renderApp();
}

async function archiveCurrentNote(id) {
  await runUserAction(async () => {
    await api(`/notes/${id}/archive`, { method: 'POST', body: {} });
    await reloadNotesAfterAction('Archived', { advanceFromId: id });
  }, 'Archive failed');
}

async function trashCurrentNote(id) {
  await runUserAction(async () => {
    await api('/notes/' + id, { method: 'DELETE' });
    await reloadNotesAfterAction('Moved to recycle bin', { advanceFromId: id });
  }, 'Delete failed');
}

async function restoreCurrentNote(id) {
  await runUserAction(async () => {
    await api(`/notes/${id}/restore`, { method: 'POST', body: {} });
    await reloadNotesAfterAction('Restored', { advanceFromId: id });
  }, 'Restore failed');
}

async function permanentlyDeleteCurrentNote(id) {
  if (!await confirmDialog({ title: 'Delete forever?', message: 'This note and its files will be permanently removed.', confirmText: 'Delete forever' })) return;
  await runUserAction(async () => {
    await api(`/notes/${id}/permanent`, { method: 'DELETE' });
    await reloadNotesAfterAction('Deleted forever', { advanceFromId: id });
  }, 'Permanent delete failed');
}

async function bulkMoveSelectedNotes(categoryId) {
  const ids = selectedVisibleNoteIds();
  if (!ids.length) return;
  await runUserAction(() => moveNotesToCategory(ids, categoryId), 'Move failed');
}

async function bulkNoteAction(action) {
  const ids = selectedVisibleNoteIds();
  if (!ids.length) return;
  if (action === 'permanent' && !await confirmDialog({ title: 'Delete selected forever?', message: `This permanently deletes ${ids.length} selected note${ids.length === 1 ? '' : 's'}.`, confirmText: 'Delete forever' })) return;
  await runUserAction(async () => {
    for (const id of ids) {
      if (action === 'archive') await api(`/notes/${id}/archive`, { method: 'POST', body: {} });
      if (action === 'trash') await api('/notes/' + id, { method: 'DELETE' });
      if (action === 'restore') await api(`/notes/${id}/restore`, { method: 'POST', body: {} });
      if (action === 'permanent') await api(`/notes/${id}/permanent`, { method: 'DELETE' });
    }
    state.selectedNoteIds.clear();
    state.selectionMode = false;
    await loadAll();
    renderApp();
    toast(`${ids.length} note${ids.length === 1 ? '' : 's'} updated`);
  }, 'Bulk action failed');
}

async function restoreVersion(noteId, versionId) {
  if (!await confirmDialog({ title: 'Restore version?', message: 'Replace the current note content with this previous version? The current content will be saved as a version first.', confirmText: 'Restore' })) return;
  await runUserAction(async () => {
    await api(`/notes/${noteId}/versions/${versionId}/restore`, { method: 'POST', body: {} });
    toast('Version restored');
    await loadCurrentSection();
    state.active = state.notes.find(n => Number(n.id) === Number(noteId)) || null;
    state.activeExtra = await api('/notes/' + noteId);
    state.editingNote = false;
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  }, 'Restore version failed');
}

async function previewVersion(noteId, versionId) {
  await runUserAction(async () => {
    const res = await api(`/notes/${noteId}/versions/${versionId}`);
    const version = res.version;
    const target = document.querySelector('#versionPreview');
    if (!target) return;
    target.innerHTML = `<div class="version-preview"><div class="block-row"><b>${esc(version.title || 'Untitled note')}</b><span class="small muted">${esc(version.created_at || '')}</span></div><div class="note-read-body">${renderReadableBlocks(parseBodyToBlocks(stripHiddenSecretLines(version.body || '')))}</div><div class="btn-row"><button class="btn primary" type="button" data-restore-version="${version.id}" data-note-id="${noteId}">Restore this version</button></div></div>`;
    target.querySelector('[data-restore-version]')?.addEventListener('click', () => restoreVersion(noteId, Number(version.id)));
  }, 'Version preview failed');
}

function insertNoteBlock(modal, block) {
  if (modal.querySelector('[data-block-editor]')) {
    addEditorBlock(modal, block === 'password' ? 'secret' : 'paragraph');
    const added = modal.querySelector('[data-block-editor]').lastElementChild;
    const input = added.querySelector('[data-block-text]');
    if (input) input.value = block === 'username' ? '👤 Username: ' : block === 'url' ? '🔗 URL: https://' : '';
    refreshSerializedBodyAndPreviews(modal);
    return;
  }
  const snippets = {
    username: '\n👤 Username: ',
    password: '\n🔒 Password: ',
    url: '\n🔗 URL: https://'
  };
  insertAtCursor(modal.querySelector('textarea[name="body"]'), snippets[block] || '');
  updateDraftAndCodeBlocks(modal);
}

function insertCodeBlock(modal, typeKey) {
  if (modal.querySelector('[data-block-editor]')) {
    addEditorBlock(modal, 'code');
    refreshSerializedBodyAndPreviews(modal);
    return;
  }
  insertAtCursor(modal.querySelector('textarea[name="body"]'), `\n\n\`\`\`text\n\n\`\`\`\n`);
  updateDraftAndCodeBlocks(modal);
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const next = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(next, next);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function updateDraftAndCodeBlocks(modal) {
  const form = modal.querySelector('#noteForm');
  const body = modal.querySelector('textarea[name="body"]');
  modal.querySelector('#codeBlocks').innerHTML = renderCodeBlocks(body.value, modal.querySelector('input[name="title"]').value || 'note');
  bindCodeBlockActions(modal);
  if (form && modal.dataset.isNewNote === '1') saveDraftNote(Object.fromEntries(new FormData(form)));
}

function collectHiddenSecretLines(body) {
  return String(body || '').split(/\r?\n/).filter(line => hiddenSecretLinePattern().test(line));
}

function stripHiddenSecretLines(body) {
  return String(body || '').split(/\r?\n/).filter(line => !hiddenSecretLinePattern().test(line)).join('\n').trim();
}

function hiddenSecretLinePattern() {
  return /^\s*(?:🔒\s*)?([^:\r\n]{0,80}(?:\b(?:password|pwd|pass|secret|token|key)\b|api\s*key)[^:\r\n]{0,80})\s*:\s*\[hidden secret\]\s*$/i;
}

function renderCodeBlocks(body, title) {
  const blocks = parseCodeBlocks(body);
  if (!blocks.length) return '';
  return `<div class="inline-block-group"><div class="inline-block-heading">⌘ Code blocks</div>${blocks.map((block, index) => `<div class="code-block-card" data-code-card data-code="${esc(block.code)}" data-lang="${esc(block.lang)}">
    <div><b>Code</b><div class="small muted">${block.code.split('\n').length} line${block.code.split('\n').length === 1 ? '' : 's'}</div></div>
    <pre>${esc(block.code).slice(0, 900)}</pre>
    <div class="btn-row"><button type="button" class="icon-action" data-expand-code="${index}" title="View full code">⛶</button><button type="button" class="icon-action" data-copy-code="${index}" title="Copy code">⧉</button><button type="button" class="icon-action" data-download-code="${index}" data-title="${esc(title)}" title="Download code">⇩</button></div>
  </div>`).join('')}</div>`;
}

function parseCodeBlocks(body) {
  const blocks = [];
  const pattern = /```([\w+-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(body || ''))) {
    blocks.push({ lang: (match[1] || 'text').toLowerCase(), code: match[2].replace(/\n$/, '') });
  }
  return blocks;
}

function codeLabel(lang) {
  return Object.values(codeTypes).find(type => type.fence === lang)?.label || lang || 'Code';
}

function codeExtension(lang) {
  return Object.values(codeTypes).find(type => type.fence === lang)?.extension || 'txt';
}

function bindCodeBlockActions(root) {
  root.querySelectorAll('[data-expand-code]').forEach(btn => btn.addEventListener('click', () => {
    const blocks = parseCodeBlocks(root.querySelector('[name="body"]')?.value || document.querySelector('#noteBodySerialized')?.value || '');
    const block = blocks[Number(btn.dataset.expandCode)] || codeBlockFromCard(btn);
    if (block) openCodePreview(block.code, 'Code');
  }));
  root.querySelectorAll('[data-copy-code]').forEach(btn => btn.addEventListener('click', async () => {
    const blocks = parseCodeBlocks(root.querySelector('[name="body"]')?.value || '');
    const block = blocks[Number(btn.dataset.copyCode)] || codeBlockFromCard(btn);
    await navigator.clipboard.writeText(block?.code || '');
    toast('Code copied');
  }));
  root.querySelectorAll('[data-download-code]').forEach(btn => btn.addEventListener('click', () => {
    const blocks = parseCodeBlocks(root.querySelector('[name="body"]')?.value || '');
    const block = blocks[Number(btn.dataset.downloadCode)] || codeBlockFromCard(btn);
    if (!block) return;
    downloadText(block.code, `${safeFilename(btn.dataset.title || 'note')}.${codeExtension(block.lang)}`);
  }));
}

function codeBlockFromCard(btn) {
  const card = btn.closest('[data-code-card]');
  if (!card) return null;
  return { code: card.dataset.code || '', lang: card.dataset.lang || 'text' };
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openCodePreview(code, title = 'Code') {
  const modal = document.createElement('div');
  modal.className = 'editor image-lightbox';
  modal.innerHTML = `<section class="editor-panel code-lightbox-panel"><div class="topbar"><div><p class="terminal-path">divault ~/code</p><h2>${esc(title)}</h2></div><div class="btn-row"><button class="btn" type="button" data-copy-preview-code>Copy</button><button class="btn ghost" type="button" data-close>Close</button></div></div><pre class="code-full-preview"><code>${esc(code || '')}</code></pre></section>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-copy-preview-code]')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code || '');
    toast('Code copied');
  });
  setupAccessibleModal(modal, '[data-close]');
}

function safeFilename(value) {
  return String(value || 'note').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

function renderSecrets(secrets) {
  if (!secrets.length) return '';
  return `<div class="inline-block-group"><div class="inline-block-heading">🔒 Hidden fields</div>${secrets.map(s => `<div class="secret-row inline-secret"><div><b>${esc(s.label)}</b><div class="secret-value">••••••••••</div></div><div class="btn-row"><button type="button" class="icon-action" data-secret="${s.id}" title="Reveal">👁</button><button type="button" class="icon-action" data-copy-secret="${s.id}" title="Copy">⧉</button></div></div>`).join('')}</div>`;
}

function renderFiles(files) {
  if (!files.length) return '';
  return `<div class="inline-block-group"><div class="inline-block-heading">📎 Files</div>${files.map(f => `<div class="file-block">
    ${isImage(f.mime) ? `<button class="file-thumb" type="button" data-preview-file="/api/files/${f.id}/preview" data-file-name="${esc(f.original_name)}" data-file-mime="${esc(f.mime || '')}" aria-label="Preview ${esc(f.original_name)}"><img class="file-preview" src="/api/files/${f.id}/preview" alt="${esc(f.original_name)}"></button>` : ''}
    <div class="file-row"><span><button class="link-button" type="button" data-preview-file="/api/files/${f.id}/preview" data-file-name="${esc(f.original_name)}" data-file-mime="${esc(f.mime || '')}">${esc(f.original_name)}</button><br><span class="small muted">${esc(f.mime || 'file')} · ${Math.ceil(Number(f.size) / 1024)} KB</span></span><a class="btn" href="/api/files/${f.id}">Download</a></div>
  </div>`).join('')}</div>`;
}

function openFilePreview(src, name, mime = '') {
  if (!src) return;
  const modal = document.createElement('div');
  modal.className = 'editor image-lightbox';
  const image = isImage(mime) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '');
  const preview = image ? `<img src="${esc(src)}" alt="${esc(name || 'Image preview')}">` : `<iframe class="file-preview-frame" src="${esc(src)}" title="${esc(name || 'File preview')}"></iframe>`;
  modal.innerHTML = `<section class="editor-panel image-lightbox-panel"><div class="topbar"><div><p class="terminal-path">divault ~/files</p><h2>${esc(name || 'File preview')}</h2></div><div class="btn-row"><a class="btn" href="${esc(src)}" target="_blank" rel="noopener noreferrer">Full size</a><a class="btn ghost" href="${esc(src.replace('/preview', ''))}">Download</a><button class="btn ghost" type="button" data-close>Close</button></div></div>${preview}</section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, '[data-close]');
}

function renderPendingAttachments() {
  if (!state.pendingAttachments.length) return '';
  return `<div class="inline-block-group pending-attachments"><div class="inline-block-heading">Queued attachments</div>${state.pendingAttachments.map((file, index) => `<div class="file-row pending-file-row">${isImage(file.type) ? `<img class="file-preview" src="${esc(URL.createObjectURL(file))}" alt="${esc(file.name)}">` : ''}<span>${esc(file.name)}<br><span class="small muted">${esc(file.type || 'file')} · ${Math.ceil(Number(file.size) / 1024)} KB</span></span><button class="btn ghost" type="button" data-remove-pending-attachment="${index}">Remove</button></div>`).join('')}<p class="small muted inline-hint">These upload when you save the note. You can also paste or drop files here.</p></div>`;
}

async function uploadAttachments(noteId, files) {
  for (const file of files) {
    const data = new FormData();
    data.append('file', file);
    await api(`/notes/${noteId}/files`, { method: 'POST', body: data });
  }
}

function isImage(mime) {
  return String(mime || '').startsWith('image/');
}

function applyPreset(modal, preset) {
  const title = modal.querySelector('input[name="title"]');
  const body = modal.querySelector('textarea[name="body"]');
  const type = modal.querySelector('input[name="type"]');
  if (preset === 'checklist') {
    type.value = 'checklist';
    if (!title.value) title.value = 'Checklist';
    if (!body.value) body.value = '- [ ] ';
  }
  if (preset === 'secure') {
    type.value = 'secure';
    if (!title.value) title.value = 'Secure note';
    if (!body.value) body.value = 'username: \npassword: ';
  }
  if (preset === 'photo') {
    type.value = 'photo';
    if (!title.value) title.value = 'Photo note';
    toast('Save first, then attach the photo or file.');
  }
  if (preset === 'text') {
    type.value = 'text';
    if (!title.value) title.value = 'Quick note';
  }
  body.focus();
  const form = modal.querySelector('#noteForm');
  if (form && modal.dataset.isNewNote === '1') saveDraftNote(Object.fromEntries(new FormData(form)));
}

function emptyDraftNote() {
  return { title: '', body: '', type: 'text', section: 'All', category_id: activeNoteCategoryId(), category: '', tags: '', client_id: '' };
}

function saveDraftNote(data) {
  clearDraftNote();
}

function clearDraftNote() {
  localStorage.removeItem('divault_note_draft');
  localStorage.removeItem('qv_note_draft');
}

function openCategoryManager() {
  state.panel = 'categories';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  state.settingsHtml = '';
  renderApp();
}

function renderCategoryManagerPanel() {
  return `<section class="inline-panel" id="categoryPanel">
    <div class="card stack"><h2>Categories</h2><p class="muted small">Create the categories and subcategories you actually use. Notes can stay in All until you move them.</p>
    <form id="categoryForm" class="category-form category-edit-row">${renderCategoryIconPicker('', 'name="icon"')}<input name="name" placeholder="Example: Passwords, SOPs, Projects" required><select name="parent_id"><option value="">Top-level category</option>${categoryOptions()}</select><button class="btn primary">Add category</button></form></div>
    <div class="card"><h3>Your categories</h3>${state.categories.length ? state.categories.map(c => `<div class="category-edit-row">${renderCategoryIconPicker(c.icon || '', `data-category-icon="${c.id}"`)}<input data-category-name="${c.id}" value="${esc(c.name)}" aria-label="Category name"><span class="small muted">${esc(c.parent_id ? 'Subcategory' : 'Category')} · ${esc(c.slug)}</span><button class="btn" data-save-category="${c.id}">Save</button><button class="btn danger" data-delete-category="${c.id}">Delete</button></div>`).join('') : '<p class="small muted">No categories yet.</p>'}</div>
  </section>`;
}

function renderCategoryIconPicker(selected = '', inputAttrs = '') {
  const selectedKey = legacyCategoryIcons[selected] || selected || 'folder';
  const selectedLabel = categoryIconPresets.find(([key]) => key === selectedKey)?.[1] || 'Folder';
  return `<details class="category-icon-picker">
    <summary aria-label="Category icon"><span class="nav-icon">${renderCategoryIcon(selectedKey)}</span><span data-icon-label>${esc(selectedLabel)}</span></summary>
    <input type="hidden" ${inputAttrs} value="${esc(selectedKey)}">
    <div class="category-icon-menu">${categoryIconPresets.map(([key, label]) => `<button type="button" class="category-icon-option ${key === selectedKey ? 'active' : ''}" data-icon-choice="${esc(key)}" data-icon-label-value="${esc(label)}"><span class="nav-icon">${renderCategoryIcon(key)}</span><span>${esc(label)}</span></button>`).join('')}</div>
  </details>`;
}

function categoryIconOptions(selected = '') {
  const selectedKey = legacyCategoryIcons[selected] || selected || 'folder';
  return categoryIconPresets.map(([key, label]) => `<option value="${esc(key)}" ${key === selectedKey ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function bindCategoryPanel(panel) {
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  panel.querySelectorAll('[data-icon-choice]').forEach(btn => btn.addEventListener('click', () => {
    const picker = btn.closest('.category-icon-picker');
    const input = picker?.querySelector('input[type="hidden"]');
    if (!picker || !input) return;
    input.value = btn.dataset.iconChoice || 'folder';
    picker.querySelector('summary .nav-icon').innerHTML = renderCategoryIcon(input.value);
    picker.querySelector('[data-icon-label]').textContent = btn.dataset.iconLabelValue || 'Folder';
    picker.querySelectorAll('[data-icon-choice]').forEach(option => option.classList.toggle('active', option === btn));
    picker.removeAttribute('open');
  }));
  panel.querySelector('#categoryForm').addEventListener('submit', async e => {
    e.preventDefault();
    const result = await api('/categories', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Category added');
    await loadAll();
    renderApp();
  });
  panel.querySelectorAll('[data-save-category]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.saveCategory;
    await api(`/categories/${id}`, { method: 'PUT', body: { name: panel.querySelector(`[data-category-name="${id}"]`)?.value || '', icon: panel.querySelector(`[data-category-icon="${id}"]`)?.value || '' } });
    toast('Category updated');
    await loadAll();
    renderApp();
  }));
  panel.querySelectorAll('[data-delete-category]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete category?', message: 'Notes in this category move back to All. Matching records are archived.', confirmText: 'Delete category' })) return;
    await api(`/categories/${btn.dataset.deleteCategory}`, { method: 'DELETE' });
    if (state.section === `notes:cat:${btn.dataset.deleteCategory}` || state.categories.find(c => String(c.id) === String(btn.dataset.deleteCategory))?.slug === state.section) {
      state.section = 'notes:all';
      localStorage.setItem('divault_section', state.section);
    }
    toast('Category deleted');
    await loadAll();
    renderApp();
  }));
}

function bindSettingsPanel(panel) {
  if (!panel) return;
}

async function openAssetEditor(id = null) {
  const existing = id ? (await api('/assets/' + id)).asset : null;
  const asset = existing || { type: state.section, name: '', status: 'Active', asset_type: defaultAssetType(state.section), os: '', primary_ip: '', serial_number: '', expires_at: '', location: '', contact: '', username: '', notes: '', client_id: state.clientId || state.clients[0]?.id || '' };
  const modal = document.createElement('div');
  modal.className = 'editor';
  modal.innerHTML = `<section class="editor-panel">
    <div class="topbar"><div><h2>${id ? 'Edit' : 'New'} ${esc(sectionLabel(state.section))}</h2><p class="muted small">Structured documentation record for organizations and assets.</p></div><button class="btn ghost" data-close>Close</button></div>
    <form id="assetForm" class="editor-grid">
      <div class="stack">
        <label class="field"><span>Name</span><input name="name" value="${esc(asset.name)}" required></label>
        <div class="two-col">
          <label class="field"><span>Status</span><select name="status">${['Active','Inactive','Planned','Retired','Expired'].map(s => `<option ${asset.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="field"><span>Type</span><input name="asset_type" value="${esc(asset.asset_type || '')}" placeholder="Server, Switch, Domain..."></label>
        </div>
        <div class="two-col">
          <label class="field"><span>OS</span><input name="os" value="${esc(asset.os || '')}" placeholder="Windows, Linux..."></label>
          <label class="field"><span>Primary IP</span><input name="primary_ip" value="${esc(asset.primary_ip || '')}" placeholder="10.0.0.1"></label>
        </div>
        <div class="two-col">
          <label class="field"><span>Serial Number</span><input name="serial_number" value="${esc(asset.serial_number || '')}"></label>
          <label class="field"><span>Expires</span><input name="expires_at" type="date" value="${esc((asset.expires_at || '').slice(0, 10))}"></label>
        </div>
        <div class="two-col">
          <label class="field"><span>Location</span><input name="location" value="${esc(asset.location || '')}"></label>
          <label class="field"><span>Contact</span><input name="contact" value="${esc(asset.contact || '')}"></label>
        </div>
        <div class="two-col"><label class="field"><span>Username</span><input name="username" value="${esc(asset.username || '')}" autocomplete="off"></label><label class="field"><span>Password</span><input name="password" type="password" placeholder="Optional, encrypted" autocomplete="new-password"></label></div>${asset.has_secret ? `<div class="card"><h3>Stored password</h3><div class="secret-row"><div class="secret-value">••••••••••</div><div class="btn-row"><button type="button" class="btn" id="assetReveal">Eye</button><button type="button" class="btn" id="assetCopy">Copy</button></div></div></div>` : ''}
        <label class="field"><span>Notes</span><textarea name="notes">${esc(asset.notes || '')}</textarea></label>
        <div class="btn-row"><button class="btn primary">Save</button>${id ? `<button type="button" class="btn danger" id="archiveAsset">Archive</button>` : ''}</div>
      </div>
      <aside class="stack">
        <label class="field"><span>Organization</span><select name="client_id"><option value="">None</option>${state.clients.map(c => `<option value="${c.id}" ${Number(asset.client_id) === Number(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <input type="hidden" name="type" value="${esc(state.section)}">
        <div class="card"><h3>Record type</h3><p class="small muted">${esc(sectionLabel(state.section))}</p></div>
      </aside>
    </form>
  </section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, 'input[name="name"]');
  modal.querySelector('#assetForm').addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      if (id) data.id = id;
      await api('/assets', { method: 'POST', body: data });
      toast('Saved');
      modal.remove();
      await loadAll();
      renderApp();
    }, 'Save failed');
  });
  modal.querySelector('#archiveAsset')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      await api('/assets/' + id, { method: 'DELETE' });
      toast('Archived');
      modal.remove();
      await loadAll();
      renderApp();
    }, 'Archive failed');
  });
  modal.querySelector('#assetReveal')?.addEventListener('click', async () => {
    const res = await api(`/assets/${id}/secret`, { method: 'POST', body: {} });
    modal.querySelector('.secret-value').textContent = res.value;
    setTimeout(() => modal.querySelector('.secret-value').textContent = '••••••••••', 30000);
  });
  modal.querySelector('#assetCopy')?.addEventListener('click', async () => {
    const res = await api(`/assets/${id}/secret`, { method: 'POST', body: {} });
    await navigator.clipboard.writeText(res.value);
    toast('Copied password');
  });
}

function defaultAssetType(section) {
  const map = { configurations: 'Server', contacts: 'Contact', locations: 'Location', domains: 'Domain', ssl_certificates: 'SSL Certificate', passwords: 'Credential', networks: 'Network', applications: 'Application' };
  return map[section] || sectionLabel(section).replace(/s$/, '');
}

async function openSettings() {
  state.panel = 'settings';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  renderApp();
  const isAdmin = canAdminSettings();
  const [users, audit, sessions, backups, syncManifest, retentionSettings, aiIntegration, desktopServer] = await Promise.all([
    isAdmin ? api('/users').catch(() => ({ users: [] })) : { users: [] },
    isAdmin ? api('/audit').catch(() => ({ audit: [] })) : { audit: [] },
    api('/sessions').catch(() => ({ sessions: [] })),
    isAdmin ? api('/backups').catch(() => ({ backups: [], pending_restore: false })) : { backups: [], pending_restore: false },
    api('/sync/manifest').catch(() => null),
    isAdmin ? api('/retention-settings').catch(() => ({ settings: { version_limit: 3, trash_days: 30 } })) : { settings: { version_limit: 3, trash_days: 30 } },
    isAdmin ? api('/integrations/ai/status').catch(() => null) : null,
    state.desktop && isAdmin ? api('/desktop/server').catch(() => ({ server_url: '' })) : { server_url: '' }
  ]);
  const adminDataCards = isAdmin ? `<div class="card stack"><h3>Import / export</h3><div class="btn-row"><a class="btn" href="/api/export">Export JSON</a><button class="btn" id="backupBtn">Create full backup</button></div><p class="small muted">Optional backup passphrases encrypt backups. Keep the passphrase; encrypted backups cannot be restored without it.</p><label class="field"><span>Import Markdown notes</span><input id="markdownImportFiles" type="file" accept=".md,text/markdown" multiple></label><label class="field"><span>Import Markdown folder</span><input id="markdownImportFolder" type="file" accept=".md,text/markdown" webkitdirectory multiple></label><button class="btn" id="importMarkdownBtn">Import Markdown</button><p class="small muted">Markdown files are read locally in this browser and imported directly. Folder imports map subfolders to categories.</p><label class="field"><span>Import JSON notes</span><textarea id="importJson" placeholder='{"notes":[{"title":"Imported","body":"Hello"}]}'></textarea></label><button class="btn" id="importBtn">Import JSON</button></div>
        <div class="card stack"><h3>Backups</h3>${backups.pending_restore ? '<p class="pill secret">Restore pending. Restart container to apply.</p>' : ''}<div class="btn-row"><input id="restoreUpload" type="file" accept=".zip,application/zip"><button class="btn danger" id="uploadRestoreBtn">Upload restore ZIP</button></div>${backups.backups.map(b => `<div class="file-row"><span>${esc(b.file)}<br><span class="small muted">${Math.ceil(Number(b.size) / 1024)} KB</span></span><span class="btn-row"><a class="btn" href="/api/backups/${esc(b.file)}">Download</a><button class="btn danger" data-restore="${esc(b.file)}">Schedule restore</button></span></div>`).join('') || '<p class="small muted">No backups yet.</p>'}</div>` : '';
  const adminSidebarCards = isAdmin ? `<div class="card stack"><h3>Add user</h3><form id="userForm" class="stack"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email"><input name="password" type="password" minlength="10" placeholder="Temporary password"><select name="role"><option>editor</option><option>viewer</option><option>admin</option></select><button class="btn">Create user</button></form></div>
        <div class="card"><h3>Users</h3>${users.users.map(u => `<div class="user-row"><span>${esc(u.email)}</span><span class="pill">${esc(u.role)}</span></div>`).join('') || '<p class="small muted">No users.</p>'}</div>
        <div class="card"><h3>Audit</h3>${auditRowsHtml(audit.audit)}</div>` : '';
  const avatarPreview = state.user.avatar_data ? `<img class="profile-avatar" src="${esc(state.user.avatar_data)}" alt="Current avatar">` : `<img class="profile-avatar" src="/assets/divault-logo.svg" alt="DiVault">`;
  const removeAvatarButton = state.user.avatar_data ? '<button class="btn ghost" id="removeAvatarBtn" type="button">Remove avatar</button>' : '';
  const desktopServerCard = state.desktop && isAdmin ? `<div class="card stack"><h3>Desktop mode</h3><p class="muted small">Choose whether this desktop app starts its standalone local vault or opens a hosted DiVault server on launch.</p><div class="inline-note-blocks"><div class="inline-note ${desktopServer.server_url ? '' : 'active'}"><b>Standalone vault</b><span>Private local vault on this computer.</span></div><div class="inline-note ${desktopServer.server_url ? 'active' : ''}"><b>Connect to server</b><span>${desktopServer.server_url ? esc(desktopServer.server_url) : 'Use one shared server for desktop, Android, and browser sync.'}</span></div></div><form id="desktopServerSettingsForm" class="stack"><label class="field"><span>Server URL</span><input name="server_url" type="url" value="${esc(desktopServer.server_url || '')}" placeholder="https://notes.example.com" autocomplete="url" required></label><div class="btn-row"><button class="btn primary">Use server on next launch</button>${desktopServer.server_url ? '<button class="btn ghost" id="desktopStandaloneBtn" type="button">Use standalone on next launch</button>' : ''}</div></form>${desktopServer.config_dir ? `<div class="file-row"><span>Local data folder<br><span class="small muted">${esc(desktopServer.config_dir)}</span></span><button class="btn ghost" id="copyDesktopDataFolderBtn" type="button">Copy path</button></div>` : ''}<p class="small muted">Restart DiVault after changing desktop mode. Server mode opens that URL directly; standalone mode starts the bundled local vault.</p></div>` : '';
  const androidClientCard = window.DiVaultAndroid ? `<div class="card stack"><h3>Android app</h3><p class="muted small">Change the saved Android server URL without waiting for the offline screen.</p><div class="file-row"><span>Current server<br><span class="small muted">${esc(location.origin)}</span></span><button class="btn" id="androidChangeServerBtn" type="button">Change server</button></div></div>` : '';
  const retention = retentionSettings?.settings || { version_limit: 3, trash_days: 30 };
  const retentionCard = isAdmin ? `<div class="card stack"><h3>Recycle bin and version policy</h3><form id="retentionSettingsForm" class="stack"><div class="file-row"><span>File version policy<br><span class="small muted">Keep only the most recent note versions.</span></span><span class="settings-inline-input">Keep only <input name="version_limit" type="number" min="0" max="100" step="1" value="${esc(retention.version_limit ?? 3)}" inputmode="numeric"> most recent versions</span></div><div class="file-row"><span>Empty recycle bin contents older than<br><span class="small muted">Uses the date a note was moved to the recycle bin.</span></span><span class="settings-inline-input"><input name="trash_days" type="number" min="1" max="3650" step="1" value="${esc(retention.trash_days ?? 30)}" inputmode="numeric"> days</span></div><button class="btn primary">Save policy</button></form></div>` : '';
  state.settingsHtml = `
    <div class="editor-grid">
      <div class="stack">
        <div class="card stack"><h3>Mini profile</h3><div class="profile-row">${avatarPreview}<div><b>${esc(state.user.name)}</b><p class="small muted">${esc(state.user.email)} · ${esc(state.user.role)}</p></div></div><form id="profileForm" class="stack"><label class="field"><span>Name</span><input name="name" value="${esc(state.user.name)}" autocomplete="name"></label><label class="field"><span>Avatar</span><div class="avatar-controls"><input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">${removeAvatarButton}</div></label><input type="hidden" name="avatar_data" value="${esc(state.user.avatar_data || '')}"><button class="btn primary">Save profile</button></form></div>
        <div class="card stack"><h3>Change password</h3><form id="passwordForm" class="stack"><input name="current_password" type="password" placeholder="Current password" autocomplete="current-password"><input name="new_password" type="password" minlength="10" placeholder="New password" autocomplete="new-password"><input name="new_password_confirm" type="password" minlength="10" placeholder="Type new password again" autocomplete="new-password"><button class="btn">Update password</button></form></div>
        <div class="card stack"><h3>Appearance</h3><p class="muted small">Pick a comfortable preset. These include light, dark, neutral, cooler, and color-safe options.</p>${themePresetPicker()}</div>
        ${desktopServerCard}
        ${androidClientCard}
        ${retentionCard}
        <div class="card stack"><h3>Sync</h3>${renderSyncSettings(syncManifest)}</div>
        ${isAdmin ? `<div class="card stack"><h3>AI review API</h3>${renderAiIntegrationSettings(aiIntegration)}</div>` : ''}
        <div class="card stack"><h3>Emergency offline snapshot</h3><p class="muted small">Create or update an encrypted localStorage snapshot for offline access. Keep the passphrase; it is required to unlock the snapshot.</p><button class="btn" id="emergencySnapshotBtn">Create/update encrypted snapshot</button><p class="small muted">Pending offline notes remain unencrypted local-only drafts until synced.</p></div>
        <div class="card stack"><h3>Two-factor authentication</h3><p class="muted small">Use an authenticator app. Save recovery codes somewhere safe.</p><div class="btn-row"><button class="btn" id="start2fa">Start 2FA setup</button><button class="btn" id="regenRecovery">New recovery codes</button></div><div id="twofa"></div></div>
        ${adminDataCards}
        <div class="card"><h3>Passkeys / biometrics</h3><p class="muted small">The database table and UI are ready. Full WebAuthn enrollment/login should be completed after the final Pangolin HTTPS domain is known, because passkeys are bound to the relying-party domain.</p></div>
      </div>
      <aside class="stack">
        ${adminSidebarCards}
        <div class="card"><h3>Sessions</h3>${groupedSessionsHtml(sessions.sessions)}</div>
      </aside>
    </div>`;
  renderApp();
  const modal = document.querySelector('#settingsPanel');
  if (!modal) return;
  bindThemeControls(modal);
  modal.querySelector('#avatarFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Choose an image file');
    if (file.size > 500000) return toast('Avatar must be under 500 KB');
    const reader = new FileReader();
    reader.onload = () => {
      modal.querySelector('input[name="avatar_data"]').value = reader.result || '';
      const preview = modal.querySelector('.profile-avatar');
      if (preview) {
        const img = document.createElement('img');
        img.className = 'profile-avatar';
        img.alt = 'Current avatar';
        img.src = reader.result || '';
        preview.replaceWith(img);
      }
    };
    reader.readAsDataURL(file);
  });
  modal.querySelector('#removeAvatarBtn')?.addEventListener('click', () => {
    modal.querySelector('input[name="avatar_data"]').value = '';
    const fileInput = modal.querySelector('#avatarFile');
    if (fileInput) fileInput.value = '';
    const preview = modal.querySelector('.profile-avatar');
    if (preview) {
      const logo = document.createElement('img');
      logo.className = 'profile-avatar';
      logo.src = '/assets/divault-logo.svg';
      logo.alt = 'DiVault';
      preview.replaceWith(logo);
    }
    toast('Avatar will be removed when you save');
  });
  modal.querySelector('#profileForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const res = await api('/profile', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      state.user = res.user;
      toast('Profile updated');
      openSettings();
    }, 'Profile update failed');
  });
  modal.querySelector('#passwordForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      if (!data.current_password || !data.new_password) return toast('Current and new password required');
      if (data.new_password !== data.new_password_confirm) return toast('New passwords do not match');
      const res = await api('/profile', { method: 'POST', body: { name: state.user.name, avatar_data: state.user.avatar_data || '', ...data } });
      state.user = res.user;
      e.target.reset();
      toast('Password updated');
    }, 'Password update failed');
  });
  modal.querySelector('#desktopServerSettingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const result = await api('/desktop/server', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Desktop server saved. Restart DiVault to use it.');
      e.target.querySelector('input[name="server_url"]').value = result.server_url || '';
      openSettings();
    }, 'Desktop server update failed');
  });
  modal.querySelector('#desktopStandaloneBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Use standalone desktop vault?', message: 'DiVault will clear the saved server URL and start the local standalone vault on the next launch.', confirmText: 'Use standalone' })) return;
    await runUserAction(async () => {
      await api('/desktop/server', { method: 'DELETE' });
      toast('Standalone mode saved. Restart DiVault to use it.');
      openSettings();
    }, 'Desktop mode update failed');
  });
  modal.querySelector('#copyDesktopDataFolderBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(desktopServer.config_dir || '');
    toast('Desktop data folder path copied');
  });
  modal.querySelector('#androidChangeServerBtn')?.addEventListener('click', () => {
    window.DiVaultAndroid?.changeServer?.();
  });
  modal.querySelector('#retentionSettingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const result = await api('/retention-settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast(`Policy saved: ${result.settings.version_limit} versions, ${result.settings.trash_days} days`);
      openSettings();
    }, 'Retention policy update failed');
  });
  modal.querySelector('#emergencySnapshotBtn').addEventListener('click', async () => {
    const passphrase = await promptDialog({ title: 'Emergency snapshot passphrase', message: 'Create a passphrase. Keep it safe; it is required for offline unlock.', type: 'password', required: true });
    if (passphrase === null) return;
    if (!passphrase) return toast('Emergency snapshot passphrase is required');
    await runUserAction(async () => {
      await createEncryptedEmergencySnapshot(passphrase);
      toast('Encrypted emergency snapshot updated');
    }, 'Emergency snapshot failed');
  });
  modal.querySelector('#checkSyncBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const manifest = await api('/sync/manifest');
      toast(`Sync ready. Watermark ${manifest.watermark ?? 0}`);
      openSettings();
    }, 'Sync check failed');
  });
  modal.querySelector('#copyServerUrlBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.origin);
    toast('Server URL copied');
  });
  modal.querySelector('#enableAiApiBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const result = await api('/integrations/ai/enable', { method: 'POST', body: {} });
      if (result.token) {
        await navigator.clipboard.writeText(result.token);
        await alertDialog({ title: 'AI API enabled', message: 'The API token was copied to your clipboard. Save it now; DiVault will not show this same token again.' });
      } else {
        toast('AI API is enabled by server config');
      }
      openSettings();
    }, 'AI API enable failed');
  });
  modal.querySelector('#disableAiApiBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Disable AI API', message: 'Disable the AI review API token for this DiVault instance?', confirmText: 'Disable' })) return;
    await runUserAction(async () => {
      await api('/integrations/ai/disable', { method: 'POST', body: {} });
      toast('AI API disabled');
      openSettings();
    }, 'AI API disable failed');
  });
  modal.querySelector('#copyAiEndpointBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(aiIntegration?.endpoint || `${location.origin}/api/integrations/ai/review-notes`);
    toast('AI endpoint copied');
  });
  modal.querySelector('#start2fa').addEventListener('click', async () => {
    const currentPassword = await promptDialog({ title: 'Current password', message: 'Enter your current password to start 2FA setup.', type: 'password', required: true });
    if (currentPassword === null) return;
    if (!currentPassword) return toast('Current password is required');
    const res = await api('/2fa/start', { method: 'POST', body: { current_password: currentPassword } });
    modal.querySelector('#twofa').innerHTML = `<p class="small">Secret: <b>${esc(res.secret)}</b></p><label class="field"><span>Code</span><input id="twofaCode" inputmode="numeric"></label><button class="btn" id="confirm2fa">Confirm</button>`;
    modal.querySelector('#confirm2fa').addEventListener('click', async () => {
      const result = await api('/2fa/confirm', { method: 'POST', body: { code: modal.querySelector('#twofaCode').value } });
      showRecoveryCodes(modal, result.recovery_codes || []);
      toast('2FA enabled');
    });
  });
  modal.querySelector('#regenRecovery').addEventListener('click', async () => {
    const currentPassword = await promptDialog({ title: 'Current password', message: 'Enter your current password to regenerate recovery codes.', type: 'password', required: true });
    if (currentPassword === null) return;
    if (!currentPassword) return toast('Current password is required');
    const result = await api('/2fa/recovery', { method: 'POST', body: { current_password: currentPassword } });
    showRecoveryCodes(modal, result.recovery_codes || []);
  });
  modal.querySelector('#backupBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const passphrase = await promptDialog({ title: 'Backup passphrase', message: 'Optional. Keep it safe; encrypted backups require it to restore. Leave blank for no passphrase.', type: 'password' });
      if (passphrase === null) return;
      const res = await api('/backup', { method: 'POST', body: { passphrase } });
      toast('Backup created: ' + res.path);
      openSettings();
    }, 'Backup failed');
  });
  modal.querySelector('#uploadRestoreBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const input = modal.querySelector('#restoreUpload');
      if (!input.files.length) return toast('Choose a backup ZIP first');
      const passphrase = await promptDialog({ title: 'Restore passphrase', message: 'Enter the backup passphrase if this ZIP is encrypted. Leave blank if none.', type: 'password' });
      if (passphrase === null) return;
      const data = new FormData();
      data.append('backup', input.files[0]);
      data.append('passphrase', passphrase);
      const result = await api('/restore/upload', { method: 'POST', body: data });
      toast(result.message);
      openSettings();
    }, 'Restore upload failed');
  });
  modal.querySelector('#importBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const json = JSON.parse(modal.querySelector('#importJson').value || '{}');
      const res = await api('/import', { method: 'POST', body: json });
      toast(`Imported ${res.imported} notes`);
      await loadAll();
      renderApp();
    }, 'Import failed');
  });
  modal.querySelector('#importMarkdownBtn')?.addEventListener('click', async () => {
    await runUserAction(async () => {
      const files = [
        ...modal.querySelector('#markdownImportFiles').files,
        ...modal.querySelector('#markdownImportFolder').files
      ];
      const payload = await buildMarkdownImportPayload(files);
      const res = await api('/import', { method: 'POST', body: payload });
      toast(`Imported ${res.imported} Markdown notes`);
      await loadAll();
      renderApp();
    }, 'Markdown import failed');
  });
  modal.querySelector('#userForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('User created');
    openSettings();
  });
  modal.querySelectorAll('[data-session]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/sessions/${btn.dataset.session}`, { method: 'DELETE' });
    toast('Session revoked');
    openSettings();
  }));
  modal.querySelectorAll('[data-session-ids]').forEach(btn => btn.addEventListener('click', async () => {
    const ids = btn.dataset.sessionIds.split(',').filter(Boolean);
    await Promise.all(ids.map(id => api(`/sessions/${id}`, { method: 'DELETE' })));
    toast(ids.length > 1 ? 'Sessions revoked' : 'Session revoked');
    openSettings();
  }));
  modal.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Schedule restore', message: 'Schedule this backup to restore on the next container restart?', confirmText: 'Schedule restore' })) return;
    await runUserAction(async () => {
      const passphrase = await promptDialog({ title: 'Restore passphrase', message: 'Enter the backup passphrase if this backup is encrypted. Leave blank if none.', type: 'password' });
      if (passphrase === null) return;
      const result = await api('/restore', { method: 'POST', body: { file: btn.dataset.restore, passphrase } });
      toast(result.message);
      openSettings();
    }, 'Restore scheduling failed');
  }));
}

function renderSyncSettings(manifest) {
  const origin = location.origin;
  if (!manifest) return '<p class="small muted">Sync status is unavailable while this device is offline.</p>';
  const capabilities = (manifest.capabilities || []).map(item => `<span class="pill">${esc(String(item).replaceAll('_', ' '))}</span>`).join('');
  return `<p class="muted small">All devices sync by signing into the same DiVault server. Phones, Android wrappers, desktop, PWA, and Docker use this same server-authoritative sync contract.</p>
    <div class="file-row"><span>Server<br><span class="small muted">${esc(origin)}</span></span><span class="pill">watermark ${esc(manifest.watermark ?? 0)}</span></div>
    <div class="file-row"><span>Signed in as<br><span class="small muted">${esc(manifest.user?.email || state.user.email)}</span></span><span class="pill">${esc(manifest.server_time || '')}</span></div>
    <div class="btn-row"><button class="btn" type="button" id="checkSyncBtn">Check sync</button><button class="btn ghost" type="button" id="copyServerUrlBtn">Copy server URL</button></div>
    <div class="btn-row sync-capabilities">${capabilities}</div>
    <p class="small muted">Use this same server URL when setting up desktop or Android clients. Standalone desktop vaults are intentionally separate until merge sync is added.</p>`;
}

function renderAiIntegrationSettings(status) {
  if (!status) return '<p class="small muted">AI API status is unavailable.</p>';
  const endpoint = status.endpoint || `${location.origin}/api/integrations/ai/review-notes`;
  const enabled = status.enabled === true;
  return `<p class="muted small">Let an AI tool add review notes directly into DiVault.</p>
    <div class="file-row"><span>Status<br><span class="small muted">${enabled ? `Enabled (${esc(status.source || 'local')})` : 'Disabled'}</span></span><span class="pill">${enabled ? 'on' : 'off'}</span></div>
    <div class="file-row"><span>Endpoint<br><span class="small muted">${esc(endpoint)}</span></span><button class="btn ghost" type="button" id="copyAiEndpointBtn">Copy URL</button></div>
    <div class="btn-row"><button class="btn" type="button" id="enableAiApiBtn">${enabled ? 'Regenerate token' : 'Enable API'}</button>${enabled && status.can_disable !== false ? '<button class="btn danger" type="button" id="disableAiApiBtn">Disable</button>' : ''}</div>
    <p class="small muted">Use header <code>X-DiVault-AI-Token</code>. Save the token when you enable or regenerate it.</p>`;
}

function showRecoveryCodes(modal, codes) {
  const target = modal.querySelector('#twofa');
  target.innerHTML = `<p class="small muted">Save these now. They are shown once.</p><textarea readonly>${codes.join('\n')}</textarea>`;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

boot().catch(err => {
  app.innerHTML = `<section class="auth-card"><h1>Could not start</h1><p>${esc(err.message)}</p></section>`;
});
