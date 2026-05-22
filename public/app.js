const state = { user: null, notes: [], assets: [], clients: [], categories: [], counts: {}, section: localStorage.getItem('divault_section') || '', panel: '', settingsHtml: '', settingsTab: localStorage.getItem('divault_settings_tab') || 'account', q: '', clientId: localStorage.getItem('divault_client_id') || localStorage.getItem('qv_client_id') || '', includeArchive: false, active: null, activeExtra: null, editingNote: false, newNoteMode: 'full', pendingAttachments: [], selectionMode: false, selectedNoteIds: new Set(), lastSelectedNoteId: null, noteLayout: localStorage.getItem('divault_note_layout') || 'cards', noteSort: localStorage.getItem('divault_note_sort') || 'updated_desc', noteFocus: localStorage.getItem('divault_note_focus') === '1', notePaneWidth: Number(localStorage.getItem('divault_note_pane_width') || 300), taskFilter: localStorage.getItem('divault_task_filter') || 'open', driveFolderId: localStorage.getItem('divault_drive_folder_id') || '', driveFolders: [], driveFiles: [], driveBreadcrumbs: [], driveLayout: localStorage.getItem('divault_drive_layout') || 'list', driveSelectionMode: false, selectedDriveItems: new Set(), lastSelectedDriveKey: '', theme: localStorage.getItem('divault_theme') || localStorage.getItem('qv_theme') || 'soft', loginMfa: false, lastSyncedAt: null, syncTimer: null, syncing: false, desktop: false, setupMode: 'local' };
Object.assign(state, { features: null, calendars: [], calendarFeeds: [], events: [], tasks: [], calendarDate: new Date(), miniCalendarDate: new Date(), calendarView: localStorage.getItem('divault_calendar_view') || 'schedule', reminders: [], reminderTimer: null, linkableNotesLoaded: false, routeNoteId: null });
if (state.calendarView === 'agenda') state.calendarView = 'schedule';
const app = document.querySelector('#app');
let onlyOfficeScriptPromise = null;
let activeContextMenuActions = [];
let driveUploadDragDepth = 0;
let driveUploadStatusTimer = null;
const driveUploadStatus = { visible: false, active: false, fileName: '', total: 0, current: 0, percent: 0, message: '', error: false };

const defaultFeatures = () => ({
  calendar: { enabled: true, settings: { home_enabled: true, reminders_enabled: true, default_reminder_minutes: 10, default_calendar_id: null } },
  tasks: { enabled: true, settings: { home_enabled: true, reminders_enabled: true, default_reminder_minutes: 10, shared_calendar_tasks: false } },
  home: { enabled: true, settings: { notes_enabled: true } },
  drive: { enabled: true, settings: {} }
});
const feature = key => state.features?.[key] || defaultFeatures()[key];
const featureOn = key => Boolean(feature(key).enabled);
const homeAvailable = () => featureOn('calendar') || featureOn('tasks');

function applyTheme() {
  if (state.theme === 'moss') {
    state.theme = 'soft';
    localStorage.setItem('divault_theme', state.theme);
  }
  const darkThemes = new Set(['dark', 'midnight', 'black', 'plum', 'blueprint']);
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
function linkifyText(value) {
  const text = String(value ?? '');
  const urlPattern = /https?:\/\/[^\s<>"]+/g;
  let html = '';
  let lastIndex = 0;
  for (const match of text.matchAll(urlPattern)) {
    const rawUrl = match[0];
    const url = rawUrl.replace(/[),.;:!?]+$/, '');
    const trailing = rawUrl.slice(url.length);
    html += esc(text.slice(lastIndex, match.index));
    html += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(trailing)}`;
    lastIndex = (match.index || 0) + rawUrl.length;
  }
  return html + esc(text.slice(lastIndex));
}
const brandMark = (alt = 'DiVault') => `<img src="/assets/divault-logo.svg" alt="${esc(alt)}">`;
const toast = message => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
};

document.addEventListener('click', e => {
  const link = e.target.closest?.('a[href]');
  if (!link || !window.__TAURI__?.core?.invoke) return;
  const href = link.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;
  const url = new URL(href, window.location.href);
  if (!/^https?:$/.test(url.protocol)) return;
  if (link.target !== '_blank' && url.origin === window.location.origin) return;
  e.preventDefault();
  openDesktopExternalUrl(url.href);
});

async function openDesktopExternalUrl(url) {
  try {
    await window.__TAURI__?.core?.invoke?.('open_external_url', { url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

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
  const normalized = normalizeDate(value);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatScheduleDateTime(value) {
  if (!value) return 'unknown time';
  const normalized = normalizeDate(value);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.includes('T') ? raw : raw.replace(' ', 'T');
}

function dateInputValue(value) {
  if (typeof value === 'string') {
    const raw = value.trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (match && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return `${match[1]}T${match[2]}`;
  }
  const date = value instanceof Date ? value : new Date(normalizeDate(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  modal.querySelectorAll('[data-close]').forEach(btn => {
    btn.classList.add('dialog-close');
    btn.setAttribute('aria-label', btn.getAttribute('aria-label') || 'Close dialog');
    btn.setAttribute('title', btn.getAttribute('title') || 'Close');
    btn.addEventListener('click', close);
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKeydown);
  setTimeout(() => (modal.querySelector(initialFocusSelector) || modal.querySelector(focusableSelector))?.focus(), 0);
  return close;
}

function promptDialog({ title, message, type = 'text', placeholder = '', value = '', required = false, confirmText = 'Continue' }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'editor';
    modal.innerHTML = `<section class="editor-panel small-panel">
      <div class="topbar"><div><h2>${esc(title)}</h2><p class="muted small">${esc(message)}</p></div><button class="btn ghost" type="button" data-close>Cancel</button></div>
      <form class="stack" id="promptForm">
        <label class="field"><span>${esc(title)}</span><input name="value" type="${esc(type)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${required ? 'required' : ''}></label>
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
  { key: 'light', label: 'Metallic chic', note: 'Sapphire, silver, aqua, champagne' },
  { key: 'soft', label: 'Earthy serene', note: 'Sand, clay, sky, fern' },
  { key: 'ocean', label: 'Lively soothing', note: 'Lemon, mint, cyan, teal' },
  { key: 'colorblind', label: 'Artsy creative', note: 'Gold, vermillion, blue, cream' },
  { key: 'mono', label: 'Mechanical floaty', note: 'Graphite, fog, blue, white' },
  { key: 'blueprint', label: 'Cool collected', note: 'Deep teal, metal, cyan, green' },
  { key: 'dark', label: 'Sleek futuristic', note: 'Sapphire, gunmetal, peach, tan' },
  { key: 'midnight', label: 'Gradient pop', note: 'Sky, salmon, orange, neon' },
  { key: 'plum', label: 'Rich colorful', note: 'Yellow, blue, pink, violet' },
  { key: 'black', label: 'Gorgeous contrast', note: 'Black, gray, yellow-green, white' }
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
  documentEdit: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M10 16l5-5 2 2-5 5H9z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
  extract: '<svg viewBox="0 0 24 24"><path d="M4 5h16v4H4zM6 9h12v10H6zM12 11v7M9 15l3 3 3-3M9 12h6"/></svg>',
  preview: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M8 8h11v13H8zM5 16H4V3h11v1"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h8M4 17h6M15 17l5-5M17 10h5v5"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M16 6a3 3 0 1 0 0 .1M6 15a3 3 0 1 0 0 .1M18 18a3 3 0 1 0 0 .1M8.5 13.5l5-5M8.7 16.1l6.6 2.8"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3zM12 14h6M15 11v6"/></svg>',
  textFile: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M9 13h6M9 17h4"/></svg>',
  fileImage: '<svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 15l3-3 2 2 2-3 3 4M9 9h.01"/></svg>',
  filePdf: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M9 16c3-6 4-6 7-2M9 18c3-1 6-2 8-4"/></svg>',
  fileSheet: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M9 12h7M9 16h7M12 10v8"/></svg>',
  fileSlides: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M9 12h7v5H9z"/></svg>',
  fileMedia: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M10 12l5 3-5 3z"/></svg>',
  fileAudio: '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M10 16h2l4-4v8l-4-4h-2z"/></svg>',
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
  , fullscreen: '<svg viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4"/></svg>'
  , restore: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5"/></svg>'
  , logout: '<svg viewBox="0 0 24 24"><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/></svg>'
  , bell: '<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'
  , print: '<svg viewBox="0 0 24 24"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-3a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v3a2 2 0 0 1-2 2h-2M7 14h10v7H7zM17 12h.01"/></svg>'
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
  , archive: '<svg viewBox="0 0 24 24"><path d="M4 5h16v4H4zM6 9h12v10H6zM10 13h4"/></svg>'
  , tag: '<svg viewBox="0 0 24 24"><path d="M4 12V5h7l9 9-7 7zM8 8h.01"/></svg>'
  , mail: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 7l8 6 8-6"/></svg>'
  , terminal: '<svg viewBox="0 0 24 24"><path d="m4 7 5 5-5 5M11 17h9"/></svg>'
  , wrench: '<svg viewBox="0 0 24 24"><path d="M14 7a5 5 0 0 0 6 6l-7 7a2 2 0 0 1-3-3l7-7a5 5 0 0 1-3-3Z"/></svg>'
}[name] || '');

function toolIcon(name, label) {
  return `<span class="tool-icon" aria-hidden="true">${icon(name)}</span><span class="sr-only">${esc(label)}</span>`;
}

function defaultSection() {
  return homeAvailable() ? 'home' : 'notes:all';
}

function sectionAllowed(section) {
  if (!section) return false;
  if (section === 'home') return homeAvailable();
  if (section === 'calendar') return featureOn('calendar');
  if (section === 'tasks') return featureOn('tasks');
  if (section === 'drive') return featureOn('drive');
  return true;
}

function normalizeCurrentSection() {
  const legacySections = ['Inbox', 'Personal', 'Projects', 'Vault', 'Archive', 'Trash'];
  if (legacySections.includes(state.section) || !sectionAllowed(state.section)) state.section = defaultSection();
  localStorage.setItem('divault_section', state.section);
}

function syncSectionRoute({ replace = false } = {}) {
  localStorage.setItem('divault_section', state.section);
  const route = routeForCurrentState();
  const hash = route ? `#${encodeURI(route)}` : '';
  if (location.hash === hash) return;
  const url = `${location.pathname}${location.search}${hash}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

function routeForCurrentState() {
  if (state.panel) return state.panel;
  if (state.section === 'drive') return driveRouteForFolder(state.driveFolderId);
  if (isNoteSection(state.section) && state.active?.id) return `${state.section}/note/${state.active.id}`;
  return state.section;
}

function driveRouteForFolder(folderId = '') {
  return folderId ? `drive/folder/${encodeURIComponent(folderId)}` : 'drive';
}

function parseDriveRoute(sectionPart) {
  if (sectionPart === 'drive') return '';
  const prefix = 'drive/folder/';
  if (!sectionPart.startsWith(prefix)) return null;
  return decodeURIComponent(sectionPart.slice(prefix.length));
}

async function applyRouteFromHash() {
  if (!applyHashSection()) return false;
  await loadCurrentSection();
  renderApp();
  if (state.panel === 'settings') await openSettings({ route: false });
  if (state.panel === 'categories') openCategoryManager({ route: false });
  if (state.routeNoteId) await openEditor(state.routeNoteId, { route: false });
  return true;
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
      await applyRouteFromHash();
      syncSectionRoute({ replace: true });
      renderApp();
      window.addEventListener('hashchange', applyRouteFromHash);
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
  const passkeyHelp = webauthnSupported() ? 'Use a saved passkey, Windows Hello, Touch ID, Face ID, or your device screen lock.' : 'Passkey login needs a browser with WebAuthn support.';
  app.innerHTML = authShell('Welcome back', 'Quick notes, client docs, files, and hidden secrets.', `
    <form class="stack" id="loginForm">
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      ${state.loginMfa ? `<label class="field"><span>2FA code</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="000000"></label><label class="field"><span>Recovery code</span><input name="recovery_code" autocomplete="one-time-code" placeholder="XXXXX-XXXXX"></label>` : ''}
      <button class="btn primary">${state.loginMfa ? 'Verify and sign in' : 'Continue'}</button>
      <button class="btn" type="button" id="passkeyLoginBtn" ${webauthnSupported() ? '' : 'disabled'}>Sign in with passkey / biometrics</button>
      <p class="small muted">${passkeyHelp}</p>
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
      await applyRouteFromHash();
      syncSectionRoute({ replace: true });
      renderApp();
      startSyncLoop();
    } catch (err) { toast(err.message); }
  });
  document.querySelector('#passkeyLoginBtn')?.addEventListener('click', async () => {
    if (!webauthnSupported()) return toast('Passkeys are not supported in this browser');
    const email = document.querySelector('#loginForm input[name="email"]')?.value.trim();
    if (!email) return toast('Enter your email first');
    try {
      const options = await api('/webauthn/login/options', { method: 'POST', body: { email } });
      const credential = await navigator.credentials.get({ publicKey: publicKeyOptionsFromServer(options) });
      const res = await api('/webauthn/login', { method: 'POST', body: webauthnAssertionPayload(email, credential) });
      state.loginMfa = false;
      state.user = res.user;
      await loadAll();
      await applyRouteFromHash();
      syncSectionRoute({ replace: true });
      renderApp();
      startSyncLoop();
    } catch (err) { toast(err.message); }
  });
}

function authShell(title, subtitle, body) {
  document.documentElement.classList.add('auth-screen');
  document.body.classList.add('auth-screen');
  return `<section class="auth-card">
    <div class="brand"><div class="brand-mark">${brandMark()}</div><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>
    ${body}
  </section>`;
}

async function loadAll() {
  const [clients, categories, counts, features] = await Promise.all([api('/clients'), api('/categories'), api('/asset-counts').catch(() => ({ counts: {} })), api('/features').catch(() => ({ features: defaultFeatures() }))]);
  state.clients = clients.clients;
  state.categories = categories.categories;
  state.features = features.features || defaultFeatures();
  if (featureOn('calendar') || featureOn('tasks')) state.calendars = (await api('/calendars').catch(() => ({ calendars: [] }))).calendars || [];
  if (featureOn('calendar') || featureOn('tasks')) await loadNotificationData();
  if (state.clientId && !state.clients.some(client => String(client.id) === String(state.clientId))) {
    state.clientId = '';
    localStorage.removeItem('divault_client_id');
    localStorage.removeItem('qv_client_id');
  }
  normalizeCurrentSection();
  state.counts = counts.counts || {};
  await loadCurrentSection();
  state.lastSyncedAt = new Date();
  const syncedPending = await syncPendingNotes();
  if (syncedPending) await loadCurrentSection();
  await saveEmergencySnapshot();
  startReminderPolling();
}

async function loadNotificationData() {
  const jobs = [];
  if (featureOn('tasks')) jobs.push(api('/tasks?view=all').then(res => { state.tasks = res.tasks || []; }).catch(() => null));
  if (featureOn('calendar')) {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    jobs.push(api('/events?' + new URLSearchParams({ start: start.toISOString(), end: end.toISOString() })).then(res => { state.events = res.events || []; }).catch(() => null));
  }
  await Promise.all(jobs);
}

function applyHashSection() {
  const hash = decodeURI(location.hash.replace(/^#\/?/, ''));
  const [sectionPart, notePart] = hash.split('/note/');
  const panel = sectionPart === 'settings' || sectionPart === 'categories' ? sectionPart : '';
  const driveFolderId = parseDriveRoute(sectionPart);
  const target = panel ? (state.section || defaultSection()) : (driveFolderId !== null ? 'drive' : (sectionAllowed(sectionPart) ? sectionPart : ''));
  const routeNoteId = notePart ? Number(notePart) : null;
  if (!target) return false;
  const routeDriveFolderId = target === 'drive' ? (driveFolderId || '') : state.driveFolderId;
  const changed = state.section !== target || state.panel !== panel || Number(state.active?.id || 0) !== Number(routeNoteId || 0) || (target === 'drive' && String(state.driveFolderId || '') !== String(routeDriveFolderId || ''));
  if (!changed) return false;
  state.section = target;
  state.panel = panel;
  state.routeNoteId = routeNoteId;
  localStorage.setItem('divault_section', state.section);
  if (target === 'drive') {
    state.driveFolderId = routeDriveFolderId || '';
    localStorage.setItem('divault_drive_folder_id', state.driveFolderId);
  }
  state.q = '';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  return true;
}

function startReminderPolling() {
  if (state.reminderTimer) return;
  pollReminders();
  state.reminderTimer = setInterval(pollReminders, 60000);
}

async function pollReminders() {
  if (!state.user || !(featureOn('calendar') || featureOn('tasks'))) return;
  const enabled = feature('calendar').settings.reminders_enabled || feature('tasks').settings.reminders_enabled;
  if (!enabled) return;
  const res = await api('/reminders/due').catch(() => ({ reminders: [] }));
  for (const reminder of res.reminders || []) await showReminder(reminder);
}

async function dismissReminder(reminder) {
  await api(`/reminders/${reminder.kind}/${reminder.id}/dismiss`, { method: 'POST', body: {} }).catch(() => null);
}

async function showReminder(reminder) {
  const title = `${reminder.kind === 'task' ? 'Task' : 'Calendar'} reminder`;
  const body = `${reminder.title}${reminder.due_at ? ` · ${formatDateTime(reminder.due_at)}` : ''}`;
  const url = reminder.kind === 'task' ? '/#tasks' : '/#calendar';
  if (window.DiVaultAndroid?.notify) {
    if (window.DiVaultAndroid.notify(title, body, new URL(url, window.location.href).href)) {
      await dismissReminder(reminder);
    }
    return;
  }
  if (await showDesktopReminderNotification(title, body)) {
    await dismissReminder(reminder);
    return;
  }
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => null);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.ready;
      const notificationOptions = { body, tag: `divault-${reminder.kind}-${reminder.id}`, data: { url }, silent: false };
      if (reg?.showNotification) await reg.showNotification(title, notificationOptions);
      else new Notification(title, notificationOptions);
    } catch {
      toast(`${title}: ${reminder.title}`);
    }
  } else {
    toast(`${title}: ${reminder.title}`);
  }
  await dismissReminder(reminder);
}

async function showDesktopReminderNotification(title, body) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke('desktop_notify', { title, body });
    return true;
  } catch {
    return false;
  }
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

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  return base64ToBytes(padded);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(new Uint8Array(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function publicKeyOptionsFromServer(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    user: options.user ? { ...options.user, id: base64UrlToBytes(options.user.id) } : undefined,
    allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id: base64UrlToBytes(item.id) })),
    excludeCredentials: (options.excludeCredentials || []).map(item => ({ ...item, id: base64UrlToBytes(item.id) }))
  };
}

function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.crypto?.subtle);
}

function webauthnAssertionPayload(email, credential) {
  return {
    email,
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
    authenticatorData: bytesToBase64Url(credential.response.authenticatorData),
    signature: bytesToBase64Url(credential.response.signature),
    userHandle: credential.response.userHandle ? bytesToBase64Url(credential.response.userHandle) : ''
  };
}

function webauthnRegistrationPayload(label, credential) {
  const publicKey = credential.response.getPublicKey?.();
  const authenticatorData = credential.response.getAuthenticatorData?.();
  if (!publicKey || !authenticatorData) throw new Error('This browser cannot export the passkey public key DiVault needs');
  return {
    label,
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
    authenticatorData: bytesToBase64Url(authenticatorData),
    publicKey: bytesToBase64Url(publicKey)
  };
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
  document.documentElement.classList.remove('auth-screen');
  document.body.classList.remove('auth-screen');
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
  if (state.section === 'home') {
    await loadHomeData();
    return;
  }
  if (state.section === 'calendar') {
    await loadCalendarData();
    return;
  }
  if (state.section === 'tasks') {
    state.tasks = (await api('/tasks?view=all').catch(() => ({ tasks: [] }))).tasks || [];
    return;
  }
  if (state.section === 'drive') {
    await loadDrive();
    return;
  }
  if (isNoteSection(state.section)) {
    state.notes = (await loadNotes()).notes;
    return;
  }
  state.assets = (await loadAssets()).assets;
}

async function loadDrive() {
  const params = new URLSearchParams();
  if (state.driveFolderId) params.set('folder_id', state.driveFolderId);
  if (state.q) params.set('q', state.q);
  const suffix = params.toString() ? `?${params}` : '';
  const [foldersRes, filesRes] = await Promise.all([
    api('/drive/folders' + suffix).catch(err => ({ error: err.message, folders: [] })),
    api('/drive/files' + suffix).catch(err => ({ error: err.message, files: [] }))
  ]);
  state.driveFolders = normalizeDriveCollection(foldersRes, 'folders');
  state.driveFiles = normalizeDriveCollection(filesRes, 'files');
  state.driveBreadcrumbs = foldersRes.breadcrumbs || foldersRes.path || filesRes.breadcrumbs || filesRes.path || [];
}

function normalizeDriveCollection(res, key) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.[key])) return res[key];
  if (Array.isArray(res?.items)) return res.items;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

async function loadHomeData() {
  const jobs = [loadNotes().catch(() => ({ notes: [] }))];
  if (featureOn('calendar')) jobs.push(loadCalendarData().then(() => null));
  if (featureOn('tasks')) jobs.push(api('/tasks').then(res => { state.tasks = res.tasks || []; }).catch(() => null));
  const [notes] = await Promise.all(jobs);
  state.notes = notes.notes || [];
}

async function loadCalendarData() {
  state.calendars = (await api('/calendars').catch(() => ({ calendars: state.calendars || [] }))).calendars || [];
  const [visibleFirst, visibleLast] = calendarVisibleRange();
  const miniFirst = new Date(state.miniCalendarDate.getFullYear(), state.miniCalendarDate.getMonth(), 1);
  const miniLast = new Date(state.miniCalendarDate.getFullYear(), state.miniCalendarDate.getMonth() + 1, 0, 23, 59, 59);
  const first = visibleFirst < miniFirst ? visibleFirst : miniFirst;
  const last = visibleLast > miniLast ? visibleLast : miniLast;
  const params = new URLSearchParams({ start: first.toISOString(), end: last.toISOString() });
  state.events = (await api('/events?' + params).catch(() => ({ events: [] }))).events || [];
  if (featureOn('tasks')) state.tasks = (await api('/tasks?view=all').catch(() => ({ tasks: [] }))).tasks || [];
}

function calendarVisibleRange() {
  const date = state.calendarDate;
  if (state.calendarView === 'day') {
    return [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0), new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59)];
  }
  if (state.calendarView === 'week') {
    const start = startOfWeek(date);
    return [start, new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59)];
  }
  if (state.calendarView === 'schedule') {
    return [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0), new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7, 23, 59, 59)];
  }
  if (state.calendarView === 'year') {
    return [new Date(date.getFullYear(), 0, 1), new Date(date.getFullYear(), 11, 31, 23, 59, 59)];
  }
  return [new Date(date.getFullYear(), date.getMonth(), 1), new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59)];
}

