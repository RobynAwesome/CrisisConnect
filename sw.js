/* ═══════════════════════════════════════════════════════════
   CrisisConnect Service Worker — Adaptive Offline Strategy
   Cache-first for shell, network-first for API, governed outbox
   ═══════════════════════════════════════════════════════════ */

importScripts('/kpgs-progressive.js');

const CACHE_VERSION = 'cc-adaptive-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/index.css',
  '/app.js',
  '/kpgs-progressive.js',
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

/* ── Fetch: adaptive caching strategy ──────────────────── */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network-first, fall back to cache for reads.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Never cache mutation responses as proof for a later mutation.
          if (event.request.method === 'GET' && response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.method === 'GET') return caches.match(event.request);
          throw new Error('Mutation transport unavailable');
        })
    );
    return;
  }

  // Shell assets: cache-first, fall back to network.
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

/* ── Background Sync: process governed durable outbox ──── */
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

async function postToClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

async function loadSyncEndpoint() {
  try {
    const response = await fetch('/kpgs_config.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const config = await response.json();
    const endpoint = config && config.progressive_updates && config.progressive_updates.sync_endpoint;
    return typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : null;
  } catch (_) {
    return null;
  }
}

async function processOfflineQueue() {
  if (!self.CCKpgs) {
    await postToClients({
      type: 'SYNC_PENDING',
      reason: 'KPGS_RUNTIME_UNAVAILABLE',
      pending: null
    });
    return;
  }

  let pending;
  try {
    pending = await self.CCKpgs.listPendingOutbox();
  } catch (error) {
    await postToClients({
      type: 'SYNC_PENDING',
      reason: 'OUTBOX_READ_FAILED',
      detail: String(error && error.message ? error.message : error),
      pending: null
    });
    return;
  }

  if (pending.length === 0) {
    await postToClients({ type: 'SYNC_IDLE', pending: 0 });
    return;
  }

  const endpoint = await loadSyncEndpoint();
  if (!endpoint) {
    // Canonical SWFUS rule: no configured receiving sink means distribution was
    // NOT_REACHED. Keep every record durable and do not emit SYNC_COMPLETE.
    await postToClients({
      type: 'SYNC_PENDING',
      reason: 'NO_SYNC_ENDPOINT',
      pending: pending.length
    });
    return;
  }

  let delivered = 0;
  const failures = [];

  for (const record of pending) {
    await self.CCKpgs.markDeliveryAttempt(record.update_id, `POST ${endpoint}`);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': record.update_id,
          'X-KPGS-Protocol': self.CCKpgs.CANONICAL_SOURCE.contract
        },
        body: JSON.stringify({
          incident: record.payload,
          kpgs: record.envelope
        })
      });

      if (!response.ok) {
        failures.push({ update_id: record.update_id, status: response.status });
        continue;
      }

      const responseBody = await response.text();
      await self.CCKpgs.markDelivered(record.update_id, {
        ok: true,
        endpoint,
        status: response.status,
        received_at: new Date().toISOString(),
        response_digest: responseBody.slice(0, 256)
      });
      delivered += 1;
    } catch (error) {
      failures.push({
        update_id: record.update_id,
        error: String(error && error.message ? error.message : error)
      });
    }
  }

  const remaining = await self.CCKpgs.countPendingOutbox();
  if (remaining === 0 && delivered === pending.length) {
    await postToClients({
      type: 'SYNC_COMPLETE',
      delivered,
      pending: 0,
      endpoint,
      ts: new Date().toISOString()
    });
    return;
  }

  await postToClients({
    type: 'SYNC_PENDING',
    delivered,
    pending: remaining,
    failures
  });
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
