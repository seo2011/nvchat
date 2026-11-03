/* NV Chat 서비스 워커 — 앱 셸 캐시(오프라인 화면 + 빠른 시작) */
const VERSION = 'nvchat-v1.0.0';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/aiassist.js',
  './js/attachments.js',
  './js/config.js',
  './js/md.js',
  './js/store.js',
  './js/vault.js',
  './js/voice.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API·CDN 등 외부 요청은 서비스 워커가 관여하지 않음
  if (url.origin !== location.origin) return;

  // 페이지 이동 → 네트워크 우선, 실패 시 캐시된 index
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // 같은 출처 자원 → 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
