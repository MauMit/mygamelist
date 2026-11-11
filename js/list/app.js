import { createStore } from './store.js';
import { loadAchievementSummaries, suggestStatus, steamCover, consoleFamily } from './achievements.js';
import { parseMvglExport, entryKey, normalizeTitle, normalizePlatform } from './mvgl.js';
import { findCovers } from './covers.js';

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------
const STATUSES = [
  { id: 'playing', label: 'Currently Playing', short: 'Playing', color: 'var(--st-playing)' },
  { id: 'almost', label: 'Almost Done', short: 'Almost Done', color: 'var(--st-almost)' },
  { id: 'completed', label: 'Completed', short: 'Completed', color: 'var(--st-completed)' },
  { id: 'plan', label: 'Plan to Play', short: 'Plan to Play', color: 'var(--st-plan)' },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
const PREFS_KEY = 'gamelist-prefs-v1';

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
const state = {
  store: null,
  user: null,
  games: [],
  ach: new Map(),
  consoleIndex: new Map(),
  achMeta: null,
  filter: 'all',
  search: '',
  sort: 'updated',
  view: 'grid',
  editingId: null,
  unsubscribeGames: null,
};

try { Object.assign(state, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ }
const savePrefs = () => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: state.sort, sortDir: state.sortDir, view: state.view, filter: state.filter })); } catch { /* ignore */ }
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const initials = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

function clean(obj) {
  // Firestore rejects undefined values
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2800);
}

function coverFor(game) {
  if (game.cover) return game.cover;
  const a = game.appid && state.ach.get(String(game.appid));
  if (a && a.icon) return a.icon;
  return game.appid ? steamCover(game.appid) : '';
}

function achFor(game) {
  if (game.appid) return state.ach.get(String(game.appid)) || null;
  // Console games (e.g. imported from MyVideoGameList) match synced Xbox/PlayStation
  // progress by platform family + title
  const family = consoleFamily(game.platform);
  return family ? state.consoleIndex.get(family + '|' + normalizeTitle(game.title)) || null : null;
}

function buildConsoleIndex() {
  const index = new Map();
  for (const a of state.ach.values()) {
    if (!a.console) continue;
    const key = a.console + '|' + normalizeTitle(a.name);
    const prev = index.get(key);
    // Same game on two consoles (e.g. PS4 + PS5 versions): use the one with more progress
    if (!prev || (a.unlocked || 0) > (prev.unlocked || 0)) index.set(key, a);
  }
  state.consoleIndex = index;
}