function startOfWeek(value) {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  date.setDate(date.getDate() - date.getDay());
  return date;
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

function isUtilitySection(section) {
  return ['home', 'calendar', 'tasks', 'drive'].includes(String(section || ''));
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
  if (section === 'home') return 'Home';
  if (section === 'calendar') return 'Calendar';
  if (section === 'tasks') return 'Tasks';
  if (section === 'drive') return 'Files';
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
  document.documentElement.classList.remove('auth-screen');
  document.body.classList.remove('auth-screen');
  const panelOpen = Boolean(state.panel);
  app.innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="brand"><button class="brand-mark brand-home" id="brandHomeBtn" type="button" aria-label="Go to home" title="Go to home">${state.user.avatar_data ? `<img src="${esc(state.user.avatar_data)}" alt="">` : brandMark()}</button><div class="brand-text"><h2>DiVault</h2><div class="small muted">${esc(state.user.name)} · ${esc(state.user.role)}</div></div><button class="sidebar-collapse" id="sidebarCollapse" type="button" aria-label="Collapse sidebar" title="Collapse sidebar">‹</button><button class="menu-toggle" id="menuToggle" type="button" aria-label="Open navigation" aria-expanded="false">☰</button></div>
      <nav class="nav">${renderNavGroups()}</nav>
      <div class="sidebar-footer">
        <button class="sync-pill sidebar-sync" data-sync-status type="button" id="syncBtn">${esc(syncLabel())}</button>
        ${renderNotificationBell()}
        <button class="btn sidebar-action icon-only-btn" id="settingsBtn" aria-label="Settings" title="Settings">${toolIcon('settings', 'Settings')}</button>
        <button class="btn ghost sidebar-action icon-only-btn" id="logoutBtn" aria-label="Log out" title="Log out">${toolIcon('logout', 'Log out')}</button>
      </div>
    </aside>
    <button class="sidebar-backdrop" id="sidebarBackdrop" type="button" aria-label="Close navigation"></button>
    <main class="main">
      ${renderTopbar(panelOpen)}
      ${renderFilterBar(panelOpen)}
      <section id="contentArea">${renderMainContent()}</section>
      ${renderDriveUploadStatus()}
    </main>
  </div>`;
  bindApp();
}

function renderFilterBar(panelOpen) {
  if (panelOpen) return '';
  if (state.section === 'home') return '';
  if (state.section === 'calendar') return `<div class="filterbar calendar-filter"><div class="calendar-toolbar"><div class="btn-row calendar-nav-row"><button class="btn icon-only-btn" id="prevCalendarMonth" type="button" aria-label="Previous">‹</button><button class="btn" id="todayCalendarMonth" type="button">Today</button><button class="btn icon-only-btn" id="nextCalendarMonth" type="button" aria-label="Next">›</button></div><select class="calendar-view-select" id="calendarViewSelect" aria-label="Calendar view"><option value="day" ${state.calendarView === 'day' ? 'selected' : ''}>Day</option><option value="week" ${state.calendarView === 'week' ? 'selected' : ''}>Week</option><option value="month" ${state.calendarView === 'month' ? 'selected' : ''}>Month</option><option value="year" ${state.calendarView === 'year' ? 'selected' : ''}>Year</option><option value="schedule" ${state.calendarView === 'schedule' ? 'selected' : ''}>Schedule</option></select><div class="calendar-view-toggle" role="group" aria-label="Calendar view"><button class="btn ghost ${state.calendarView === 'day' ? 'active' : ''}" data-calendar-view="day" type="button">Day</button><button class="btn ghost ${state.calendarView === 'week' ? 'active' : ''}" data-calendar-view="week" type="button">Week</button><button class="btn ghost ${state.calendarView === 'month' ? 'active' : ''}" data-calendar-view="month" type="button">Month</button><button class="btn ghost ${state.calendarView === 'year' ? 'active' : ''}" data-calendar-view="year" type="button">Year</button><button class="btn ghost ${state.calendarView === 'schedule' ? 'active' : ''}" data-calendar-view="schedule" type="button">Schedule</button></div><div class="btn-row calendar-add-row"><button class="btn primary icon-only-btn action-fab" id="newEventBtn" type="button" aria-label="New event" title="New event">${toolIcon('calendar', 'New event')}</button><button class="btn primary icon-only-btn action-fab" id="newCalendarTaskBtn" type="button" aria-label="New task" title="New task">${toolIcon('check', 'New task')}</button></div></div></div>`;
  if (state.section === 'tasks') return `<div class="filterbar task-filter"><input class="search" id="search" aria-label="Search tasks" placeholder="Search tasks..." value="${esc(state.q)}"><button class="btn primary" id="newTaskBtn" type="button">New task</button></div>`;
  if (state.section === 'drive') return renderDriveFilterBar();
  if (isNoteSection(state.section)) {
    return `<div class="filterbar notes-filter"><div class="filter-actions filter-actions-left">${state.notes.length && !state.selectionMode ? '<button class="btn" type="button" id="startSelectNotes">Select</button>' : ''}${renderNoteLayoutToggle()}${renderNoteSortSelect()}${state.section === 'notes:trash' ? '<button class="btn danger" id="emptyTrashBtn" type="button">Empty recycle bin</button>' : ''}</div><input class="search" id="search" aria-label="Search notes. Press Q to focus search." title="Press Q to search" placeholder="Search ${esc(sectionLabel(state.section))}...  Q" value="${esc(state.q)}"><div class="filter-actions note-filter-actions"><button class="btn ghost icon-only-btn" id="shortcutsHelpBtn" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button><button class="btn primary icon-only-btn action-fab" id="quickNotesBtn" type="button" aria-label="Quick notes" title="Quick notes (K)">${toolIcon('quick', 'Quick notes')}</button><button class="btn primary icon-only-btn action-fab" id="newBtn" aria-label="New note" title="New full note (N or +)">+</button></div></div>`;
  }
  return `<div class="filterbar"><select id="clientFilter" aria-label="Organization"><option value="">All organizations</option>${state.clients.map(c => `<option value="${c.id}" ${String(c.id) === String(state.clientId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input class="search" id="search" aria-label="Search. Press Q to focus search." title="Press Q to search" placeholder="Search ${esc(sectionLabel(state.section))}...  Q" value="${esc(state.q)}"><label class="checkline"><input type="checkbox" id="includeArchive" ${state.includeArchive ? 'checked' : ''}> Include archive</label></div>`;
}

function renderDriveFilterBar() {
  const selectLabel = state.driveSelectionMode ? 'Cancel selection' : 'Select files';
  const selectIcon = state.driveSelectionMode ? 'selectNone' : 'selectAll';
  return `<div class="filterbar drive-filter"><label class="drive-search-field"><span class="sr-only">Search Drive</span><input class="search" id="search" type="search" aria-label="Search files" placeholder="Search files and folders...  Q" value="${esc(state.q)}"></label><div class="filter-actions drive-commandbar"><div class="drive-tool-group" aria-label="Drive actions"><button class="btn drive-tool-btn icon-only-btn ${state.driveSelectionMode ? 'active' : ''}" id="toggleDriveSelect" type="button" aria-label="${esc(selectLabel)}" title="${esc(selectLabel)}">${toolIcon(selectIcon, selectLabel)}</button><button class="btn primary drive-upload-button drive-tool-btn" id="driveUploadButton" type="button" aria-label="Upload files" title="Upload files">${toolIcon('upload', 'Upload')}<span>Upload</span></button><input id="driveUploadInput" class="drive-upload-input" type="file" multiple aria-hidden="true" tabindex="-1"><button class="btn drive-tool-btn icon-only-btn" id="newDriveFolderBtn" type="button" aria-label="New folder" title="New folder">${toolIcon('folderPlus', 'New folder')}</button><button class="btn drive-tool-btn icon-only-btn" id="newDriveTextBtn" type="button" aria-label="Text file" title="Text file">${toolIcon('textFile', 'Text file')}</button></div><div class="note-layout-toggle drive-layout-toggle" role="group" aria-label="Drive layout"><button class="btn ghost icon-only-btn ${state.driveLayout === 'grid' ? 'active' : ''}" data-drive-layout="grid" type="button" aria-label="Grid view" title="Grid view">${toolIcon('cards', 'Grid view')}</button><button class="btn ghost icon-only-btn ${state.driveLayout === 'list' ? 'active' : ''}" data-drive-layout="list" type="button" aria-label="List view" title="List view">${toolIcon('list', 'List view')}</button></div></div></div>`;
}

function notificationItems() {
  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const soonEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const recentStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const tasks = featureOn('tasks') ? state.tasks.filter(task => task.status !== 'done' && task.due_at).map(task => ({ kind: 'task', item: task, when: new Date(normalizeDate(task.due_at)) })).filter(entry => entry.when <= todayEnd) : [];
  const events = featureOn('calendar') ? state.events.map(event => ({ kind: 'event', item: event, when: new Date(normalizeDate(event.starts_at)) })).filter(entry => entry.when >= recentStart && entry.when <= soonEnd) : [];
  return [...tasks, ...events].sort((a, b) => a.when - b.when);
}

function renderNotificationBell() {
  if (!homeAvailable()) return '';
  const count = notificationItems().length;
  return `<button class="btn sidebar-action icon-only-btn notification-bell" id="notificationBellBtn" aria-label="Notifications" title="Notifications">${toolIcon('bell', 'Notifications')}${count ? `<span class="notification-badge">${count > 99 ? '99+' : count}</span>` : ''}</button>`;
}

function renderNotificationDropdown() {
  const items = notificationItems();
  return `<div class="notification-menu" id="notificationMenu"><div class="section-title-row"><h3>Notifications</h3><span class="small muted">${items.length}</span></div><div class="notification-list">${items.length ? items.slice(0, 12).map(entry => {
    if (entry.kind === 'task') {
      const task = entry.item;
      return `<div class="notification-row notification-link notification-task-row" data-open-task="${task.id}" role="button" tabindex="0"><span class="agenda-kind task-kind notification-kind">Task</span><span class="notification-copy"><b class="notification-title">${esc(task.title)}</b><span class="small muted notification-meta">Due ${formatScheduleDateTime(task.due_at)}</span></span><span class="notification-action"><button class="task-complete-btn notification-complete-btn" data-task-complete="${task.id}" type="button" aria-label="Complete task" title="Complete task">${toolIcon('check', 'Complete task')}</button></span></div>`;
    }
    const event = entry.item;
      return `<div class="notification-row notification-link" data-open-event="${event.series_id || event.id}" role="button" tabindex="0"><span class="agenda-kind event-kind notification-kind">Event</span><span class="notification-copy"><b class="notification-title">${esc(event.title)}</b><span class="small muted notification-meta">${formatScheduleDateTime(event.starts_at)}</span></span></div>`;
  }).join('') : '<p class="small muted notification-empty">Nothing needs attention.</p>'}</div></div>`;
}

async function completeTask(task, after = async () => {}) {
  if (!task || task.status === 'done') return;
  await runUserAction(async () => {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...task, status: 'done', shared: Number(task.private) === 0 } });
    await after();
  }, 'Task update failed');
}

async function toggleTaskStatus(task, after = async () => {}) {
  if (!task) return;
  const status = task.status === 'done' ? 'open' : 'done';
  await runUserAction(async () => {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...task, status, shared: Number(task.private) === 0 } });
    await after(status);
  }, 'Task update failed');
}

function renderTopbar(panelOpen) {
  if (!panelOpen && isNoteSection(state.section)) return '';
  if (!panelOpen && isUtilitySection(state.section)) return '';
  const actions = isUtilitySection(state.section) && !panelOpen ? '' : `<div class="topbar-actions"><button class="btn primary icon-only-btn action-fab" id="quickNotesBtn" type="button" aria-label="Quick notes" title="Quick notes (K)">${toolIcon('quick', 'Quick notes')}</button><button class="btn primary icon-only-btn action-fab" id="newBtn" aria-label="New note" title="New full note (N or +)">+</button></div>`;
  return `<div class="topbar"><div>${topbarKicker()}<h1>${esc(panelTitle())}</h1>${topbarSubtitle()}</div>${actions}</div>`;
}

function panelTitle() {
  if (state.panel === 'categories') return 'Categories';
  if (state.panel === 'settings') return 'Settings';
  return sectionLabel(state.section);
}

function topbarContext() {
  if (state.panel === 'categories') return 'Notes';
  if (state.panel === 'settings') return 'DiVault';
  if (state.section === 'home') return 'Workspace';
  if (state.section === 'calendar') return 'Calendar';
  if (state.section === 'tasks') return 'Tasks';
  return isNoteSection(state.section) ? 'Notes' : `${activeClientName()} / ${panelTitle()}`;
}

function panelSubtitle() {
  return '';
}

function topbarKicker() {
  return isNoteSection(state.section) && !state.panel ? '' : `<div class="breadcrumb">${esc(topbarContext())}</div>`;
}

function topbarSubtitle() {
  const subtitle = panelSubtitle();
  return subtitle && !(isNoteSection(state.section) && !state.panel) ? `<p class="muted">${esc(subtitle)}</p>` : '';
}

function renderMainContent() {
  if (state.panel === 'categories') return renderCategoryManagerPanel();
  if (state.panel === 'settings') return `<section class="inline-panel card" id="settingsPanel">${state.settingsHtml || '<p class="muted">Loading settings...</p>'}</section>`;
  if (state.section === 'home') return renderHome();
  if (state.section === 'calendar') return renderCalendar();
  if (state.section === 'tasks') return renderTasks();
  if (state.section === 'drive') return renderDrive();
  return isNoteSection(state.section) ? renderNotesWorkspace() : renderAssetTable();
}

function renderNavGroups() {
  const utility = `<div class="nav-group"><div class="nav-heading">Workspace</div>${homeAvailable() ? renderNavButton('home', 'Home', 0) : ''}${featureOn('calendar') ? renderNavButton('calendar', 'Calendar', state.events.length || 0) : ''}${featureOn('tasks') ? renderNavButton('tasks', 'Tasks', state.tasks.filter(t => t.status !== 'done').length || 0) : ''}${featureOn('drive') ? renderNavButton('drive', 'Files', state.driveFiles.length || 0) : ''}</div>`;
  const notes = `<div class="nav-group"><div class="nav-heading">Notes</div>
    ${renderNavButton('notes:all', 'All', state.counts['notes:all'] ?? 0, '')}
    ${renderNavButton('notes:quick', 'Quick notes', state.counts['notes:quick'] ?? 0, '')}
  </div>`;
  const categories = `<div class="nav-group nav-category-group"><div class="nav-heading">Categories<button class="mini-add" id="addCategoryBtn" type="button" aria-label="Manage note categories">Manage</button></div>
    ${renderCategoryTree(null, 'notes')}
  </div>`;
  const storage = `<div class="nav-group nav-storage-group"><div class="nav-heading">Storage</div>${renderNavButton('notes:archive', 'Archive', state.counts['notes:archive'] ?? 0)}${renderNavButton('notes:trash', 'Recycle bin', state.counts['notes:trash'] ?? 0)}</div>`;
  return utility + notes + categories + storage;
}

function renderNavButton(key, label, count = 0, dropCategoryId = undefined) {
  const drop = dropCategoryId !== undefined ? `data-drop-category-id="${dropCategoryId}"` : '';
  const category = key.startsWith('notes:cat:') ? state.categories.find(c => String(c.id) === key.replace('notes:cat:', '')) : null;
  const icon = category?.icon || (key === 'home' ? 'home' : key === 'calendar' ? 'calendar' : key === 'tasks' ? 'check' : key === 'drive' ? 'folder' : key === 'notes:all' ? 'folder' : key === 'notes:quick' ? 'quick' : key === 'notes:archive' ? 'receipt' : key === 'notes:trash' ? 'trash' : 'folder');
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
  const visible = new Set(noteVisibleSelectionIds());
  return [...state.selectedNoteIds].filter(id => visible.has(Number(id)));
}

function noteVisibleSelectionIds() {
  return (state.notes || []).map(note => Number(note.id)).filter(Boolean);
}

function refreshContentArea(html) {
  const content = document.querySelector('#contentArea');
  if (!content) return;
  content.innerHTML = html;
  bindContentActions();
}

function toggleNoteSelection(id) {
  const noteId = Number(id);
  if (!noteId) return;
  state.selectionMode = true;
  if (state.selectedNoteIds.has(noteId)) state.selectedNoteIds.delete(noteId);
  else state.selectedNoteIds.add(noteId);
  state.lastSelectedNoteId = noteId;
}

function selectNoteRangeTo(id) {
  const noteId = Number(id);
  if (!noteId) return;
  const visible = noteVisibleSelectionIds();
  const end = visible.indexOf(noteId);
  if (end < 0) return toggleNoteSelection(noteId);
  const anchorId = visible.includes(Number(state.lastSelectedNoteId)) ? Number(state.lastSelectedNoteId) : noteId;
  const start = visible.indexOf(anchorId);
  const [from, to] = start < end ? [start, end] : [end, start];
  state.selectionMode = true;
  state.selectedNoteIds.clear();
  visible.slice(from, to + 1).forEach(visibleId => state.selectedNoteIds.add(visibleId));
  state.lastSelectedNoteId = noteId;
}

function handleNoteSelectionClick(event, id) {
  if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) selectNoteRangeTo(id);
  else toggleNoteSelection(id);
  refreshContentArea(renderNotesWorkspace());
  return true;
}

function activeClientName() {
  if (!state.clientId) return 'All organizations';
  return state.clients.find(c => String(c.id) === String(state.clientId))?.name || 'Organization';
}

function renderHome() {
  const selected = new Date(state.calendarDate);
  const query = state.q.trim().toLowerCase();
  const scheduleStart = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 0, 0, 0);
  const scheduleEnd = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + 7, 23, 59, 59);
  const todaysEvents = state.events.filter(event => new Date(normalizeDate(event.starts_at)).toDateString() === new Date().toDateString()).slice(0, 6);
  const dueToday = state.tasks.filter(task => task.status !== 'done' && task.due_at && new Date(normalizeDate(task.due_at)).toDateString() === new Date().toDateString()).slice(0, 6);
  const recentNotes = feature('home').settings.notes_enabled ? state.notes.filter(note => !query || matchesText(query, note.title, note.body, note.tags, note.category_name, note.client_name)).slice(0, 6) : [];
  const scheduleItems = agendaItemsForRange(scheduleStart, scheduleEnd).slice(0, 12);
  const noteEmpty = query ? 'No matching recent notes.' : 'No recent notes.';
  return `<div class="home-grid refined-home">
    <section class="home-main stack">
      <div class="home-hero card"><div><p class="breadcrumb">Today in DiVault</p><h2>${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h2></div><div class="home-stat-row"><span class="pill">${state.notes.length} notes</span><span class="pill">${todaysEvents.length} events today</span><span class="pill">${dueToday.length} tasks due</span></div><label class="home-search"><span class="sr-only">Search Home</span><input class="search" id="search" type="search" aria-label="Search Home. Press Q to focus search." title="Press Q to search" placeholder="Search Home notes and schedule...  Q" value="${esc(state.q)}"></label><div class="home-action-row"><button class="btn primary icon-only-btn action-fab" id="quickNotesBtn" type="button" aria-label="Quick note" title="Quick note">${toolIcon('quick', 'Quick note')}</button><button class="btn icon-only-btn action-fab" id="newBtn" type="button" aria-label="Add note" title="Add note">+</button>${featureOn('calendar') ? `<button class="btn icon-only-btn action-fab" id="newEventBtn" type="button" aria-label="New event" title="New event">${toolIcon('calendar', 'New event')}</button>` : ''}${featureOn('tasks') ? `<button class="btn icon-only-btn action-fab" id="newCalendarTaskBtn" type="button" aria-label="New task" title="New task">${toolIcon('check', 'New task')}</button>` : ''}</div></div>
      <section class="card home-widget home-notes-widget stack"><div class="section-title-row"><h3>${query ? 'Matching notes' : 'Recent notes'}</h3><button class="btn ghost" data-section="notes:all" type="button">View all</button></div>${recentNotes.length ? `<div class="home-note-grid">${recentNotes.map(note => `<button class="home-note-card" data-open="${note.id}"><b>${esc(note.title)}</b><span>${esc(note.updated_at || '')}</span></button>`).join('')}</div>` : `<p class="muted small">${noteEmpty}</p>`}</section>
    </section>
    <aside class="home-side stack">
      ${featureOn('calendar') && feature('calendar').settings.home_enabled ? renderMiniMonthPicker() : ''}
      <section class="card home-widget home-schedule-widget stack"><div class="section-title-row"><h3>Schedule</h3>${featureOn('calendar') ? '<button class="btn ghost" data-section="calendar" type="button">Calendar</button>' : ''}</div><p class="small muted">${scheduleStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${scheduleEnd.toLocaleDateString([], { month: 'short', day: 'numeric' })}</p>${(featureOn('calendar') || featureOn('tasks')) ? renderAgendaItems(scheduleItems, true, { readonly: true }) : '<p class="muted small">Calendar and tasks are disabled.</p>'}</section>
    </aside>
  </div>`;
}

