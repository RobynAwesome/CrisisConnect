/* ═══════════════════════════════════════════════════════════
   CrisisConnect Service Worker — Adaptive Offline Strategy
   Cache-first for shell, network-first for API, governed outbox
   ═══════════════════════════════════════════════════════════ */

importScripts('/kpgs-outbox.js');

const CACHE_VERSION = 'cc-adaptive-v3';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/index.css',
  '/app.js',
  '/kpgs-outbox.js',
  '/kpgs-runtime-adapter.js',
  '/kpgs_config.json',
  '/manifest.json'
];

/* ── Install: cache app shell ──────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: clean old caches ────────────────────────── */
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

async function injectGovernedRuntime(response) {
  if (!response) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const html = await response.clone().text();
  if (html.includes('kpgs-runtime-adapter.js')) return response;

  const marker = '<script src="app.js"></script>';
  if (!html.includes(marker)) return response;

  const injected = html.replace(
    marker,
    `${marker}\n  <script src="kpgs-outbox.js"></script>\n  <script src="kpgs-runtime-adapter.js"></script>`
  );

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function shellResponse(request) {
  let response = await caches.match(request);
  if (!response) {
    response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
  }

  if (request.mode === 'navigate') {
    return injectGovernedRuntime(response);
  }
  return response;
}

/* ── Fetch: adaptive caching strategy ──────────────────── */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network-first, fall back to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    shellResponse(event.request).catch(async () => {
      if (event.request.mode === 'navigate') {
        return injectGovernedRuntime(await caches.match('/index.html'));
      }
      return caches.match(event.request);
    })
  );
});

async function loadSyncEndpoint() {
  try {
    const cached = await caches.match('/kpgs_config.json');
    if (!cached) return '';
    const config = await cached.json();
    return typeof config.sync_endpoint === 'string' ? config.sync_endpoint.trim() : '';
  } catch (_) {
    return '';
  }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

/* ── Background Sync: process governed durable outbox ─── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'cc-offline-queue') {
    event.waitUntil(processOfflineQueue());
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PROCESS_OUTBOX') {
    event.waitUntil(processOfflineQueue());
  }
});

async function processOfflineQueue() {
  const endpoint = await loadSyncEndpoint();
  const result = await self.CrisisOutbox.syncPending({ endpoint });

  if (result.complete) {
    // SWFUS distribution PASS is allowed only after the configured receiving
    // sink returned success for every attempted pending proposal.
    await notifyClients({
      type: 'SYNC_COMPLETE',
      delivered: result.delivered,
      retained: result.retained,
      detail: result.detail,
      ts: new Date().toISOString()
    });
    return result;
  }

  // No sink or failed transport is a truthful pending state. Never collapse it
  // into a successful dispatch/sync claim.
  await notifyClients({
    type: 'SYNC_PENDING',
    delivered: result.delivered,
    retained: result.retained,
    code: result.code,
    detail: result.detail,
    ts: new Date().toISOString()
  });
  return result;
}

/* ── Push Notifications ────────────────────────────────── */
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
