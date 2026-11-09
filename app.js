'use strict';
/* Mırıl — Google Drive'daki sesli kitaplar için tatlı bir oynatıcı. Giriş yok.
   - Kitaplar: "bağlantıya sahip herkes" ile paylaşılmış bir Drive klasörü.
     Klasör bir API anahtarıyla listelenir, sesler doğrudan akış halinde çalınır.
   - Profiller ve kaldığın yer: senin hesabında çalışan bir Apps Script'te
     (apps-script.gs) tutulur. PC ↔ telefon böyle eşitlenir.
   - Klasör linki ve senkron adresi repoda değil, cihazın ayarlarında durur. */

const CFG = window.MIRIL_CONFIG || {};
const DRIVE = CFG.DRIVE_API || 'https://www.googleapis.com/drive/v3/';
const HAS_KEY = !!CFG.API_KEY && !CFG.API_KEY.startsWith('BURAYA');
const AUDIO_RE = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)$/i;
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const AVATARS = ['🦊','🐻','🐰','🐼','🐨','🦉','🐸','🐯','🐧','🐹','🦔','🐢','🐱','🐶','🦁','🐙'];
const COLORS = ['#F6B8A6','#F9D88B','#B9DDB4','#A9CFEA','#CDB8EC','#F3B5D3'];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const COVER_PAIRS = [['#F6B8A6','#F9D88B'],['#B9DDB4','#F3E6A6'],['#A9CFEA','#D9C9F0'],['#F3B5D3','#FBD3B6'],['#CDB8EC','#A9CFEA'],['#F9D88B','#B9DDB4'],['#FBC8A8','#E9A6A6']];

let DEMO = new URLSearchParams(location.search).has('demo');
try { DEMO ||= sessionStorage.getItem('miril.demo') === '1'; } catch {}

const S = {
  set: null,              // { folder, sync } — cihaz ayarları
  books: [], sync: null,
  profile: null,
  book: null, idx: 0,
  filter: 'all',
  sleepEnd: 0, sleepChapter: false,
  pendingSeek: null, lastLocalSave: 0, lastRemotePush: 0,
  syncOk: null, syncAt: 0,
  dl: new Set(), jobs: {}, dlSheetFor: null,
};

/* ---------- küçük yardımcılar ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const lsKey = (k) => (DEMO ? 'miril.demo.' : 'miril.') + k;
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} sa ${m} dk`;
  if (h) return `${h} sa`;
  return `${Math.max(1, m)} dk`;
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
const natural = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

let toastTimer;
function toast(msg, action, fn, ms = 3200) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('on'); fn(); };
  t.classList.add('on');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
  window.scrollTo(0, 0);
  if (typeof renderMini === 'function') renderMini();
}

/* =========================================================
   Ayarlar (klasör linki + senkron adresi)
   ========================================================= */
function folderIdFrom(link) {
  link = String(link || '').trim();
  const m = link.match(/folders\/([A-Za-z0-9_-]{10,})/) || link.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(link) ? link : null;
}
const isSyncUrl = (u) => /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(String(u || '').trim()) || (CFG.ALLOW_ANY_SYNC && /^https?:\/\//.test(u || ''));
const ready = () => !!(S.set?.folder && S.set?.sync && HAS_KEY);

function loadSettings() {
  S.set = LS.get('miril.set') || { folder: '', sync: '' };
  // Kurulum linkiyle açıldıysa (#kurulum=...) ayarları al ve adresi temizle.
  const m = location.hash.match(/kurulum=([^&]+)/);
  if (m) {
    try {
      const d = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      if (d.f) S.set.folder = d.f;
      if (d.s) S.set.sync = d.s;
      LS.set('miril.set', S.set);
      S.fromSetupLink = true;
    } catch (e) { console.warn('kurulum linki okunamadı', e); }
    history.replaceState(null, '', location.pathname + location.search);
  }
}
function setupLink() {
  const code = btoa(unescape(encodeURIComponent(JSON.stringify({ f: S.set.folder, s: S.set.sync }))));
  return `${location.origin}${location.pathname}#kurulum=${encodeURIComponent(code)}`;
}

class DriveError extends Error {}
async function api(path) {
  const url = DRIVE + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(CFG.API_KEY);
  let r;
  try { r = await fetch(url); } catch { throw new DriveError('Bağlantı yok'); }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error?.message || ''; } catch {}
    if (r.status === 404) throw new DriveError('Klasör bulunamadı. Link doğru mu, "bağlantıya sahip herkes" ile paylaşıldı mı?');
    if (r.status === 403) throw new DriveError('Drive erişimi reddetti: ' + (msg || 'API anahtarını kontrol et'));
    throw new DriveError(`Drive hatası ${r.status}: ${msg}`);
  }
  return r.json();
}

/* =========================================================
   Kütüphane taraması (Drive)
   ========================================================= */