function renderCalendar() {
  if (state.calendarView === 'day') return renderCalendarDay();
  if (state.calendarView === 'week') return renderCalendarWeek();
  if (state.calendarView === 'year') return renderCalendarYear();
  if (state.calendarView === 'schedule') return renderCalendarScheduleView();
  const month = state.calendarDate;
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const dayEvents = eventsForDay(day);
    const dayTasks = tasksForDay(day);
    const classes = ['calendar-day'];
    if (day.getMonth() !== month.getMonth()) classes.push('muted-day');
    if (day < startOfToday()) classes.push('past-day');
    if (day.toDateString() === new Date().toDateString()) classes.push('today');
    cells.push(`<div class="${classes.join(' ')}" data-quick-add="${dateInputValue(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))}"><div class="calendar-day-head"><b>${day.getDate()}</b></div>${dayEvents.slice(0, 3).map(event => renderEventChip(event)).join('')}${dayTasks.slice(0, 2).map(task => renderTaskChip(task)).join('')}${dayEvents.length + dayTasks.length > 5 ? `<p class="small muted">+${dayEvents.length + dayTasks.length - 5} more</p>` : ''}</div>`);
  }
  return `${renderCalendarSearchPanel()}<section class="calendar-page-grid"><div class="calendar-primary stack"><div class="card calendar-toolbar compact-view-title"><h2>${month.toLocaleString([], { month: 'long', year: 'numeric' })}</h2></div><div class="calendar-grid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<div class="small muted"><b>${day}</b></div>`).join('')}${cells.join('')}</div></div>${renderCalendarSidebar('Upcoming', agendaItemsForRange(...calendarVisibleRange()).slice(0, 10))}</section>`;
}

function startOfToday() {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

function renderCalendarDay() {
  const day = state.calendarDate;
  const items = agendaItemsForRange(...calendarVisibleRange());
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const hourRows = hours.map(hour => {
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0);
    const hourItems = items.filter(entry => new Date(normalizeDate(entry.when)).getHours() === hour);
    const classes = ['day-hour-slot'];
    const now = new Date();
    if (slot.toDateString() === now.toDateString() && hour === now.getHours()) classes.push('current-hour');
    return `<div class="${classes.join(' ')}" data-quick-add="${dateInputValue(slot)}"><span class="day-hour-label">${formatHour(hour)}</span><div class="day-hour-content">${hourItems.length ? renderAgendaItems(hourItems, true) : ''}</div></div>`;
  }).join('');
  return `${renderCalendarSearchPanel()}<section class="calendar-page-grid"><div class="calendar-primary stack"><div class="card calendar-toolbar compact-view-title"><h2>${day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h2></div><div class="day-timeline">${hourRows}</div></div>${renderCalendarSidebar()}</section>`;
}

function renderCalendarWeek() {
  const [start] = calendarVisibleRange();
  const days = Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const hasToday = days.some(day => day.toDateString() === new Date().toDateString());
  const allDayRows = days.map(day => {
    const items = agendaItemsForDay(day).filter(entry => entry.kind === 'task' || Number(entry.item.all_day));
    return `<div class="week-all-day-cell">${items.slice(0, 3).map(entry => entry.kind === 'task' ? renderTaskChip(entry.item) : renderEventChip(entry.item)).join('') || '<span class="small muted">No all-day items</span>'}</div>`;
  }).join('');
  return `${renderCalendarSearchPanel()}<section class="calendar-page-grid"><div class="calendar-primary stack"><div class="card calendar-toolbar compact-view-title"><h2>${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</h2></div><div class="week-calendar"><div class="week-time-head"></div>${days.map(day => `<div class="week-day-head ${day.toDateString() === new Date().toDateString() ? 'today' : ''}"><span>${day.toLocaleDateString([], { weekday: 'short' })}</span><b>${day.getDate()}</b></div>`).join('')}<div class="week-time-label">All day</div>${allDayRows}${hours.map(hour => `<div class="week-time-label ${hasToday && hour === new Date().getHours() ? 'current-hour-label' : ''}">${formatHour(hour)}</div>${days.map(day => {
    const hourItems = agendaItemsForDay(day).filter(entry => !Number(entry.item.all_day) && new Date(normalizeDate(entry.when)).getHours() === hour);
    const classes = ['week-hour-cell'];
    const now = new Date();
    if (day.toDateString() === now.toDateString()) classes.push('current-day');
    if (day.toDateString() === now.toDateString() && hour === now.getHours()) classes.push('current-hour');
    return `<div class="${classes.join(' ')}" data-quick-add="${dateInputValue(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0))}">${hourItems.map(entry => entry.kind === 'task' ? renderTaskChip(entry.item) : renderEventChip(entry.item)).join('') || '<span class="quick-add-hint">+</span>'}</div>`;
  }).join('')}`).join('')}</div></div>${renderCalendarSidebar('This week', agendaItemsForRange(...calendarVisibleRange()).slice(0, 12))}</section>`;
}

function renderCalendarYear() {
  const year = state.calendarDate.getFullYear();
  const months = Array.from({ length: 12 }, (_, monthIndex) => renderYearMonth(year, monthIndex)).join('');
  return `${renderCalendarSearchPanel()}<section class="calendar-page-grid"><div class="calendar-primary stack"><div class="card calendar-toolbar compact-view-title"><h2>${year}</h2></div><div class="year-grid">${months}</div></div>${renderCalendarSidebar('Scheduled this year', agendaItemsForRange(...calendarVisibleRange()).slice(0, 12))}</section>`;
}

function renderYearMonth(year, monthIndex) {
  const start = new Date(year, monthIndex, 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const count = eventsForDay(day).length + tasksForDay(day).length;
    const classes = ['year-day'];
    if (day.getMonth() !== monthIndex) classes.push('muted-day');
    if (day < startOfToday()) classes.push('past-day');
    if (day.toDateString() === new Date().toDateString()) classes.push('today');
    if (count) classes.push('busy-day');
    cells.push(`<button class="${classes.join(' ')}" data-year-day="${dateInputValue(day)}" type="button" aria-label="${day.toLocaleDateString()}${count ? ', busy' : ''}"><span>${day.getDate()}</span></button>`);
  }
  return `<section class="year-month"><h3>${start.toLocaleString([], { month: 'long' })}</h3><div class="year-weekdays">${['S','M','T','W','T','F','S'].map(day => `<span>${day}</span>`).join('')}</div><div class="year-days">${cells.join('')}</div></section>`;
}

function renderCalendarScheduleView() {
  const [start, end] = calendarVisibleRange();
  const rangeStart = start < startOfToday() ? startOfToday() : start;
  const grouped = new Map();
  agendaItemsForRange(rangeStart, end).forEach(item => {
    const when = new Date(normalizeDate(item.when));
    const key = when.toDateString();
    if (!grouped.has(key)) grouped.set(key, { day: new Date(when.getFullYear(), when.getMonth(), when.getDate()), items: [] });
    grouped.get(key).items.push(item);
  });
  const days = [...grouped.values()].map(group => `<section class="agenda-list-day"><div class="agenda-list-date"><span>${group.day.toLocaleDateString([], { weekday: 'short' })}</span><b>${group.day.toLocaleDateString([], { month: 'short', day: 'numeric' })}</b></div><div class="agenda-list-content"><div class="section-title-row"><h3>${group.day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h3><span><button class="btn ghost mini-btn icon-only-btn" data-new-event-date="${dateInputValue(group.day)}" type="button" aria-label="Add event" title="Add event">${toolIcon('calendar', 'Add event')}</button><button class="btn ghost mini-btn icon-only-btn" data-new-task-date="${dateInputValue(group.day)}" type="button" aria-label="Add task" title="Add task">${toolIcon('check', 'Add task')}</button></span></div>${renderAgendaItems(group.items, true)}</div></section>`);
  const content = days.length ? days.join('') : '<section class="card"><p class="muted small">No upcoming events or tasks.</p></section>';
  return `${renderCalendarSearchPanel()}<section class="calendar-page-grid"><div class="calendar-primary stack"><div class="card calendar-toolbar compact-view-title"><h2>Schedule</h2></div><div class="agenda-list-stack">${content}</div></div>${renderCalendarSidebar()}</section>`;
}

function renderCalendarSearchPanel() {
  return `<div class="card calendar-search-panel"><label><span class="sr-only">Search calendar</span><input class="search" id="search" type="search" aria-label="Search calendar events and tasks. Press Q to focus search." title="Press Q to search" placeholder="Search Calendar events and tasks...  Q" value="${esc(state.q)}"></label>${state.q ? `<span class="pill">Filtering: ${esc(state.q)}</span>` : '<span class="small muted">Events and tasks in the current view</span>'}</div>`;
}

function renderCalendarSidebar(agendaTitle = '', agendaItems = []) {
  const agenda = agendaTitle ? `<section class="card calendar-agenda stack"><h3>${esc(agendaTitle)}</h3>${renderAgendaItems(agendaItems, true, { readonly: true })}</section>` : '';
  return `<aside class="calendar-side stack">${renderCalendarSharing()}${renderMiniMonthPicker()}${agenda}</aside>`;
}

function renderMiniMonthPicker() {
  const month = state.miniCalendarDate;
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const count = eventsForDay(day).length + tasksForDay(day).length;
    const classes = ['mini-month-day'];
    if (day.getMonth() !== month.getMonth()) classes.push('muted-day');
    if (day < startOfToday()) classes.push('past-day');
    if (day.toDateString() === new Date().toDateString()) classes.push('today');
    if (day.toDateString() === state.calendarDate.toDateString()) classes.push('selected');
    cells.push(`<button class="${classes.join(' ')}" data-mini-calendar-day="${dateInputValue(day)}" type="button" aria-label="Open ${day.toLocaleDateString()}${count ? `, ${count} scheduled` : ''}"><span>${day.getDate()}</span>${count ? '<b></b>' : ''}</button>`);
  }
  return `<section class="card mini-month-card stack"><div class="section-title-row mini-month-head"><button class="btn ghost mini-btn" data-mini-month-shift="-1" type="button" aria-label="Previous month">‹</button><h3>${month.toLocaleString([], { month: 'long', year: 'numeric' })}</h3><button class="btn ghost mini-btn" data-mini-month-shift="1" type="button" aria-label="Next month">›</button></div><div class="mini-month-weekdays">${['S','M','T','W','T','F','S'].map(day => `<span>${day}</span>`).join('')}</div><div class="mini-month-grid">${cells.join('')}</div></section>`;
}

function formatHour(hour) {
  const date = new Date(2026, 0, 1, hour, 0);
  return date.toLocaleTimeString([], { hour: 'numeric' });
}

function eventsForDay(day) {
  const query = state.q.trim().toLowerCase();
  return state.events.filter(event => calendarVisible(event.calendar_id) && (!query || matchesCalendarEvent(event, query)) && new Date(normalizeDate(event.starts_at)).toDateString() === day.toDateString());
}

function tasksForDay(day) {
  const query = state.q.trim().toLowerCase();
  return state.tasks.filter(task => task.status !== 'done' && (!task.calendar_id || calendarVisible(task.calendar_id)) && (!query || matchesCalendarTask(task, query)) && task.due_at && new Date(normalizeDate(task.due_at)).toDateString() === day.toDateString());
}

function agendaItemsForDay(day) {
  return [
    ...eventsForDay(day).map(event => ({ kind: 'event', when: event.starts_at, item: event })),
    ...tasksForDay(day).map(task => ({ kind: 'task', when: task.due_at, item: task })),
  ].sort((a, b) => new Date(normalizeDate(a.when)) - new Date(normalizeDate(b.when)));
}

function agendaItemsForRange(start, end) {
  const query = state.q.trim().toLowerCase();
  const startTs = start.getTime();
  const endTs = end.getTime();
  return [
    ...state.events.filter(event => calendarVisible(event.calendar_id) && (!query || matchesCalendarEvent(event, query)) && (() => { const time = new Date(normalizeDate(event.starts_at)).getTime(); return time >= startTs && time <= endTs; })()).map(event => ({ kind: 'event', when: event.starts_at, item: event })),
    ...state.tasks.filter(task => task.status !== 'done' && (!task.calendar_id || calendarVisible(task.calendar_id)) && (!query || matchesCalendarTask(task, query)) && task.due_at && (() => { const time = new Date(normalizeDate(task.due_at)).getTime(); return time >= startTs && time <= endTs; })()).map(task => ({ kind: 'task', when: task.due_at, item: task })),
  ].sort((a, b) => new Date(normalizeDate(a.when)) - new Date(normalizeDate(b.when)));
}

function matchesText(query, ...values) {
  return values.some(value => String(value || '').toLowerCase().includes(query));
}

function matchesCalendarEvent(event, query) {
  return matchesText(query, event.title, event.description, event.location, event.calendar_name);
}

function matchesCalendarTask(task, query) {
  return matchesText(query, task.title, task.description, task.calendar_name);
}

function renderEventChip(event) {
  return `<button class="calendar-event-chip" style="--event-color:${esc(event.calendar_color || '#2563eb')}" data-open-event="${event.series_id || event.id}" title="${esc(event.title)}">${esc(event.title)}</button>`;
}

function renderTaskChip(task) {
  return `<button class="calendar-event-chip task-chip" data-open-task="${task.id}" title="${esc(task.title)}">Task: ${esc(task.title)}</button>`;
}

function renderAgendaItems(items, spacious = false, options = {}) {
  if (!items.length) return '<p class="muted small">Nothing scheduled.</p>';
  const readonly = Boolean(options.readonly);
  return items.map(entry => {
    if (entry.kind === 'task') {
      const task = entry.item;
      return `<button class="agenda-item agenda-link ${spacious ? 'large' : ''} ${task.status === 'done' ? 'done' : ''}" data-open-task="${task.id}" type="button"><span class="agenda-kind task-kind">Task</span><span><b>${esc(task.title)}</b><br><span class="small muted">Due ${formatScheduleDateTime(task.due_at)}${task.calendar_name ? ` · ${esc(task.calendar_name)}` : ''}</span></span></button>`;
    }
    const event = entry.item;
    return `<button class="agenda-item agenda-link ${spacious ? 'large' : ''}" data-open-event="${event.series_id || event.id}" type="button"><span class="agenda-kind event-kind">Event</span><span><b>${esc(event.title)}</b><br><span class="small muted">${formatScheduleDateTime(event.starts_at)}${event.calendar_name ? ` · ${esc(event.calendar_name)}` : ''}</span></span></button>`;
  }).join('');
}

function renderCalendarSharing() {
  if (!state.calendars.length) return `<section class="card stack"><div class="section-title-row"><h3>Calendars</h3><button class="btn" id="addCalendarBtn" type="button">Add</button></div><p class="small muted">No calendars yet.</p></section>`;
  const calendarRows = state.calendars.map(item => {
    const canAdmin = ['owner', 'admin'].includes(item.permission);
    const checked = visibleCalendarIds().has(Number(item.id));
    return `<div class="calendar-manage-row"><label class="calendar-visible-toggle" title="Show calendar"><input type="checkbox" data-calendar-visible="${item.id}" ${checked ? 'checked' : ''}><span style="--calendar-color:${esc(item.color || '#635bff')}"></span></label><span class="calendar-row-name">${esc(item.name)}</span>${canAdmin ? `<button class="icon-action calendar-edit" data-edit-calendar="${item.id}" type="button" aria-label="Edit calendar" title="Edit calendar">${toolIcon('draw', 'Edit')}</button>` : ''}</div>`;
  }).join('');
  return `<section class="card stack"><div class="section-title-row"><h3>Calendars</h3><button class="btn" id="addCalendarBtn" type="button">Add</button></div><div class="stack">${calendarRows}</div></section>`;
}

function visibleCalendarIds() {
  const all = new Set(state.calendars.map(calendar => Number(calendar.id)));
  const stored = JSON.parse(localStorage.getItem('divault_visible_calendar_ids') || 'null');
  if (!Array.isArray(stored) || !stored.length) return all;
  const storedIds = stored.map(Number);
  const selected = new Set(storedIds.filter(id => all.has(id)));
  for (const id of all) {
    if (!storedIds.includes(id)) selected.add(id);
  }
  return selected.size ? selected : all;
}

function calendarVisible(calendarId) {
  if (!calendarId) return true;
  return visibleCalendarIds().has(Number(calendarId));
}

function renderTasks() {
  const query = state.q.trim().toLowerCase();
  const allTasks = query ? state.tasks.filter(task => `${task.title} ${task.description || ''}`.toLowerCase().includes(query)) : state.tasks;
  const allOpenTasks = allTasks.filter(task => task.status !== 'done');
  const allCompletedTasks = allTasks.filter(task => task.status === 'done');
  const today = new Date();
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  const overdue = allOpenTasks.filter(task => task.due_at && new Date(normalizeDate(task.due_at)) < today);
  const dueSoon = allOpenTasks.filter(task => task.due_at && new Date(normalizeDate(task.due_at)) >= today && new Date(normalizeDate(task.due_at)) <= endOfToday);
  const filteredTasks = state.taskFilter === 'done' ? allCompletedTasks : state.taskFilter === 'overdue' ? overdue : state.taskFilter === 'today' ? dueSoon : allOpenTasks;
  const heading = state.taskFilter === 'done' ? 'Completed tasks' : state.taskFilter === 'overdue' ? 'Overdue tasks' : state.taskFilter === 'today' ? 'Due today' : 'Open tasks';
  const pillLabel = state.taskFilter === 'done' ? `${filteredTasks.length} done` : `${filteredTasks.length} shown`;
  const emptyTitle = query ? 'No matching tasks' : state.taskFilter === 'done' ? 'No completed tasks' : state.taskFilter === 'overdue' ? 'No overdue tasks' : state.taskFilter === 'today' ? 'No tasks due today' : 'No open tasks';
  const emptyText = query ? 'Try another search or choose another task filter.' : state.taskFilter === 'done' ? 'Completed tasks will appear here after you check them off.' : state.taskFilter === 'overdue' ? 'Nothing is past due right now.' : state.taskFilter === 'today' ? 'Nothing is due before midnight.' : 'Create a task when something needs follow-up.';
  const card = (filter, label, count, note, extra = '') => `<button class="task-summary-card ${extra} ${state.taskFilter === filter ? 'active' : ''}" data-task-filter="${filter}" type="button"><span>${label}</span><b>${count}</b><small>${note}</small></button>`;
  return `<div class="task-page"><section class="task-summary-grid" aria-label="Task filters">${card('open', 'Open', allOpenTasks.length, 'active tasks')}${card('overdue', 'Overdue', overdue.length, 'need attention', 'urgent')}${card('today', 'Today', dueSoon.length, 'due before midnight', 'today')}${card('done', 'Done', allCompletedTasks.length, 'completed tasks')}</section><section class="card task-board"><div class="task-board-head"><div><p class="breadcrumb">${state.taskFilter === 'done' ? 'Finished work' : 'Active work'}</p><h2>${heading}</h2></div><span class="pill">${pillLabel}</span></div>${renderTaskRows(filteredTasks, { completed: state.taskFilter === 'done', emptyTitle, emptyText })}</section></div>`;
}

function renderTaskRows(tasks, options = {}) {
  return tasks.length ? tasks.map(task => {
    const due = task.due_at ? new Date(normalizeDate(task.due_at)) : null;
    const isOverdue = due && task.status !== 'done' && due < new Date();
    const dueText = due ? `Due ${formatScheduleDateTime(task.due_at)}` : 'No due date';
    const deleteButton = options.completed ? `<button class="btn danger task-delete-btn" data-delete-completed-task="${task.id}" type="button">Delete</button>` : '';
    return `<article class="task-row ${task.status === 'done' ? 'done' : ''} ${isOverdue ? 'overdue' : ''}" data-open-task="${task.id}" role="button" tabindex="0"><span class="task-copy"><b>${esc(task.title)}</b><span class="task-meta"><span>${esc(dueText)}</span>${task.calendar_name ? `<span>${esc(task.calendar_name)}</span>` : ''}${Number(task.priority) > 0 ? `<span>Priority ${Number(task.priority)}</span>` : ''}</span></span><div class="task-row-actions">${deleteButton}<label class="task-check" title="${task.status === 'done' ? 'Mark open' : 'Mark complete'}"><input type="checkbox" data-task-done="${task.id}" ${task.status === 'done' ? 'checked' : ''}><span class="sr-only">${task.status === 'done' ? 'Mark open' : 'Mark complete'}</span></label></div></article>`;
  }).join('') : `<div class="task-empty"><h3>${esc(options.emptyTitle || 'No tasks found')}</h3><p class="muted small">${esc(options.emptyText || 'Create a task or clear the search to see more work.')}</p></div>`;
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

async function goHome() {
  if (!await confirmDiscardUnsaved()) return;
  state.section = defaultSection();
  state.panel = '';
  state.q = '';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  state.selectionMode = false;
  state.selectedNoteIds.clear();
  syncSectionRoute();
  toggleMobileMenu(false);
  await loadCurrentSection();
  renderApp();
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
        ${quickMode ? `<textarea class="quick-note-body" name="body" data-simple-body placeholder="Type the quick note here. No formatting, no blocks, just text.">${esc(visibleBody)}</textarea>` : `<div class="block-editor" data-block-editor>${renderEditorBlocks(parseBodyToBlocks(visibleBody))}</div><p class="small muted slash-hint">Type /heading, /check, /list, /code, /secret, /table, /draw, or /divider in an empty paragraph to switch block type.</p>`}
        <input type="hidden" name="existing_secret_markers" value="${esc(hiddenMarkers.join('\n'))}">
        <input id="fileInput" class="hidden" type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json,.zip,.doc,.docx,.xls,.xlsx">
        <div id="pendingAttachments">${renderPendingAttachments()}</div>
        ${renderNoteExtras(visibleBody, note.title || 'note', state.activeExtra || {})}
        <p class="small muted editor-sync"><span data-autosave-status>Autosaves while open.</span> Saved notes sync through the server on every device.</p>
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
  document.querySelector('#brandHomeBtn')?.addEventListener('click', goHome);
  document.querySelector('#menuToggle')?.addEventListener('click', () => toggleMobileMenu());
  document.querySelector('#sidebarCollapse')?.addEventListener('click', () => toggleDesktopSidebar());
  restoreDesktopSidebarState();
  document.querySelector('#sidebarBackdrop')?.addEventListener('click', () => toggleMobileMenu(false));
  document.querySelector('#notificationBellBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    const existing = document.querySelector('#notificationMenu');
    if (existing) return existing.remove();
    document.querySelector('#notificationBellBtn').insertAdjacentHTML('afterend', renderNotificationDropdown());
    bindNotificationMenuActions();
  });
  document.querySelectorAll('[data-section]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDiscardUnsaved()) return;
    state.section = btn.dataset.section;
    state.panel = '';
    syncSectionRoute();
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
      syncSectionRoute();
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
      syncSectionRoute();
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
    document.querySelector('#contentArea').innerHTML = renderMainContent();
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

function bindNotificationMenuActions() {
  const menu = document.querySelector('#notificationMenu');
  if (!menu) return;
  const close = event => {
    if (!menu.contains(event.target) && !event.target.closest('#notificationBellBtn')) {
      menu.remove();
      document.removeEventListener('pointerdown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  menu.querySelectorAll('[data-task-complete]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const task = state.tasks.find(item => String(item.id) === String(btn.dataset.taskComplete));
    await completeTask(task, async () => {
      await loadNotificationData();
      await loadCurrentSection();
      renderApp();
    });
  }));
  menu.querySelectorAll('[data-open-event]').forEach(row => row.addEventListener('click', () => openEventDialogById(row.dataset.openEvent)));
  menu.querySelectorAll('[data-open-task]').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('[data-task-complete]')) return;
    openTaskDialogById(row.dataset.openTask);
  }));
  menu.querySelectorAll('.notification-link').forEach(row => row.addEventListener('keydown', e => {
    if (!['Enter', ' '].includes(e.key) || e.target.closest('[data-task-complete]')) return;
    e.preventDefault();
    row.click();
  }));
}

function bindContentActions() {
  bindCategoryPanel(document.querySelector('#categoryPanel'));
  bindSettingsPanel(document.querySelector('#settingsPanel'));
  bindNotePaneResize();
  bindCalendarTaskActions();
  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', async e => {
    const card = el.closest('[data-open-card]');
    if (card && handleNoteSelectionClick(e, Number(card.dataset.openCard || el.dataset.open))) return;
    if (!await confirmDiscardUnsaved()) return;
    openEditor(Number(el.dataset.open));
  }));
  document.querySelectorAll('[data-open-card]').forEach(card => card.addEventListener('click', async e => {
    if (e.target.closest('button, input, label, a, select, textarea')) return;
    if (handleNoteSelectionClick(e, Number(card.dataset.openCard))) return;
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
    state.lastSelectedNoteId = id;
    refreshContentArea(renderNotesWorkspace());
  }));
  document.querySelector('#startSelectNotes')?.addEventListener('click', () => {
    state.selectionMode = true;
    document.querySelector('#contentArea').innerHTML = renderNotesWorkspace();
    bindContentActions();
  });
  document.querySelector('#selectAllNotes')?.addEventListener('click', () => {
    state.selectionMode = true;
    state.notes.forEach(note => state.selectedNoteIds.add(Number(note.id)));
    state.lastSelectedNoteId = noteVisibleSelectionIds().at(-1) || null;
    refreshContentArea(renderNotesWorkspace());
  });
  document.querySelector('#selectNoNotes')?.addEventListener('click', () => {
    state.selectedNoteIds.clear();
    state.lastSelectedNoteId = null;
    refreshContentArea(renderNotesWorkspace());
  });
  document.querySelector('#clearSelectedNotes')?.addEventListener('click', () => {
    state.selectionMode = false;
    state.selectedNoteIds.clear();
    state.lastSelectedNoteId = null;
    refreshContentArea(renderNotesWorkspace());
  });
  document.querySelector('#bulkMoveNotes')?.addEventListener('click', () => bulkMoveSelectedNotes(document.querySelector('#bulkMoveCategory')?.value || ''));
  document.querySelector('#bulkArchiveNotes')?.addEventListener('click', () => bulkNoteAction('archive'));
  document.querySelector('#bulkTrashNotes')?.addEventListener('click', () => bulkNoteAction('trash'));
  document.querySelector('#bulkRestoreNotes')?.addEventListener('click', () => bulkNoteAction('restore'));
  document.querySelector('#bulkPermanentDeleteNotes')?.addEventListener('click', () => bulkNoteAction('permanent'));
  document.querySelectorAll('[data-preview-version]').forEach(btn => btn.addEventListener('click', () => previewVersion(Number(btn.dataset.noteId), Number(btn.dataset.previewVersion))));
  document.querySelectorAll('[data-restore-version]').forEach(btn => btn.addEventListener('click', () => restoreVersion(Number(btn.dataset.noteId), Number(btn.dataset.restoreVersion))));
  document.querySelectorAll('[data-preview-file]').forEach(btn => btn.addEventListener('click', e => openDriveFileFromButton(btn, e)));
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
  bindDriveActions();
  bindDesktopContextMenus();
}

function bindDriveActions() {
  if (state.section !== 'drive') return;
  document.querySelectorAll('[data-drive-layout]').forEach(btn => btn.addEventListener('click', () => {
    state.driveLayout = btn.dataset.driveLayout === 'list' ? 'list' : 'grid';
    localStorage.setItem('divault_drive_layout', state.driveLayout);
    document.querySelector('#contentArea').innerHTML = renderDrive();
    bindContentActions();
  }));
  document.querySelectorAll('[data-drive-sort]').forEach(btn => btn.addEventListener('click', () => {
    const field = btn.dataset.driveSort || 'name';
    const [currentField, currentDir] = String(state.driveSort || 'name_asc').split('_');
    const dir = currentField === field && currentDir === 'asc' ? 'desc' : 'asc';
    state.driveSort = `${field}_${dir}`;
    localStorage.setItem('divault_drive_sort', state.driveSort);
    document.querySelector('#contentArea').innerHTML = renderDrive();
    bindContentActions();
  }));
  document.querySelectorAll('[data-drive-folder]').forEach(btn => btn.addEventListener('click', e => {
    if (btn.closest('.drive-main') && handleDriveSelectionClick(e, `folder:${btn.dataset.driveFolder || ''}`)) return;
    navigateDriveFolder(btn.dataset.driveFolder || '');
  }));
  document.querySelector('#newDriveFolderBtn')?.addEventListener('click', createDriveFolder);
  document.querySelector('#newDriveTextBtn')?.addEventListener('click', createDriveTextFile);
  document.querySelector('#driveUploadButton')?.addEventListener('click', openDriveUploadPicker);
  document.querySelector('#driveUploadInput')?.addEventListener('change', e => {
    uploadDriveFiles([...e.target.files]);
    e.target.value = '';
  });
  bindDriveDropUpload();
  document.querySelector('#toggleDriveSelect')?.addEventListener('click', () => {
    state.driveSelectionMode = !state.driveSelectionMode;
    if (!state.driveSelectionMode) {
      state.selectedDriveItems.clear();
      state.lastSelectedDriveKey = '';
    }
    renderApp();
  });
  document.querySelectorAll('[data-select-drive]').forEach(input => input.addEventListener('click', e => e.stopPropagation()));
  document.querySelectorAll('[data-select-drive]').forEach(input => input.addEventListener('change', e => {
    const key = e.target.dataset.selectDrive;
    if (e.target.checked) state.selectedDriveItems.add(key);
    else state.selectedDriveItems.delete(key);
    state.lastSelectedDriveKey = key;
    refreshContentArea(renderDrive());
  }));
  document.querySelector('#selectAllDriveItems')?.addEventListener('click', () => {
    state.driveSelectionMode = true;
    driveVisibleSelectionKeys().forEach(key => state.selectedDriveItems.add(key));
    state.lastSelectedDriveKey = driveVisibleSelectionKeys().at(-1) || '';
    refreshContentArea(renderDrive());
  });
  document.querySelector('#selectNoDriveItems')?.addEventListener('click', () => {
    state.selectedDriveItems.clear();
    state.lastSelectedDriveKey = '';
    refreshContentArea(renderDrive());
  });
  document.querySelector('#compressSelectedDrive')?.addEventListener('click', compressSelectedDriveItems);
  document.querySelector('#deleteSelectedDrive')?.addEventListener('click', deleteSelectedDriveItems);
  document.querySelectorAll('.drive-menu-toggle').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const menu = btn.closest('.drive-actions');
    document.querySelectorAll('.drive-actions.open').forEach(item => {
      if (item === menu) return;
      item.classList.remove('open');
      item.querySelector('.drive-menu-toggle')?.setAttribute('aria-expanded', 'false');
    });
    const open = Boolean(menu?.classList.toggle('open'));
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }));
  document.addEventListener('click', closeDriveMenus, { once: true });
  document.querySelectorAll('[data-rename-drive-folder]').forEach(btn => btn.addEventListener('click', () => renameDriveItem('folder', btn.dataset.renameDriveFolder, btn.dataset.name)));
  document.querySelectorAll('[data-delete-drive-folder]').forEach(btn => btn.addEventListener('click', () => deleteDriveItem('folder', btn.dataset.deleteDriveFolder, btn.dataset.name)));
  document.querySelectorAll('[data-rename-drive-file]').forEach(btn => btn.addEventListener('click', () => renameDriveItem('file', btn.dataset.renameDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-delete-drive-file]').forEach(btn => btn.addEventListener('click', () => deleteDriveItem('file', btn.dataset.deleteDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-share-drive-folder]').forEach(btn => btn.addEventListener('click', () => openDriveShareDialog('folder', btn.dataset.shareDriveFolder, btn.dataset.name)));
  document.querySelectorAll('[data-share-drive-file]').forEach(btn => btn.addEventListener('click', () => openDriveShareDialog('file', btn.dataset.shareDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-edit-drive-file]').forEach(btn => btn.addEventListener('click', () => openDriveTextEditor(btn.dataset.editDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-office-drive-file]').forEach(btn => btn.addEventListener('click', () => openDriveOfficeEditor(btn.dataset.officeDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-zip-drive-folder]').forEach(btn => btn.addEventListener('click', () => zipDriveItem('folder', btn.dataset.zipDriveFolder, btn.dataset.name)));
  document.querySelectorAll('[data-zip-drive-file]').forEach(btn => btn.addEventListener('click', () => zipDriveItem('file', btn.dataset.zipDriveFile, btn.dataset.name)));
  document.querySelectorAll('[data-extract-drive-file]').forEach(btn => btn.addEventListener('click', () => extractDriveZip(btn.dataset.extractDriveFile, btn.dataset.name)));
}

function bindDriveDropUpload() {
  const shell = document.querySelector('.drive-shell');
  if (!shell) return;
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const setActive = active => shell.classList.toggle('drive-drop-active', active);
  shell.addEventListener('dragenter', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    driveUploadDragDepth += 1;
    setActive(true);
  });
  shell.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  shell.addEventListener('dragleave', event => {
    if (!hasFiles(event)) return;
    driveUploadDragDepth = Math.max(0, driveUploadDragDepth - 1);
    if (!driveUploadDragDepth) setActive(false);
  });
  shell.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    driveUploadDragDepth = 0;
    setActive(false);
    uploadDriveFiles([...event.dataTransfer.files]);
  });
}

function openDriveUploadPicker() {
  const input = document.querySelector('#driveUploadInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function navigateDriveFolder(folderId = '', { replace = false } = {}) {
  state.driveFolderId = folderId || '';
  localStorage.setItem('divault_drive_folder_id', state.driveFolderId);
  syncSectionRoute({ replace });
  await loadDrive();
  renderApp();
}

function closeDriveMenus() {
  document.querySelectorAll('.drive-actions.open').forEach(menu => {
    menu.classList.remove('open');
    menu.querySelector('.drive-menu-toggle')?.setAttribute('aria-expanded', 'false');
  });
}

function bindDesktopContextMenus() {
  document.querySelectorAll('.drive-item').forEach(item => item.addEventListener('contextmenu', event => {
    if (!shouldOpenDesktopContextMenu(event) || event.target.closest('input, label, .drive-actions')) return;
    event.preventDefault();
    event.stopPropagation();
    openDriveContextMenu(item, event);
  }));
  document.querySelectorAll('[data-open-card]').forEach(card => card.addEventListener('contextmenu', event => {
    const button = event.target.closest('button');
    if (!shouldOpenDesktopContextMenu(event) || event.target.closest('input, label, a, select, textarea') || (button && !button.matches('[data-open]'))) return;
    event.preventDefault();
    event.stopPropagation();
    openNoteContextMenu(card, event);
  }));
}

function shouldOpenDesktopContextMenu(event) {
  if (event.pointerType && event.pointerType !== 'mouse') return false;
  return window.matchMedia?.('(pointer: fine)').matches ?? !('ontouchstart' in window);
}

function focusDriveItemForContextMenu(item) {
  const key = item.dataset.driveKey || '';
  if (!key) return;
  if (!state.selectedDriveItems.has(key)) {
    state.driveSelectionMode = true;
    state.selectedDriveItems.clear();
    state.selectedDriveItems.add(key);
    document.querySelectorAll('.drive-item.selected').forEach(selected => selected.classList.remove('selected'));
    item.classList.add('selected');
  }
  state.lastSelectedDriveKey = key;
  item.querySelector('.drive-main')?.focus({ preventScroll: true });
}

function focusNoteForContextMenu(card, id) {
  const noteId = Number(id);
  if (!noteId) return;
  if (!state.selectedNoteIds.has(noteId)) {
    state.selectionMode = true;
    state.selectedNoteIds.clear();
    state.selectedNoteIds.add(noteId);
    document.querySelectorAll('.note-card.selected').forEach(selected => selected.classList.remove('selected'));
    card.classList.add('selected');
  }
  state.lastSelectedNoteId = noteId;
  card.focus({ preventScroll: true });
}

function openDriveContextMenu(item, event) {
  focusDriveItemForContextMenu(item);
  const main = item.querySelector('.drive-main');
  const officeEditable = Boolean(main?.dataset.drivePreviewOffice);
  const openLabel = item.classList.contains('folder-item') ? 'Open folder' : officeEditable ? 'Edit document' : 'Open file';
  const openIcon = item.classList.contains('folder-item') ? 'folder' : officeEditable ? 'documentEdit' : 'preview';
  const actions = main ? [{ label: openLabel, iconName: openIcon, run: () => main.click() }] : [];
  item.querySelectorAll('.drive-action-menu [role="menuitem"]').forEach(action => {
    const label = action.getAttribute('aria-label') || action.getAttribute('title') || action.textContent?.trim() || 'Action';
    const iconHtml = action.querySelector('.tool-icon')?.innerHTML || '';
    actions.push({ label, iconHtml, danger: action.classList.contains('danger-link'), run: () => action.click() });
  });
  showDesktopContextMenu(actions, event.clientX, event.clientY, `${openLabel} actions`);
}

function openNoteContextMenu(card, event) {
  const id = Number(card.dataset.noteId || card.dataset.openCard || 0);
  if (!id) return;
  focusNoteForContextMenu(card, id);
  const note = state.notes.find(item => Number(item.id) === id) || {};
  const actions = [{ label: 'Open note', iconName: 'note', attrs: `data-open="${esc(id)}"`, run: async () => {
    if (!await confirmDiscardUnsaved()) return;
    openEditor(id);
  } }];
  if (Number(note.deleted)) {
    actions.push({ label: 'Restore', iconName: 'undo', attrs: 'data-restore-note', run: () => restoreCurrentNote(id) });
    actions.push({ label: 'Delete forever', iconName: 'trash', attrs: 'data-permanent-delete-note', danger: true, run: () => permanentlyDeleteCurrentNote(id) });
  } else if (Number(note.archived)) {
    actions.push({ label: 'Restore', iconName: 'undo', attrs: 'data-restore-note', run: () => restoreCurrentNote(id) });
  } else {
    actions.push({ label: 'Archive', iconName: 'archive', attrs: 'data-archive-note-readonly', run: () => archiveCurrentNote(id) });
    actions.push({ label: 'Recycle', iconName: 'trash', attrs: 'data-trash-note-readonly', danger: true, run: () => trashCurrentNote(id) });
  }
  showDesktopContextMenu(actions, event.clientX, event.clientY, `Note actions for ${note.title || 'note'}`);
}

function showDesktopContextMenu(actions, x, y, label) {
  closeDesktopContextMenu();
  if (!actions.length) return;
  activeContextMenuActions = actions;
  const menu = document.createElement('div');
  menu.className = 'app-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.innerHTML = actions.map((action, index) => `<button class="app-context-menu-item ${action.danger ? 'danger-link' : ''}" type="button" role="menuitem" data-context-menu-action="${index}" ${action.attrs || ''} aria-label="${esc(action.label)}"><span class="tool-icon" aria-hidden="true">${action.iconHtml || icon(action.iconName || 'file')}</span><span>${esc(action.label)}</span></button>`).join('');
  document.body.appendChild(menu);
  positionDesktopContextMenu(menu, x, y);
  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-context-menu-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = activeContextMenuActions[Number(button.dataset.contextMenuAction)];
    closeDesktopContextMenu();
    action?.run?.();
  });
  requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
  addDesktopContextMenuListeners(menu);
}

function positionDesktopContextMenu(menu, x, y) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(margin, x), window.innerWidth - rect.width - margin);
  const top = Math.min(Math.max(margin, y), window.innerHeight - rect.height - margin);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeDesktopContextMenu() {
  removeDesktopContextMenuListeners();
  document.querySelector('.app-context-menu')?.remove();
  activeContextMenuActions = [];
}

function addDesktopContextMenuListeners(menu) {
  const closeOutside = event => {
    if (!menu.contains(event.target)) closeDesktopContextMenu();
  };
  const closeOnEscape = event => {
    if (event.key === 'Escape') closeDesktopContextMenu();
  };
  menu.__divaultContextListeners = { closeOutside, closeOnEscape };
  setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0);
  document.addEventListener('keydown', closeOnEscape);
  window.addEventListener('scroll', closeDesktopContextMenu, true);
  window.addEventListener('resize', closeDesktopContextMenu);
}

function removeDesktopContextMenuListeners() {
  const menu = document.querySelector('.app-context-menu');
  const listeners = menu?.__divaultContextListeners;
  if (listeners) {
    document.removeEventListener('pointerdown', listeners.closeOutside, true);
    document.removeEventListener('keydown', listeners.closeOnEscape);
  }
  window.removeEventListener('scroll', closeDesktopContextMenu, true);
  window.removeEventListener('resize', closeDesktopContextMenu);
}

async function createDriveFolder() {
  const name = await promptDialog({ title: 'New folder', label: 'Folder name', value: '' });
  if (!name) return;
  await runUserAction(async () => {
    await api('/drive/folders', { method: 'POST', body: { name, parent_id: state.driveFolderId || null, folder_id: state.driveFolderId || null } });
    toast('Folder created');
    await loadDrive();
    renderApp();
  }, 'Create folder failed');
}

async function createDriveTextFile() {
  const name = await promptDialog({ title: 'New text file', label: 'File name', value: 'Untitled.txt' });
  if (!name) return;
  const safeName = /\.txt$/i.test(name) ? name : `${name}.txt`;
  const file = new File(['New text file\n'], safeName, { type: 'text/plain' });
  await uploadDriveFiles([file]);
}

async function uploadDriveFiles(files) {
  files = files.filter(Boolean);
  if (!files.length) return;
  await runUserAction(async () => {
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0) || files.length;
    let uploadedBytes = 0;
    setDriveUploadStatus({ visible: true, active: true, error: false, total: files.length, current: 0, percent: 0, fileName: files[0]?.name || '', message: `Uploading ${files.length} file${files.length === 1 ? '' : 's'}...` });
    try {
      for (const [index, file] of files.entries()) {
        const data = new FormData();
        data.append('file', file);
        if (state.driveFolderId) data.append('folder_id', state.driveFolderId);
        await uploadDriveFile(data, progress => {
          const fileProgress = file.size ? progress * Number(file.size || 0) : progress;
          const percent = Math.min(99, Math.round(((uploadedBytes + fileProgress) / totalBytes) * 100));
          setDriveUploadStatus({ visible: true, active: true, error: false, total: files.length, current: index + 1, percent, fileName: file.name || 'File', message: `Uploading ${index + 1} of ${files.length}` });
        });
        uploadedBytes += Number(file.size || 0) || 1;
      }
    } catch (err) {
      setDriveUploadStatus({ visible: true, active: false, error: true, percent: 0, message: err.message || 'Upload failed' });
      throw err;
    }
    setDriveUploadStatus({ visible: true, active: false, error: false, total: files.length, current: files.length, percent: 100, fileName: '', message: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}` });
    toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
    await loadDrive();
    renderApp();
    scheduleDriveUploadStatusHide();
  }, 'Upload failed');
}

