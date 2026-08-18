/* ═══════════════════════════════════════════════════════════
   CrisisConnect Service Worker — Adaptive Offline Strategy
   Cache-first for shell, network-first for API, governed outbox
   ═══════════════════════════════════════════════════════════ */

importScripts('/outbox.js');

const CACHE_VERSION = 'cc-adaptive-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/index.css',
  '/app.js',
  '/outbox.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // GET API reads can be network-first. Mutation requests are never cached as
  // proof and the governed outbox owns incident-report delivery explicitly.
  if (url.pathname.startsWith('/api/') && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
      .catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'cc-offline-queue') {
    event.waitUntil(processOfflineQueue());
  }
});

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(client => client.postMessage(message));
}

async function processOfflineQueue() {
  try {
    const result = await self.CrisisOutbox.syncPending();

    // SYNC_COMPLETE is reserved for actual delivery acknowledged by a valid
    // non-authoritative SWFUS receipt. Local persistence or merely coming online
    // can never emit this event.
    if (result.status === 'complete' && result.delivered > 0 && result.pending === 0) {
      await broadcast({
        type: 'SYNC_COMPLETE',
        delivered: result.delivered,
        pending: 0,
        ts: new Date().toISOString()
      });
      return;
    }

    await broadcast({
      type: 'OUTBOX_PENDING',
      reason: result.reason || (result.failed ? 'DELIVERY_FAILED' : 'NO_CONFIRMED_DELIVERY'),
      delivered: result.delivered || 0,
      failed: result.failed || 0,
      pending: result.pending || 0,
      ts: new Date().toISOString()
    });
  } catch (error) {
    await broadcast({
      type: 'OUTBOX_FAILED',
      reason: error && error.message ? error.message : 'OUTBOX_FAILURE',
      ts: new Date().toISOString()
    });
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PROCESS_OUTBOX') {
    event.waitUntil(processOfflineQueue());
  }
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'CrisisConnect Alert', body: 'New incident update' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/manifest.json',
      badge: '/manifest.json',
      vibrate: [200, 100, 200],
      tag: 'cc-alert',
      renotify: true,
      requireInteraction: data.urgency === 'critical'
    })
  );
});