async function listChildren(id) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const r = await api(`files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}
const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';
const isAudio = (f) => AUDIO_RE.test(f.name) || (f.mimeType || '').startsWith('audio/');
const isImage = (f) => IMG_RE.test(f.name);

async function collect(id, prefix, depth) {
  const kids = await listChildren(id);
  const audio = [], images = [];
  const subs = [];
  for (const k of kids) {
    if (isFolder(k)) { if (depth < 3) subs.push(collect(k.id, prefix + k.name + '/', depth + 1)); }
    else if (isAudio(k)) audio.push({ id: k.id, name: k.name, path: prefix + k.name, size: +k.size || 0 });
    else if (isImage(k)) images.push(k);
  }
  for (const s of await Promise.all(subs)) { audio.push(...s.audio); images.push(...s.images); }
  return { audio, images };
}

function parseName(name) {
  const base = name.replace(AUDIO_RE, '').trim();
  const i = base.indexOf(' - ');
  return i > 0 ? { author: base.slice(0, i).trim(), title: base.slice(i + 3).trim() } : { author: '', title: base };
}
function pickCover(images) {
  return (images.find((i) => /^(cover|folder|kapak|front)/i.test(i.name)) || images[0])?.id || null;
}

async function scanLibrary() {
  const rootId = folderIdFrom(S.set.folder);
  if (!rootId) throw new DriveError('Klasör linki geçersiz');
  // Klasörün kendisi erişilebilir mi? (link yanlışsa 404 burada çıkar)
  await api(`files/${rootId}?fields=id,name`);
  const kids = await listChildren(rootId);
  const books = [];
  await Promise.all(kids.map(async (k) => {
    if (isFolder(k)) {
      const { audio, images } = await collect(k.id, '', 1);
      if (!audio.length) return;
      audio.sort((a, b) => natural.compare(a.path, b.path));
      books.push({ id: k.id, ...parseName(k.name), files: audio, cover: pickCover(images) });
    } else if (isAudio(k)) {
      books.push({ id: k.id, ...parseName(k.name), files: [{ id: k.id, name: k.name, path: k.name, size: +k.size || 0 }], cover: null });
    }
  }));
  books.sort((a, b) => natural.compare(a.title, b.title));
  return { missing: false, books };
}

/* =========================================================
   Demo modu (Drive'sız deneme)
   ========================================================= */
const DEMO_BOOKS = [
  ['Ömer Seyfettin', 'Kaşağı', 3], ['Jules Verne', 'Seksen Günde Devr-i Âlem', 8],
  ['Lewis Carroll', 'Alice Harikalar Diyarında', 6], ['Halit Ziya Uşaklıgil', 'Mai ve Siyah', 5],
  ['Reşat Nuri Güntekin', 'Çalıkuşu', 9], ['Sait Faik Abasıyanık', 'Semaver', 2],
];
function demoLibrary() {
  return DEMO_BOOKS.map(([author, title, n], bi) => ({
    id: 'demo' + bi, author, title, cover: null,
    files: Array.from({ length: n }, (_, i) => ({ id: `demo${bi}_${i}`, name: `${String(i + 1).padStart(2, '0')} - Bölüm ${i + 1}.mp3`, path: '', size: 44 + 16000 * (60 + ((bi * 7 + i * 13) % 50)), demo: { sec: 60 + ((bi * 7 + i * 13) % 50), freq: 196 + bi * 30 + i * 12 } })),
  }));
}
const demoUrls = {};
function wavUrl(sec, freq) {
  const sr = 8000, n = sr * sec, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = 0.35 + 0.35 * Math.sin(2 * Math.PI * t / 5);
    v.setInt16(44 + i * 2, (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 1.5 * t)) * env * 1800, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const mediaUrl = (id) => `${DRIVE}files/${id}?alt=media&key=${encodeURIComponent(CFG.API_KEY)}`;
const netSrc = (f) => f.demo ? (demoUrls[f.id] ||= wavUrl(f.demo.sec, f.demo.freq)) : mediaUrl(f.id);
const swOn = () => !!navigator.serviceWorker?.controller;
const fileSrc = (f) => (S.dl.has(f.id) && swOn()) ? 'offline/' + f.id : netSrc(f);
const coverSrc = (b) => b.cover ? ((S.dl.has(b.cover) && swOn()) ? 'offline/' + b.cover : mediaUrl(b.cover)) : null;

/* =========================================================
   İndirmeler (uygulama içi depolama — internetsiz dinleme)
   ========================================================= */
const DL_CACHE = 'miril-audio-v1';
const offKey = (id) => new URL('offline/' + id, location.href).href;
function fmtBytes(n) {
  if (!n) return '0 MB';
  return n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
}
async function dlInit() {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open(DL_CACHE);
    const keys = await c.keys();
    S.dl = new Set(keys.map((r) => r.url.split('/').pop()));
  } catch (e) { console.warn('dl init', e); }
}
function dlState(b) {
  const have = b.files.filter((f) => S.dl.has(f.id));
  return {
    n: have.length, all: have.length === b.files.length, any: have.length > 0,
    bytes: have.reduce((a, f) => a + (f.size || 0), 0),
    total: b.files.reduce((a, f) => a + (f.size || 0), 0),
    job: S.jobs[b.id] || null,
  };
}
let dlTick = 0;
function renderDl(force) {
  if (!force && now() - dlTick < 250) return;
  dlTick = now();
  if (S.book) renderDlChip();
  if (S.profile && $('#v-library').classList.contains('on')) {
    if (force) renderLibrary();
    else for (const [bid, j] of Object.entries(S.jobs)) {
      const el = document.querySelector(`.book[data-id="${bid}"] .dl-badge`);
      if (el) el.textContent = Math.min(100, Math.round(j.done / j.total * 100)) + '%';
      else if (document.querySelector(`.book[data-id="${bid}"]`)) { renderLibrary(); break; }
    }
  }
  if (S.dlSheetFor) dlSheet(S.dlSheetFor, true);
}

async function downloadBook(b) {
  if (S.jobs[b.id]) return;
  if (!('caches' in window)) return toast('Bu tarayıcı indirmeyi desteklemiyor');
  if (!DEMO && !navigator.onLine) return toast('İnternet yok');
  try { await navigator.storage?.persist?.(); } catch {}
  const todo = b.files.filter((f) => !S.dl.has(f.id));
  const items = [...(b.cover && !S.dl.has(b.cover) && !DEMO ? [{ id: b.cover, cover: true }] : []), ...todo];
  const job = S.jobs[b.id] = { done: 0, total: todo.reduce((a, f) => a + (f.size || 0), 0) || 1, ctrl: new AbortController() };
  renderDl(true);
  let ok = true;
  try {
    const c = await caches.open(DL_CACHE);
    for (const f of items) {
      const r = await fetch(f.cover ? mediaUrl(f.id) : netSrc(f), { signal: job.ctrl.signal });
      if (!r.ok) throw new Error('Drive ' + r.status);
      const counter = new TransformStream({
        transform(chunk, ctl) { if (!f.cover) { job.done += chunk.byteLength; renderDl(); } ctl.enqueue(chunk); },
      });
      const type = r.headers.get('Content-Type') || (f.cover ? 'image/jpeg' : 'audio/mpeg');
      await c.put(offKey(f.id), new Response(r.body.pipeThrough(counter), { headers: { 'Content-Type': type } }));
      S.dl.add(f.id);
    }
  } catch (e) {
    ok = false;
    if (e.name === 'AbortError') toast('İndirme durduruldu');
    else if (e.name === 'QuotaExceededError') toast('Cihazda yer kalmadı');
    else toast('İndirme yarıda kaldı: ' + (e.message || e.name), 'Devam et', () => downloadBook(b), 8000);
    console.warn('download', e);
  }
  delete S.jobs[b.id];
  if (ok) toast(`"${b.title}" indirildi, internetsiz dinleyebilirsin`);
  renderDl(true);
}

async function deleteDownload(b) {
  S.jobs[b.id]?.ctrl.abort();
  const c = await caches.open(DL_CACHE);
  const ids = [...b.files.map((f) => f.id), ...(b.cover ? [b.cover] : [])];
  await Promise.all(ids.map((id) => c.delete(offKey(id))));
  ids.forEach((id) => S.dl.delete(id));
  // Şu an bu kitap cihazdan çalıyorsa internete geçir
  if (S.book?.id === b.id && audio.src.includes('/offline/')) reloadCurrent(!audio.paused);
  toast(`"${b.title}" bu cihazdan silindi`);
  renderDl(true);
}

// İndirilmiş dosyaları cihazın İndirilenler klasörüne de kopyala.
async function exportBook(b) {
  const c = await caches.open(DL_CACHE);
  const files = b.files.filter((f) => S.dl.has(f.id));
  // Türkçe harfler bazı tarayıcılarda dosya adını bozuyor → ASCII'ye çevir.
  const TR = { 'ı': 'i', 'İ': 'I', 'ğ': 'g', 'Ğ': 'G', 'ü': 'u', 'Ü': 'U', 'ş': 's', 'Ş': 'S', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C' };
  const safe = (x) => x.replace(/[ıİğĞüÜşŞöÖçÇ]/g, (c) => TR[c]).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  toast(`${files.length} dosya kaydediliyor…`);
  for (const f of files) {
    const hit = await c.match(offKey(f.id));
    if (!hit) continue;
    const url = URL.createObjectURL(await hit.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: safe(`Miril - ${b.title} - ${f.name}`) });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    await new Promise((r) => setTimeout(r, 700));
  }
}

function dlSheet(b, refresh) {
  S.dlSheetFor = b;
  const d = dlState(b);
  let body;
  if (d.job) {
    const pct = Math.min(100, Math.round(d.job.done / d.job.total * 100));
    body = `<p class="sheet-note">İndiriliyor… ${fmtBytes(d.job.done)} / ${fmtBytes(d.job.total)}</p>
      <div class="bar dl-bar"><i style="width:${pct}%"></i></div>
      <p class="sheet-note">Uygulama açık kalmalı. Ekranı kilitleyebilirsin ama uygulamayı kapatma.</p>
      <div class="opt-list"><button class="opt" data-act="stop">Durdur</button></div>`;
  } else if (!d.any) {
    body = `<p class="sheet-note">Kitap bu cihaza iner, internetsiz dinlersin. Uygulamanın içinde durur, buradan silebilirsin.</p>
      <div class="row-btns"><button class="big-btn" data-act="dl">İndir${d.total ? ' · ' + fmtBytes(d.total) : ''}</button></div>`;
  } else {
    body = `<p class="sheet-note">${d.all ? '✓ Tamamı bu cihazda' : `${d.n} / ${b.files.length} bölüm bu cihazda`} · ${fmtBytes(d.bytes)}</p>
      <div class="opt-list">
        ${!d.all ? '<button class="opt" data-act="dl">Kalan bölümleri indir</button>' : ''}
        <button class="opt" data-act="export">Cihaza da kaydet <small>(İndirilenler klasörü)</small></button>
        <button class="opt danger-opt" data-act="del">Bu cihazdan sil</button>
      </div>
      <p class="sheet-note small">"Cihaza da kaydet" dosyaları telefonun/PC'nin İndirilenler klasörüne kopyalar. O kopyalar uygulamadan bağımsızdır; uygulama onları göremez ve silemez.</p>`;
  }
  const html = `<h3>${esc(b.title)}</h3>${body}`;
  if (refresh) { if ($('#sheet').classList.contains('on')) $('#sheet-body').innerHTML = html; else { S.dlSheetFor = null; return; } }
  else openSheet(html);
  document.querySelectorAll('#sheet-body [data-act]').forEach((el) => el.onclick = () => {
    const a = el.dataset.act;
    if (a === 'dl') downloadBook(b);
    if (a === 'stop') S.jobs[b.id]?.ctrl.abort();
    if (a === 'export') { closeSheet(); exportBook(b); }
    if (a === 'del') { if (confirm(`"${b.title}" bu cihazdan silinsin mi? (Drive'daki asıl dosyalar silinmez)`)) { closeSheet(); deleteDownload(b); } }
  });
}