function uploadDriveFile(data, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drive/files');
    xhr.withCredentials = true;
    const csrf = getCookie('divault_csrf') || getCookie('qv_csrf');
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(csrf));
    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
        return;
      }
      let message = 'Upload failed';
      try {
        message = JSON.parse(xhr.responseText || '{}').error || message;
      } catch (err) {
        message = xhr.responseText || message;
      }
      reject(new Error(message));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.send(data);
  });
}

function setDriveUploadStatus(next) {
  Object.assign(driveUploadStatus, next);
  if (driveUploadStatusTimer) {
    clearTimeout(driveUploadStatusTimer);
    driveUploadStatusTimer = null;
  }
  updateDriveUploadStatusDom();
}

function scheduleDriveUploadStatusHide() {
  if (driveUploadStatusTimer) clearTimeout(driveUploadStatusTimer);
  driveUploadStatusTimer = setTimeout(() => {
    driveUploadStatus.visible = false;
    updateDriveUploadStatusDom();
  }, 3600);
}

function updateDriveUploadStatusDom() {
  const current = document.querySelector('#driveUploadStatus');
  if (!current) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderDriveUploadStatus();
  current.replaceWith(wrapper.firstElementChild);
}

function renderDriveUploadStatus() {
  const show = state.section === 'drive' && driveUploadStatus.visible;
  const classes = ['drive-upload-status', show ? 'visible' : '', driveUploadStatus.active ? 'active' : '', driveUploadStatus.error ? 'error' : ''].filter(Boolean).join(' ');
  const percent = Math.max(0, Math.min(100, Number(driveUploadStatus.percent || 0)));
  const detail = driveUploadStatus.fileName ? `${driveUploadStatus.fileName}${driveUploadStatus.current && driveUploadStatus.total ? ` · ${driveUploadStatus.current}/${driveUploadStatus.total}` : ''}` : `${driveUploadStatus.current || driveUploadStatus.total || 0}/${driveUploadStatus.total || 0}`;
  return `<div class="${classes}" id="driveUploadStatus" role="status" aria-live="polite" aria-hidden="${show ? 'false' : 'true'}"><div class="drive-upload-status-copy"><b>${esc(driveUploadStatus.message || 'Ready to upload')}</b><span>${esc(detail)}</span></div><div class="drive-upload-progress" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" role="progressbar"><span style="width:${percent}%"></span></div></div>`;
}

async function renameDriveItem(kind, id, currentName) {
  const name = await promptDialog({ title: `Rename ${kind}`, label: 'Name', value: currentName || '' });
  if (!name || name === currentName) return;
  await runUserAction(async () => {
    await api(`/drive/${kind === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
    toast('Renamed');
    await loadDrive();
    renderApp();
  }, 'Rename failed');
}

async function deleteDriveItem(kind, id, name) {
  if (!await confirmDialog({ title: `Delete ${kind}?`, message: `Delete ${name || `this ${kind}`}?`, confirmText: 'Delete' })) return;
  await runUserAction(async () => {
    await api(`/drive/${kind === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Deleted');
    await loadDrive();
    renderApp();
  }, 'Delete failed');
}

async function zipDriveItem(kind, id, name) {
  await runUserAction(async () => {
    await api(`/drive/${kind === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(id)}/zip`, { method: 'POST' });
    toast(`${name || kind} compressed`);
    await loadDrive();
    renderApp();
  }, 'Compress failed');
}

async function extractDriveZip(id, name) {
  if (!await confirmDialog({ title: 'Extract ZIP?', message: `Extract ${name || 'this ZIP'} into a new folder?`, confirmText: 'Extract' })) return;
  await runUserAction(async () => {
    await api(`/drive/files/${encodeURIComponent(id)}/extract`, { method: 'POST' });
    toast('ZIP extracted');
    await loadDrive();
    renderApp();
  }, 'Extract failed');
}

function driveVisibleSelectionKeys() {
  const folders = sortDriveItems(state.driveFolders || [], 'folder').map(item => `folder:${item.id}`);
  const files = sortDriveItems(state.driveFiles || [], 'file').map(item => `file:${item.id}`);
  return [...folders, ...files];
}

function toggleDriveSelection(key) {
  if (!key || /:(undefined|null)?$/.test(key)) return;
  state.driveSelectionMode = true;
  if (state.selectedDriveItems.has(key)) state.selectedDriveItems.delete(key);
  else state.selectedDriveItems.add(key);
  state.lastSelectedDriveKey = key;
}

function selectDriveRangeTo(key) {
  if (!key || /:(undefined|null)?$/.test(key)) return;
  const visible = driveVisibleSelectionKeys();
  const end = visible.indexOf(key);
  if (end < 0) return toggleDriveSelection(key);
  const anchorKey = visible.includes(state.lastSelectedDriveKey) ? state.lastSelectedDriveKey : key;
  const start = visible.indexOf(anchorKey);
  const [from, to] = start < end ? [start, end] : [end, start];
  state.driveSelectionMode = true;
  state.selectedDriveItems.clear();
  visible.slice(from, to + 1).forEach(visibleKey => state.selectedDriveItems.add(visibleKey));
  state.lastSelectedDriveKey = key;
}

function handleDriveSelectionClick(event, key) {
  if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return false;
  if (!key || /:(undefined|null)?$/.test(key)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) selectDriveRangeTo(key);
  else toggleDriveSelection(key);
  refreshContentArea(renderDrive());
  return true;
}

function selectedVisibleDriveKeys() {
  const visible = new Set(driveVisibleSelectionKeys());
  return [...state.selectedDriveItems].filter(key => visible.has(key));
}

function selectedDrivePayload() {
  const keys = selectedVisibleDriveKeys();
  return {
    keys,
    folder_ids: keys.filter(key => key.startsWith('folder:')).map(key => Number(key.slice(7))).filter(Boolean),
    file_ids: keys.filter(key => key.startsWith('file:')).map(key => Number(key.slice(5))).filter(Boolean),
  };
}

async function compressSelectedDriveItems() {
  const selection = selectedDrivePayload();
  if (!selection.keys.length) return;
  await runUserAction(async () => {
    await api('/drive/zip', { method: 'POST', body: { folder_ids: selection.folder_ids, file_ids: selection.file_ids, parent_id: state.driveFolderId || null } });
    state.selectedDriveItems.clear();
    state.driveSelectionMode = false;
    toast(`${selection.keys.length} item${selection.keys.length === 1 ? '' : 's'} compressed`);
    await loadDrive();
    renderApp();
  }, 'Compress selected failed');
}

async function deleteSelectedDriveItems() {
  const selection = selectedDrivePayload();
  if (!selection.keys.length) return;
  if (!await confirmDialog({ title: 'Delete selected?', message: `Delete ${selection.keys.length} selected Drive item${selection.keys.length === 1 ? '' : 's'}?`, confirmText: 'Delete' })) return;
  await runUserAction(async () => {
    for (const id of selection.file_ids) await api(`/drive/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    for (const id of selection.folder_ids) await api(`/drive/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.selectedDriveItems.clear();
    state.driveSelectionMode = false;
    toast('Selected items deleted');
    await loadDrive();
    renderApp();
  }, 'Delete selected failed');
}

async function openDriveShareDialog(kind, id, name) {
  const apiKind = kind === 'folder' ? 'folders' : 'files';
  await runUserAction(async () => {
    const result = await api(`/drive/${apiKind}/${encodeURIComponent(id)}/shares`);
    const shares = result.shares || [];
    const rows = shares.map(share => `<form class="share-row" data-drive-share-user="${esc(share.user_id)}" data-share-email="${esc(share.email)}">
      <span><b>${esc(share.name || share.email)}</b><br><span class="small muted">${esc(share.email)}</span></span>
      <select name="permission" aria-label="Share permission"><option value="view" ${share.permission === 'view' ? 'selected' : ''}>View</option><option value="edit" ${share.permission === 'edit' ? 'selected' : ''}>Edit</option><option value="admin" ${share.permission === 'admin' ? 'selected' : ''}>Admin</option></select>
      <button class="btn ghost mini-btn" type="submit">Save</button><button class="btn danger mini-btn" data-drive-unshare-user="${esc(share.user_id)}" type="button">Remove</button>
    </form>`).join('') || '<p class="small muted">Not shared with anyone yet.</p>';
    const modal = document.createElement('div');
    modal.className = 'editor';
    modal.innerHTML = `<section class="editor-panel small-panel drive-share-dialog"><div class="topbar"><div><h2>Share ${esc(name || kind)}</h2><p class="muted small">Private by default. Add users only when they should access this ${esc(kind)}.</p></div><button class="btn ghost" type="button" data-close>Close</button></div>
      <form id="driveShareForm" class="compact-dialog-share-form"><input name="email" type="email" placeholder="user@example.com" required><select name="permission" aria-label="Permission"><option value="view">View</option><option value="edit">Edit/upload</option><option value="admin">Manage</option></select><button class="btn primary">Share</button></form>
      <div class="stack">${rows}</div></section>`;
    document.body.appendChild(modal);
    setupAccessibleModal(modal, 'input[name="email"]');
    const refresh = async () => {
      modal.remove();
      await loadDrive();
      renderApp();
      openDriveShareDialog(kind, id, name);
    };
    modal.querySelector('#driveShareForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      await runUserAction(async () => {
        await api(`/drive/${apiKind}/${encodeURIComponent(id)}/shares`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('Drive item shared');
        await refresh();
      }, 'Drive share failed');
    });
    modal.querySelectorAll('[data-drive-share-user]').forEach(form => form.addEventListener('submit', async e => {
      e.preventDefault();
      await runUserAction(async () => {
        await api(`/drive/${apiKind}/${encodeURIComponent(id)}/shares`, { method: 'POST', body: { email: form.dataset.shareEmail, permission: new FormData(form).get('permission') } });
        toast('Share updated');
        await refresh();
      }, 'Share update failed');
    }));
    modal.querySelectorAll('[data-drive-unshare-user]').forEach(btn => btn.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Remove share?', message: 'Remove this user from the Drive item?', confirmText: 'Remove' })) return;
      await runUserAction(async () => {
        await api(`/drive/${apiKind}/${encodeURIComponent(id)}/shares/${encodeURIComponent(btn.dataset.driveUnshareUser)}`, { method: 'DELETE' });
        toast('Share removed');
        await refresh();
      }, 'Remove share failed');
    }));
  }, 'Load shares failed');
}

async function openDriveTextEditor(id, name) {
  await runUserAction(async () => {
    const response = await fetch(`/api/drive/files/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('File load failed');
    const content = await response.text();
    if (content.length > 2 * 1024 * 1024) throw new Error('Editable files must be 2 MB or smaller');
    const modal = document.createElement('div');
    modal.className = 'editor';
    modal.innerHTML = `<section class="editor-panel code-lightbox-panel drive-editor-panel"><div class="topbar"><div><p class="terminal-path">divault ~/drive</p><h2>Edit ${esc(name || 'file')}</h2></div><div class="btn-row"><button class="btn primary" form="driveTextEditForm">Save</button><button class="btn ghost" type="button" data-close>Close</button></div></div><form id="driveTextEditForm" class="stack"><textarea class="drive-text-editor" name="content" spellcheck="false">${esc(content)}</textarea></form></section>`;
    document.body.appendChild(modal);
    setupAccessibleModal(modal, 'textarea[name="content"]');
    modal.querySelector('#driveTextEditForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      await runUserAction(async () => {
        await api(`/drive/files/${encodeURIComponent(id)}/content`, { method: 'PATCH', body: { content: new FormData(e.target).get('content') || '' } });
        toast('File saved');
        modal.remove();
        await loadDrive();
        renderApp();
      }, 'File save failed');
    });
  }, 'Open editor failed');
}

async function openDriveOfficeEditor(id, name) {
  let result;
  try {
    result = await api(`/drive/files/${encodeURIComponent(id)}/office`);
  } catch (error) {
    toast(error.message || 'Open OnlyOffice editor failed');
    return false;
  }
  const modal = document.createElement('div');
  const editorId = `onlyoffice-editor-${Date.now()}`;
  modal.className = 'editor onlyoffice-editor';
  modal.innerHTML = `<section class="editor-panel onlyoffice-editor-panel"><div class="topbar preview-topbar"><div><p class="terminal-path">divault ~/drive/office</p><h2>${esc(name || 'Document')}</h2><p class="muted small">Edits save back to Drive after OnlyOffice finishes processing the document.</p></div><div class="btn-row preview-action-row"><button class="btn ghost icon-only-btn" type="button" data-preview-fullscreen aria-pressed="false" title="Enter fullscreen" aria-label="Enter fullscreen">${toolIcon('fullscreen', 'Enter fullscreen')}</button><button class="btn ghost" type="button" data-close>Close</button></div></div><div class="onlyoffice-frame" id="${editorId}"><p class="muted">Loading OnlyOffice...</p></div></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, '[data-close]');
  bindFilePreviewFullscreen(modal);
  let editor = null;
  modal.querySelector('[data-close]')?.addEventListener('click', async () => {
    if (editor && typeof editor.destroyEditor === 'function') editor.destroyEditor();
    await loadDrive();
    renderApp();
  }, { once: true });
  try {
    await loadOnlyOfficeApi(result.api_script);
    editor = new window.DocsAPI.DocEditor(editorId, result.config);
  } catch (error) {
    renderOnlyOfficeLoadError(document.getElementById(editorId), error);
    toast('OnlyOffice could not load');
  }
  return true;
}

function renderOnlyOfficeLoadError(frame, error) {
  if (!frame) return;
  frame.innerHTML = `<div class="onlyoffice-error"><span class="drive-file-mark drive-file-document">${icon('documentEdit')}</span><div><h3>OnlyOffice could not load</h3><p class="muted">${esc(error?.message || 'Check the OnlyOffice public URL, browser access, and Content Security Policy settings.')}</p><p class="muted small">The document is still safe in Drive. Close this window, verify the OnlyOffice Docker URL settings, then try again.</p></div></div>`;
}

function validateOnlyOfficeApiUrl(src) {
  let url;
  try {
    url = new URL(String(src || '').trim(), window.location.href);
  } catch (error) {
    throw new Error('OnlyOffice public URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OnlyOffice public URL must use HTTP or HTTPS.');
  if (window.location.protocol === 'https:' && url.protocol === 'http:') {
    throw new Error('OnlyOffice public URL must use HTTPS when DiVault is loaded over HTTPS.');
  }
  return url.href;
}

function loadOnlyOfficeApi(src) {
  if (window.DocsAPI?.DocEditor) return Promise.resolve();
  if (!String(src || '').trim()) return Promise.reject(new Error('OnlyOffice public URL is not configured'));
  let safeSrc;
  try {
    safeSrc = validateOnlyOfficeApiUrl(src);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!onlyOfficeScriptPromise) {
    onlyOfficeScriptPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = message => {
        onlyOfficeScriptPromise = null;
        reject(new Error(message));
      };
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        fail('OnlyOffice script timed out. Check ONLYOFFICE_PUBLIC_URL and network access.');
      }, 15000);
      const finish = callback => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        callback();
      };
      const script = document.createElement('script');
      script.src = safeSrc;
      script.async = true;
      script.onload = () => finish(() => window.DocsAPI?.DocEditor ? resolve() : fail('OnlyOffice script loaded, but DocsAPI was not available.'));
      script.onerror = () => finish(() => fail('OnlyOffice script could not be loaded. Check ONLYOFFICE_PUBLIC_URL and CSP settings.'));
      document.head.appendChild(script);
    });
  }
  return onlyOfficeScriptPromise;
}

async function openDriveFileFromButton(btn, event) {
  const main = btn.closest('.drive-main');
  if (main && handleDriveSelectionClick(event, `file:${btn.dataset.drivePreviewId}`)) return;
  const options = {
    downloadUrl: btn.dataset.downloadFile || '',
    editId: btn.dataset.drivePreviewEdit || '',
    officeId: btn.dataset.drivePreviewOffice || '',
    metadataId: btn.dataset.drivePreviewId || '',
    extractId: btn.dataset.drivePreviewExtract || '',
  };
  const name = btn.dataset.fileName || 'File preview';
  if (options.officeId && await openDriveOfficeEditor(options.officeId, name)) return;
  openFilePreview(btn.dataset.previewFile, name, btn.dataset.fileMime || '', options);
}

function bindCalendarTaskActions() {
  document.querySelectorAll('[data-task-filter]').forEach(btn => btn.addEventListener('click', () => {
    state.taskFilter = btn.dataset.taskFilter || 'open';
    localStorage.setItem('divault_task_filter', state.taskFilter);
    document.querySelector('#contentArea').innerHTML = renderMainContent();
    bindContentActions();
  }));
  document.querySelector('#prevCalendarMonth')?.addEventListener('click', async () => { shiftCalendarDate(-1); await loadCalendarData(); renderApp(); });
  document.querySelector('#nextCalendarMonth')?.addEventListener('click', async () => { shiftCalendarDate(1); await loadCalendarData(); renderApp(); });
  document.querySelector('#todayCalendarMonth')?.addEventListener('click', async () => { state.calendarDate = new Date(); state.miniCalendarDate = new Date(state.calendarDate); await loadCalendarData(); renderApp(); });
  document.querySelectorAll('[data-calendar-view]').forEach(btn => btn.addEventListener('click', async () => {
    state.calendarView = btn.dataset.calendarView;
    localStorage.setItem('divault_calendar_view', state.calendarView);
    await loadCalendarData();
    renderApp();
  }));
  document.querySelector('#calendarViewSelect')?.addEventListener('change', async e => {
    state.calendarView = e.target.value;
    localStorage.setItem('divault_calendar_view', state.calendarView);
    await loadCalendarData();
    renderApp();
  });
  document.querySelector('#newEventBtn')?.addEventListener('click', () => openEventDialog());
  document.querySelector('#newCalendarTaskBtn')?.addEventListener('click', () => openTaskDialog({ due_at: dateInputValue(state.calendarDate), calendar_id: state.calendars[0]?.id || '' }));
  document.querySelectorAll('[data-new-event-date]').forEach(btn => btn.addEventListener('click', () => openEventDialog({ starts_at: `${btn.dataset.newEventDate}T09:00`.replace('T00:00T', 'T') })));
  document.querySelectorAll('[data-new-task-date]').forEach(btn => btn.addEventListener('click', () => openTaskDialog({ due_at: `${btn.dataset.newTaskDate}T15:00`.replace('T00:00T', 'T'), calendar_id: state.calendars[0]?.id || '' })));
  document.querySelectorAll('[data-quick-add]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    openQuickAddPopover(el, el.dataset.quickAdd);
  }));
  document.querySelectorAll('[data-year-day]').forEach(btn => btn.addEventListener('click', async () => {
    state.calendarDate = new Date(normalizeDate(btn.dataset.yearDay));
    state.calendarView = 'day';
    localStorage.setItem('divault_calendar_view', state.calendarView);
    await loadCalendarData();
    renderApp();
  }));
  document.querySelectorAll('[data-mini-calendar-day]').forEach(btn => btn.addEventListener('click', async () => {
    state.calendarDate = new Date(normalizeDate(btn.dataset.miniCalendarDay));
    state.miniCalendarDate = new Date(state.calendarDate);
    if (state.section !== 'home') {
      state.calendarView = 'day';
      localStorage.setItem('divault_calendar_view', state.calendarView);
    }
    await loadCalendarData();
    renderApp();
  }));
  document.querySelectorAll('[data-mini-month-shift]').forEach(btn => btn.addEventListener('click', async () => {
    state.miniCalendarDate = new Date(state.miniCalendarDate.getFullYear(), state.miniCalendarDate.getMonth() + Number(btn.dataset.miniMonthShift || 0), 1);
    await loadCalendarData();
    renderApp();
  }));
  document.querySelectorAll('[data-open-event]').forEach(btn => btn.addEventListener('click', () => openEventDialogById(btn.dataset.openEvent)));
  document.querySelector('#newTaskBtn')?.addEventListener('click', () => openTaskDialog());
  document.querySelectorAll('[data-open-task]').forEach(item => {
    const open = event => {
      const interactive = event.target.closest('button, input, label, a, select, textarea');
      if (interactive && interactive !== item) return;
      openTaskDialogById(item.dataset.openTask);
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      open(event);
    });
  });
  document.querySelectorAll('[data-task-done]').forEach(input => input.addEventListener('change', async e => {
    const task = state.tasks.find(item => String(item.id) === String(e.target.dataset.taskDone));
    if (!task) return;
    await runUserAction(async () => {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...task, status: e.target.checked ? 'done' : 'open', shared: Number(task.private) === 0 } });
      await loadCurrentSection();
      renderApp();
    }, 'Task update failed');
  }));
  document.querySelectorAll('[data-task-complete]').forEach(btn => btn.addEventListener('click', async () => {
    const task = state.tasks.find(item => String(item.id) === String(btn.dataset.taskComplete));
    if (!task) return;
    await runUserAction(async () => {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...task, status: 'done', shared: Number(task.private) === 0 } });
      await loadCurrentSection();
      renderApp();
    }, 'Task update failed');
  }));
  document.querySelectorAll('[data-delete-completed-task]').forEach(btn => btn.addEventListener('click', async () => {
    const task = state.tasks.find(item => String(item.id) === String(btn.dataset.deleteCompletedTask));
    if (!task) return;
    if (!await confirmDialog({ title: 'Delete completed task?', message: `Permanently delete "${task.title}"?`, confirmText: 'Delete' })) return;
    await runUserAction(async () => {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      await loadCurrentSection();
      renderApp();
    }, 'Task delete failed');
  }));
  document.querySelectorAll('[data-calendar-color]').forEach(btn => btn.addEventListener('click', () => {
    const input = btn.closest('form')?.querySelector('input[name="color"]');
    if (input) {
      input.value = btn.dataset.calendarColor;
      input.closest('.round-color-input')?.style.setProperty('--picked-color', btn.dataset.calendarColor);
    }
  }));
  document.querySelectorAll('.round-color-input input[type="color"]').forEach(input => input.addEventListener('input', () => input.closest('.round-color-input')?.style.setProperty('--picked-color', input.value)));
  document.querySelector('#addCalendarBtn')?.addEventListener('click', () => openCalendarDialog());
  document.querySelectorAll('[data-calendar-visible]').forEach(input => input.addEventListener('change', async () => {
    const selected = [...document.querySelectorAll('[data-calendar-visible]:checked')].map(item => Number(item.dataset.calendarVisible));
    localStorage.setItem('divault_visible_calendar_ids', JSON.stringify(selected));
    await loadCalendarData();
    renderApp();
  }));
  document.querySelectorAll('[data-edit-calendar]').forEach(btn => btn.addEventListener('click', () => openCalendarDialog(btn.dataset.editCalendar)));
  document.querySelectorAll('[data-calendar-manage]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api(`/calendars/${form.dataset.calendarManage}`, { method: 'PATCH', body: Object.fromEntries(new FormData(form)) });
      state.calendars = (await api('/calendars')).calendars || [];
      await loadCalendarData();
      renderApp();
      toast('Calendar saved');
    }, 'Calendar save failed');
  }));
  document.querySelectorAll('[data-delete-calendar]').forEach(btn => btn.addEventListener('click', async () => {
    const calendar = state.calendars.find(item => String(item.id) === String(btn.dataset.deleteCalendar));
    if (!await confirmDialog({ title: 'Delete calendar?', message: `Delete ${calendar?.name || 'this calendar'}? Events stay hidden with the archived calendar.`, confirmText: 'Delete' })) return;
    await runUserAction(async () => {
      await api(`/calendars/${btn.dataset.deleteCalendar}`, { method: 'DELETE' });
      state.calendars = (await api('/calendars')).calendars || [];
      await loadCalendarData();
      renderApp();
      toast('Calendar deleted');
    }, 'Calendar delete failed');
  }));
  document.querySelector('#shareCalendarForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const calendarId = state.calendars[0]?.id;
    if (!calendarId) return;
    await runUserAction(async () => {
      await api(`/calendars/${calendarId}/share`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      state.calendars = (await api('/calendars')).calendars || [];
      renderApp();
      toast('Calendar shared');
    }, 'Calendar share failed');
  });
  document.querySelectorAll('[data-unshare-user]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Remove calendar share?', message: 'Remove this user from the calendar?', confirmText: 'Remove' })) return;
    await runUserAction(async () => {
      await api(`/calendars/${btn.dataset.calendarId}/share/${btn.dataset.unshareUser}`, { method: 'DELETE' });
      state.calendars = (await api('/calendars')).calendars || [];
      renderApp();
      toast('Calendar share removed');
    }, 'Calendar unshare failed');
  }));
  document.querySelectorAll('[data-share-user]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api(`/calendars/${form.dataset.calendarId}/share`, { method: 'POST', body: { email: form.dataset.shareEmail, permission: new FormData(form).get('permission') } });
      state.calendars = (await api('/calendars')).calendars || [];
      renderApp();
      toast('Share updated');
    }, 'Share update failed');
  }));
}

