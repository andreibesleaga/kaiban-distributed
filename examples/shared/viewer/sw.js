/**
 * Kaiban Distributed — Viewer Service Worker
 *
 * Caches the static assets (HTML, JS, CSS) for offline viewing of the board UI.
 * When offline, the cached shell is served and the board gracefully shows
 * "Disconnected" status without a broken page.
 *
 * The live data (socket.io events) always requires a network connection —
 * this SW only caches the static shell, not live state.
 *
 * Cache versioning: increment CACHE_VERSION to bust old caches on deploy.
 */

const CACHE_VERSION = 'kaiban-viewer-v1';

// Static assets to pre-cache on install.
// Example-specific files are resolved from the registered scope (the viewer
// directory), while shared assets are resolved relative to this SW file.
// self.registration.scope is set to the viewer directory when the SW is
// registered with { scope: './' } from each example's board.html.
const PRECACHE_URLS = [
  self.registration.scope + 'board.html',
  self.registration.scope + 'board.js',
  self.registration.scope + 'board.css',
  './board-base.js',
  './board-base.css',
];

// ── Install: pre-cache all static assets ─────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// ── Activate: remove old caches ──────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim()) // control all clients immediately
  );
});

// ── Fetch: cache-first for static assets, network-only for socket.io ────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache socket.io or API requests — always hit the network
  if (
    url.pathname.includes('/socket.io') ||
    url.pathname.startsWith('/api') ||
    url.hostname === 'cdn.socket.io'
  ) {
    return; // let browser handle normally (network only)
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request)
        .then(response => {
          // Cache successful GET responses for static files
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_VERSION)
              .then(cache => cache.put(event.request, clone))
              .catch(function () { /* quota exceeded or non-cacheable — ignore */ });
          }
          return response;
        })
      )
  );
});