function relDate(unixSeconds) {
  if (!unixSeconds) return '';
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function coverHtml(game, cls = 'cover') {
  const src = coverFor(game);
  const letter = esc(initials(game.title));
  if (!src) return `<div class="${cls}">${letter}</div>`;
  // Steam header art is already wide; box art (Wikipedia, custom) is shown whole over a blurred copy
  const wide = /steamstatic\.com|steampowered\.com|steamcdn/.test(src);
  const fit = wide ? '' : ` fit" style="--bg:url('${esc(src).replace(/'/g, '%27')}')`;
  return `<div class="${cls}${fit}">${letter}<img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('fit');this.remove()"></div>`;
}

function pill(statusId) {
  const s = STATUS[statusId] || STATUS.playing;
  return `<span class="pill" style="--c:${s.color}">${esc(s.short)}</span>`;
}

function progressHtml(a) {
  if (!a || !a.total) return '';
  const full = a.percent >= 100;
  return `<div class="progress" title="${a.unlocked} of ${a.total} achievements">
    <div class="progress-top"><span>🏆 ${a.unlocked}/${a.total}</span><span>${a.percent}%</span></div>
    <div class="bar${full ? ' full' : ''}"><span style="width:${a.percent}%"></span></div>
  </div>`;
}

// Nudges the user when achievement progress no longer matches the status
function hintFor(game, a) {
  if (!a || !a.total) return null;
  if (a.percent >= 100 && game.status !== 'completed') return { to: 'completed', text: '100% achievements', cls: '' };
  if (a.percent >= 75 && a.percent < 100 && (game.status === 'playing' || game.status === 'plan')) {
    return { to: 'almost', text: `${a.percent}% achievements`, cls: 'almost' };
  }
  return null;
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------
function counts() {
  const c = { all: state.games.length };
  STATUSES.forEach((s) => (c[s.id] = 0));
  state.games.forEach((g) => { if (c[g.status] !== undefined) c[g.status]++; });
  return c;
}

function renderStats() {
  const c = counts();
  let achUnlocked = 0;
  let achTotal = 0;
  state.games.forEach((g) => { const a = achFor(g); if (a) { achUnlocked += a.unlocked; achTotal += a.total; } });

  const cards = [
    `<button class="stat${state.filter === 'all' ? ' active' : ''}" data-filter="all" style="--c:var(--accent)"><span class="num">${c.all}</span><span class="lbl">Total games</span></button>`,
    ...STATUSES.map((s) => `<button class="stat${state.filter === s.id ? ' active' : ''}" data-filter="${s.id}" style="--c:${s.color}"><span class="num">${c[s.id]}</span><span class="lbl">${esc(s.label)}</span></button>`),
    `<div class="stat static" style="--c:#ffd36b"><span class="num">${achUnlocked.toLocaleString()}</span><span class="lbl">Achievements${achTotal ? ` of ${achTotal.toLocaleString()}` : ''}</span></div>`,
  ];
  const dist = c.all
    ? `<div class="dist" aria-hidden="true">${STATUSES.filter((s) => c[s.id]).map((s) => `<span style="flex:${c[s.id]};background:${s.color}" title="${esc(s.label)}: ${c[s.id]}"></span>`).join('')}</div>`
    : '';
  $('#stats').innerHTML = cards.join('') + dist;
}

function renderTabs() {
  const c = counts();
  const tabs = [{ id: 'all', label: 'All', color: 'var(--accent)' }, ...STATUSES];
  $('#status-tabs').innerHTML = tabs
    .map((t) => `<button type="button" role="tab" class="status-tab${state.filter === t.id ? ' active' : ''}" data-filter="${t.id}" aria-selected="${state.filter === t.id}" style="--c:${t.color}">
      <span class="dot"></span>${esc(t.label)} <span class="count">${c[t.id]}</span></button>`)
    .join('');
}

function visibleGames() {
  const q = state.search.trim().toLowerCase();
  let list = state.games.filter((g) => (state.filter === 'all' || g.status === state.filter) &&
    (!q || [g.title, g.platform, g.notes].some((v) => String(v || '').toLowerCase().includes(q))));

  const key = SORT_VALUES[state.sort] ? state.sort : 'updated';
  const value = SORT_VALUES[key];
  const dir = sortDir() === 'asc' ? 1 : -1;
  const lastUnlock = (g) => achFor(g)?.lastUnlock || 0;
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base', numeric: true });

  return list.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    // Empty values ("–") always go last, whichever direction
    if (va == null || vb == null) {
      if (va == null && vb == null) return byTitle(a, b);
      return va == null ? 1 : -1;
    }
    const c = typeof va === 'string'
      ? va.localeCompare(vb, undefined, { sensitivity: 'base', numeric: true })
      : va - vb;
    // Ties (e.g. a batch import) fall back to latest achievement unlock, then title
    return c * dir || lastUnlock(b) - lastUnlock(a) || byTitle(a, b);
  });
}

// Value each sort key compares on; null means "no value"
const STATUS_ORDER = { playing: 0, almost: 1, completed: 2, plan: 3 };
const SORT_VALUES = {
  updated: (g) => g.updatedAt || 0,
  added: (g) => g.createdAt || 0,
  title: (g) => String(g.title || ''),
  platform: (g) => (g.platform ? String(g.platform) : null),
  status: (g) => STATUS_ORDER[g.status] ?? 9,
  score: (g) => (g.score ? Number(g.score) : null),
  hours: (g) => (g.hours ? Number(g.hours) : null),
  progress: (g) => { const a = achFor(g); return a && a.total ? a.percent : null; },
};
// Direction a column starts in when you first click it
const DEFAULT_DIR = { updated: 'desc', added: 'desc', title: 'asc', platform: 'asc', status: 'asc', score: 'desc', hours: 'desc', progress: 'desc' };

function sortDir() {
  return state.sortDir === 'asc' || state.sortDir === 'desc' ? state.sortDir : (DEFAULT_DIR[state.sort] || 'desc');
}

function setSort(key, dir) {
  state.sort = key;
  state.sortDir = dir || DEFAULT_DIR[key] || 'desc';
  $('#sort').value = key;
  savePrefs();
  renderGames();
}