function openQuickAddPopover(anchor, value) {
  document.querySelector('.quick-add-popover')?.remove();
  const when = value || dateInputValue(state.calendarDate);
  const popover = document.createElement('div');
  popover.className = 'quick-add-popover';
  popover.innerHTML = `<b>${formatDateTime(when)}</b><div class="btn-row"><button class="btn primary mini-btn icon-only-btn" data-quick-event type="button" aria-label="Add event" title="Add event">${toolIcon('calendar', 'Add event')}</button><button class="btn mini-btn icon-only-btn" data-quick-task type="button" aria-label="Add task" title="Add task">${toolIcon('check', 'Add task')}</button></div>`;
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - 190)}px`;
  popover.style.top = `${rect.top + window.scrollY + Math.min(rect.height, 42)}px`;
  const close = event => {
    if (!popover.contains(event.target)) {
      popover.remove();
      document.removeEventListener('pointerdown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  popover.querySelector('[data-quick-event]').addEventListener('click', () => {
    const end = new Date(normalizeDate(when));
    end.setHours(end.getHours() + 1);
    popover.remove();
    openEventDialog({ starts_at: when, ends_at: dateInputValue(end) });
  });
  popover.querySelector('[data-quick-task]').addEventListener('click', () => { popover.remove(); openTaskDialog({ due_at: when, calendar_id: state.calendars[0]?.id || '' }); });
}

function shiftCalendarDate(direction) {
  const date = new Date(state.calendarDate);
  if (state.calendarView === 'day') date.setDate(date.getDate() + direction);
  else if (state.calendarView === 'week' || state.calendarView === 'schedule') date.setDate(date.getDate() + (direction * 7));
  else if (state.calendarView === 'year') date.setFullYear(date.getFullYear() + direction);
  else date.setMonth(date.getMonth() + direction);
  state.calendarDate = date;
  state.miniCalendarDate = new Date(date);
}

function openCalendarDialog(id = '') {
  const calendar = id ? state.calendars.find(item => String(item.id) === String(id)) : { name: '', color: '#2563eb', description: '', shares: [], permission: 'owner' };
  if (!calendar) return;
  const editing = Boolean(id);
  const canAdmin = ['owner', 'admin'].includes(calendar.permission);
  const shares = (calendar.shares || []).map(share => `<form class="share-row" data-dialog-share-user="${share.user_id}" data-share-email="${esc(share.email)}" data-calendar-id="${calendar.id}"><span><b>${esc(share.name || share.email)}</b><br><span class="small muted">${esc(share.email)}</span></span><select name="permission" aria-label="Share permission"><option value="view" ${share.permission === 'view' ? 'selected' : ''}>View</option><option value="edit" ${share.permission === 'edit' ? 'selected' : ''}>Edit</option><option value="admin" ${share.permission === 'admin' ? 'selected' : ''}>Admin</option></select><button class="btn ghost mini-btn" type="submit">Save</button><button class="btn danger mini-btn" data-dialog-unshare-user="${share.user_id}" data-calendar-id="${calendar.id}" type="button">Remove</button></form>`).join('') || '<p class="small muted">Not shared with anyone yet.</p>';
  const modal = document.createElement('div');
  modal.className = 'editor';
  modal.innerHTML = `<section class="editor-panel small-panel calendar-dialog"><div class="topbar"><div><h2>${editing ? 'Edit calendar' : 'Add calendar'}</h2><p class="muted small">${editing ? 'Manage this calendar.' : 'Create a calendar and choose a color.'}</p></div><button class="btn ghost" type="button" data-close>Close</button></div><form id="calendarEditForm" class="calendar-dialog-form"><label class="field"><span>Name</span><input name="name" value="${esc(calendar.name)}" placeholder="Calendar name" required ${canAdmin ? '' : 'disabled'}></label><label class="field compact-color-field"><span>Color</span><label class="round-color-input" style="--picked-color:${esc(calendar.color || '#635bff')}" aria-label="Calendar color"><input name="color" type="color" value="${esc(calendar.color || '#635bff')}" ${canAdmin ? '' : 'disabled'}></label></label><label class="field calendar-description-field"><span>Description</span><textarea name="description" ${canAdmin ? '' : 'disabled'}>${esc(calendar.description || '')}</textarea></label>${canAdmin ? `<div class="btn-row dialog-action-row"><button class="btn primary">${editing ? 'Save' : 'Add calendar'}</button>${editing ? '<button class="btn danger" id="deleteCalendarDialogBtn" type="button">Delete</button>' : ''}</div>` : '<p class="small muted">You can view this shared calendar.</p>'}</form>${editing && canAdmin ? `<section class="calendar-dialog-share import-export-panel"><div class="section-title-row"><h3>Import / export</h3><div class="dialog-inline-actions"><button class="btn" data-dialog-import-calendar="${calendar.id}" type="button">Import ICS</button><a class="btn" href="/api/calendar/export/${calendar.id}.ics">Export ICS</a></div></div><p class="small muted">Import or export only ${esc(calendar.name)}.</p></section><section class="calendar-dialog-share"><div class="section-title-row"><h3>Sharing</h3></div><form id="shareCalendarForm" class="compact-dialog-share-form"><input name="email" type="email" placeholder="user@example.com" required><select name="permission"><option value="view">View</option><option value="edit">Edit</option><option value="admin">Admin</option></select><button class="btn">Share</button></form><div class="stack">${shares}</div></section>` : ''}</section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, 'input[name="name"]');
  modal.querySelector('.round-color-input input[type="color"]')?.addEventListener('input', e => e.target.closest('.round-color-input')?.style.setProperty('--picked-color', e.target.value));
  modal.querySelector('#calendarEditForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api(editing ? `/calendars/${calendar.id}` : '/calendars', { method: editing ? 'PATCH' : 'POST', body: Object.fromEntries(new FormData(e.target)) });
      state.calendars = (await api('/calendars')).calendars || [];
      await loadCalendarData();
      modal.remove();
      renderApp();
      toast(editing ? 'Calendar saved' : 'Calendar added');
    }, editing ? 'Calendar save failed' : 'Calendar create failed');
  });
  modal.querySelector('[data-dialog-import-calendar]')?.addEventListener('click', () => importIcsFile(calendar.id));
  modal.querySelector('#deleteCalendarDialogBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete calendar?', message: `Delete ${calendar.name}? Events stay hidden with the archived calendar.`, confirmText: 'Delete' })) return;
    await runUserAction(async () => {
      await api(`/calendars/${calendar.id}`, { method: 'DELETE' });
      state.calendars = (await api('/calendars')).calendars || [];
      await loadCalendarData();
      modal.remove();
      renderApp();
      toast('Calendar deleted');
    }, 'Calendar delete failed');
  });
  modal.querySelector('#shareCalendarForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api(`/calendars/${calendar.id}/share`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      state.calendars = (await api('/calendars')).calendars || [];
      modal.remove();
      renderApp();
      toast('Calendar shared');
    }, 'Calendar share failed');
  });
  modal.querySelectorAll('[data-dialog-share-user]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api(`/calendars/${form.dataset.calendarId}/share`, { method: 'POST', body: { email: form.dataset.shareEmail, permission: new FormData(form).get('permission') } });
      state.calendars = (await api('/calendars')).calendars || [];
      modal.remove();
      renderApp();
      toast('Share updated');
    }, 'Share update failed');
  }));
  modal.querySelectorAll('[data-dialog-unshare-user]').forEach(btn => btn.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Remove calendar share?', message: 'Remove this user from the calendar?', confirmText: 'Remove' })) return;
    await runUserAction(async () => {
      await api(`/calendars/${btn.dataset.calendarId}/share/${btn.dataset.dialogUnshareUser}`, { method: 'DELETE' });
      state.calendars = (await api('/calendars')).calendars || [];
      modal.remove();
      renderApp();
      toast('Calendar share removed');
    }, 'Calendar unshare failed');
  }));
}

async function openEventDialogById(id) {
  await runUserAction(async () => {
    const res = await api(`/events/${id}`);
    openEventDetailDialog(res.event || {});
  }, 'Event load failed');
}

async function openTaskDialogById(id) {
  await runUserAction(async () => {
    const res = await api(`/tasks/${id}`);
    openTaskDetailDialog(res.task || {});
  }, 'Task load failed');
}

async function ensureNotesForLinking(force = false) {
  if (!force && state.linkableNotesLoaded && state.notes.length) return;
  state.notes = (await api('/notes?view=all&sort=updated_desc').catch(() => ({ notes: [] }))).notes || [];
  state.linkableNotesLoaded = true;
}

function noteLinkOptions(selected = []) {
  const selectedSet = new Set((selected || []).map(note => String(note.id || note)));
  const selectedNotes = (selected || []).filter(note => note && typeof note === 'object');
  const byId = new Map([...selectedNotes, ...state.notes].filter(note => note?.id).map(note => [String(note.id), note]));
  return [...byId.values()].slice(0, 240).map(note => `<option value="${note.id}" ${selectedSet.has(String(note.id)) ? 'selected' : ''}>${esc(note.title || 'Untitled note')}</option>`).join('');
}

function recurrenceLabel(rule = '') {
  if (!rule) return 'Does not repeat';
  const match = String(rule).match(/FREQ=([^;]+)/i);
  if (!match) return rule;
  const frequency = match[1].toLowerCase();
  return `Repeats ${frequency}`;
}

function reminderLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) return 'No reminder';
  if (value === 0) return 'At start time';
  if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? '' : 's'} before`;
  if (value % 60 === 0) return `${value / 60} hour${value === 60 ? '' : 's'} before`;
  return `${value} minutes before`;
}

function detailRow(label, value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return `<div class="detail-row"><span>${esc(label)}</span><b>${esc(text)}</b></div>`;
}

function normalizeLocationUrl(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = value.match(/(?:https?:\/\/|www\.)\S+/i);
  if (!match) return '';
  const url = match[0].replace(/[),.;]+$/, '');
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function isLikelyAddress(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (normalizeLocationUrl(value)) return false;
  if (/\b(zoom|teams|meet|webex|skype|facetime|phone call|video call|conference call|online|virtual)\b/i.test(value)) return false;
  if (/\d+\s+[^,]+\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|pl|place|way|pkwy|parkway|hwy|highway|suite|ste|unit|apt)\b/i.test(value)) return true;
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(value)) return true;
  return value.includes(',') && /\d/.test(value) && /[a-z]/i.test(value);
}

function locationDetailRow(locationText) {
  const text = String(locationText ?? '').trim();
  if (!text) return '';
  const meetingUrl = normalizeLocationUrl(text);
  const action = meetingUrl
    ? `<a class="small detail-action-link" href="${esc(meetingUrl)}" target="_blank" rel="noopener noreferrer">Open link</a>`
    : isLikelyAddress(text)
      ? `<a class="small detail-action-link" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer">Directions</a>`
      : '';
  return `<div class="detail-row"><span>Location</span><b>${esc(text)}${action ? ` ${action}` : ''}</b></div>`;
}

function linkedNoteDetailList(notes = []) {
  if (!notes.length) return '<p class="small muted">No linked notes.</p>';
  return `<div class="linked-note-picks detail-note-list">${notes.map(note => `<span class="linked-note-pill"><span>${esc(note.title || 'Untitled note')}</span><button type="button" data-open-linked-note="${esc(note.id)}">View</button></span>`).join('')}</div>`;
}

async function openLinkedNoteFromModal(modal, id) {
  await ensureNotesForLinking(true);
  const noteId = Number(id);
  if (!state.notes.find(note => Number(note.id) === noteId)) return toast('Linked note not found');
  modal?.remove();
  state.section = 'notes:all';
  state.panel = '';
  state.active = state.notes.find(note => Number(note.id) === noteId) || null;
  state.editingNote = false;
  renderApp();
  openEditor(noteId);
}

function printDetail(title, rowsHtml, notesHtml, description = '') {
  const printWindow = window.open('', '_blank', 'width=720,height=860');
  if (!printWindow) return window.print();
  printWindow.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{margin:0 0 18px}.detail-row{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid #ddd}.detail-row span{color:#666}.description{white-space:pre-wrap;margin-top:18px}.linked-note-pill{display:inline-block;margin:4px 6px 4px 0;padding:5px 10px;border:1px solid #ccc;border-radius:999px}</style></head><body><h1>${esc(title)}</h1>${rowsHtml}<div class="description">${linkifyText(description || '')}</div><h2>Linked notes</h2>${notesHtml.replace(/<button[^>]*>.*?<\/button>/g, '')}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function openEventDetailDialog(event = {}) {
  if (!event.id) return;
  const modal = document.createElement('div');
  modal.className = 'editor';
  const readOnly = event.source === 'ics_feed' || event.import_source === 'ics_feed';
  const rows = [
    detailRow('Source', readOnly ? 'External read-only feed' : ''),
    detailRow('Calendar', event.calendar_name),
    detailRow('Starts', formatScheduleDateTime(event.starts_at)),
    detailRow('Ends', event.ends_at ? formatScheduleDateTime(event.ends_at) : ''),
    detailRow('All day', Number(event.all_day) ? 'Yes' : ''),
    detailRow('Repeat', recurrenceLabel(event.recurrence_rule)),
    detailRow('Reminder', reminderLabel(event.reminder_minutes)),
    locationDetailRow(event.location)
  ].join('');
  const notes = linkedNoteDetailList(event.notes || []);
  const editControls = readOnly ? '<span class="pill">read-only</span>' : `<button class="btn ghost icon-only-btn" type="button" data-edit-detail aria-label="Edit" title="Edit">${toolIcon('draw', 'Edit')}</button><button class="btn danger icon-only-btn" type="button" data-delete-detail aria-label="Delete" title="Delete">${toolIcon('trash', 'Delete')}</button>`;
  modal.innerHTML = `<section class="editor-panel small-panel detail-dialog"><div class="topbar"><div><p class="breadcrumb">Event</p><h2>${esc(event.title || 'Untitled event')}</h2></div><div class="btn-row"><button class="btn ghost icon-only-btn" type="button" data-print-detail aria-label="Print" title="Print">${toolIcon('print', 'Print')}</button>${editControls}<button class="btn ghost" type="button" data-close>Close</button></div></div><div class="detail-grid">${rows}</div>${event.description ? `<div class="detail-description"><h3>Description</h3><p>${linkifyText(event.description)}</p></div>` : ''}<section class="detail-notes"><h3>Related notes</h3>${notes}</section></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, '[data-close]');
  modal.querySelector('[data-edit-detail]')?.addEventListener('click', () => { modal.remove(); openEventDialog(event); });
  modal.querySelector('[data-print-detail]').addEventListener('click', () => printDetail(event.title || 'Event', rows, notes, event.description));
  modal.querySelector('[data-delete-detail]')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete event?', message: 'Delete this calendar event?', confirmText: 'Delete' })) return;
    await runUserAction(async () => {
      await api(`/events/${event.id}`, { method: 'DELETE' });
      modal.remove();
      await loadCurrentSection();
      renderApp();
      toast('Event deleted');
    }, 'Event delete failed');
  });
  modal.addEventListener('click', e => {
    const open = e.target.closest('[data-open-linked-note]');
    if (open) openLinkedNoteFromModal(modal, open.dataset.openLinkedNote);
  });
}

function openTaskDetailDialog(task = {}) {
  if (!task.id) return;
  const modal = document.createElement('div');
  modal.className = 'editor';
  const rows = [
    detailRow('Status', task.status || 'open'),
    detailRow('Due', task.due_at ? formatScheduleDateTime(task.due_at) : 'No due date'),
    detailRow('Calendar', task.calendar_name || (Number(task.private) ? 'Private task' : '')),
    detailRow('Priority', task.priority ? task.priority : ''),
    detailRow('Reminder', reminderLabel(task.reminder_minutes)),
    locationDetailRow(task.location)
  ].join('');
  const notes = linkedNoteDetailList(task.notes || []);
  const isDone = task.status === 'done';
  const completeButton = `<button class="task-complete-btn ${isDone ? 'is-complete' : ''}" type="button" data-complete-detail aria-label="${isDone ? 'Reopen task' : 'Complete task'}" title="${isDone ? 'Reopen task' : 'Complete task'}">${toolIcon('check', isDone ? 'Reopen task' : 'Complete task')}</button>`;
  modal.innerHTML = `<section class="editor-panel small-panel detail-dialog"><div class="topbar"><div><p class="breadcrumb">Task</p><h2>${esc(task.title || 'Untitled task')}</h2></div><div class="btn-row">${completeButton}<button class="btn ghost icon-only-btn" type="button" data-print-detail aria-label="Print" title="Print">${toolIcon('print', 'Print')}</button><button class="btn ghost icon-only-btn" type="button" data-edit-detail aria-label="Edit" title="Edit">${toolIcon('draw', 'Edit')}</button><button class="btn danger icon-only-btn" type="button" data-delete-detail aria-label="Delete" title="Delete">${toolIcon('trash', 'Delete')}</button><button class="btn ghost" type="button" data-close>Close</button></div></div><div class="detail-grid">${rows}</div>${task.description ? `<div class="detail-description"><h3>Description</h3><p>${linkifyText(task.description)}</p></div>` : ''}<section class="detail-notes"><h3>Related notes</h3>${notes}</section></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, '[data-close]');
  modal.querySelector('[data-complete-detail]')?.addEventListener('click', async () => {
    await toggleTaskStatus(task, async status => {
      modal.remove();
      await loadNotificationData();
      await loadCurrentSection();
      renderApp();
      toast(status === 'done' ? 'Task completed' : 'Task reopened');
    });
  });
  modal.querySelector('[data-edit-detail]').addEventListener('click', () => { modal.remove(); openTaskDialog(task); });
  modal.querySelector('[data-print-detail]').addEventListener('click', () => printDetail(task.title || 'Task', rows, notes, task.description));
  modal.querySelector('[data-delete-detail]').addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete task?', message: 'Delete this task?', confirmText: 'Delete' })) return;
    await runUserAction(async () => {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      modal.remove();
      await loadCurrentSection();
      renderApp();
      toast('Task deleted');
    }, 'Task delete failed');
  });
  modal.addEventListener('click', e => {
    const open = e.target.closest('[data-open-linked-note]');
    if (open) openLinkedNoteFromModal(modal, open.dataset.openLinkedNote);
  });
}

function enhanceLinkedNotes(modal) {
  const select = modal.querySelector('select[name="note_ids"]');
  if (!select || select.dataset.enhanced === '1') return;
  select.dataset.enhanced = '1';
  select.classList.add('linked-note-select');
  select.insertAdjacentHTML('afterend', `<div class="linked-note-tools"><div class="linked-note-picks" data-linked-note-picks></div><div class="small muted" data-linked-note-status role="status">Linked-note changes apply when you save this item.</div><div class="linked-note-search"><input type="search" data-linked-note-search aria-label="Search notes to link" placeholder="Search notes to link"><div class="linked-note-results" data-linked-note-results aria-live="polite"></div></div><div class="linked-note-create"><input type="text" data-linked-note-title aria-label="New linked note title" placeholder="New linked note title"><button class="btn" type="button" data-add-linked-note>Add note</button></div></div>`);
  const selectedIds = () => new Set([...select.selectedOptions].map(option => String(option.value)));
  const noteById = id => state.notes.find(note => String(note.id) === String(id));
  const setSelected = (id, selected) => {
    const option = [...select.options].find(item => String(item.value) === String(id));
    if (option) option.selected = selected;
  };
  const markPending = () => {
    const status = modal.querySelector('[data-linked-note-status]');
    if (status) status.textContent = 'Unsaved linked-note changes. Save this item to apply them.';
  };
  const renderPicks = () => {
    const picks = [...select.selectedOptions].map(option => `<span class="linked-note-pill"><span>${esc(option.textContent || 'Untitled note')}</span><button type="button" data-open-linked-note="${esc(option.value)}">View</button><button type="button" data-remove-linked-note="${esc(option.value)}" aria-label="Unlink ${esc(option.textContent || 'linked note')}" title="Unlink from this item on save">Unlink</button></span>`).join('');
    const target = modal.querySelector('[data-linked-note-picks]');
    if (target) target.innerHTML = picks || '<span class="small muted">No linked notes selected.</span>';
  };
  const renderResults = () => {
    const query = String(modal.querySelector('[data-linked-note-search]')?.value || '').trim().toLowerCase();
    const target = modal.querySelector('[data-linked-note-results]');
    if (!target) return;
    if (!query) {
      target.innerHTML = '<span class="small muted">Start typing to find notes to link.</span>';
      return;
    }
    const selected = selectedIds();
    const matches = state.notes
      .filter(note => !selected.has(String(note.id)))
      .filter(note => String(note.title || '').toLowerCase().includes(query))
      .slice(0, 8);
    if (target) target.innerHTML = matches.map(note => `<button class="linked-note-result" type="button" data-pick-linked-note="${note.id}"><b>${esc(note.title || 'Untitled note')}</b><span>${esc(note.updated_at || '')}</span></button>`).join('') || '<span class="small muted">No matching notes.</span>';
  };
  select.addEventListener('change', renderPicks);
  modal.querySelector('[data-linked-note-search]')?.addEventListener('input', renderResults);
  modal.addEventListener('click', async e => {
    const pick = e.target.closest('[data-pick-linked-note]');
    if (pick) {
      setSelected(pick.dataset.pickLinkedNote, true);
      markPending();
      const search = modal.querySelector('[data-linked-note-search]');
      if (search) search.value = '';
      renderPicks();
      renderResults();
      return;
    }
    const remove = e.target.closest('[data-remove-linked-note]');
    if (remove) {
      setSelected(remove.dataset.removeLinkedNote, false);
      markPending();
      renderPicks();
      renderResults();
      return;
    }
    const open = e.target.closest('[data-open-linked-note]');
    if (open) {
      if (!noteById(open.dataset.openLinkedNote)) await ensureNotesForLinking(true);
      await openLinkedNoteFromModal(modal, open.dataset.openLinkedNote);
    }
  });
  modal.querySelector('[data-add-linked-note]')?.addEventListener('click', async () => {
    const input = modal.querySelector('[data-linked-note-title]');
    const title = String(input?.value || '').trim();
    if (!title) return toast('Enter a note title first');
    await runUserAction(async () => {
      const note = await api('/notes', { method: 'POST', body: { title, body: '', section: 'All', type: 'text' } });
      const id = Number(note.id);
      if (!id) throw new Error('Linked note was not created');
      state.notes.unshift({ id, title });
      state.linkableNotesLoaded = true;
      const option = document.createElement('option');
      option.value = String(id);
      option.textContent = title;
      option.selected = true;
      select.prepend(option);
      markPending();
      if (input) input.value = '';
      renderPicks();
      renderResults();
      toast('Linked note added');
    }, 'Linked note create failed');
  });
  renderPicks();
  renderResults();
}

async function openEventDialog(event = {}) {
  await ensureNotesForLinking();
  const modal = document.createElement('div');
  modal.className = 'editor';
  const calendarOptions = state.calendars.map(calendar => `<option value="${calendar.id}" ${String(calendar.id) === String(event.calendar_id || state.calendars[0]?.id || '') ? 'selected' : ''}>${esc(calendar.name)}</option>`).join('');
  const reminderMinutes = event.id ? (event.reminder_minutes ?? -1) : (feature('calendar').settings.default_reminder_minutes ?? 10);
  modal.innerHTML = `<section class="editor-panel small-panel"><div class="topbar"><div><h2>${event.id ? 'Edit event' : 'New event'}</h2></div><button class="btn ghost" type="button" data-close>Cancel</button></div><form id="eventForm" class="stack"><label class="field"><span>Calendar</span><select name="calendar_id">${calendarOptions}</select></label><label class="field"><span>Title</span><input name="title" value="${esc(event.title || '')}" required></label><label class="field"><span>Starts</span><input name="starts_at" type="datetime-local" value="${esc(dateInputValue(event.starts_at || new Date()))}" required></label><label class="field"><span>Ends</span><input name="ends_at" type="datetime-local" value="${esc(dateInputValue(event.ends_at || event.starts_at || new Date()))}"></label><label class="checkline"><input name="all_day" type="checkbox" ${Number(event.all_day) ? 'checked' : ''}> All day</label><label class="field"><span>Repeats</span><select name="recurrence_rule"><option value="">Does not repeat</option><option value="FREQ=DAILY" ${event.recurrence_rule === 'FREQ=DAILY' ? 'selected' : ''}>Daily</option><option value="FREQ=WEEKLY" ${event.recurrence_rule === 'FREQ=WEEKLY' ? 'selected' : ''}>Weekly</option><option value="FREQ=MONTHLY" ${event.recurrence_rule === 'FREQ=MONTHLY' ? 'selected' : ''}>Monthly</option><option value="FREQ=YEARLY" ${event.recurrence_rule === 'FREQ=YEARLY' ? 'selected' : ''}>Yearly</option></select></label><label class="field"><span>Reminder minutes before</span><input name="reminder_minutes" type="number" min="-1" max="10080" value="${esc(reminderMinutes)}"></label><label class="field"><span>Location</span><input name="location" value="${esc(event.location || '')}"></label><label class="field"><span>Linked notes</span><select name="note_ids" multiple size="5">${noteLinkOptions(event.notes || [])}</select></label><label class="field"><span>Description</span><textarea name="description">${esc(event.description || '')}</textarea></label><div class="btn-row"><button class="btn primary">Save event</button>${event.id ? '<button class="btn danger" type="button" id="deleteEventBtn">Delete</button>' : ''}</div></form></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, 'input[name="title"]');
  enhanceLinkedNotes(modal);
  modal.querySelector('#eventForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.note_ids = [...e.target.querySelector('select[name="note_ids"]').selectedOptions].map(option => Number(option.value));
    data.all_day = Boolean(data.all_day);
    await runUserAction(async () => {
      await api(event.id ? `/events/${event.id}` : '/events', { method: event.id ? 'PATCH' : 'POST', body: data });
      modal.remove();
      await loadCurrentSection();
      renderApp();
    }, 'Event save failed');
  });
  modal.querySelector('#deleteEventBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete event?', message: 'Delete this calendar event?', confirmText: 'Delete' })) return;
    await api(`/events/${event.id}`, { method: 'DELETE' });
    modal.remove();
    await loadCurrentSection();
    renderApp();
  });
}

async function openTaskDialog(task = {}) {
  await ensureNotesForLinking();
  const modal = document.createElement('div');
  modal.className = 'editor';
  const calendarOptions = '<option value="">Private task</option>' + state.calendars.map(calendar => `<option value="${calendar.id}" ${String(calendar.id) === String(task.calendar_id || '') ? 'selected' : ''}>${esc(calendar.name)}</option>`).join('');
  const sharedChecked = task.id ? Number(task.private) === 0 : Boolean(task.calendar_id);
  const reminderMinutes = task.id ? (task.reminder_minutes ?? -1) : (feature('tasks').settings.default_reminder_minutes ?? 10);
  modal.innerHTML = `<section class="editor-panel small-panel"><div class="topbar"><div><h2>${task.id ? 'Edit task' : 'New task'}</h2></div><button class="btn ghost" type="button" data-close>Cancel</button></div><form id="taskForm" class="stack"><label class="field"><span>Title</span><input name="title" value="${esc(task.title || '')}" required></label><label class="field"><span>Calendar</span><select name="calendar_id">${calendarOptions}</select></label><label class="checkline"><input name="shared" type="checkbox" ${sharedChecked ? 'checked' : ''}> Show on calendar</label><label class="field"><span>Due</span><input name="due_at" type="datetime-local" value="${esc(dateInputValue(task.due_at || ''))}"></label><label class="field"><span>Priority</span><input name="priority" type="number" min="0" max="5" value="${esc(task.priority || 0)}"></label><label class="field"><span>Reminder minutes before</span><input name="reminder_minutes" type="number" min="-1" max="10080" value="${esc(reminderMinutes)}"></label><label class="field"><span>Location</span><input name="location" value="${esc(task.location || '')}"></label><label class="field"><span>Linked notes</span><select name="note_ids" multiple size="5">${noteLinkOptions(task.notes || [])}</select></label><label class="field"><span>Description</span><textarea name="description">${esc(task.description || '')}</textarea></label><div class="btn-row"><button class="btn primary">Save task</button>${task.id ? '<button class="btn danger" type="button" id="deleteTaskBtn">Delete</button>' : ''}</div></form></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, 'input[name="title"]');
  enhanceLinkedNotes(modal);
  modal.querySelector('#taskForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.note_ids = [...e.target.querySelector('select[name="note_ids"]').selectedOptions].map(option => Number(option.value));
    data.shared = Boolean(data.shared);
    data.status = task.status || 'open';
    await runUserAction(async () => {
      await api(task.id ? `/tasks/${task.id}` : '/tasks', { method: task.id ? 'PATCH' : 'POST', body: data });
      modal.remove();
      await loadCurrentSection();
      renderApp();
    }, 'Task save failed');
  });
  modal.querySelector('#deleteTaskBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Delete task?', message: 'Delete this task?', confirmText: 'Delete' })) return;
    await api(`/tasks/${task.id}`, { method: 'DELETE' });
    modal.remove();
    await loadCurrentSection();
    renderApp();
  });
}