function renderDlChip() {
  const chip = $('#btn-dl');
  if (!chip || !S.book) return;
  const d = dlState(S.book);
  chip.classList.toggle('on', d.all && !d.job);
  $('#dl-label').textContent = d.job ? `%${Math.min(100, Math.round(d.job.done / d.job.total * 100))}` : d.all ? 'İndirildi' : d.any ? `${d.n}/${S.book.files.length}` : 'İndir';
}

/* =========================================================
   Eşitleme verisi (profiller + ilerleme)
   ========================================================= */
const emptySync = () => ({ v: 1, profiles: {}, progress: {}, durations: {}, prefs: {} });
function newer(a, b) { return !a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a; }
function merge(a, b) {
  const out = emptySync();
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [id, p] of Object.entries(src.profiles || {})) out.profiles[id] = newer(out.profiles[id], p);
    for (const [pid, books] of Object.entries(src.progress || {})) {
      out.progress[pid] ||= {};
      for (const [bid, pr] of Object.entries(books)) out.progress[pid][bid] = newer(out.progress[pid][bid], pr);
    }
    Object.assign(out.durations, src.durations || {});
    for (const [pid, pf] of Object.entries(src.prefs || {})) out.prefs[pid] = newer(out.prefs[pid], pf);
  }
  return out;
}
const syncStr = (s) => JSON.stringify(s);

function saveLocal() { LS.set(lsKey('sync'), S.sync); S.lastLocalSave = now(); }

// Apps Script web uygulaması: GET → kayıtlı veri, POST → gönderileni birleştir + sonucu döndür.
async function syncCall(body) {
  const url = S.set.sync.trim();
  const opts = body ? { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } } : {};
  const r = await fetch(body ? url : url + (url.includes('?') ? '&' : '?') + '_=' + now(), opts);
  if (!r.ok) throw new Error('Senkron hatası ' + r.status);
  let d;
  try { d = await r.json(); } catch { throw new Error('Senkron adresi JSON döndürmedi (dağıtım ayarı "Herkes" mi?)'); }
  if (d.error) throw new Error(d.error);
  return d.data || {};
}

async function pullRemote() {
  if (DEMO || !ready()) return;
  try {
    const remote = await syncCall();
    S.sync = merge(S.sync, remote);
    saveLocal();
    S.syncOk = true; S.syncAt = now();
  } catch (e) { S.syncOk = false; throw e; }
}

let pushing = null, pushQueued = false;
async function pushRemote() {
  if (DEMO || !ready()) return;
  if (pushing) { pushQueued = true; return pushing; }
  pushing = (async () => {
    try {
      const merged = await syncCall(syncStr(S.sync));
      S.sync = merge(S.sync, merged);
      saveLocal();
      S.lastRemotePush = now(); S.syncOk = true; S.syncAt = now();
    } catch (e) { S.syncOk = false; console.warn('push', e); }
    pushing = null;
    if (pushQueued) { pushQueued = false; pushRemote(); }
  })();
  return pushing;
}
let pushTimer;
const pushSoon = (ms = 1500) => { clearTimeout(pushTimer); pushTimer = setTimeout(pushRemote, ms); };

// Sayfa/uygulama kapanırken son konumu yetiştir.
function pushOnExit() {
  if (DEMO || !ready()) return;
  try { navigator.sendBeacon(S.set.sync.trim(), new Blob([syncStr(S.sync)], { type: 'text/plain;charset=utf-8' })); } catch {}
}

/* ---- profil ve ilerleme erişimi ---- */
const profiles = () => Object.values(S.sync.profiles).filter((p) => !p.deleted).sort((a, b) => (a.created || 0) - (b.created || 0));
const prog = (bid, pid = S.profile?.id) => S.sync.progress[pid]?.[bid] || null;
const prefs = () => S.sync.prefs[S.profile.id] || {};
function setPrefs(patch) { S.sync.prefs[S.profile.id] = { ...prefs(), ...patch, at: now() }; saveLocal(); pushSoon(); }
function setProg(bid, data) {
  S.sync.progress[S.profile.id] ||= {};
  S.sync.progress[S.profile.id][bid] = { ...data, at: now() };
}

function bookStats(b) {
  const p = prog(b.id);
  const durs = b.files.map((f) => S.sync.durations[f.id] || 0);
  const known = durs.every((d) => d > 0);
  const total = known ? durs.reduce((a, c) => a + c, 0) : null;
  let idx = p ? b.files.findIndex((f) => f.id === p.fileId) : 0;
  if (idx < 0) idx = 0;
  const t = p?.t || 0;
  if (p?.done) return { pct: 1, done: true, started: true, idx: 0, t: 0, total, left: 0 };
  let pct, left = null;
  if (known && total) {
    const before = durs.slice(0, idx).reduce((a, c) => a + c, 0);
    pct = (before + t) / total; left = total - before - t;
  } else {
    pct = (idx + (durs[idx] ? t / durs[idx] : 0)) / b.files.length;
  }
  return { pct: Math.min(1, pct), done: false, started: !!p && (t > 0 || idx > 0), idx, t, total, left, at: p?.at || 0 };
}