function sortHeader(key, label, cls = '') {
  const active = state.sort === key;
  const dir = sortDir();
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : '↕';
  const aria = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<button type="button" class="sort-head ${cls}${active ? ' active' : ''}" data-sort="${key}" aria-sort="${aria}" title="Sort by ${esc(label)}">${esc(label)} <span class="arrow" aria-hidden="true">${arrow}</span></button>`;
}

function renderGames() {
  const box = $('#games');
  const empty = $('#empty');
  const list = visibleGames();
  box.className = 'games ' + state.view;
  $$('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const asc = sortDir() === 'asc';
  $('#sort-dir').textContent = asc ? '▲' : '▼';
  $('#sort-dir').title = asc ? 'Ascending (click to reverse)' : 'Descending (click to reverse)';
  $('#sort-dir').setAttribute('aria-label', $('#sort-dir').title);

  if (!list.length) {
    box.innerHTML = '';
    empty.hidden = false;
    const importable = importCandidates().length;
    if (!state.games.length) {
      empty.innerHTML = `<h2>Your list is empty</h2>
        <p>Add the games you're playing, have finished, or want to play next.${importable ? ` Your achievement watcher already has <strong>${importable}</strong> games ready to import.` : ''}</p>
        <div class="btns">${importable ? '<button class="btn btn-primary" data-action="import">🏆 Import from achievements</button>' : ''}
        <button class="btn ${importable ? 'btn-ghost' : 'btn-primary'}" data-action="add">+ Add a game</button></div>`;
    } else {
      empty.innerHTML = `<h2>No games here</h2><p>${state.search ? 'Nothing matches your search.' : 'No games with this status yet.'}</p>`;
    }
    return;
  }
  empty.hidden = true;

  if (state.view === 'list') {
    box.innerHTML = `<div class="row-head"><span>#</span><span></span>${sortHeader('title', 'Title')}${sortHeader('platform', 'Platform', 'c-platform')}${sortHeader('status', 'Status')}${sortHeader('score', 'Score', 'c-score')}${sortHeader('hours', 'Hours', 'c-hours')}${sortHeader('progress', 'Achievements', 'c-progress')}</div>` +
      list.map((g, i) => {
        const a = achFor(g);
        const s = STATUS[g.status] || STATUS.playing;
        return `<button type="button" class="row" data-id="${esc(g.id)}" style="--c:${s.color}">
          <span class="idx">${i + 1}</span>
          ${coverHtml(g, 'thumb')}
          <span class="t" title="${esc(g.title)}">${esc(g.title)}</span>
          <span class="c-platform muted">${esc(g.platform || '–')}</span>
          <span>${pill(g.status)}</span>
          <span class="c-score num">${g.score ? `★ ${g.score}` : '–'}</span>
          <span class="c-hours num muted">${g.hours ? `${g.hours}h` : '–'}</span>
          <span class="c-progress">${progressHtml(a) || '<span class="muted small">–</span>'}</span>
        </button>`;
      }).join('');
    return;
  }

  box.innerHTML = list.map((g) => {
    const a = achFor(g);
    const hint = hintFor(g, a);
    const meta = [g.platform, g.hours ? `${g.hours}h` : null, a && a.lastUnlock ? `last unlock ${relDate(a.lastUnlock)}` : null].filter(Boolean).join(' · ');
    return `<div class="card" role="button" tabindex="0" data-id="${esc(g.id)}" aria-label="${esc(g.title)}">
      ${coverHtml(g)}
      ${pill(g.status)}
      ${g.score ? `<span class="score">★ ${g.score}</span>` : ''}
      <div class="card-body">
        <div class="card-title">${esc(g.title)}</div>
        ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
        ${progressHtml(a)}
        ${hint ? `<div class="hint ${hint.cls}"><span>${esc(hint.text)}</span><button type="button" data-quick="${hint.to}" data-id="${esc(g.id)}">Mark ${esc(STATUS[hint.to].short)}</button></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderAll() {
  renderStats();
  renderTabs();
  renderGames();
  const n = importCandidates().length;
  $('#import-count').textContent = n;
  $('#import-count').hidden = n === 0;
}

function renderUser() {
  const u = state.user;
  $('#user-box').hidden = !u;
  if (!u) return;
  $('#user-name').textContent = u.name;
  $('#list-title').textContent = `${u.name}'s Game List`;
  document.title = `${u.name}'s Game List`;
  const img = $('#user-avatar');
  if (u.photo) { img.src = u.photo; img.hidden = false; $('#user-initial').hidden = true; }
  else { img.hidden = true; $('#user-initial').hidden = false; $('#user-initial').textContent = initials(u.name); }
}

function renderAchSource() {
  const m = state.achMeta;
  const el = $('#ach-source');
  if (!m) { el.textContent = 'Loading achievement data…'; return; }
  const repo = `${m.source.owner}/${m.source.repo}`;
  if (m.error && !m.games.size) { el.textContent = `Couldn't load achievement data from ${repo} (${m.error.message}).`; return; }
  const when = m.lastUpdated ? new Date(m.lastUpdated * 1000).toLocaleString() : 'unknown';
  el.textContent = `${m.games.size} games with achievements from ${repo} · synced ${when}${m.fromCache ? ' (cached)' : ''}`;
}

// ------------------------------------------------------------
// Views
// ------------------------------------------------------------
function show(view) {
  $('#boot').hidden = view !== 'boot';
  $('#auth-view').hidden = view !== 'auth';
  $('#app-view').hidden = view !== 'app';
}

// ------------------------------------------------------------
// Auth UI
// ------------------------------------------------------------
let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach((t) => { const on = t.dataset.mode === mode; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $('#name-field').hidden = mode !== 'signup';
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#forgot-btn').hidden = mode !== 'signin' || !state.store.supportsReset;
  authMessage();
}
function authMessage(error = '', info = '') {
  $('#auth-error').textContent = error; $('#auth-error').hidden = !error;
  $('#auth-info').textContent = info; $('#auth-info').hidden = !info;
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!email || !password) return authMessage('Enter your email and password.');
  const btn = $('#auth-submit');
  btn.disabled = true;
  authMessage();
  try {
    if (authMode === 'signup') await state.store.signUp($('#auth-name').value.trim(), email, password);
    else await state.store.signIn(email, password);
    $('#auth-password').value = '';
  } catch (err) {
    authMessage(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------
// Add / edit dialog
// ------------------------------------------------------------
function fillDatalist() {
  const titles = [...state.ach.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('#ach-titles').innerHTML = titles.map((a) => `<option value="${esc(a.name)}"></option>`).join('');
}

function updatePreview() {
  const appid = $('#f-appid').value.trim();
  const a = appid ? state.ach.get(appid) : null;
  const box = $('#game-preview');
  const cover = $('#f-cover').value.trim() || (a && a.icon) || (appid ? steamCover(appid) : '');
  if (!cover && !a) { box.classList.remove('show'); box.innerHTML = ''; }
  else {
    box.classList.add('show');
    box.innerHTML = `${cover ? `<img src="${esc(cover)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
      <div class="gp-info"><div class="gp-title">${esc($('#f-title').value || (a && a.name) || '')}</div>
      ${a ? progressHtml(a) || '<span class="muted small">No achievements for this game.</span>' : '<span class="muted small">No achievement data synced for this AppID.</span>'}</div>`;
  }
  const link = $('#view-ach');
  link.hidden = !a;
  if (a) link.href = `index.html?game=${encodeURIComponent(a.appid)}`;
}

function openGameDialog(game = null) {
  state.editingId = game ? game.id : null;
  $('#game-dialog-title').textContent = game ? 'Edit game' : 'Add game';
  $('#delete-game').hidden = !game;
  $('#game-error').hidden = true;
  $('#f-status').innerHTML = STATUSES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');

  const g = game || { status: state.filter !== 'all' ? state.filter : 'playing' };
  $('#f-title').value = g.title || '';
  $('#f-status').value = g.status || 'playing';
  $('#f-platform').value = g.platform || '';
  $('#f-score').value = g.score ? String(g.score) : '';
  $('#f-hours').value = g.hours ?? '';
  $('#f-started').value = g.startedAt || '';
  $('#f-finished').value = g.finishedAt || '';
  $('#f-appid').value = g.appid || '';
  $('#f-cover').value = g.cover || '';
  $('#f-notes').value = g.notes || '';
  updatePreview();
  $('#game-dialog').showModal();
  if (!game) $('#f-title').focus();
}

function onTitleInput() {
  // Picking a title from the achievement list links its AppID
  const title = $('#f-title').value.trim().toLowerCase();
  const match = [...state.ach.values()].find((a) => a.name.toLowerCase() === title);
  if (match) {
    $('#f-appid').value = match.appid;
    if (!$('#f-platform').value) $('#f-platform').value = match.platform || 'PC';
  }
  updatePreview();
}

async function onGameSubmit(e) {
  e.preventDefault();
  const title = $('#f-title').value.trim();
  const appid = $('#f-appid').value.trim();
  const err = (m) => { $('#game-error').textContent = m; $('#game-error').hidden = false; };
  if (!title) return err('Give the game a title.');
  if (appid && !/^\d+$/.test(appid)) return err('Steam AppID should be numbers only.');
  const hours = $('#f-hours').value === '' ? null : Number($('#f-hours').value);
  if (hours !== null && (Number.isNaN(hours) || hours < 0)) return err('Hours must be 0 or more.');

  const status = $('#f-status').value;
  let finishedAt = $('#f-finished').value || null;
  if (status === 'completed' && !finishedAt) finishedAt = today();

  const data = clean({
    title,
    status,
    platform: $('#f-platform').value.trim() || null,
    score: $('#f-score').value ? Number($('#f-score').value) : null,
    hours,
    startedAt: $('#f-started').value || null,
    finishedAt,
    appid: appid || null,
    cover: $('#f-cover').value.trim() || null,
    notes: $('#f-notes').value.trim() || null,
  });

  const btn = $('#save-game');
  btn.disabled = true;
  try {
    if (state.editingId) { await state.store.update(state.editingId, data); toast('Saved'); }
    else {
      if (appid && state.games.some((g) => String(g.appid) === appid)) {
        if (!confirm('This game is already on your list. Add it again?')) return;
      }
      await state.store.add(data);
      toast(`Added ${title}`);
    }
    $('#game-dialog').close();
  } catch (e2) {
    err(e2.message);
  } finally {
    btn.disabled = false;
  }
}

async function onDeleteGame() {
  const g = state.games.find((x) => x.id === state.editingId);
  if (!g || !confirm(`Remove "${g.title}" from your list?`)) return;
  try {
    await state.store.remove(g.id);
    $('#game-dialog').close();
    toast(`Removed ${g.title}`);
  } catch (e) { toast(e.message, true); }
}

async function quickStatus(id, status) {
  const patch = { status };
  const g = state.games.find((x) => x.id === id);
  if (status === 'completed' && g && !g.finishedAt) patch.finishedAt = today();
  try { await state.store.update(id, patch); toast(`Moved to ${STATUS[status].label}`); }
  catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------
// Import from achievements
// ------------------------------------------------------------
function importCandidates() {
  const listed = new Set(state.games.map((g) => String(g.appid || '')));
  // Console games already on the list by title (no appid) count as listed too
  const linked = new Set(state.games.map((g) => achFor(g)).filter(Boolean).map((a) => a.appid));
  return [...state.ach.values()]
    .filter((a) => !listed.has(a.appid) && !linked.has(a.appid))
    .sort((a, b) => (b.lastUnlock || 0) - (a.lastUnlock || 0));
}

function openImport() {
  const items = importCandidates();
  if (!items.length) {
    toast(state.ach.size ? 'Every game from your achievements is already on your list.' : 'No achievement data found yet.');
    return;
  }
  $('#import-list').innerHTML = items.map((a) => {
    const sug = suggestStatus(a);
    return `<label class="import-item" data-appid="${esc(a.appid)}">
      <input type="checkbox" checked>
      <img src="${esc(a.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span style="min-width:0"><span class="t" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="muted small">${a.total ? `${a.unlocked}/${a.total} · ${a.percent}%` : 'No achievements'}${a.lastUnlock ? ` · ${relDate(a.lastUnlock)}` : ''}</span></span>
      <select aria-label="Status for ${esc(a.name)}">${STATUSES.map((s) => `<option value="${s.id}"${s.id === sug ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
    </label>`;
  }).join('');
  $('#import-all').checked = true;
  updateImportSummary();
  $('#import-dialog').showModal();
}

function updateImportSummary() {
  const boxes = $$('#import-list input[type=checkbox]');
  const n = boxes.filter((b) => b.checked).length;
  $('#import-summary').textContent = `${n} of ${boxes.length} selected`;
  $('#import-confirm').disabled = n === 0;
  $('#import-all').checked = n === boxes.length;
}

async function onImportConfirm() {
  const rows = $$('#import-list .import-item').filter((r) => $('input[type=checkbox]', r).checked);
  const games = rows.map((r) => {
    const a = state.ach.get(r.dataset.appid);
    const status = $('select', r).value;
    return clean({
      title: a.name,
      appid: a.appid,
      status,
      platform: a.platform || 'PC',
      finishedAt: status === 'completed' && a.lastUnlock ? new Date(a.lastUnlock * 1000).toISOString().slice(0, 10) : null,
      score: null, hours: null, startedAt: null, cover: null, notes: null,
    });
  });
  const btn = $('#import-confirm');
  btn.disabled = true;
  try {
    await state.store.addMany(games);
    $('#import-dialog').close();
    toast(`Imported ${games.length} game${games.length === 1 ? '' : 's'}`);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
}

// ------------------------------------------------------------
// Cover art for games without Steam art (runs in the background)
// ------------------------------------------------------------
let coverRunStarted = false;

async function fillMissingCovers() {
  if (coverRunStarted || !state.user) return;
  const needs = state.games.filter((g) => !g.cover && !g.appid && !g.coverChecked && g.title);
  if (!needs.length) return;
  coverRunStarted = true;

  const byTitle = new Map();
  for (const g of needs) {
    if (!byTitle.has(g.title)) byTitle.set(g.title, []);
    byTitle.get(g.title).push(g);
  }

  let done = 0;
  let found = 0;
  const total = byTitle.size;
  const status = $('#cover-status');
  const show = () => {
    status.hidden = false;
    status.textContent = `Finding cover art… ${done}/${total}`;
  };
  show();

  try {
    await findCovers([...byTitle.keys()], async (title, url) => {
      for (const g of byTitle.get(title) || []) {
        const patch = url ? { cover: url, coverSource: 'wikipedia', coverChecked: true } : { coverChecked: true };
        try { await state.store.update(g.id, patch, { touch: false }); } catch { /* try again next visit */ }
      }
      done++;
      if (url) found++;
      show();
    });
    toast(`Found cover art for ${found} of ${total} games`);
  } catch (err) {
    console.warn('Cover lookup stopped:', err);
  } finally {
    status.hidden = true;
    coverRunStarted = false;
  }
}

// ------------------------------------------------------------
// Import from MyVideoGameList
// ------------------------------------------------------------
let mvgl = null;

function prepareMvgl(entries, fileName) {
  const byKey = new Map(state.games.map((g) => [entryKey(g.title, g.platform), g]));
  const byMvglId = new Map(state.games.filter((g) => g.mvglEntryId != null).map((g) => [g.mvglEntryId, g]));
  const byAppid = new Map(state.games.filter((g) => g.appid).map((g) => [String(g.appid), g]));
  const achByTitle = new Map([...state.ach.values()].map((a) => [normalizeTitle(a.name), a]));

  const fresh = [];
  const existing = [];
  const seen = new Set();
  for (const e of entries) {
    const key = entryKey(e.title, e.platform);
    const isPc = normalizePlatform(e.platform) === 'pc';
    const ach = isPc ? achByTitle.get(normalizeTitle(e.title)) || null : null;
    const match = (e.mvglEntryId != null && byMvglId.get(e.mvglEntryId)) || byKey.get(key) || (ach && byAppid.get(ach.appid)) || null;
    const item = { ...e, key, ach, match };
    if (match) existing.push(item);
    else if (!seen.has(key)) { seen.add(key); fresh.push(item); }
  }
  mvgl = { fileName, total: entries.length, fresh, existing, show: 'new' };
}

function renderMvgl() {
  const m = mvgl;
  const linkable = m.fresh.filter((e) => e.ach).length + m.existing.filter((e) => e.ach && !e.match.appid).length;
  $('#mvgl-summary').textContent = `${m.fileName}: ${m.total} games. ${m.fresh.length} new, ${m.existing.length} already on your list.`;

  const counts = {};
  m.fresh.forEach((e) => (counts[e.status] = (counts[e.status] || 0) + 1));
  $('#mvgl-chips').innerHTML = STATUSES.filter((s) => counts[s.id])
    .map((s) => `<span class="pill" style="--c:${s.color}">${esc(s.label)}: ${counts[s.id]}</span>`).join('');

  $('#mvgl-link-label').textContent = `Link achievement progress for ${linkable} matching PC game${linkable === 1 ? '' : 's'}`;
  $('#mvgl-link').closest('label').hidden = linkable === 0;
  $('#mvgl-update-label').textContent = `Also update the ${m.existing.length} game${m.existing.length === 1 ? '' : 's'} already on your list (status, score, hours and dates from MyVideoGameList)`;
  $('#mvgl-update-wrap').hidden = m.existing.length === 0;

  $$('.mvgl-filter [data-show]').forEach((b) => b.classList.toggle('active', b.dataset.show === m.show));
  const rows = m.show === 'new' ? m.fresh : m.existing;
  const LIMIT = 300;
  $('#mvgl-list').innerHTML = rows.length
    ? rows.slice(0, LIMIT).map((e) => `<div class="mvgl-row">
        <span class="t" title="${esc(e.title)}">${esc(e.title)}</span>
        <span class="p muted">${esc(e.platform || '–')}</span>
        <span>${pill(e.status)}</span>
        <span class="linked" title="${e.ach ? `Achievements: ${e.ach.unlocked}/${e.ach.total}` : ''}">${e.ach ? '🏆 ' + e.ach.percent + '%' : ''}</span>
      </div>`).join('') + (rows.length > LIMIT ? `<div class="mvgl-more muted small">…and ${rows.length - LIMIT} more</div>` : '')
    : `<div class="mvgl-more muted small">${m.show === 'new' ? 'Nothing new to add.' : 'None of these games are on your list yet.'}</div>`;

  const updating = $('#mvgl-update').checked ? m.existing.length : 0;
  const parts = [`${m.fresh.length} to add`];
  if (updating) parts.push(`${updating} to update`);
  $('#mvgl-count').textContent = parts.join(', ');
  $('#mvgl-confirm').textContent = m.fresh.length || updating ? `Import ${m.fresh.length + updating} games` : 'Nothing to import';
  $('#mvgl-confirm').disabled = !(m.fresh.length || updating);
}

async function onMvglFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const entries = parseMvglExport(await file.text());
    if (!entries.length) throw new Error('The export has no games in it.');
    prepareMvgl(entries, file.name);
    $('#mvgl-update').checked = false;
    $('#mvgl-link').checked = true;
    renderMvgl();
    $('#mvgl-dialog').showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onMvglConfirm() {
  const link = $('#mvgl-link').checked;
  const update = $('#mvgl-update').checked;
  const btn = $('#mvgl-confirm');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const toAdd = mvgl.fresh.map((e) => clean({
      title: e.title,
      status: e.status,
      platform: e.platform,
      score: e.score,
      hours: e.hours,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      notes: e.notes,
      appid: link && e.ach ? e.ach.appid : null,
      cover: null,
      mvglEntryId: e.mvglEntryId,
      source: 'myvideogamelist',
    }));
    if (toAdd.length) await state.store.addMany(toAdd);

    let updated = 0;
    if (update) {
      for (const e of mvgl.existing) {
        const patch = clean({
          status: e.status,
          score: e.score ?? undefined,
          hours: e.hours ?? undefined,
          startedAt: e.startedAt ?? undefined,
          finishedAt: e.finishedAt ?? undefined,
          appid: link && e.ach && !e.match.appid ? e.ach.appid : undefined,
          mvglEntryId: e.mvglEntryId ?? undefined,
        });
        await state.store.update(e.match.id, patch);
        updated++;
      }
    }

    $('#mvgl-dialog').close();
    toast(`Imported ${toAdd.length} game${toAdd.length === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''} from MyVideoGameList`);
  } catch (err) {
    toast(err.message, true);
    renderMvgl();
  }
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------
function bindEvents() {
  $$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('#auth-form').addEventListener('submit', onAuthSubmit);
  $('#google-btn').addEventListener('click', async () => {
    authMessage();
    try { await state.store.signInWithGoogle(); } catch (e) { authMessage(e.message); }
  });
  $('#forgot-btn').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) return authMessage('Type your email above first, then press "Forgot password?".');
    try { await state.store.resetPassword(email); authMessage('', `Password reset email sent to ${email}.`); }
    catch (e) { authMessage(e.message); }
  });
  $('#sign-out').addEventListener('click', () => state.store.signOut().catch((e) => toast(e.message, true)));

  $('#add-btn').addEventListener('click', () => openGameDialog());
  $('#import-btn').addEventListener('click', openImport);

  const setFilter = (f) => { state.filter = f; savePrefs(); renderAll(); };
  $('#stats').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) setFilter(b.dataset.filter); });
  $('#status-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) setFilter(b.dataset.filter); });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderGames(); });
  $('#sort').addEventListener('change', (e) => setSort(e.target.value));
  $('#sort-dir').addEventListener('click', () => setSort(state.sort, sortDir() === 'asc' ? 'desc' : 'asc'));
  // Column headers in list view: click to sort, click again to reverse
  $('#games').addEventListener('click', (e) => {
    const head = e.target.closest('[data-sort]');
    if (!head) return;
    e.stopPropagation();
    const key = head.dataset.sort;
    if (state.sort === key) setSort(key, sortDir() === 'asc' ? 'desc' : 'asc');
    else setSort(key);
  }, true);
  $$('.view-toggle button').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; savePrefs(); renderGames(); }));

  const openFromEvent = (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) { e.stopPropagation(); quickStatus(quick.dataset.id, quick.dataset.quick); return; }
    const item = e.target.closest('[data-id]');
    if (item) openGameDialog(state.games.find((g) => g.id === item.dataset.id));
  };
  $('#games').addEventListener('click', openFromEvent);
  $('#games').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) { e.preventDefault(); openFromEvent(e); }
  });
  $('#empty').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a) (a.dataset.action === 'import' ? openImport() : openGameDialog());
  });

  $('#game-form').addEventListener('submit', onGameSubmit);
  $('#delete-game').addEventListener('click', onDeleteGame);
  $('#f-title').addEventListener('input', onTitleInput);
  $('#f-appid').addEventListener('input', updatePreview);
  $('#f-cover').addEventListener('change', updatePreview);
  $('#f-status').addEventListener('change', () => {
    if ($('#f-status').value === 'completed' && !$('#f-finished').value) $('#f-finished').value = today();
    if ($('#f-status').value === 'playing' && !$('#f-started').value) $('#f-started').value = today();
  });

  $('#import-list').addEventListener('change', (e) => { if (e.target.type === 'checkbox') updateImportSummary(); });
  $('#import-all').addEventListener('change', (e) => { $$('#import-list input[type=checkbox]').forEach((b) => (b.checked = e.target.checked)); updateImportSummary(); });
  $('#import-confirm').addEventListener('click', onImportConfirm);

  $('#mvgl-btn').addEventListener('click', () => $('#mvgl-file').click());
  $('#mvgl-file').addEventListener('change', onMvglFile);
  $('#mvgl-confirm').addEventListener('click', onMvglConfirm);
  $('#mvgl-update').addEventListener('change', renderMvgl);
  $$('.mvgl-filter [data-show]').forEach((b) => b.addEventListener('click', () => { mvgl.show = b.dataset.show; renderMvgl(); }));

  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
}

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
async function main() {
  show('boot');
  try {
    state.store = await createStore();
  } catch (e) {
    $('#boot').innerHTML = `<p class="form-error">Couldn't start: ${esc(e.message)}</p>`;
    return;
  }

  $('#local-banner').hidden = state.store.mode !== 'local';
  $('#google-wrap').hidden = !state.store.supportsGoogle;
  $('#sort').value = state.sort;
  bindEvents();
  setAuthMode('signin');

  // Achievement data loads in parallel with auth
  loadAchievementSummaries().then((res) => {
    state.ach = res.games;
    state.achMeta = res;
    buildConsoleIndex();
    fillDatalist();
    renderAchSource();
    if (state.user) renderAll();
  });

  state.store.onAuth((user) => {
    if (state.unsubscribeGames) { state.unsubscribeGames(); state.unsubscribeGames = null; }
    state.user = user;
    state.games = [];
    renderUser();
    if (!user) { setAuthMode('signin'); show('auth'); return; }
    show('app');
    renderAchSource();
    renderAll();
    let firstLoad = true;
    let renderQueued = false;
    state.unsubscribeGames = state.store.subscribe(
      (games) => {
        state.games = games;
        // Coalesce bursts of updates (imports, cover lookups) into one redraw per frame
        if (!renderQueued) {
          renderQueued = true;
          requestAnimationFrame(() => { renderQueued = false; renderAll(); });
        }
        if (firstLoad) {
          firstLoad = false;
          setTimeout(fillMissingCovers, 1500);
        }
      },
      (err) => toast(err.message, true)
    );
  });
}

main();