async function importIcsFile(calendarId = '') {
  if (!state.calendars.length) {
    await runUserAction(async () => {
      await api('/calendars', { method: 'POST', body: { name: 'Imported Calendar', color: '#635bff' } });
      state.calendars = (await api('/calendars')).calendars || [];
    }, 'Calendar create failed');
  }
  const modal = document.createElement('div');
  modal.className = 'editor';
  const calendarOptions = state.calendars.map(calendar => `<option value="${calendar.id}" ${String(calendar.id) === String(calendarId) ? 'selected' : ''}>${esc(calendar.name)}</option>`).join('');
  modal.innerHTML = `<section class="editor-panel small-panel"><div class="topbar"><div><h2>Import ICS calendar</h2><p class="muted small">Import standard iCalendar files.</p></div><button class="btn ghost" type="button" data-close>Cancel</button></div><form id="icsImportForm" class="stack"><label class="field"><span>ICS file</span><input name="ics" type="file" accept=".ics,text/calendar" required></label><label class="field ${calendarId ? 'hidden' : ''}"><span>Import into</span><select name="calendar_id">${calendarOptions}</select></label><label class="field"><span>If duplicates are found</span><select name="mode"><option value="skip">Skip existing events</option><option value="update">Update existing imported events</option></select></label><button class="btn primary">Import calendar</button></form></section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, 'input[type="file"]');
  modal.querySelector('#icsImportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    await runUserAction(async () => {
      const res = await api('/calendar/import', { method: 'POST', body: form });
      toast(`ICS import: ${res.imported || 0} new, ${res.updated || 0} updated, ${res.skipped || 0} skipped`);
      modal.remove();
      state.calendars = (await api('/calendars')).calendars || [];
      await loadCalendarData();
      renderApp();
    }, 'ICS import failed');
  });
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

function renderDrive() {
  const folders = sortDriveItems(state.driveFolders || [], 'folder');
  const files = sortDriveItems(state.driveFiles || [], 'file');
  const crumbs = renderDriveBreadcrumbs();
  const empty = !folders.length && !files.length;
  const bulkActions = renderDriveBulkActions(folders.length + files.length);
  const currentName = driveCurrentFolderName();
  const totalItems = folders.length + files.length;
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || file.bytes || 0), 0);
  const latest = latestDriveTimestamp([...folders, ...files]);
  const pathText = drivePathText();
  const parentFolderId = driveParentFolderId();
  const itemSummary = `${totalItems} item${totalItems === 1 ? '' : 's'}`;
  const statPills = [`${folders.length} folder${folders.length === 1 ? '' : 's'}`, `${files.length} file${files.length === 1 ? '' : 's'}`];
  const photoCount = files.filter(file => isDriveImageFile(file.original_name || file.name || file.filename || '', file.mime || file.mime_type || file.type || '')).length;
  const photoFolder = state.driveLayout === 'grid' && photoCount >= 3;
  if (totalBytes) statPills.push(formatDriveSize(totalBytes));
  if (photoCount) statPills.push(`${photoCount} photo${photoCount === 1 ? '' : 's'}`);
  if (latest) statPills.push(`Updated ${formatDateTime(latest)}`);
  const upLabel = state.driveFolderId ? `Up from ${currentName}` : 'Already at Drive root';
  const upButton = state.driveFolderId ? `<button class="drive-up-btn" data-drive-folder="${esc(parentFolderId)}" type="button" aria-label="${esc(upLabel)}" title="${esc(upLabel)}"><span aria-hidden="true">‹</span></button>` : `<button class="drive-up-btn" type="button" aria-label="${esc(upLabel)}" title="${esc(upLabel)}" disabled><span aria-hidden="true">‹</span></button>`;
  return `<section class="drive-shell ${state.driveLayout === 'list' ? 'list-view' : 'grid-view'} ${photoFolder ? 'photo-folder' : ''} ${state.driveSelectionMode ? 'selecting' : ''}" aria-label="Drive file browser">
    ${bulkActions}<div class="drive-header card"><div class="drive-path-controls">${upButton}<span class="drive-root-mark compact" aria-hidden="true">${icon('folder')}</span></div><div class="drive-path-line"><span class="drive-path-label">Drive</span>${crumbs}</div><div class="drive-stats" aria-label="Folder summary"><span class="drive-summary" title="/${esc(pathText)}">${esc(itemSummary)}</span>${statPills.map(stat => `<span class="pill">${esc(stat)}</span>`).join('')}</div></div>
    ${photoFolder ? `<div class="drive-gallery-note"><span>${toolIcon('cards', 'Photo gallery')}</span><div><b>Photo gallery view</b><small>${photoCount} images are shown with larger previews. Switch to list view for compact file details.</small></div></div>` : ''}
    ${empty ? renderDriveEmptyState() : `<div class="drive-list-card" role="region" aria-label="${esc(currentName)} contents"><div class="drive-list-head">${renderDriveSortHeader('name', 'Name')}${renderDriveSortHeader('size', 'Size')}${renderDriveSortHeader('type', 'Type')}${renderDriveSortHeader('date', 'Modified')}<span>Actions</span></div><div class="drive-items">${folders.map(renderDriveFolder).join('')}${files.map(renderDriveFile).join('')}</div></div>`}
  </section>`;
}

function renderDriveEmptyState() {
  const title = state.q ? 'No matching files' : 'This folder is empty';
  const hint = state.q ? 'Try another search term or use the path above to move up.' : 'Use the compact toolbar to upload, create a folder, or start a text file here.';
  return `<div class="empty card drive-empty"><span class="drive-empty-mark">${icon('folder')}</span><div><span class="drive-path-label">Ready at</span><div class="drive-empty-path">/${esc(drivePathText())}</div></div><h2>${esc(title)}</h2><p>${esc(hint)}</p></div>`;
}

function renderDriveBulkActions(total) {
  if (!state.driveSelectionMode) return '';
  const selectedCount = selectedVisibleDriveKeys().length;
  return `<div class="bulk-note-actions drive-bulk-actions card ${selectedCount ? 'has-selection' : ''}"><span class="small muted">${selectedCount ? `${selectedCount} selected` : 'Select files or folders for bulk actions.'}</span><button class="btn ghost bulk-icon-btn" type="button" id="selectAllDriveItems" aria-label="Select all" title="Select all">${toolIcon('selectAll', 'Select all')}<span>Select all</span></button>${selectedCount ? `<button class="btn ghost bulk-icon-btn" type="button" id="selectNoDriveItems" aria-label="Select none" title="Select none">${toolIcon('selectNone', 'Select none')}<span>Select none</span></button><button class="btn" type="button" id="compressSelectedDrive" aria-label="Compress selected" title="Compress selected">Compress</button><span class="bulk-danger-zone"><button class="btn danger icon-only-btn" type="button" id="deleteSelectedDrive" aria-label="Delete selected" title="Delete selected">${toolIcon('trash', 'Delete selected')}</button></span>` : total ? '' : '<span class="small muted">This folder is empty.</span>'}</div>`;
}

function renderDriveSortHeader(field, label) {
  const [currentField, dir] = String(state.driveSort || 'name_asc').split('_');
  const active = currentField === field;
  return `<button class="drive-sort-head ${active ? 'active' : ''}" data-drive-sort="${field}" type="button">${esc(label)}${active ? `<span>${dir === 'desc' ? '↓' : '↑'}</span>` : ''}</button>`;
}

function sortDriveItems(items, kind) {
  const [field, dir = 'asc'] = String(state.driveSort || 'name_asc').split('_');
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const left = driveSortValue(a, kind, field);
    const right = driveSortValue(b, kind, field);
    if (typeof left === 'number' || typeof right === 'number') return ((Number(left) || 0) - (Number(right) || 0)) * sign;
    return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

function driveSortValue(item, kind, field) {
  if (field === 'size') return kind === 'folder' ? -1 : Number(item.size || item.bytes || 0);
  if (field === 'type') return kind === 'folder' ? 'folder' : driveFileExtension(item.original_name || item.name || item.filename || '');
  if (field === 'date') return new Date(normalizeDate(item.updated_at || item.created_at || 0)).getTime() || 0;
  return kind === 'folder' ? (item.name || item.title || '') : (item.original_name || item.name || item.filename || '');
}

function renderDriveBreadcrumbs() {
  const crumbs = normalizeDriveBreadcrumbs();
  if (!crumbs.length) return `<div class="drive-breadcrumbs" aria-label="Current Drive path"><button class="link-button" data-drive-folder="" type="button" aria-current="page">Root</button></div>`;
  return `<div class="drive-breadcrumbs" aria-label="Current Drive path"><button class="link-button" data-drive-folder="" type="button">Root</button>${crumbs.map((crumb, index) => `<span aria-hidden="true">/</span><button class="link-button" data-drive-folder="${esc(crumb.id || '')}" type="button" ${index === crumbs.length - 1 ? 'aria-current="page"' : ''}>${esc(crumb.name || 'Folder')}</button>`).join('')}</div>`;
}

function drivePathText() {
  const crumbs = normalizeDriveBreadcrumbs();
  return ['Root', ...crumbs.map(crumb => crumb.name || 'Folder')].join(' / ');
}

function driveParentFolderId() {
  const crumbs = normalizeDriveBreadcrumbs();
  if (!state.driveFolderId || crumbs.length < 2) return '';
  return crumbs.at(-2)?.id || '';
}

function normalizeDriveBreadcrumbs() {
  return (state.driveBreadcrumbs || []).map(crumb => typeof crumb === 'string' ? { id: '', name: crumb } : crumb).filter(Boolean);
}

function driveCurrentFolderName() {
  const last = normalizeDriveBreadcrumbs().at(-1);
  if (!state.driveFolderId) return 'Root';
  return last?.name || state.driveFolders.find(folder => String(folder.id) === String(state.driveFolderId))?.name || 'Folder';
}

function latestDriveTimestamp(items) {
  const latest = items.map(item => new Date(normalizeDate(item.updated_at || item.created_at || 0)).getTime() || 0).filter(Boolean).sort((a, b) => b - a)[0];
  return latest ? new Date(latest).toISOString() : '';
}

function renderDriveFolder(folder) {
  const name = folder.name || folder.title || 'Untitled folder';
  const updated = folder.updated_at || folder.created_at || '';
  const contents = driveFolderContentsLabel(folder);
  const modified = updated ? `Modified ${formatDateTime(updated)}` : '';
  const meta = [contents, modified].filter(Boolean).join(' · ');
  const canManage = driveCanManage(folder);
  const selectionKey = `folder:${folder.id}`;
  const selected = state.selectedDriveItems.has(selectionKey);
  const selector = state.driveSelectionMode ? `<label class="drive-select"><input type="checkbox" data-select-drive="${esc(selectionKey)}" ${selected ? 'checked' : ''} aria-label="Select ${esc(name)}"><span class="sr-only">Select ${esc(name)}</span></label>` : '';
  const actions = `${driveActionButton('Compress', 'box', `data-zip-drive-folder="${esc(folder.id)}" data-name="${esc(name)}"`)}${driveActionButton('Rename', 'rename', `data-rename-drive-folder="${esc(folder.id)}" data-name="${esc(name)}"`)}${canManage ? driveActionButton('Share', 'share', `data-share-drive-folder="${esc(folder.id)}" data-name="${esc(name)}"`) : ''}${driveActionButton('Delete', 'trash', `data-delete-drive-folder="${esc(folder.id)}" data-name="${esc(name)}"`, 'danger-link')}`;
  return `<article class="drive-item folder-item ${selected ? 'selected' : ''}" data-drive-folder-card="${esc(folder.id)}" data-drive-key="${esc(selectionKey)}">${selector}<button class="drive-main" data-drive-folder="${esc(folder.id)}" type="button"><span class="drive-icon">${icon('folder')}</span><span class="drive-name-stack"><b>${esc(name)}</b><small>${esc(meta)}</small><span class="drive-meta-row"><span>${esc(contents)}</span>${modified ? `<span>${esc(modified)}</span>` : ''}</span></span></button><span class="drive-size">-</span><span class="drive-kind">Folder</span><span class="drive-modified">${updated ? esc(formatDateTime(updated)) : '-'}</span>${renderDriveActionMenu(actions)}</article>`;
}

function renderDriveFile(file) {
  const name = file.original_name || file.name || file.filename || 'Untitled file';
  const mime = file.mime || file.mime_type || file.type || '';
  const size = formatDriveSize(file.size || file.bytes || 0) || '0 B';
  const id = file.id;
  const previewUrl = `/api/drive/files/${encodeURIComponent(id)}/preview`;
  const downloadUrl = `/api/drive/files/${encodeURIComponent(id)}/download`;
  const editable = isDriveEditable(name, mime);
  const officeEditable = isDriveOfficeEditable(name, mime);
  const zip = isDriveZip(name, mime);
  const selectionKey = `file:${id}`;
  const selected = state.selectedDriveItems.has(selectionKey);
  const selector = state.driveSelectionMode ? `<label class="drive-select"><input type="checkbox" data-select-drive="${esc(selectionKey)}" ${selected ? 'checked' : ''} aria-label="Select ${esc(name)}"><span class="sr-only">Select ${esc(name)}</span></label>` : '';
  const thumb = renderDriveFileThumb(name, mime, previewUrl);
  const visualType = driveFileVisualType(name, mime);
  const canManage = driveCanManage(file);
  const updated = file.updated_at || file.created_at || '';
  const typeLabel = driveFileTypeLabel(name, mime);
  const modified = updated ? `Modified ${formatDateTime(updated)}` : '';
  const meta = [typeLabel, size, modified].filter(Boolean).join(' · ');
  const previewAttrs = `data-preview-file="${previewUrl}" data-file-name="${esc(name)}" data-file-mime="${esc(mime)}" data-download-file="${downloadUrl}" data-drive-preview-id="${esc(id)}"${editable ? ` data-drive-preview-edit="${esc(id)}"` : ''}${officeEditable ? ` data-drive-preview-office="${esc(id)}"` : ''}${zip ? ` data-drive-preview-extract="${esc(id)}"` : ''}`;
  const actions = `${driveActionLink('Download', 'download', downloadUrl)}${editable ? driveActionButton('Edit text', 'draw', `data-edit-drive-file="${esc(id)}" data-name="${esc(name)}"`) : ''}${officeEditable ? driveActionButton('Edit document', 'documentEdit', `data-office-drive-file="${esc(id)}" data-name="${esc(name)}"`) : ''}${zip ? driveActionButton('Extract', 'extract', `data-extract-drive-file="${esc(id)}" data-name="${esc(name)}"`) : ''}${driveActionButton('Compress', 'box', `data-zip-drive-file="${esc(id)}" data-name="${esc(name)}"`)}${driveActionButton('Rename', 'rename', `data-rename-drive-file="${esc(id)}" data-name="${esc(name)}"`)}${canManage ? driveActionButton('Share', 'share', `data-share-drive-file="${esc(id)}" data-name="${esc(name)}"`) : ''}${driveActionButton('Delete', 'trash', `data-delete-drive-file="${esc(id)}" data-name="${esc(name)}"`, 'danger-link')}`;
  return `<article class="drive-item file-item drive-${visualType}-item ${selected ? 'selected' : ''}" data-drive-key="${esc(selectionKey)}">${selector}<button class="drive-main" ${previewAttrs} type="button">${thumb}<span class="drive-name-stack"><b>${esc(name)}</b><small>${esc(meta)}</small><span class="drive-meta-row"><span>${esc(typeLabel)}</span><span>${esc(size)}</span>${modified ? `<span>${esc(modified)}</span>` : ''}</span></span></button><span class="drive-size">${esc(size)}</span><span class="drive-kind">${esc(driveFileExtension(name))}</span><span class="drive-modified">${updated ? esc(formatDateTime(updated)) : '-'}</span>${renderDriveActionMenu(actions)}</article>`;
}

function driveFolderContentsLabel(folder) {
  const folderCount = Number(folder.folder_count ?? folder.folders_count ?? folder.child_folder_count ?? 0);
  const fileCount = Number(folder.file_count ?? folder.files_count ?? 0);
  if (!folderCount && !fileCount) return 'Folder';
  return `${folderCount} folder${folderCount === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'}`;
}

function driveFileTypeLabel(name, mime) {
  if (mime) return mime;
  const ext = driveFileExtension(name);
  return ext === 'FILE' ? 'File' : `${ext} file`;
}

function renderDriveFileThumb(name, mime, previewUrl) {
  const type = driveFileVisualType(name, mime);
  const ext = driveFileExtension(name);
  if (type === 'image') return `<span class="drive-thumb-wrap drive-file-${type}"><img class="drive-thumb" src="${previewUrl}" alt="${esc(name)}" loading="lazy"><span class="drive-file-badge">${esc(ext)}</span></span>`;
  return `<span class="drive-file-mark drive-file-${type}" aria-hidden="true"><span class="drive-file-glyph">${icon(driveFileVisualIcon(type))}</span><span class="drive-file-badge">${esc(ext)}</span></span>`;
}

function isDriveImageFile(name, mime) {
  return driveFileVisualType(name, mime) === 'image';
}

function driveFileVisualType(name, mime) {
  const value = String(mime || '').toLowerCase();
  const ext = String(driveFileExtension(name)).toLowerCase();
  if (value.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'avif'].includes(ext)) return 'image';
  if (value.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (value.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'media';
  if (ext === 'pdf' || value === 'application/pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || value.includes('zip') || value.includes('archive')) return 'archive';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || value.includes('spreadsheet')) return 'sheet';
  if (['ppt', 'pptx', 'odp'].includes(ext) || value.includes('presentation')) return 'slides';
  if (['doc', 'docx', 'odt', 'rtf', 'md', 'txt'].includes(ext) || value.includes('wordprocessingml')) return 'document';
  if (['js', 'ts', 'css', 'html', 'json', 'xml', 'yaml', 'yml', 'php', 'py', 'sh', 'sql'].includes(ext) || value.includes('json') || value.includes('xml')) return 'code';
  return 'generic';
}

function driveFileVisualIcon(type) {
  return ({ image: 'fileImage', audio: 'fileAudio', media: 'fileMedia', pdf: 'filePdf', archive: 'archive', sheet: 'fileSheet', slides: 'fileSlides', document: 'textFile', code: 'code' }[type] || 'file');
}

function renderDriveActionMenu(actions) {
  return `<div class="drive-actions"><button class="drive-menu-toggle" type="button" aria-label="More actions" aria-expanded="false">...</button><div class="drive-action-menu" role="menu">${actions}</div></div>`;
}

function driveActionButton(label, iconName, attrs, extraClass = '') {
  return `<button class="icon-btn drive-action-btn ${extraClass}" ${attrs} type="button" title="${esc(label)}" aria-label="${esc(label)}" role="menuitem">${toolIcon(iconName, label)}</button>`;
}

function driveActionLink(label, iconName, href) {
  return `<a class="icon-btn drive-action-btn" href="${esc(href)}" title="${esc(label)}" aria-label="${esc(label)}" role="menuitem">${toolIcon(iconName, label)}</a>`;
}

function driveCanManage(item) {
  return ['owner', 'admin'].includes(String(item?.permission || '').toLowerCase());
}

function isDriveEditable(name, mime) {
  const value = String(mime || '').toLowerCase();
  return value.startsWith('text/') || ['application/json', 'application/xml', 'application/csv', 'application/x-yaml'].includes(value) || /\.(txt|md|markdown|csv|json|xml|yaml|yml|log|html|css|js|ts)$/i.test(name || '');
}

function isDriveOfficeEditable(name, mime) {
  return /\.(docx?|docm|dotx?|odt|ott|rtf|xlsx?|xlsm|xltx?|ods|ots|pptx?|pptm|potx?|odp|otp)$/i.test(name || '');
}

function isDriveZip(name, mime) {
  const value = String(mime || '').toLowerCase();
  return value === 'application/zip' || value === 'application/x-zip-compressed' || /\.zip$/i.test(name || '');
}

function driveFileExtension(name) {
  const parts = String(name || '').split('.');
  if (parts.length < 2 || !parts.at(-1)) return 'FILE';
  return parts.at(-1).slice(0, 4).toUpperCase();
}

function formatDriveSize(size) {
  const value = Number(size || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function renderAssetTable() {
  const rows = state.assets;
  if (!rows.length) return `<div class="empty card"><h2>No ${esc(sectionLabel(state.section))}</h2><p>Create the first record for this documentation section.</p></div>`;
  return `<div class="table-wrap"><table class="asset-table"><thead><tr>${assetColumns().map(c => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(row => `<tr>${assetColumns().map(c => `<td data-label="${esc(c.label)}">${formatAssetCell(row, c.key)}</td>`).join('')}<td class="row-actions" data-label="Actions"><button class="icon-btn" data-asset="${row.id}" title="Edit" aria-label="Edit">${toolIcon('draw', 'Edit')}</button><button class="icon-btn" data-archive-asset="${row.id}" title="Archive" aria-label="Archive">${toolIcon('archive', 'Archive')}</button></td></tr>`).join('')}</tbody></table></div>`;
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
    if (e.target.matches('[data-rich-text]') && handleSlashCommand(modal, e.target)) return;
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

function handleSlashCommand(modal, richText) {
  const command = String(richText.textContent || '').trim().toLowerCase();
  const type = {
    '/p': 'paragraph', '/paragraph': 'paragraph',
    '/h': 'heading', '/heading': 'heading',
    '/check': 'checklist', '/todo': 'checklist',
    '/list': 'bullet', '/bullet': 'bullet',
    '/number': 'numbered', '/numbered': 'numbered',
    '/quote': 'quote', '/divider': 'hr', '/hr': 'hr',
    '/table': 'table', '/code': 'code', '/math': 'math',
    '/secret': 'secret', '/password': 'secret',
    '/draw': 'drawing', '/drawing': 'drawing'
  }[command];
  if (!type) return false;
  const block = richText.closest('[data-block]');
  if (!block) return false;
  block.insertAdjacentHTML('afterend', renderEditorBlock(newEditorBlock(type)));
  const added = block.nextElementSibling;
  block.remove();
  if (type === 'drawing') bindDrawingCanvas(added.querySelector('[data-drawing-canvas]'), modal);
  if (type === 'code') syncCodeLineNumbers(added.querySelector('[data-block-code]'));
  refreshSerializedBodyAndPreviews(modal);
  added.querySelector('[contenteditable], textarea, input:not([type="hidden"]), select')?.focus();
  return true;
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
      const keepStyle = el.tagName === 'SPAN' && attr.name === 'style' && safeColorStyle(attr.value);
      if (keepStyle) el.setAttribute('style', keepStyle);
      if (!keepHref && !keepStyle) el.removeAttribute(attr.name);
    });
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return template.innerHTML;
}

function safeColorStyle(value) {
  const match = String(value || '').match(/^\s*color\s*:\s*(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))\s*;?\s*$/i);
  return match ? `color: ${match[1]}` : '';
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
  }
  state.editingNote = !id;
  const content = document.querySelector('#contentArea');
  if (content) {
    content.innerHTML = renderNotesWorkspace();
    bindContentActions();
    const editor = content.querySelector('[data-inline-editor]');
    setTimeout(() => editor?.querySelector('input[name="title"]')?.focus({ preventScroll: true }), 0);
  }
  if (options.route !== false) syncSectionRoute();
}

async function closeInlineEditor() {
  if (!await confirmDiscardUnsaved()) return;
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  syncSectionRoute();
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
  let autosaveTimer = null;
  const scheduleAutosave = () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (modal.dataset.editing !== '1' || !hasUnsavedEditorChanges()) return;
    if (modal.dataset.autosaving === '1') {
      modal.dataset.autosaveQueued = '1';
      return;
    }
    autosaveTimer = setTimeout(() => saveInlineNote(modal, id, { autosave: true }), 1200);
  };
  modal.addEventListener('input', scheduleAutosave);
  modal.addEventListener('change', scheduleAutosave);
  modal.querySelector('#noteForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (autosaveTimer) clearTimeout(autosaveTimer);
    await runUserAction(async () => {
      const savedId = await saveInlineNote(modal, id, { autosave: false });
      toast('Saved');
      state.editingNote = false;
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

async function saveInlineNote(modal, initialId = null, { autosave = false } = {}) {
  const status = modal.querySelector('[data-autosave-status]');
  const form = modal.querySelector('#noteForm');
  if (!form) return null;
  const data = Object.fromEntries(new FormData(form));
  if (data.existing_secret_markers) data.body = [data.body, data.existing_secret_markers].filter(Boolean).join('\n');
  delete data.existing_secret_markers;
  const currentId = Number(modal.dataset.autosaveNoteId || initialId || 0);
  if (currentId) data.id = currentId;
  if (autosave && !currentId && !String(data.title || '').trim() && !String(data.body || '').trim() && !state.pendingAttachments.length) return null;
  const submittedSignature = editorDirtySignature(modal);

  modal.dataset.autosaving = '1';
  modal.dataset.autosaveQueued = '0';
  if (status) status.textContent = autosave ? 'Autosaving...' : 'Saving...';
  try {
    const saved = await api('/notes', { method: 'POST', body: data });
    const savedId = Number(saved.id || currentId || initialId || 0);
    if (savedId) modal.dataset.autosaveNoteId = String(savedId);
    if (savedId && state.pendingAttachments.length) {
      await uploadAttachments(savedId, state.pendingAttachments);
      state.pendingAttachments = [];
      const pending = modal.querySelector('#pendingAttachments');
      if (pending) pending.innerHTML = renderPendingAttachments();
    }
    if (savedId) {
      if (!initialId) clearDraftNote();
      state.notes = (await loadNotes()).notes;
      state.active = state.notes.find(n => Number(n.id) === savedId) || state.active;
      state.activeExtra = await api('/notes/' + savedId);
    }
    if (editorDirtySignature(modal) === submittedSignature) modal.dataset.dirtyBaseline = submittedSignature;
    else modal.dataset.autosaveQueued = '1';
    if (status) status.textContent = `${autosave ? 'Autosaved' : 'Saved'} ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    return savedId;
  } catch (err) {
    if (status) status.textContent = autosave ? 'Autosave failed. Keep this note open or use Save.' : 'Save failed.';
    if (!autosave) throw err;
    return null;
  } finally {
    modal.dataset.autosaving = '0';
    if (autosave && modal.dataset.autosaveQueued === '1' && hasUnsavedEditorChanges(modal)) {
      modal.dataset.autosaveQueued = '0';
      setTimeout(() => {
        if (modal.isConnected && modal.dataset.editing === '1' && hasUnsavedEditorChanges(modal)) saveInlineNote(modal, initialId, { autosave: true });
      }, 1200);
    }
  }
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
    if (btn.dataset.revealed === '1') {
      clearTimeout(Number(btn.dataset.hideTimer || 0));
      target.textContent = '••••••••••';
      btn.dataset.revealed = '0';
      return;
    }
    target.textContent = btn.dataset.secretValue || '';
    btn.dataset.revealed = '1';
    clearTimeout(Number(btn.dataset.hideTimer || 0));
    btn.dataset.hideTimer = String(setTimeout(() => {
      target.textContent = '••••••••••';
      btn.dataset.revealed = '0';
    }, 30000));
  }));
  root.querySelectorAll('[data-inline-secret-copy]').forEach(btn => btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(btn.dataset.secretValue || '');
    toast('Secret copied');
  }));
  root.querySelectorAll('[data-secret]').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.secret-row');
    const target = row?.querySelector('.secret-value');
    if (!target) return;
    if (btn.dataset.revealed === '1') {
      clearTimeout(Number(btn.dataset.hideTimer || 0));
      target.textContent = '••••••••••';
      btn.dataset.revealed = '0';
      return;
    }
    const value = await api(`/secrets/${btn.dataset.secret}/reveal`, { method: 'POST', body: {} });
    target.textContent = value.value;
    btn.dataset.revealed = '1';
    clearTimeout(Number(btn.dataset.hideTimer || 0));
    btn.dataset.hideTimer = String(setTimeout(() => {
      target.textContent = '••••••••••';
      btn.dataset.revealed = '0';
    }, 30000));
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

function openFilePreview(src, name, mime = '', options = {}) {
  if (!src) return;
  const modal = document.createElement('div');
  modal.className = 'editor image-lightbox';
  const image = isImage(mime) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '');
  const media = isMediaPreview(name, mime);
  const pdf = isPdfPreview(name, mime);
  const text = isTextFilePreview(name, mime);
  const inline = image || media || pdf || text;
  const downloadUrl = options.downloadUrl || previewDownloadUrl(src);
  const editButton = options.editId ? `<button class="btn primary icon-only-btn" type="button" data-preview-edit-drive-file="${esc(options.editId)}" data-name="${esc(name || 'file')}" title="Edit" aria-label="Edit">${toolIcon('draw', 'Edit')}</button>` : '';
  const officeButton = options.officeId ? `<button class="btn primary icon-only-btn" type="button" data-preview-office-drive-file="${esc(options.officeId)}" data-name="${esc(name || 'file')}" title="Edit document" aria-label="Edit document">${toolIcon('documentEdit', 'Edit document')}</button>` : '';
  const extractButton = options.extractId ? `<button class="btn ghost icon-only-btn" type="button" data-preview-extract-drive-file="${esc(options.extractId)}" data-name="${esc(name || 'file')}" title="Extract" aria-label="Extract">${toolIcon('extract', 'Extract')}</button>` : '';
  const fullscreenButton = `<button class="btn ghost icon-only-btn" type="button" data-preview-fullscreen aria-pressed="false" title="Enter fullscreen" aria-label="Enter fullscreen">${toolIcon('fullscreen', 'Enter fullscreen')}</button>`;
  const imageControls = image ? '<span class="image-preview-meta" data-image-preview-meta>Loading image...</span><button class="btn ghost icon-only-btn" type="button" data-image-zoom="out" title="Zoom out" aria-label="Zoom out">-</button><button class="btn ghost icon-only-btn" type="button" data-image-zoom="fit" title="Fit image" aria-label="Fit image">Fit</button><button class="btn ghost icon-only-btn" type="button" data-image-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>' : '';
  const preview = image
    ? `<div class="file-preview-stage image-stage"><img class="image-preview-img" data-image-preview-img src="${esc(src)}" alt="${esc(name || 'Image preview')}"></div>`
    : media
      ? renderMediaPreview(src, name, mime)
      : pdf
      ? `<div class="file-preview-stage file-detail-stage" data-pdf-preview-stage><p class="muted">Checking PDF...</p></div>`
      : text
        ? `<div class="file-preview-stage text-preview-stage" data-text-preview-stage><p class="muted">Loading text preview...</p></div>`
      : `<div class="file-preview-stage file-detail-stage" data-file-detail-stage><p class="muted">Loading file details...</p></div>`;
  modal.innerHTML = `<section class="editor-panel image-lightbox-panel"><div class="topbar preview-topbar"><div><p class="terminal-path">divault ~/files</p><h2>${esc(name || 'File preview')}</h2></div><div class="btn-row preview-action-row">${imageControls}${editButton}${officeButton}${extractButton}${fullscreenButton}<a class="btn ghost icon-only-btn" href="${esc(downloadUrl)}" title="Download" aria-label="Download">${toolIcon('download', 'Download')}</a><button class="btn ghost icon-only-btn" type="button" data-close title="Close" aria-label="Close">×</button></div></div>${preview}</section>`;
  document.body.appendChild(modal);
  setupAccessibleModal(modal, '[data-close]');
  bindFilePreviewFullscreen(modal);
  if (image) bindImagePreviewControls(modal);
  if (pdf) loadPdfFilePreview(modal, options.metadataId, src, name, mime);
  if (text) loadTextFilePreview(modal, downloadUrl, name, mime);
  if (!inline && options.metadataId) loadDriveFileDetails(modal, options.metadataId, name, mime);
  if (!inline && !options.metadataId) modal.querySelector('[data-file-detail-stage]').innerHTML = renderDriveFileDetails({}, null, name, mime);
  modal.querySelector('[data-preview-edit-drive-file]')?.addEventListener('click', btn => {
    modal.remove();
    openDriveTextEditor(btn.currentTarget.dataset.previewEditDriveFile, btn.currentTarget.dataset.name || name);
  });
  modal.querySelector('[data-preview-office-drive-file]')?.addEventListener('click', btn => {
    modal.remove();
    openDriveOfficeEditor(btn.currentTarget.dataset.previewOfficeDriveFile, btn.currentTarget.dataset.name || name);
  });
  modal.querySelector('[data-preview-extract-drive-file]')?.addEventListener('click', async btn => {
    modal.remove();
    await extractDriveZip(btn.currentTarget.dataset.previewExtractDriveFile, btn.currentTarget.dataset.name || name);
  });
}

function bindFilePreviewFullscreen(modal) {
  const button = modal.querySelector('[data-preview-fullscreen]');
  if (!button) return;
  const render = () => {
    const fullscreen = modal.classList.contains('preview-fullscreen');
    const label = fullscreen ? 'Restore preview size' : 'Enter fullscreen';
    button.classList.toggle('active', fullscreen);
    button.setAttribute('aria-pressed', fullscreen ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.innerHTML = toolIcon(fullscreen ? 'restore' : 'fullscreen', label);
  };
  button.addEventListener('click', () => {
    modal.classList.toggle('preview-fullscreen');
    render();
  });
  render();
}

function bindImagePreviewControls(modal) {
  const img = modal.querySelector('[data-image-preview-img]');
  const meta = modal.querySelector('[data-image-preview-meta]');
  if (!img) return;
  let zoom = 1;
  const render = () => {
    img.style.maxWidth = zoom === 1 ? '100%' : 'none';
    img.style.maxHeight = zoom === 1 ? '100%' : 'none';
    img.style.width = zoom === 1 ? '' : `${Math.round(img.naturalWidth * zoom)}px`;
    img.style.height = zoom === 1 ? '' : 'auto';
    if (meta) meta.textContent = img.naturalWidth ? `${img.naturalWidth} x ${img.naturalHeight} px · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
  };
  img.addEventListener('load', render, { once: true });
  modal.querySelectorAll('[data-image-zoom]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.imageZoom;
    if (action === 'fit') zoom = 1;
    if (action === 'in') zoom = Math.min(4, Number((zoom + 0.25).toFixed(2)));
    if (action === 'out') zoom = Math.max(0.25, Number((zoom - 0.25).toFixed(2)));
    render();
  }));
  if (img.complete) render();
}

async function loadPdfFilePreview(modal, id, src, name, mime) {
  const stage = modal.querySelector('[data-pdf-preview-stage]');
  if (!stage) return;
  if (!id) {
    stage.classList.remove('file-detail-stage');
    stage.innerHTML = `<iframe class="file-preview-frame" src="${esc(src)}" title="${esc(name || 'File preview')}"></iframe>`;
    return;
  }
  try {
    const result = await api(`/drive/files/${encodeURIComponent(id)}/metadata`);
    if (result.pdf && !result.pdf.valid) {
      stage.innerHTML = renderDriveFileDetails(result.file || {}, null, name, mime, result.pdf.error || 'PDF could not be previewed');
      return;
    }
    stage.classList.remove('file-detail-stage');
    stage.innerHTML = `<iframe class="file-preview-frame" src="${esc(src)}" title="${esc(name || 'File preview')}"></iframe>`;
  } catch (err) {
    stage.innerHTML = `<div class="file-detail-empty"><h3>Preview unavailable</h3><p class="muted small">${esc(err.message || 'Could not load PDF preview.')}</p></div>`;
  }
}

async function loadTextFilePreview(modal, url, name = '', mime = '') {
  const stage = modal.querySelector('[data-text-preview-stage]');
  if (!stage) return;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Text preview failed');
    const size = Number(res.headers.get('content-length') || 0);
    if (size > 2 * 1024 * 1024) {
      stage.innerHTML = '<div class="file-detail-empty"><h3>Text preview skipped</h3><p class="muted small">This text file is larger than 2 MB. Download it to view locally.</p></div>';
      return;
    }
    const text = await res.text();
    stage.innerHTML = isCodeFilePreview(name, mime) ? renderNumberedTextPreview(text) : `<pre class="text-file-preview">${esc(text)}</pre>`;
  } catch (err) {
    stage.innerHTML = `<div class="file-detail-empty"><h3>Preview unavailable</h3><p class="muted small">${esc(err.message || 'Could not load text preview.')}</p></div>`;
  }
}

function renderNumberedTextPreview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  return `<div class="numbered-code-preview" role="table" aria-label="Code preview">${lines.map((line, index) => `<div class="code-preview-row" role="row"><span class="code-preview-line" role="rowheader">${index + 1}</span><code role="cell">${esc(line || ' ')}</code></div>`).join('')}</div>`;
}

function renderMediaPreview(src, name, mime) {
  if (String(mime || '').startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(name || '')) {
    return `<div class="file-preview-stage media-preview-stage"><audio controls preload="metadata" src="${esc(src)}"></audio></div>`;
  }
  return `<div class="file-preview-stage media-preview-stage"><video controls preload="metadata" src="${esc(src)}"></video></div>`;
}

async function loadDriveFileDetails(modal, id, name, mime) {
  const stage = modal.querySelector('[data-file-detail-stage]');
  if (!stage) return;
  try {
    const result = await api(`/drive/files/${encodeURIComponent(id)}/metadata`);
    const file = result.file || {};
    stage.innerHTML = renderDriveFileDetails(file, result.zip, name, mime);
    stage.querySelector('[data-office-drive-file]')?.addEventListener('click', btn => openDriveOfficeEditor(btn.dataset.officeDriveFile, btn.dataset.name));
  } catch (err) {
    stage.innerHTML = `<div class="file-detail-empty"><h3>Preview unavailable</h3><p class="muted small">${esc(err.message || 'Could not load file details.')}</p></div>`;
  }
}

function renderDriveFileDetails(file, zip, fallbackName, fallbackMime, message = '') {
  const name = file.original_name || fallbackName || 'File';
  const mime = file.mime || fallbackMime || 'application/octet-stream';
  const officeButton = file.id && isDriveOfficeEditable(name, mime) ? `<button class="btn primary" type="button" data-office-drive-file="${esc(file.id)}" data-name="${esc(name)}">Edit in OnlyOffice</button>` : '';
  const typeLabel = driveFileTypeLabel(name, mime);
  const sizeLabel = formatDriveSize(file.size || 0) || '0 B';
  const modifiedLabel = file.updated_at ? formatDateTime(file.updated_at) : '-';
  const visualType = driveFileVisualType(name, mime);
  const extension = driveFileExtension(name);
  const rows = [
    ['Name', name],
    ['Type', typeLabel],
    ['Size', sizeLabel],
    ['Modified', modifiedLabel],
  ];
  const zipHtml = zip ? renderZipPreview(zip) : `<p class="muted small">${esc(message || 'This file type does not have an inline browser preview yet. You can still download it and open it in a local app.')}</p>${officeButton ? `<div class="btn-row">${officeButton}</div>` : ''}`;
  return `<div class="file-detail-card"><header class="file-detail-identity"><span class="drive-file-mark drive-file-${esc(visualType)} detail-file-mark" aria-hidden="true"><span class="drive-file-glyph">${icon(driveFileVisualIcon(visualType))}</span><span class="drive-file-badge">${esc(extension)}</span></span><div class="file-detail-heading"><p class="file-detail-kicker">File inspector</p><h3>${esc(name)}</h3><p class="muted small">${esc(typeLabel)} · ${esc(sizeLabel)}</p></div></header><div class="file-detail-copy"><div class="file-detail-grid" aria-label="File metadata">${rows.map(([label, value]) => `<div class="file-detail-meta"><span>${esc(label)}</span><b>${esc(String(value || '-'))}</b></div>`).join('')}</div>${zipHtml}</div></div>`;
}

function renderZipPreview(zip) {
  if (!zip.available) return `<section class="zip-preview"><div class="zip-preview-head"><div><p class="file-detail-kicker">Archive</p><h4>ZIP contents</h4></div></div><p class="muted small">${esc(zip.error || 'ZIP contents could not be read.')}</p></section>`;
  const entries = zip.entries || [];
  const count = Number(zip.count || entries.length);
  const rows = entries.map(entry => `<div class="zip-entry"><span class="zip-entry-name"><span class="zip-entry-dot" aria-hidden="true"></span><span>${esc(entry.name || 'file')}</span></span><b>${esc(formatDriveSize(entry.size || 0) || '0 B')}</b></div>`).join('') || '<p class="muted small zip-empty-note">This ZIP archive is empty.</p>';
  return `<section class="zip-preview"><div class="zip-preview-head"><div><p class="file-detail-kicker">Archive</p><h4>ZIP contents</h4></div><span class="pill">${count} item${count === 1 ? '' : 's'}</span></div><div class="zip-entry-list" role="list" aria-label="ZIP archive contents"><div class="zip-entry zip-entry-head" aria-hidden="true"><span>Name</span><b>Size</b></div>${rows}</div>${zip.truncated ? '<p class="muted small zip-preview-note">Showing first 200 entries.</p>' : ''}</section>`;
}

function isPdfPreview(name, mime) {
  const value = String(mime || '').toLowerCase();
  return value.includes('pdf') || /\.pdf$/i.test(name || '');
}

function isTextFilePreview(name, mime) {
  const value = String(mime || '').toLowerCase();
  return value.startsWith('text/') || ['application/json', 'application/xml', 'application/csv', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/javascript', 'application/x-javascript'].includes(value) || /\.(txt|md|markdown|csv|json|xml|yaml|yml|toml|ini|conf|cfg|log|html|htm|css|js|mjs|cjs|ts|tsx|jsx|php|py|rb|go|rs|java|c|h|cpp|hpp|cs|sh|bat|ps1|sql|env)$/i.test(name || '');
}

function isCodeFilePreview(name, mime) {
  const value = String(mime || '').toLowerCase();
  return ['text/css', 'text/html', 'text/javascript', 'application/javascript', 'application/x-javascript', 'application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/toml'].includes(value) || /\.(php|css|scss|sass|less|html|htm|js|mjs|cjs|ts|tsx|jsx|json|xml|yaml|yml|toml|ini|conf|cfg|env|ps1|psm1|psd1|sh|bash|zsh|fish|bat|cmd|sql|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|kt|kts|dart|vue|svelte|log)$/i.test(name || '');
}

function isMediaPreview(name, mime) {
  const value = String(mime || '').toLowerCase();
  return value.startsWith('audio/') || value.startsWith('video/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus|mp4|webm|mov|m4v|ogv)$/i.test(name || '');
}

function previewDownloadUrl(src) {
  return src.includes('/drive/files/') ? src.replace(/\/preview$/, '/download') : src.replace(/\/preview$/, '');
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

function openCategoryManager(options = {}) {
  state.panel = 'categories';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  state.settingsHtml = '';
  if (options.route !== false) syncSectionRoute();
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
      syncSectionRoute();
    }
    toast('Category deleted');
    await loadAll();
    renderApp();
  }));
}