/* =========================================================
   Görünümler
   ========================================================= */
function coverHTML(b, size = 'md') {
  const src = coverSrc(b);
  const img = src ? `<img src="${src}" alt="" loading="lazy" style="position:absolute;inset:0" onerror="this.remove()">` : '';
  const [c1, c2] = COVER_PAIRS[hash(b.title + b.author) % COVER_PAIRS.length];
  const hsh = hash(b.title);
  const dots = [0, 1, 2].map((i) => {
    const s = 30 + ((hsh >> (i * 3)) % 40);
    return `<i class="g-dot" style="width:${s}%;height:${s}%;right:${-10 + ((hsh >> (i * 4)) % 50)}%;bottom:${-12 + ((hsh >> (i * 5)) % 40)}%;background:${i % 2 ? '#fff' : c2}"></i>`;
  }).join('');
  return `<div class="cover ${size}" style="background:linear-gradient(150deg,${c1},${c2})"><div class="gen">${dots}<div class="g-title" style="position:relative">${esc(b.title)}</div><div class="g-author" style="position:relative">${esc(b.author)}</div></div>${img}</div>`;
}
function badgeHTML(st) {
  if (st.done) return '<span class="badge done">Bitti ✓</span>';
  return '';
}
const DL_ICON = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
function dlBadgeHTML(b) {
  const d = dlState(b);
  if (d.job) return `<span class="dl-badge busy">${Math.min(100, Math.round(d.job.done / d.job.total * 100))}%</span>`;
  if (d.all) return `<span class="dl-badge" title="İndirildi">${DL_ICON}</span>`;
  return '';
}

function renderProfiles(editing = false) {
  const grid = $('#profile-grid');
  grid.classList.toggle('editing', editing);
  grid.innerHTML = profiles().map((p) => `
    <button class="prof" data-id="${p.id}">
      <span class="avatar" style="background:${p.color}">${p.avatar}</span><b>${esc(p.name)}</b>
    </button>`).join('') + `
    <button class="prof adder" data-add="1">
      <span class="avatar add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><b>Ekle</b>
    </button>`;
  grid.querySelectorAll('.prof').forEach((el) => el.onclick = () => {
    if (el.dataset.add) return editProfile(null);
    const p = S.sync.profiles[el.dataset.id];
    editing ? editProfile(p) : choose(p);
  });
  const btn = $('#btn-edit-profiles');
  btn.classList.toggle('hidden', !profiles().length);
  btn.textContent = editing ? 'Tamam' : 'Profilleri düzenle';
  btn.onclick = () => renderProfiles(!editing);
}

function choose(p) {
  if (S.profile?.id !== p.id && S.book) { audio.pause(); closePlayer(); S.book = null; $('#mini').classList.add('hidden'); }
  S.profile = p;
  LS.set(lsKey('profile'), p.id);
  renderLibrary();
  show('library');
}

function editProfile(p) {
  const isNew = !p;
  const d = p ? { ...p } : { id: uid(), name: '', avatar: AVATARS[profiles().length % AVATARS.length], color: COLORS[profiles().length % COLORS.length], created: now() };
  const draw = () => {
    openSheet(`
      <h3>${isNew ? 'Yeni profil' : 'Profili düzenle'}</h3>
      <div class="avatar preview-av" style="background:${d.color}">${d.avatar}</div>
      <label class="field"><span>İsim</span><input id="pf-name" maxlength="20" value="${esc(d.name)}" placeholder="Örn. Burak"></label>
      <div class="field"><span>Hayvan</span><div class="av-grid">${AVATARS.map((a) => `<button data-a="${a}" class="${a === d.avatar ? 'on' : ''}">${a}</button>`).join('')}</div></div>
      <div class="field"><span>Renk</span><div class="col-grid">${COLORS.map((c) => `<button data-c="${c}" class="${c === d.color ? 'on' : ''}" style="background:${c}" aria-label="renk"></button>`).join('')}</div></div>
      <div class="row-btns"><button class="big-btn" id="pf-save">${isNew ? 'Oluştur' : 'Kaydet'}</button></div>
      ${!isNew ? '<button class="danger" id="pf-del">Profili sil</button>' : ''}`);
    const nameIn = $('#pf-name');
    nameIn.oninput = () => (d.name = nameIn.value);
    document.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => { d.avatar = b.dataset.a; d.name = nameIn.value; draw(); });
    document.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { d.color = b.dataset.c; d.name = nameIn.value; draw(); });
    $('#pf-save').onclick = () => {
      d.name = nameIn.value.trim();
      if (!d.name) { nameIn.focus(); return; }
      S.sync.profiles[d.id] = { ...d, at: now() };
      saveLocal(); pushSoon(300); closeSheet();
      if (isNew && profiles().length === 1) choose(S.sync.profiles[d.id]);
      else renderProfiles(!isNew);
    };
    if (!isNew) $('#pf-del').onclick = () => {
      if (!confirm(`"${d.name}" profili ve dinleme geçmişi silinsin mi?`)) return;
      S.sync.profiles[d.id] = { id: d.id, deleted: true, at: now() };
      delete S.sync.progress[d.id];
      saveLocal(); pushSoon(300); closeSheet();
      if (S.profile?.id === d.id) S.profile = null;
      renderProfiles(true);
    };
  };
  draw();
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
}

function renderLibrary() {
  const p = S.profile;
  $('#btn-me').textContent = p.avatar;
  $('#btn-me').style.background = p.color;
  $('#hello').innerHTML = `${greeting()}, <em>${esc(p.name)}</em>.<br>Ne dinliyoruz?`;

  const stats = new Map(S.books.map((b) => [b.id, bookStats(b)]));

  // Devam et kartı: en son dinlenen, bitmemiş kitap
  const last = S.books.filter((b) => stats.get(b.id).started && !stats.get(b.id).done).sort((a, b) => stats.get(b.id).at - stats.get(a.id).at)[0];
  const cont = $('#continue');
  if (last) {
    const st = stats.get(last.id);
    const sub = st.left != null ? `${fmtLong(st.left)} kaldı` : `Bölüm ${st.idx + 1} / ${last.files.length}`;
    cont.innerHTML = `<div class="continue" id="cont-card">${coverHTML(last, 'sm')}
      <div class="continue-text"><small>Kaldığın yerden</small><h3>${esc(last.title)}</h3><p class="meta-line">${esc(last.author || '')}${last.author ? ' · ' : ''}${sub}</p>
      <div class="bar"><i style="width:${(st.pct * 100).toFixed(1)}%"></i></div></div>
      <button class="resume" aria-label="Devam et"><svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg></button></div>`;
    $('#cont-card').onclick = () => openBook(last, true);
  } else cont.innerHTML = '';

  // Filtreler
  const fl = [['all', 'Tümü'], ['going', 'Devam eden'], ['new', 'Yeni'], ['done', 'Biten'], ['dl', 'İndirilenler']];
  $('#filters').innerHTML = fl.map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${l}</button>`).join('');
  $('#filters').querySelectorAll('button').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; renderLibrary(); });

  const list = S.books.filter((b) => {
    const st = stats.get(b.id);
    return S.filter === 'all' || (S.filter === 'going' && st.started && !st.done) || (S.filter === 'new' && !st.started) || (S.filter === 'done' && st.done) || (S.filter === 'dl' && (dlState(b).any || !!S.jobs[b.id]));
  });
  $('#grid').innerHTML = list.map((b) => {
    const st = stats.get(b.id);
    return `<div class="book" data-id="${b.id}" tabindex="0">
      <div style="position:relative">${coverHTML(b, 'md')}${badgeHTML(st)}${dlBadgeHTML(b)}</div>
      <h4>${esc(b.title)}</h4><p>${esc(b.author || (b.files.length > 1 ? b.files.length + ' bölüm' : ''))}</p>
      ${st.started && !st.done ? `<div class="bar"><i style="width:${(st.pct * 100).toFixed(1)}%"></i></div>` : ''}
    </div>`;
  }).join('');
  // rozet kapağın içinde dursun
  $('#grid').querySelectorAll('.book').forEach((el) => {
    el.querySelectorAll('.badge, .dl-badge').forEach((x) => el.querySelector('.cover').appendChild(x));
    el.onclick = () => openBook(S.books.find((b) => b.id === el.dataset.id), true);
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
  });

  const empty = $('#empty');
  if (!S.books.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = S.libError
      ? `<div class="big">📂</div><p>${esc(S.libError)}</p><p><button class="big-btn alt" onclick="settingsSheet()">Ayarlara git</button></p>`
      : `<div class="big">🎧</div><p>Kitap klasörün boş görünüyor.<br>Her kitap için bir alt klasör aç, ses dosyalarını içine at, sonra yenile.</p>`;
  } else if (!list.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = S.filter === 'dl'
      ? `<div class="big">📥</div><p>Henüz indirilen kitap yok.<br>Bir kitabı açıp <b>İndir</b>'e dokun.</p>`
      : `<div class="big">🌙</div><p>Bu rafta kitap yok.</p>`;
  } else empty.classList.add('hidden');
}

