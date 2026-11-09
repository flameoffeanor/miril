// Mırıl service worker
// 1) Uygulama dosyaları: önce internet, yoksa önbellek → internetsiz de açılır,
//    güncellemeler internet varken hemen gelir.
// 2) "offline/<id>": indirilen kitapları cihaz depolamasından çalar (ileri/geri sarma dahil).

const SHELL = 'miril-shell-v1';
const DL = 'miril-audio-v1';
const FONT = 'miril-font-v1';

const SHELL_FILES = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

// İlk ziyarette uygulama dosyalarını önbelleğe al → internetsiz de açılsın.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) =>
    Promise.all(SHELL_FILES.map((f) => fetch(new Request(f, { cache: 'reload' })).then((r) => r.ok && c.put(f === './' ? new URL('./', self.registration.scope).href : new URL(f, self.registration.scope).href, r)).catch(() => {})))
  ));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);

  if (u.origin === self.location.origin) {
    if (/\/offline\/[A-Za-z0-9_-]+$/.test(u.pathname)) return e.respondWith(serveOffline(req));
    const scope = new URL(self.registration.scope);
    const rel = u.pathname.startsWith(scope.pathname) ? u.pathname.slice(scope.pathname.length) : null;
    if (req.mode === 'navigate' || (rel !== null && SHELL_FILES.includes(rel))) return e.respondWith(networkFirst(req));
    return; // diğer her şey (API vb.) önbelleğe dokunmadan geçer
  }
  // Kitap kapakları (Google Books / Open Library): bir kere indir, sonra internetsiz de görünsün
  if (/(^|\.)books\.google\.com$|^books\.googleusercontent\.com$|^covers\.openlibrary\.org$|\.archive\.org$/.test(u.hostname)) {
    return e.respondWith(cacheFirst(req, 'miril-cover-v1'));
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    return e.respondWith(cacheFirst(req, FONT));
  }
  // Drive API ve diğer her şey: dokunma.
});

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const idx = await c.match(new URL('./', self.registration.scope).href) || await c.match(new URL('index.html', self.registration.scope).href);
      if (idx) return idx;
    }
    return new Response('offline', { status: 503 });
  }
}

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') c.put(req, r.clone());
    return r;
  } catch { return new Response('', { status: 503 }); }
}

async function serveOffline(req) {
  const c = await caches.open(DL);
  const hit = await c.match(req.url);
  if (!hit) return new Response('not downloaded', { status: 404 });
  const blob = await hit.blob();
  const type = hit.headers.get('Content-Type') || 'application/octet-stream';
  const size = blob.size;
  const range = req.headers.get('range');
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] !== '' ? +m[1] : 0;
    let end = m && m[2] !== '' ? +m[2] : size - 1;
    if (m && m[1] === '' && m[2] !== '') { start = size - +m[2]; end = size - 1; } // son N bayt
    end = Math.min(end, size - 1);
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(blob.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}