function bindSettingsPanel(panel) {
  if (!panel) return;
  panel.querySelectorAll('[data-settings-tab]').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.settingsTab;
    state.settingsTab = tab;
    localStorage.setItem('divault_settings_tab', tab);
    panel.querySelectorAll('[data-settings-tab]').forEach(item => {
      const active = item.dataset.settingsTab === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    panel.querySelectorAll('[data-settings-panel]').forEach(section => {
      section.classList.toggle('hidden', section.dataset.settingsPanel !== tab);
    });
  }));
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
        <div class="two-col"><label class="field"><span>Username</span><input name="username" value="${esc(asset.username || '')}" autocomplete="off"></label><label class="field"><span>Password</span><input name="password" type="password" placeholder="Optional, encrypted" autocomplete="new-password"></label></div>${asset.has_secret ? `<div class="card"><h3>Stored password</h3><div class="secret-row"><div class="secret-value">••••••••••</div><div class="btn-row"><button type="button" class="btn icon-only-btn" id="assetReveal" title="Reveal password" aria-label="Reveal password">${toolIcon('preview', 'Reveal password')}</button><button type="button" class="btn icon-only-btn" id="assetCopy" title="Copy password" aria-label="Copy password">${toolIcon('copy', 'Copy password')}</button></div></div></div>` : ''}
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

function renderDesktopParityCard(desktopServer = {}) {
  const hasTauriBridge = Boolean(window.__TAURI__?.core?.invoke);
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
  const standalone = !desktopServer.server_url;
  const checks = [
    ['Standalone local vault', standalone, standalone ? 'Default mode is the bundled local vault on this computer.' : 'Server mode is configured. Use standalone below to return to the local vault.'],
    ['Upload button', 'File' in window && 'FormData' in window, 'Uses the same browser file picker and upload pipeline as the web app.'],
    ['Main-section drag and drop', 'DataTransfer' in window && 'File' in window, 'Windows desktop passes file drops through to the Drive surface.'],
    ['External links', hasTauriBridge, 'HTTP and HTTPS links open through the desktop shell bridge.'],
    ['Notifications', hasTauriBridge || 'Notification' in window, 'Reminders can use the desktop notifier, then browser notifications as fallback.'],
    ['Clipboard', Boolean(navigator.clipboard), 'Copy actions use the standard browser clipboard API.'],
    ['Local secure context', window.isSecureContext || localHost, 'Standalone desktop runs on loopback so browser security APIs stay available.']
  ];
  return `<div class="card stack"><h3>Windows desktop browser parity</h3><p class="muted small">DiVault keeps standalone mode as the default. This desktop build uses the browser APIs where possible and only adds desktop bridges for features browsers cannot handle directly.</p>${checks.map(([label, ready, detail]) => renderDesktopParityRow(label, ready, detail)).join('')}</div>`;
}

function renderDesktopParityRow(label, ready, detail) {
  return `<div class="file-row"><span><b>${esc(label)}</b><br><span class="small muted">${esc(detail)}</span></span><span class="pill ${ready ? 'file' : 'danger'}">${ready ? 'Ready' : 'Check'}</span></div>`;
}