function showSkeleton() {
  $('#grid').innerHTML = Array.from({ length: 6 }, () => '<div><div class="skel"></div></div>').join('');
}

async function refreshLibrary(manual) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    if (DEMO) S.books = demoLibrary();
    else {
      const r = await scanLibrary();
      S.books = r.books;
      LS.set('miril.lib', S.books);
    }
    S.libError = null;
    if (S.profile) renderLibrary();
    if (manual) toast(`${S.books.length} kitap bulundu`);
  } catch (e) {
    console.error(e);
    if (!navigator.onLine) {
      if (S.dl.size && S.filter === 'all') { S.filter = 'dl'; if (S.profile) renderLibrary(); }
      if (manual || S.dl.size) toast('Çevrimdışısın: indirilen kitaplar çalışır');
    } else if (e instanceof DriveError && !S.books.length) { S.libError = e.message; if (S.profile) renderLibrary(); }
    else toast(e instanceof DriveError ? e.message : 'Kütüphane yüklenemedi');
  }
  btn.classList.remove('spin');
}

/* =========================================================
   Oynatıcı
   ========================================================= */
const audio = new Audio();
// Ses seviyesi bu cihaza özel (telefon/PC farklı olabilir).
let VOL = Math.min(1, Math.max(0, +(LS.get('miril.vol', 1)) || 0));
let VOL_BEFORE_MUTE = VOL || 1;
audio.volume = VOL;
function setVol(v, save = true) {
  VOL = Math.min(1, Math.max(0, v));
  if (VOL > 0) VOL_BEFORE_MUTE = VOL;
  if (!S.sleepEnd || S.sleepEnd - now() > 10000) audio.volume = VOL;
  if (save) LS.set('miril.vol', VOL);
  renderVol();
}
function renderVol() {
  const el = $('#p-vol');
  if (!el) return;
  el.value = Math.round(VOL * 100);
  el.style.setProperty('--p', VOL * 100 + '%');
  $('#btn-mute').innerHTML = VOL === 0
    ? '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>'
    : VOL < 0.5
      ? '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5M18.5 6.5a8.5 8.5 0 0 1 0 11"/></svg>';
  $('#btn-mute').setAttribute('aria-label', VOL === 0 ? 'Sesi aç' : 'Sesi kapat');
}
audio.preload = 'auto';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="5.5" y="4" width="4.5" height="16" rx="1.5"/><rect x="14" y="4" width="4.5" height="16" rx="1.5"/></svg>';

function openBook(b, autoplay) {
  if (S.book?.id === b.id) { openPlayer(); if (autoplay && audio.paused) togglePlay(); return; }
  S.book = b;
  const st = bookStats(b);
  const p = prog(b.id);
  const startIdx = st.done ? 0 : st.idx;
  const startT = st.done ? 0 : Math.max(0, (p?.t || 0) - 3); // 3 sn geriden başla, cümleyi yakala
  setPrefs({ lastBook: b.id });
  renderPlayerStatic();
  loadFile(startIdx, startT, autoplay);
  openPlayer();
  probeDurations(b);
}

function loadFile(idx, t, play) {
  const f = S.book.files[idx];
  S.idx = idx;
  S.pendingSeek = t || 0;
  $('#btn-play').classList.add('loading');
  audio.src = fileSrc(f);
  audio.playbackRate = prefs().speed || 1;
  renderChapter();
  updateMediaSession();
  if (play) safePlay();
}

function reloadCurrent(play) {
  const t = audio.currentTime;
  loadFile(S.idx, t, play);
}

