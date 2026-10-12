/* 横浜市 粗大ごみナビ Service Worker */
const PREFIX = 'yokohama-sodai-nav-';
const VERSION = '2026-10-12.6';
const CACHE = PREFIX + VERSION;
const ASSETS = ['./', 'index.html', 'style.css', 'logic.js', 'recognizer.js', 'app.js', 'manifest.webmanifest', 'data/fees.json', 'data/rules.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

const validFees = j => j && Array.isArray(j.items) && j.items.length > 100 && typeof j.retrievedAt === 'string';
const validRules = j => j && j.schemaVersion >= 5 && j.definition && j.reception;
const validatorFor = url => url.endsWith('/data/fees.json') ? validFees : url.endsWith('/data/rules.json') ? validRules : null;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // このアプリの古いキャッシュだけを削除（同じドメインの他アプリのキャッシュには触れない）
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function fromCache(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (!hit) return null;
  const h = new Headers(hit.headers); h.set('x-sodai-cache', '1');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (!res.ok || res.type !== 'basic') return (await fromCache(req)) || res; // 失敗した応答は保存しない
      const v = validatorFor(url.pathname);
      if (v) {
        let ok = false; try { ok = v(await res.clone().json()); } catch { ok = false; }
        if (!ok) return (await fromCache(req)) || res; // 壊れたデータで正しい保存データを上書きしない
      }
      const c = await caches.open(CACHE); await c.put(req, res.clone());
      return res;
    } catch {
      return (await fromCache(req)) || (req.mode === 'navigate' ? await fromCache(new Request('index.html')) : null) || Response.error();
    }
  })());
});