async function openSettings(options = {}) {
  state.panel = 'settings';
  state.active = null;
  state.activeExtra = null;
  state.editingNote = false;
  if (options.route !== false) syncSectionRoute();
  renderApp();
  const isAdmin = canAdminSettings();
  const [users, audit, sessions, backups, syncManifest, retentionSettings, aiIntegration, onlyOfficeIntegration, driveStorage, desktopServer, passkeys, calendarFeeds] = await Promise.all([
    isAdmin ? api('/users').catch(() => ({ users: [] })) : { users: [] },
    isAdmin ? api('/audit').catch(() => ({ audit: [] })) : { audit: [] },
    api('/sessions').catch(() => ({ sessions: [] })),
    isAdmin ? api('/backups').catch(() => ({ backups: [], pending_restore: false })) : { backups: [], pending_restore: false },
    api('/sync/manifest').catch(() => null),
    isAdmin ? api('/retention-settings').catch(() => ({ settings: { version_limit: 3, trash_days: 30 } })) : { settings: { version_limit: 3, trash_days: 30 } },
    isAdmin ? api('/integrations/ai/status').catch(() => null) : null,
    isAdmin ? api('/integrations/onlyoffice/status').catch(() => null) : null,
    isAdmin ? api('/drive/storage-settings').catch(() => null) : null,
    state.desktop && isAdmin ? api('/desktop/server').catch(() => ({ server_url: '' })) : { server_url: '' },
    api('/webauthn/credentials').catch(() => ({ credentials: [] })),
    api('/calendar-feeds').catch(() => ({ feeds: [] }))
  ]);
  state.calendarFeeds = calendarFeeds.feeds || [];
  const adminDataCards = isAdmin ? `<div class="card stack"><h3>Import / export</h3><div class="btn-row"><a class="btn" href="/api/export">Export JSON</a><button class="btn" id="backupBtn">Create full backup</button></div><p class="small muted">Optional backup passphrases encrypt backups. Keep the passphrase; encrypted backups cannot be restored without it.</p><label class="field"><span>Import Markdown notes</span><input id="markdownImportFiles" type="file" accept=".md,text/markdown" multiple></label><label class="field"><span>Import Markdown folder</span><input id="markdownImportFolder" type="file" accept=".md,text/markdown" webkitdirectory multiple></label><button class="btn" id="importMarkdownBtn">Import Markdown</button><p class="small muted">Markdown files are read locally in this browser and imported directly. Folder imports map subfolders to categories.</p><label class="field"><span>Import JSON notes</span><textarea id="importJson" placeholder='{"notes":[{"title":"Imported","body":"Hello"}]}'></textarea></label><button class="btn" id="importBtn">Import JSON</button></div>
        <div class="card stack"><h3>Backups</h3>${backups.pending_restore ? '<p class="pill secret">Restore pending. Restart container to apply.</p>' : ''}<div class="btn-row"><input id="restoreUpload" type="file" accept=".zip,application/zip"><button class="btn danger" id="uploadRestoreBtn">Upload restore ZIP</button></div>${backups.backups.map(b => `<div class="file-row"><span>${esc(b.file)}<br><span class="small muted">${Math.ceil(Number(b.size) / 1024)} KB</span></span><span class="btn-row"><a class="btn" href="/api/backups/${esc(b.file)}">Download</a><button class="btn danger" data-restore="${esc(b.file)}">Schedule restore</button></span></div>`).join('') || '<p class="small muted">No backups yet.</p>'}</div>` : '';
  const userRows = (users.users || []).map(u => {
    const disabled = Number(u.disabled) === 1;
    const isSelf = Number(u.id) === Number(state.user.id);
    const actions = !isSelf ? `<span class="btn-row"><button class="btn ghost" type="button" data-reset-user-password="${esc(u.id)}" data-user-email="${esc(u.email)}" ${disabled ? 'disabled' : ''}>Reset password</button><button class="btn danger" type="button" data-delete-user="${esc(u.id)}" data-user-email="${esc(u.email)}" ${disabled ? 'disabled' : ''}>Delete user</button></span>` : '<span class="small muted">Current user</span>';
    return `<div class="file-row user-management-row"><span><b>${esc(u.name || u.email)}</b><br><span class="small muted">${esc(u.email)} · ${esc(u.role)}</span></span><span class="pill-row"><span class="pill ${disabled ? 'danger' : ''}">${disabled ? 'disabled' : esc(u.role)}</span>${actions}</span></div>`;
  }).join('') || '<p class="small muted">No users.</p>';
  const adminSidebarCards = isAdmin ? `<div class="card stack"><h3>Add user</h3><form id="userForm" class="stack"><label class="field"><span>Name</span><input name="name" placeholder="Name" autocomplete="name" required></label><label class="field"><span>Email</span><input name="email" type="email" placeholder="Email" autocomplete="email" required></label><label class="field"><span>Temporary password</span><input name="password" type="password" minlength="10" placeholder="Temporary password" autocomplete="new-password" required></label><label class="field"><span>Confirm password</span><input name="password_confirm" type="password" minlength="10" placeholder="Type temporary password again" autocomplete="new-password" required></label><label class="field"><span>Role</span><select name="role"><option value="editor">editor</option><option value="viewer">viewer</option><option value="admin">admin</option></select></label><button class="btn">Create user</button></form></div>
        <div class="card stack"><h3>Users</h3><p class="small muted">Delete disables login and revokes sessions without removing the user's notes or files.</p>${userRows}</div>
        <div class="card"><h3>Audit</h3>${auditRowsHtml(audit.audit)}</div>` : '';
  const avatarPreview = state.user.avatar_data ? `<img class="profile-avatar" src="${esc(state.user.avatar_data)}" alt="Current avatar">` : `<img class="profile-avatar" src="/assets/divault-logo.svg" alt="DiVault">`;
  const removeAvatarButton = state.user.avatar_data ? '<button class="btn ghost" id="removeAvatarBtn" type="button">Remove avatar</button>' : '';
  const desktopServerCard = state.desktop && isAdmin ? `<div class="card stack"><h3>Desktop mode</h3><p class="muted small">Choose whether this desktop app starts its standalone local vault or opens a hosted DiVault server on launch.</p><div class="inline-note-blocks"><div class="inline-note ${desktopServer.server_url ? '' : 'active'}"><b>Standalone vault</b><span>Private local vault on this computer.</span></div><div class="inline-note ${desktopServer.server_url ? 'active' : ''}"><b>Connect to server</b><span>${desktopServer.server_url ? esc(desktopServer.server_url) : 'Use one shared server for desktop, Android, and browser sync.'}</span></div></div><form id="desktopServerSettingsForm" class="stack"><label class="field"><span>Server URL</span><input name="server_url" type="url" value="${esc(desktopServer.server_url || '')}" placeholder="https://notes.example.com" autocomplete="url" required></label><div class="btn-row"><button class="btn primary">Use server on next launch</button>${desktopServer.server_url ? '<button class="btn ghost" id="desktopStandaloneBtn" type="button">Use standalone on next launch</button>' : ''}</div></form>${desktopServer.config_dir ? `<div class="file-row"><span>Local data folder<br><span class="small muted">${esc(desktopServer.config_dir)}</span></span><button class="btn ghost" id="copyDesktopDataFolderBtn" type="button">Copy path</button></div>` : ''}<p class="small muted">Restart DiVault after changing desktop mode. Server mode opens that URL directly; standalone mode starts the bundled local vault.</p></div>` : '';
  const desktopParityCard = state.desktop && isAdmin ? renderDesktopParityCard(desktopServer) : '';
  const androidClientCard = window.DiVaultAndroid ? `<div class="card stack"><h3>Android app</h3><p class="muted small">Change the saved Android server URL without waiting for the offline screen.</p><div class="file-row"><span>Current server<br><span class="small muted">${esc(location.origin)}</span></span><button class="btn" id="androidChangeServerBtn" type="button">Change server</button></div></div>` : '';
  const retention = retentionSettings?.settings || { version_limit: 3, trash_days: 30 };
  const retentionCard = isAdmin ? `<div class="card stack"><h3>Recycle bin and version policy</h3><form id="retentionSettingsForm" class="stack"><div class="file-row"><span>File version policy<br><span class="small muted">Keep only the most recent note versions.</span></span><span class="settings-inline-input">Keep only <input name="version_limit" type="number" min="0" max="100" step="1" value="${esc(retention.version_limit ?? 3)}" inputmode="numeric"> most recent versions</span></div><div class="file-row"><span>Empty recycle bin contents older than<br><span class="small muted">Uses the date a note was moved to the recycle bin.</span></span><span class="settings-inline-input"><input name="trash_days" type="number" min="1" max="3650" step="1" value="${esc(retention.trash_days ?? 30)}" inputmode="numeric"> days</span></div><button class="btn primary">Save policy</button></form></div>` : '';
  const passkeyRows = (passkeys.credentials || []).map(key => `<div class="file-row"><span>${esc(key.label)}<br><span class="small muted">Added ${esc(key.created_at || '')}${key.last_used_at ? ` · Last used ${esc(key.last_used_at)}` : ''}</span></span><button class="btn danger" type="button" data-passkey-delete="${key.id}">Remove</button></div>`).join('') || '<p class="small muted">No passkeys enrolled yet.</p>';
  const passkeyCard = `<div class="card stack"><h3>Passkeys / biometrics</h3><p class="muted small">Use a passkey with Windows Hello, Touch ID, Face ID, or your device screen lock. Works best on HTTPS or localhost.</p><div class="btn-row"><button class="btn" id="startPasskey" type="button" ${webauthnSupported() ? '' : 'disabled'}>Add passkey</button></div>${passkeyRows}</div>`;
  const deviceCards = `${desktopServerCard}${desktopParityCard}${androidClientCard}`;
  const settingsTabs = [
    ['account', 'Account'],
    ['workspace', 'Workspace'],
    ['calendar', 'Calendar'],
    ['devices', 'Devices & sync'],
    ...(isAdmin ? [['integrations', 'Integrations']] : []),
    ['security', 'Security'],
    ...(isAdmin ? [['data', 'Data'], ['people', 'People']] : [])
  ];
  const legacySettingsTabs = { features: 'workspace', sync: 'devices' };
  state.settingsTab = legacySettingsTabs[state.settingsTab] || state.settingsTab;
  if (!settingsTabs.some(([key]) => key === state.settingsTab)) state.settingsTab = settingsTabs[0][0];
  const settingsTabButtons = settingsTabs.map(([key, label]) => `<button class="btn ghost settings-tab ${state.settingsTab === key ? 'active' : ''}" type="button" role="tab" aria-selected="${state.settingsTab === key ? 'true' : 'false'}" data-settings-tab="${key}">${label}</button>`).join('');
  state.settingsHtml = `
    <div class="settings-shell">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">${settingsTabButtons}</div>
      <section class="settings-tab-panel ${state.settingsTab === 'account' ? '' : 'hidden'}" data-settings-panel="account" role="tabpanel">
        <div class="editor-grid settings-grid">
          <div class="stack">
            <div class="card stack"><h3>Mini profile</h3><div class="profile-row">${avatarPreview}<div><b>${esc(state.user.name)}</b><p class="small muted">${esc(state.user.email)} · ${esc(state.user.role)}</p></div></div><form id="profileForm" class="stack"><label class="field"><span>Name</span><input name="name" value="${esc(state.user.name)}" autocomplete="name"></label><label class="field"><span>Avatar</span><div class="avatar-controls"><input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">${removeAvatarButton}</div></label><input type="hidden" name="avatar_data" value="${esc(state.user.avatar_data || '')}"><button class="btn primary">Save profile</button></form></div>
            <div class="card stack"><h3>Change password</h3><form id="passwordForm" class="stack"><input name="current_password" type="password" placeholder="Current password" autocomplete="current-password"><input name="new_password" type="password" minlength="10" placeholder="New password" autocomplete="new-password"><input name="new_password_confirm" type="password" minlength="10" placeholder="Type new password again" autocomplete="new-password"><button class="btn">Update password</button></form></div>
            <div class="card stack"><h3>Appearance</h3><p class="muted small">Pick a comfortable preset. These include light, dark, neutral, cooler, and color-safe options.</p>${themePresetPicker()}</div>
          </div>
          <aside class="stack"><div class="card"><h3>Sessions</h3>${groupedSessionsHtml(sessions.sessions)}</div></aside>
        </div>
      </section>
      <section class="settings-tab-panel ${state.settingsTab === 'workspace' ? '' : 'hidden'}" data-settings-panel="workspace" role="tabpanel">
        <div class="editor-grid settings-grid">
          <div class="stack"><div class="card stack"><h3>Workspace modules</h3><p class="muted small">Choose which major areas appear in this user's sidebar.</p>${renderFeatureSettings()}</div></div>
          <aside class="stack"><div class="card stack"><h3>Files workspace</h3><p class="muted small">Files/Drive is private by default. Admins do not automatically get access to another user's private Drive files.</p><p class="small muted">Use the Files toggle here for this user. Use Drive sharing for file/folder access.</p></div>${isAdmin ? `<div class="card stack"><h3>Drive storage</h3>${renderDriveStorageSettings(driveStorage)}</div>` : ''}</aside>
        </div>
      </section>
      <section class="settings-tab-panel ${state.settingsTab === 'calendar' ? '' : 'hidden'}" data-settings-panel="calendar" role="tabpanel">
        <div class="editor-grid settings-grid">
          <div class="stack"><div class="card stack"><h3>Calendar and task behavior</h3>${renderCalendarTaskFeatureSettings()}</div></div>
          <aside class="stack"><div class="card stack"><h3>Read-only calendar feeds</h3>${renderCalendarFeedSettings(state.calendarFeeds)}</div></aside>
        </div>
      </section>
      <section class="settings-tab-panel ${state.settingsTab === 'devices' ? '' : 'hidden'}" data-settings-panel="devices" role="tabpanel">
        <div class="stack">
          <div class="card stack"><h3>Sync</h3>${renderSyncSettings(syncManifest)}</div>
          ${deviceCards}
        </div>
      </section>
      ${isAdmin ? `<section class="settings-tab-panel ${state.settingsTab === 'integrations' ? '' : 'hidden'}" data-settings-panel="integrations" role="tabpanel"><div class="editor-grid settings-grid"><div class="stack"><div class="card stack"><h3>OnlyOffice document editing</h3>${renderOnlyOfficeSettings(onlyOfficeIntegration)}</div></div><aside class="stack"><div class="card stack"><h3>AI review API</h3>${renderAiIntegrationSettings(aiIntegration)}</div></aside></div></section>` : ''}
      <section class="settings-tab-panel ${state.settingsTab === 'security' ? '' : 'hidden'}" data-settings-panel="security" role="tabpanel">
        <div class="editor-grid settings-grid">
          <div class="stack">
            ${retentionCard}
          </div>
          <aside class="stack">
            <div class="card stack"><h3>Emergency offline snapshot</h3><p class="muted small">Create or update an encrypted localStorage snapshot for offline access. Keep the passphrase; it is required to unlock the snapshot.</p><button class="btn" id="emergencySnapshotBtn">Create/update encrypted snapshot</button><p class="small muted">Pending offline notes remain unencrypted local-only drafts until synced.</p></div>
            <div class="card stack"><h3>Two-factor authentication</h3><p class="muted small">Use an authenticator app. Save recovery codes somewhere safe.</p><div class="btn-row"><button class="btn" id="start2fa">Start 2FA setup</button><button class="btn" id="regenRecovery">New recovery codes</button></div><div id="twofa"></div></div>
            ${passkeyCard}
          </aside>
        </div>
      </section>
      ${isAdmin ? `<section class="settings-tab-panel ${state.settingsTab === 'data' ? '' : 'hidden'}" data-settings-panel="data" role="tabpanel"><div class="stack">${adminDataCards}</div></section>` : ''}
      ${isAdmin ? `<section class="settings-tab-panel ${state.settingsTab === 'people' ? '' : 'hidden'}" data-settings-panel="people" role="tabpanel"><div class="editor-grid settings-grid"><div class="stack">${adminSidebarCards}</div></div></section>` : ''}
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
  modal.querySelectorAll('.feature-settings-form').forEach(formEl => formEl.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const form = new FormData(e.target);
      const payload = {
        calendar: { enabled: form.has('calendar_enabled'), home_enabled: form.has('calendar_home_enabled'), reminders_enabled: form.has('calendar_reminders_enabled'), default_reminder_minutes: Number(form.get('calendar_default_reminder_minutes') || 10) },
        tasks: { enabled: form.has('tasks_enabled'), home_enabled: form.has('tasks_home_enabled'), reminders_enabled: form.has('tasks_reminders_enabled'), shared_calendar_tasks: form.has('tasks_shared_calendar_tasks'), default_reminder_minutes: Number(form.get('tasks_default_reminder_minutes') || 10) },
        home: { enabled: true, notes_enabled: form.has('home_notes_enabled') },
        drive: { enabled: form.has('drive_enabled') }
      };
      const result = await api('/features', { method: 'PATCH', body: payload });
      state.features = result.features;
      normalizeCurrentSection();
      syncSectionRoute();
      if (featureOn('calendar') || featureOn('tasks')) state.calendars = (await api('/calendars')).calendars || [];
      toast('Feature settings saved');
      await loadCurrentSection();
      openSettings();
    }, 'Feature settings failed');
  }));
  modal.querySelector('#driveStorageSettingsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      await api('/drive/storage-settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Drive storage settings saved');
      openSettings();
    }, 'Drive storage update failed');
  });
  modal.querySelector('#calendarFeedForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    await runUserAction(async () => {
      const form = new FormData(e.target);
      const payload = { ...Object.fromEntries(form), enabled: form.has('enabled'), sync_now: form.has('sync_now') };
      const id = form.get('id');
      const result = await api(id ? `/calendar-feeds/${id}` : '/calendar-feeds', { method: id ? 'PATCH' : 'POST', body: payload });
      state.calendars = [];
      toast(result.sync_error ? `Feed saved. Sync failed: ${result.sync_error}` : (id ? 'Calendar feed saved' : 'Calendar feed added'));
      await loadCalendarData();
      openSettings();
    }, 'Calendar feed save failed');
  });
  modal.querySelectorAll('[data-edit-feed]').forEach(button => button.addEventListener('click', () => {
    const feed = state.calendarFeeds.find(item => String(item.id) === String(button.dataset.editFeed));
    if (!feed) return;
    modal.querySelector('#calendarFeedId').value = feed.id;
    modal.querySelector('#calendarFeedName').value = feed.name || '';
    modal.querySelector('#calendarFeedUrl').value = feed.url || '';
    modal.querySelector('#calendarFeedColor').value = feed.color || '#22c55e';
    modal.querySelector('#calendarFeedRefresh').value = feed.refresh_minutes || 360;
    modal.querySelector('#calendarFeedEnabled').checked = Number(feed.enabled) === 1;
    modal.querySelector('#calendarFeedSaveBtn').textContent = 'Save feed';
  }));
  modal.querySelector('#calendarFeedResetBtn')?.addEventListener('click', () => {
    modal.querySelector('#calendarFeedId').value = '';
    modal.querySelector('#calendarFeedSaveBtn').textContent = 'Add feed';
  });
  modal.querySelectorAll('[data-sync-feed]').forEach(button => button.addEventListener('click', async () => {
    await runUserAction(async () => {
      const result = await api(`/calendar-feeds/${button.dataset.syncFeed}/sync`, { method: 'POST', body: {} });
      state.calendars = [];
      toast(result.message || 'Calendar feed synced');
      await loadCalendarData();
      openSettings();
    }, 'Calendar feed sync failed');
  }));
  modal.querySelectorAll('[data-delete-feed]').forEach(button => button.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Remove calendar feed?', message: 'Remove this read-only feed and hide its synced calendar from DiVault?', confirmText: 'Remove' })) return;
    await runUserAction(async () => {
      await api(`/calendar-feeds/${button.dataset.deleteFeed}`, { method: 'DELETE' });
      state.calendars = [];
      toast('Calendar feed removed');
      await loadCalendarData();
      openSettings();
    }, 'Calendar feed removal failed');
  }));
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
        await showAiApiToken(modal, result.token, result.endpoint);
      } else {
        toast('AI API is enabled by server config');
      }
    }, 'AI API enable failed');
  });
  modal.querySelector('#copyAiTokenBtn')?.addEventListener('click', async () => {
    const currentPassword = await promptDialog({ title: 'Current password', message: 'Enter your current password to copy the saved local AI API token.', type: 'password', required: true });
    if (currentPassword === null) return;
    await runUserAction(async () => {
      const result = await api('/integrations/ai/reveal', { method: 'POST', body: { current_password: currentPassword } });
      await showAiApiToken(modal, result.token, result.endpoint);
    }, 'AI token copy failed');
  });
  modal.querySelector('#testAiTokenBtn')?.addEventListener('click', async () => {
    const preview = modal.querySelector('#aiApiTokenPreview');
    const existing = preview && !preview.classList.contains('hidden') ? preview.value : '';
    const token = existing || await promptDialog({ title: 'Test AI API token', message: 'Paste the AI API token to validate it against this server.', type: 'password', required: true });
    if (token === null) return;
    await runUserAction(async () => {
      const result = await api('/integrations/ai/test', { method: 'POST', body: { token } });
      toast(result.message || 'AI token validated');
    }, 'AI token validation failed');
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
  modal.querySelector('#startPasskey')?.addEventListener('click', async () => {
    if (!webauthnSupported()) return toast('Passkeys are not supported in this browser');
    const currentPassword = await promptDialog({ title: 'Current password', message: 'Enter your current password to add a passkey.', type: 'password', required: true });
    if (currentPassword === null) return;
    const label = await promptDialog({ title: 'Passkey label', message: 'Name this passkey so you can recognize it later.', placeholder: 'Windows Hello on this PC' });
    if (label === null) return;
    await runUserAction(async () => {
      const options = await api('/webauthn/register/options', { method: 'POST', body: { current_password: currentPassword } });
      const credential = await navigator.credentials.create({ publicKey: publicKeyOptionsFromServer(options) });
      await api('/webauthn/register', { method: 'POST', body: webauthnRegistrationPayload(label || 'Passkey', credential) });
      toast('Passkey enabled');
      state.user.passkey_enabled = 1;
      openSettings();
    }, 'Passkey setup failed');
  });
  modal.querySelectorAll('[data-passkey-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Remove passkey?', message: 'Remove this passkey from DiVault login?', confirmText: 'Remove' })) return;
    await runUserAction(async () => {
      const result = await api(`/webauthn/credentials/${button.dataset.passkeyDelete}`, { method: 'DELETE' });
      state.user.passkey_enabled = result.credentials?.length ? 1 : 0;
      toast('Passkey removed');
      openSettings();
    }, 'Passkey removal failed');
  }));
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
    await runUserAction(async () => {
      const data = Object.fromEntries(new FormData(e.target));
      if (data.password !== data.password_confirm) throw new Error('Passwords do not match');
      delete data.password_confirm;
      await api('/users', { method: 'POST', body: data });
      toast('User created');
      openSettings();
    }, 'User creation failed');
  });
  modal.querySelectorAll('[data-reset-user-password]').forEach(btn => btn.addEventListener('click', async () => {
    const email = btn.dataset.userEmail || 'this user';
    const password = await promptDialog({ title: 'Reset user password', message: `Enter a new temporary password for ${email}.`, type: 'password', required: true, confirmText: 'Continue' });
    if (password === null) return;
    const passwordConfirm = await promptDialog({ title: 'Confirm password', message: `Type the new temporary password for ${email} again.`, type: 'password', required: true, confirmText: 'Reset password' });
    if (passwordConfirm === null) return;
    await runUserAction(async () => {
      await api(`/users/${btn.dataset.resetUserPassword}`, { method: 'PATCH', body: { password, password_confirm: passwordConfirm } });
      toast('Password reset and sessions revoked');
      openSettings();
    }, 'User password reset failed');
  }));
  modal.querySelectorAll('[data-delete-user]').forEach(btn => btn.addEventListener('click', async () => {
    const email = btn.dataset.userEmail || 'this user';
    if (!await confirmDialog({ title: 'Delete user?', message: `Disable sign-in for ${email} and revoke all of their active sessions? Their notes and files stay in place.`, confirmText: 'Delete user' })) return;
    await runUserAction(async () => {
      await api(`/users/${btn.dataset.deleteUser}`, { method: 'DELETE' });
      toast('User disabled and sessions revoked');
      openSettings();
    }, 'User delete failed');
  }));
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

async function showAiApiToken(panel, token, endpoint) {
  await navigator.clipboard.writeText(token);
  const preview = panel.querySelector('#aiApiTokenPreview');
  if (preview) {
    preview.value = token;
    preview.classList.remove('hidden');
  }
  const tokenStatus = panel.querySelector('#aiApiTokenStatus');
  if (tokenStatus) tokenStatus.textContent = `Token copied. Endpoint: ${endpoint || `${location.origin}/api/integrations/ai/review-notes`}`;
  toast('AI API token copied');
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

function renderFeatureSettings() {
  const calendar = feature('calendar');
  const tasks = feature('tasks');
  const home = feature('home');
  const drive = feature('drive');
  return `<form class="stack feature-settings-form">${featureHidden('calendar_enabled', calendar.enabled)}${featureHidden('tasks_enabled', tasks.enabled)}${featureHidden('calendar_home_enabled', calendar.settings.home_enabled)}${featureHidden('tasks_home_enabled', tasks.settings.home_enabled)}${featureHidden('calendar_reminders_enabled', calendar.settings.reminders_enabled)}${featureHidden('tasks_reminders_enabled', tasks.settings.reminders_enabled)}${featureHidden('tasks_shared_calendar_tasks', tasks.settings.shared_calendar_tasks)}<input name="calendar_default_reminder_minutes" type="hidden" value="${esc(calendar.settings.default_reminder_minutes ?? 10)}"><input name="tasks_default_reminder_minutes" type="hidden" value="${esc(tasks.settings.default_reminder_minutes ?? 10)}"><div class="feature-toggle-grid">
    <label class="checkline"><input name="drive_enabled" type="checkbox" ${drive.enabled ? 'checked' : ''}> Enable Files</label>
    <label class="checkline"><input name="home_notes_enabled" type="checkbox" ${home.settings.notes_enabled ? 'checked' : ''}> Show notes on Home</label>
  </div><button class="btn primary">Save workspace settings</button></form>`;
}

function renderCalendarTaskFeatureSettings() {
  const calendar = feature('calendar');
  const tasks = feature('tasks');
  const home = feature('home');
  const drive = feature('drive');
  return `<form class="stack feature-settings-form">${featureHidden('drive_enabled', drive.enabled)}${featureHidden('home_notes_enabled', home.settings.notes_enabled)}<div class="feature-toggle-grid">
    <label class="checkline"><input name="calendar_enabled" type="checkbox" ${calendar.enabled ? 'checked' : ''}> Enable Calendar</label>
    <label class="checkline"><input name="tasks_enabled" type="checkbox" ${tasks.enabled ? 'checked' : ''}> Enable Tasks</label>
    <label class="checkline"><input name="calendar_home_enabled" type="checkbox" ${calendar.settings.home_enabled ? 'checked' : ''}> Show calendar on Home</label>
    <label class="checkline"><input name="tasks_home_enabled" type="checkbox" ${tasks.settings.home_enabled ? 'checked' : ''}> Show tasks on Home</label>
    <label class="checkline"><input name="calendar_reminders_enabled" type="checkbox" ${calendar.settings.reminders_enabled ? 'checked' : ''}> Calendar reminders</label>
    <label class="checkline"><input name="tasks_reminders_enabled" type="checkbox" ${tasks.settings.reminders_enabled ? 'checked' : ''}> Task reminders</label>
    <label class="checkline"><input name="tasks_shared_calendar_tasks" type="checkbox" ${tasks.settings.shared_calendar_tasks ? 'checked' : ''}> Shared-calendar tasks</label>
  </div><div class="editor-grid"><label class="field"><span>Default calendar reminder minutes</span><input name="calendar_default_reminder_minutes" type="number" min="0" max="10080" value="${esc(calendar.settings.default_reminder_minutes ?? 10)}"></label><label class="field"><span>Default task reminder minutes</span><input name="tasks_default_reminder_minutes" type="number" min="0" max="10080" value="${esc(tasks.settings.default_reminder_minutes ?? 10)}"></label></div><button class="btn primary">Save calendar/task settings</button></form>`;
}

function featureHidden(name, enabled) {
  return enabled ? `<input name="${esc(name)}" type="hidden" value="on">` : '';
}

function renderCalendarFeedSettings(feeds = []) {
  const rows = feeds.map(feed => `<div class="file-row calendar-feed-row"><span><b>${esc(feed.name)}</b><br><span class="small muted">${esc(feed.url)}${feed.last_synced_at ? ` · synced ${esc(feed.last_synced_at)}` : ''}${feed.last_error ? ` · ${esc(feed.last_error)}` : ''}</span></span><span class="btn-row"><span class="pill" style="--calendar-color:${esc(feed.color || '#22c55e')}">${Number(feed.enabled) === 1 ? 'on' : 'off'}</span><button class="btn ghost" type="button" data-edit-feed="${feed.id}">Edit</button><button class="btn" type="button" data-sync-feed="${feed.id}">Sync</button><button class="btn danger" type="button" data-delete-feed="${feed.id}">Remove</button></span></div>`).join('') || '<p class="small muted">No external calendar feeds yet.</p>';
  return `<p class="muted small">Add private ICS/iCalendar subscription links from Microsoft, Google, Apple, Proton, or another calendar provider. These are read-only one-way pulls into your DiVault account. Other DiVault users do not see your synced calendars unless you share the resulting DiVault calendar with them.</p>
    <form id="calendarFeedForm" class="stack"><input id="calendarFeedId" name="id" type="hidden"><div class="editor-grid"><label class="field"><span>Feed name</span><input id="calendarFeedName" name="name" placeholder="Work Outlook" required></label><label class="field"><span>Color</span><input id="calendarFeedColor" name="color" type="color" value="#22c55e"></label></div><label class="field"><span>ICS subscription URL</span><input id="calendarFeedUrl" name="url" type="url" placeholder="https://.../calendar.ics" autocomplete="off" required></label><div class="editor-grid"><label class="field"><span>Refresh minutes</span><input id="calendarFeedRefresh" name="refresh_minutes" type="number" min="15" max="10080" value="360"></label><label class="checkline"><input id="calendarFeedEnabled" name="enabled" type="checkbox" checked> Feed enabled</label></div><label class="checkline"><input name="sync_now" type="checkbox" checked> Sync after saving</label><div class="btn-row"><button class="btn primary" id="calendarFeedSaveBtn">Add feed</button><button class="btn ghost" id="calendarFeedResetBtn" type="reset">Clear</button></div></form><div class="stack">${rows}</div>`;
}

function renderDriveStorageSettings(settings) {
  if (!settings) return '<p class="small muted">Drive storage settings are unavailable.</p>';
  const dir = settings.drive_files_dir || '/config/drive-files';
  const uploadMax = settings.drive_upload_max_mb || 250;
  return `<p class="muted small">Choose the container path for Drive file contents. To use a host disk, mount it into the container first, then set this to that container path, for example <code>/media</code>.</p>
    <form id="driveStorageSettingsForm" class="stack"><label class="field"><span>Drive files path</span><input name="drive_files_dir" value="${esc(dir)}" placeholder="/media" autocomplete="off"></label><label class="field"><span>Upload limit MB</span><input name="drive_upload_max_mb" type="number" min="1" max="2048" value="${esc(uploadMax)}"></label><button class="btn primary">Save storage settings</button></form>
    <div class="file-row"><span>Current path<br><span class="small muted">${esc(dir)}</span></span><span class="pill ${settings.writable ? '' : 'secret'}">${settings.writable ? 'writable' : 'not writable'}</span></div>
    <pre class="settings-code-block">DIVAULT_MEDIA_PATH=/host/path/for/files
Drive files path: /media</pre>
    <p class="small muted">When you change this path, DiVault copies existing Drive files into the new path. The path is inside the container; Docker controls which host folder it maps to.</p>`;
}

function renderAiIntegrationSettings(status) {
  if (!status) return '<p class="small muted">AI API status is unavailable.</p>';
  const endpoint = status.endpoint || `${location.origin}/api/integrations/ai/review-notes`;
  const enabled = status.enabled === true;
  const localTokenControls = enabled && status.can_reveal ? '<button class="btn ghost" type="button" id="copyAiTokenBtn">Copy current token</button>' : '';
  return `<p class="muted small">Let an AI tool add review notes directly into DiVault.</p>
    <div class="file-row"><span>Status<br><span class="small muted">${enabled ? `Enabled (${esc(status.source || 'local')})` : 'Disabled'}</span></span><span class="pill">${enabled ? 'on' : 'off'}</span></div>
    <div class="file-row"><span>Endpoint<br><span class="small muted">${esc(endpoint)}</span></span><button class="btn ghost" type="button" id="copyAiEndpointBtn">Copy URL</button></div>
    <label class="field ai-token-preview"><span>Token</span><textarea id="aiApiTokenPreview" class="hidden" readonly spellcheck="false" aria-label="AI API token"></textarea><span id="aiApiTokenStatus" class="small muted">${enabled && status.can_reveal ? 'Copy requires your current password.' : 'Token is shown after enable/regenerate.'}</span></label>
    <div class="btn-row"><button class="btn" type="button" id="enableAiApiBtn">${enabled ? 'Regenerate token' : 'Enable API'}</button>${localTokenControls}<button class="btn ghost" type="button" id="testAiTokenBtn">Test token</button>${enabled && status.can_disable !== false ? '<button class="btn danger" type="button" id="disableAiApiBtn">Disable</button>' : ''}</div>
    <p class="small muted">Use header <code>X-DiVault-AI-Token</code> or <code>Authorization: Bearer TOKEN</code>. Local tokens can be copied here with your password. Environment-managed tokens must be read from your server config or hosting secrets.</p>`;
}

function renderOnlyOfficeSettings(status) {
  if (!status) return '<p class="small muted">OnlyOffice status is unavailable.</p>';
  const enabled = status.enabled === true;
  const composeFile = status.compose_file || 'docker-compose.onlyoffice.yml';
  const internalUrl = status.recommended_internal_url || 'http://onlyoffice';
  const configuredInternalUrl = status.url || internalUrl;
  const publicUrl = status.public_url || 'http://127.0.0.1:8082';
  const callbackBaseUrl = status.callback_base_url || 'http://notes:3443';
  return `<p class="muted small">Run OnlyOffice Document Server next to DiVault when you want real Word, Excel, and PowerPoint editing. It is optional and not bundled into the main lightweight DiVault container.</p>
    <div class="file-row"><span>Status<br><span class="small muted">${enabled ? 'Ready for document editing' : 'Needs URL and JWT settings'}</span></span><span class="pill ${enabled ? '' : 'secret'}">${enabled ? 'ready' : 'setup'}</span></div>
    <div class="file-row"><span>Internal URL<br><span class="small muted">${esc(configuredInternalUrl)}</span></span><span class="pill ${status.url ? '' : 'secret'}">app to server</span></div>
    <div class="file-row"><span>Public URL<br><span class="small muted">${esc(publicUrl || 'Not configured')}</span></span><span class="pill ${publicUrl ? '' : 'secret'}">browser</span></div>
    <div class="file-row"><span>Callback URL<br><span class="small muted">${esc(callbackBaseUrl || 'Not configured')}</span></span><span class="pill ${callbackBaseUrl ? '' : 'secret'}">server to app</span></div>
    <div class="file-row"><span>JWT secret<br><span class="small muted">${status.jwt_configured ? 'Configured' : 'Missing'}</span></span><span class="pill ${status.jwt_configured ? '' : 'secret'}">${status.jwt_configured ? 'set' : 'required'}</span></div>
    <div class="inline-note-blocks"><div class="inline-note active"><b>Sidecar compose</b><span>${esc(composeFile)}</span></div><div class="inline-note"><b>Internal URL</b><span>${esc(internalUrl)}</span></div><div class="inline-note"><b>Browser URL</b><span>${esc(publicUrl)}</span></div><div class="inline-note"><b>Callback URL</b><span>${esc(callbackBaseUrl)}</span></div></div>
    <pre class="settings-code-block">ONLYOFFICE_JWT_SECRET=change-this-long-random-secret
ONLYOFFICE_URL=${esc(internalUrl)}
ONLYOFFICE_PUBLIC_URL=${esc(publicUrl)}
ONLYOFFICE_CALLBACK_BASE_URL=${esc(callbackBaseUrl)}
docker compose -f docker-compose.yml -f ${esc(composeFile)} up -d</pre>
    <p class="small muted">The browser must reach the public URL, and the OnlyOffice Document Server must reach the callback URL. For production, put both DiVault and OnlyOffice behind HTTPS and use the same JWT secret in both containers.</p>`;
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