async function safePlay() {
  try { await audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
}
function togglePlay() { audio.paused ? safePlay() : audio.pause(); }

function recordPosition(force) {
  if (!S.book || !S.profile) return;
  const f = S.book.files[S.idx];
  if (!f) return;
  if (!force && now() - S.lastLocalSave < 3000) return;
  setProg(S.book.id, { fileId: f.id, t: Math.floor(audio.currentTime || S.pendingSeek || 0) });
  saveLocal();
  if (force || now() - S.lastRemotePush > 60000) pushSoon(force ? 300 : 0);
}

audio.addEventListener('loadedmetadata', () => {
  if (S.pendingSeek != null) { try { audio.currentTime = Math.min(S.pendingSeek, audio.duration - 1); } catch {} S.pendingSeek = null; }
  audio.playbackRate = prefs().speed || 1;
  const f = S.book?.files[S.idx];
  if (f && isFinite(audio.duration) && audio.duration > 0) {
    const d = Math.round(audio.duration);
    if (S.sync.durations[f.id] !== d) { S.sync.durations[f.id] = d; saveLocal(); }
  }
  renderTime();
});
audio.addEventListener('canplay', () => $('#btn-play').classList.remove('loading'));
audio.addEventListener('waiting', () => $('#btn-play').classList.add('loading'));
audio.addEventListener('playing', () => $('#btn-play').classList.remove('loading'));
audio.addEventListener('play', () => { audio.playbackRate = prefs().speed || 1; renderPlayState(); });
audio.addEventListener('pause', () => { renderPlayState(); recordPosition(true); });
audio.addEventListener('timeupdate', () => { renderTime(); recordPosition(false); checkSleep(); });
audio.addEventListener('ended', () => {
  if (S.sleepChapter) { clearSleep(); recordPosition(true); toast('Bölüm bitti, iyi uykular 🌙'); return; }
  if (S.idx < S.book.files.length - 1) loadFile(S.idx + 1, 0, true);
  else {
    setProg(S.book.id, { fileId: S.book.files[0].id, t: 0, done: true });
    saveLocal(); pushSoon(300);
    renderPlayState();
    toast(`"${S.book.title}" bitti 🎉`);
  }
});
audio.addEventListener('error', () => {
  $('#btn-play').classList.remove('loading');
  if (!audio.src) return;
  const f = S.book?.files[S.idx];
  if (!navigator.onLine && f && !S.dl.has(f.id)) toast('İnternet yok ve bu bölüm indirilmemiş', null, null, 5000);
  else toast('Dosya çalınamadı', 'Tekrar dene', () => reloadCurrent(true), 6000);
});

function seekBy(d) {
  const dur = audio.duration || 0;
  let t = (audio.currentTime || 0) + d;
  if (t < 0 && S.idx > 0 && d < 0) { // önceki bölüme taş
    const prevDur = S.sync.durations[S.book.files[S.idx - 1].id];
    if (prevDur) return loadFile(S.idx - 1, Math.max(0, prevDur + t), !audio.paused);
  }
  if (dur && t >= dur - 0.5 && S.idx < S.book.files.length - 1) return loadFile(S.idx + 1, Math.max(0, t - dur), !audio.paused);
  audio.currentTime = Math.max(0, Math.min(t, dur ? dur - 0.5 : t));
  recordPosition(true);
}
function goChapter(i, play = !audio.paused) {
  if (i < 0 || i >= S.book.files.length) return;
  loadFile(i, 0, play);
  recordPosition(true);
}

/* ---- oynatıcı arayüzü ---- */
function openPlayer() {
  $('#player').classList.add('open');
  $('#player').setAttribute('aria-hidden', 'false');
  renderMini();
}
function closePlayer() {
  $('#player').classList.remove('open');
  if (S.profile && $('#v-library').classList.contains('on')) renderLibrary();
  $('#player').setAttribute('aria-hidden', 'true');
  renderMini();
}
function renderPlayerStatic() {
  const b = S.book;
  $('#p-cover').innerHTML = coverHTML(b, 'lg');
  $('#p-title').textContent = b.title;
  $('#p-author').textContent = b.author;
  const [c1] = COVER_PAIRS[hash(b.title + b.author) % COVER_PAIRS.length];
  $('#player').style.setProperty('--tint', `radial-gradient(circle at 50% 20%, ${c1}, transparent 60%)`);
  $('#btn-speed').textContent = fmtSpeed(prefs().speed || 1);
  renderDlChip();
}
const fmtSpeed = (s) => String(s).replace('.', ',') + '×';
function chapterName(f, i) {
  const n = f.name.replace(AUDIO_RE, '');
  return /^\d+$/.test(n.trim()) ? `Bölüm ${i + 1}` : n;
}
function renderChapter() {
  const b = S.book;
  $('#p-chapter').textContent = b.files.length > 1 ? `${S.idx + 1} / ${b.files.length} · ${chapterName(b.files[S.idx], S.idx)}` : '';
  $('#btn-prev').style.visibility = $('#btn-next').style.visibility = b.files.length > 1 ? 'visible' : 'hidden';
  renderMini();
}
function renderPlayState() {
  const playing = !audio.paused;
  $('#btn-play').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('#btn-play').setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
  $('#mini-play').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('#player').classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
let seeking = false;
function renderTime() {
  if (!S.book) return;
  const cur = audio.currentTime || 0, dur = audio.duration || S.sync.durations[S.book.files[S.idx]?.id] || 0;
  const pct = dur ? cur / dur : 0;
  if (!seeking) { $('#p-seek').value = Math.round(pct * 1000); $('#p-seek').style.setProperty('--p', (pct * 100) + '%'); }
  $('#p-cur').textContent = fmt(cur);
  $('#p-left').textContent = '-' + fmt(Math.max(0, dur - cur));
  $('#mini-bar').style.width = (pct * 100) + '%';
  const st = bookStats(S.book);
  const rate = prefs().speed || 1;
  $('#p-book').textContent = st.done ? 'Bu kitabı bitirdin ✓'
    : st.left != null ? `Kitap: %${Math.round(st.pct * 100)} · ${fmtLong(st.left / rate)} kaldı${rate !== 1 ? ' (bu hızla)' : ''}`
    : S.book.files.length > 1 ? `Kitap: ~%${Math.round(st.pct * 100)}` : '';
  if ('mediaSession' in navigator && dur && isFinite(dur)) {
    try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(cur, dur), playbackRate: audio.playbackRate || 1 }); } catch {}
  }
}
function renderMini() {
  const mini = $('#mini');
  const visible = !!S.book && !$('#player').classList.contains('open') && $('#v-library').classList.contains('on');
  mini.classList.toggle('hidden', !visible);
  if (!S.book) return;
  $('#mini-cover').innerHTML = coverHTML(S.book, 'xs');
  $('#mini-title').textContent = S.book.title;
  $('#mini-sub').textContent = S.book.files.length > 1 ? `Bölüm ${S.idx + 1} / ${S.book.files.length}` : S.book.author;
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !S.book) return;
  const src = coverSrc(S.book);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: S.book.files.length > 1 ? chapterName(S.book.files[S.idx], S.idx) : S.book.title,
    artist: S.book.author, album: S.book.title,
    artwork: src ? [{ src: new URL(src, location.href).href, sizes: '512x512' }] : [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
  });
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => safePlay());
  set('pause', () => audio.pause());
  set('seekbackward', (d) => seekBy(-(d.seekOffset || 15)));
  set('seekforward', (d) => seekBy(d.seekOffset || 30));
  set('previoustrack', () => goChapter(S.idx - 1));
  set('nexttrack', () => goChapter(S.idx + 1));
  set('seekto', (d) => { audio.currentTime = d.seekTime; recordPosition(true); });
}

/* ---- süreleri arka planda öğren (toplam kalan süre için) ---- */
let probing = false;
async function probeDurations(b) {
  if (probing) return;
  probing = true;
  for (const f of b.files) {
    if (S.sync.durations[f.id] || S.book?.id !== b.id) continue;
    if (!navigator.onLine && !S.dl.has(f.id)) continue;
    const d = await new Promise((res) => {
      const a = new Audio(); a.preload = 'metadata';
      const done = (v) => { a.removeAttribute('src'); a.load(); res(v); };
      a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration) : 0);
      a.onerror = () => done(0);
      setTimeout(() => done(0), 15000);
      a.src = fileSrc(f);
    });
    if (d) { S.sync.durations[f.id] = d; saveLocal(); }
  }
  probing = false;
  renderTime(); pushSoon(5000);
}

/* ---- uyku zamanlayıcı ---- */
let fadeTimer;
function setSleep(min) {
  clearSleep();
  if (min === 'ch') S.sleepChapter = true;
  else if (min) S.sleepEnd = now() + min * 60000;
  renderSleep();
  if (min) toast(min === 'ch' ? 'Bölüm sonunda duracak' : `${min} dk sonra duracak`);
}
function clearSleep() { S.sleepEnd = 0; S.sleepChapter = false; clearInterval(fadeTimer); audio.volume = VOL; renderSleep(); }
function checkSleep() {
  if (!S.sleepEnd) return;
  const left = S.sleepEnd - now();
  renderSleep();
  if (left <= 10000 && left > 0) audio.volume = VOL * Math.max(0.05, left / 10000);
  if (left <= 0) { audio.pause(); seekBy(-10); clearSleep(); }
}
function renderSleep() {
  const on = S.sleepEnd || S.sleepChapter;
  $('#btn-sleep').classList.toggle('on', !!on);
  $('#sleep-label').textContent = S.sleepChapter ? 'Bölüm sonu' : S.sleepEnd ? fmt((S.sleepEnd - now()) / 1000) : 'Uyku';
}
setInterval(() => { if (S.sleepEnd && audio.paused) { /* duraklatılınca bekler */ S.sleepEnd += 1000; } renderSleep(); }, 1000);

/* ---- alt sayfa ---- */
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('on');
  $('#sheet-backdrop').classList.add('on');
}
function closeSheet() { S.dlSheetFor = null; $('#sheet').classList.remove('on'); $('#sheet-backdrop').classList.remove('on'); }

function chaptersSheet() {
  const b = S.book;
  openSheet(`<h3>Bölümler</h3><div class="opt-list">${b.files.map((f, i) => {
    const d = S.sync.durations[f.id];
    return `<button class="opt ${i === S.idx ? 'on' : ''} ${i < S.idx ? 'done' : ''}" data-i="${i}"><span class="num">${i + 1}</span><span class="lbl">${esc(chapterName(f, i))}</span><span class="dur">${d ? fmt(d) : ''}</span></button>`;
  }).join('')}</div>`);
  document.querySelectorAll('.opt[data-i]').forEach((el) => el.onclick = () => { goChapter(+el.dataset.i, true); closeSheet(); });
  $('.opt.on')?.scrollIntoView({ block: 'center' });
}
function speedSheet() {
  const cur = prefs().speed || 1;
  openSheet(`<h3>Dinleme hızı</h3><div class="speed-grid">${SPEEDS.map((s) => `<button data-s="${s}" class="${s === cur ? 'on' : ''}">${fmtSpeed(s)}</button>`).join('')}</div>`);
  document.querySelectorAll('[data-s]').forEach((el) => el.onclick = () => {
    const s = +el.dataset.s;
    setPrefs({ speed: s }); audio.playbackRate = s;
    $('#btn-speed').textContent = fmtSpeed(s); renderTime(); closeSheet();
  });
}
function sleepSheet() {
  const opts = [[5, '5 dakika'], [15, '15 dakika'], [30, '30 dakika'], [45, '45 dakika'], [60, '1 saat'], ['ch', 'Bu bölüm bitince']];
  openSheet(`<h3>Uyku zamanlayıcı 🌙</h3><div class="opt-list">${opts.map(([v, l]) => `<button class="opt" data-v="${v}">${l}</button>`).join('')}
    ${S.sleepEnd || S.sleepChapter ? '<button class="opt" data-v="0">Kapat</button>' : ''}</div>`);
  document.querySelectorAll('[data-v]').forEach((el) => el.onclick = () => { const v = el.dataset.v; setSleep(v === 'ch' ? 'ch' : +v); closeSheet(); });
}

/* =========================================================
   Olaylar
   ========================================================= */
function wire() {
  $('#btn-play').onclick = togglePlay;
  $('#mini-play').onclick = (e) => { e.stopPropagation(); togglePlay(); };
  $('#mini').onclick = openPlayer;
  $('#mini').onkeydown = (e) => { if (e.key === 'Enter') openPlayer(); };
  $('#btn-close-player').onclick = closePlayer;
  $('#btn-back').onclick = () => seekBy(-15);
  $('#btn-fwd').onclick = () => seekBy(30);
  $('#btn-prev').onclick = () => (audio.currentTime > 5 ? (audio.currentTime = 0) : goChapter(S.idx - 1));
  $('#btn-next').onclick = () => goChapter(S.idx + 1);
  $('#btn-chapters').onclick = chaptersSheet;
  $('#btn-speed').onclick = speedSheet;
  $('#btn-sleep').onclick = sleepSheet;
  $('#sheet-backdrop').onclick = closeSheet;
  $('#btn-me').onclick = () => { renderProfiles(false); show('profiles'); renderMini(); };
  $('#btn-refresh').onclick = () => refreshLibrary(true);
  $('#btn-settings').onclick = $('#btn-settings2').onclick = settingsSheet;

  const vol = $('#p-vol');
  vol.oninput = () => setVol(vol.value / 100, false);
  vol.onchange = () => setVol(vol.value / 100);
  $('#btn-mute').onclick = () => setVol(VOL > 0 ? 0 : VOL_BEFORE_MUTE);
  renderVol();

  const seek = $('#p-seek');
  seek.oninput = () => {
    seeking = true;
    const dur = audio.duration || 0;
    seek.style.setProperty('--p', seek.value / 10 + '%');
    $('#p-cur').textContent = fmt(dur * seek.value / 1000);
  };
  seek.onchange = () => {
    const dur = audio.duration || 0;
    if (dur) audio.currentTime = dur * seek.value / 1000;
    seeking = false; recordPosition(true);
  };

  // Aşağı kaydırarak oynatıcıyı kapat (telefon)
  let y0 = null;
  $('#player').addEventListener('touchstart', (e) => { if ($('#player').scrollTop <= 0 && !e.target.closest('input')) y0 = e.touches[0].clientY; }, { passive: true });
  $('#player').addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 110) closePlayer(); y0 = null; }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || !S.book) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') seekBy(-15);
    else if (e.key === 'ArrowRight') seekBy(30);
    else if (e.key === 'ArrowUp' && $('#player').classList.contains('open')) { e.preventDefault(); setVol(VOL + 0.1); }
    else if (e.key === 'ArrowDown' && $('#player').classList.contains('open')) { e.preventDefault(); setVol(VOL - 0.1); }
    else if (e.key === 'Escape') { $('#sheet').classList.contains('on') ? closeSheet() : closePlayer(); }
  });

  // Sekme gizlenince kaydet; geri gelince diğer cihazdaki ilerlemeyi çek.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { recordPosition(true); pushOnExit(); return; }
    if (DEMO || !ready()) return;
    try {
      await pullRemote();
      if (S.profile) {
        if (S.profile && S.sync.profiles[S.profile.id]?.deleted) { S.profile = null; show('profiles'); renderProfiles(); return; }
        if (S.book && audio.paused) {
          const p = prog(S.book.id);
          const f = S.book.files[S.idx];
          if (p && (p.fileId !== f.id || Math.abs((p.t || 0) - audio.currentTime) > 5)) {
            const idx = Math.max(0, S.book.files.findIndex((x) => x.id === p.fileId));
            loadFile(idx, Math.max(0, p.t - 3), false);
            toast('Diğer cihazdaki yerden devam ediyor');
          }
        }
        renderLibrary();
      }
    } catch (e) { console.warn('pull', e); }
  });
  window.addEventListener('pagehide', () => { recordPosition(true); pushOnExit(); });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(S.jobs).length) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => { toast('İnternet geri geldi'); refreshLibrary(false); pushSoon(500); });
  $('#btn-dl').onclick = () => S.book && dlSheet(S.book);
}

/* =========================================================
   Açılış
   ========================================================= */
function renderSetup() {
  show('login');
  $('#login-actions').innerHTML = `<button class="big-btn" id="btn-setup">Kurulumu yap</button>
    <button class="big-btn alt" id="btn-demo">Önce demoya bak</button>`;
  $('#login-note').innerHTML = HAS_KEY
    ? 'Kitap klasörünün Drive linkini ve senkron adresini bir kere girmen yeterli. Eşine kurulum linkini gönderirsen onun bir şey yazmasına gerek kalmaz.'
    : '<code>config.js</code> içine Drive API anahtarını yazman gerekiyor. Adımlar KURULUM.md dosyasında.';
  $('#btn-setup').onclick = settingsSheet;
  if (!HAS_KEY) $('#btn-setup').remove();
  $('#btn-demo').onclick = () => { try { sessionStorage.setItem('miril.demo', '1'); } catch {} location.reload(); };
}

function ago(t) {
  const s = Math.round((now() - t) / 1000);
  return s < 60 ? 'az önce' : s < 3600 ? `${Math.round(s / 60)} dk önce` : `${Math.round(s / 3600)} sa önce`;
}

async function renderDlSettings() {
  const box = $('#st-dl');
  if (!box) return;
  const books = S.books.filter((b) => dlState(b).any);
  const used = books.reduce((a, b) => a + dlState(b).bytes, 0);
  let free = '';
  try { const est = await navigator.storage.estimate(); free = ` · cihazda yaklaşık ${fmtBytes(est.quota - est.usage)} boş`; } catch {}
  box.innerHTML = books.length
    ? `<p>${books.length} kitap · ${fmtBytes(used)}${free}</p><div class="opt-list">${books.map((b) => `<div class="opt dl-row"><span class="lbl">${esc(b.title)}</span><span class="dur">${fmtBytes(dlState(b).bytes)}</span><button class="icon-btn" data-del="${b.id}" aria-label="Sil"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>`).join('')}</div>`
    : `<p>Henüz indirilen kitap yok${free}.</p>`;
  box.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
    const b = S.books.find((x) => x.id === el.dataset.del);
    if (b && confirm(`"${b.title}" bu cihazdan silinsin mi?`)) { await deleteDownload(b); renderDlSettings(); }
  });
}

function settingsSheet() {
  if (DEMO) {
    openSheet(`<h3>Ayarlar</h3><p class="sheet-note">Şu an demo modundasın. Gerçek kütüphanen için demodan çık.</p>
      <div class="row-btns"><button class="big-btn" id="st-exit">Demodan çık</button></div>
      <div class="share-box"><b>Bu cihazdaki indirilenler</b><div id="st-dl"><p>Hesaplanıyor…</p></div></div>`);
    renderDlSettings();
    $('#st-exit').onclick = () => { try { sessionStorage.removeItem('miril.demo'); } catch {} location.href = location.pathname; };
    return;
  }
  const st = S.syncOk == null ? '' : S.syncOk ? `✓ Senkron çalışıyor · ${ago(S.syncAt)}` : '⚠︎ Senkrona ulaşılamadı, değişiklikler bu cihazda bekliyor';
  openSheet(`
    <h3>Ayarlar</h3>
    <label class="field"><span>Kitap klasörü (Drive linki)</span><input id="st-folder" inputmode="url" autocomplete="off" placeholder="https://drive.google.com/drive/folders/…" value="${esc(S.set.folder)}"></label>
    <label class="field"><span>Senkron adresi (Apps Script)</span><input id="st-sync" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec?k=…" value="${esc(S.set.sync)}"></label>
    <p class="sheet-note" id="st-msg">${esc(st)}</p>
    <div class="row-btns"><button class="big-btn" id="st-save">Kaydet ve dene</button></div>
    ${ready() ? `<div class="share-box"><b>Diğer cihazlar için</b><p>Bu linki eşine ya da kendi telefonuna gönder. Açtığı anda bu ayarlarla kurulur.</p>
      <button class="big-btn alt" id="st-share">Kurulum linkini paylaş</button></div>` : ''}
    <div class="share-box"><b>Bu cihazdaki indirilenler</b><div id="st-dl"><p>Hesaplanıyor…</p></div></div>`);
  renderDlSettings();
  $('#st-save').onclick = async () => {
    const folder = $('#st-folder').value.trim(), sync = $('#st-sync').value.trim();
    const msg = $('#st-msg');
    if (!folderIdFrom(folder)) { msg.textContent = 'Klasör linkini tanıyamadım. Drive\'da klasörü açıp adres çubuğundaki linki yapıştır.'; return; }
    if (!isSyncUrl(sync)) { msg.textContent = 'Senkron adresi "https://script.google.com/macros/s/…/exec?k=…" gibi olmalı.'; return; }
    const prev = { ...S.set };
    S.set = { folder, sync };
    msg.textContent = 'Deneniyor…';
    try {
      const r = await scanLibrary();
      await pullRemote();
      LS.set('miril.set', S.set);
      S.books = r.books; LS.set('miril.lib', S.books); S.libError = null;
      msg.textContent = `✓ ${r.books.length} kitap bulundu, senkron çalışıyor.`;
      setTimeout(() => { closeSheet(); if (!$('#v-library').classList.contains('on') || !S.profile) afterData(); else renderLibrary(); }, 900);
    } catch (e) {
      S.set = prev;
      msg.textContent = '⚠︎ ' + (e.message || 'Olmadı');
    }
  };
  if ($('#st-share')) $('#st-share').onclick = async () => {
    const link = setupLink();
    try {
      if (navigator.share) await navigator.share({ title: 'Mırıl kurulumu', url: link });
      else { await navigator.clipboard.writeText(link); toast('Kurulum linki kopyalandı'); }
    } catch (e) { if (e.name !== 'AbortError') prompt('Bu linki kopyala:', link); }
  };
}

async function afterData() {
  S.sync ||= merge(LS.get(lsKey('sync')), null);
  const lastPid = LS.get(lsKey('profile'));
  const p = lastPid && S.sync.profiles[lastPid] && !S.sync.profiles[lastPid].deleted ? S.sync.profiles[lastPid] : null;
  if (p) { S.profile = p; renderLibrary(); show('library'); }
  else { renderProfiles(); show('profiles'); if (!profiles().length) editProfile(null); }
}

async function startReal() {
  S.sync = merge(LS.get(lsKey('sync')), null);
  S.books = LS.get('miril.lib') || [];
  try { await pullRemote(); } catch (e) { console.warn('pull', e); toast('Senkrona ulaşılamadı, bu cihazdaki kayıtla devam'); }
  if (!S.books.length) showSkeleton();
  await afterData();
  if (S.fromSetupLink) toast('Kurulum tamam 🎉');
  refreshLibrary(false);
  pushSoon(2000);
}

async function boot() {
  document.title = CFG.APP_NAME || 'Mırıl';
  document.querySelectorAll('.app-name').forEach((e) => (e.textContent = CFG.APP_NAME || 'Mırıl'));
  wire();
  renderPlayState();
  loadSettings();
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js', { scope: './' });
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
      }
    } catch (e) { console.warn('sw', e); }
  }
  await dlInit();

  if (DEMO) {
    S.sync = merge(LS.get(lsKey('sync')), null);
    S.books = demoLibrary();
    await afterData();
    toast('Demo modu: sesler deneme tonu', 'Çık', () => {
      try { sessionStorage.removeItem('miril.demo'); } catch {}
      location.href = location.pathname;
    }, 5000);
    return;
  }
  if (!ready()) return renderSetup();
  await startReal();
}

boot();
