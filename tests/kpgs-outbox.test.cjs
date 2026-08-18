'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

// Minimal deterministic IndexedDB contract used to exercise the exact browser
// persistence calls in kpgs-outbox.js without adding a production dependency.
function createFakeIndexedDB() {
  const databases = new Map();

  class FakeStore {
    constructor(meta, tx) {
      this.meta = meta;
      this.tx = tx;
    }

    createIndex() {
      return this;
    }

    request(operation) {
      const req = {};
      queueMicrotask(() => {
        try {
          req.result = operation();
          if (req.onsuccess) req.onsuccess();
          queueMicrotask(() => this.tx.complete());
        } catch (error) {
          req.error = error;
          if (req.onerror) req.onerror();
          this.tx.fail(error);
        }
      });
      return req;
    }

    get(key) {
      return this.request(() => this.meta.records.get(key));
    }

    getAll() {
      return this.request(() => Array.from(this.meta.records.values()));
    }

    add(value) {
      const key = value[this.meta.keyPath];
      if (this.meta.records.has(key)) {
        const error = new Error('ConstraintError');
        error.name = 'ConstraintError';
        queueMicrotask(() => this.tx.fail(error));
        return undefined;
      }
      this.meta.records.set(key, structuredClone(value));
      queueMicrotask(() => this.tx.complete());
      return undefined;
    }

    put(value) {
      const key = value[this.meta.keyPath];
      this.meta.records.set(key, structuredClone(value));
      queueMicrotask(() => this.tx.complete());
      return undefined;
    }
  }

  class FakeTransaction {
    constructor(db, name) {
      this.db = db;
      this.name = name;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.error = null;
      this.finished = false;
    }

    objectStore() {
      return new FakeStore(this.db.stores.get(this.name), this);
    }

    complete() {
      if (this.finished) return;
      this.finished = true;
      if (this.oncomplete) this.oncomplete();
    }

    fail(error) {
      if (this.finished) return;
      this.finished = true;
      this.error = error;
      if (this.onerror) this.onerror();
    }
  }

  class FakeDB {
    constructor(name) {
      this.name = name;
      this.stores = new Map();
      this.objectStoreNames = {
        contains: storeName => this.stores.has(storeName)
      };
    }

    createObjectStore(name, options) {
      const meta = { keyPath: options.keyPath, records: new Map() };
      this.stores.set(name, meta);
      return new FakeStore(meta, { complete() {}, fail() {} });
    }

    transaction(name) {
      return new FakeTransaction(this, name);
    }

    close() {}
  }

  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const created = !db;
        if (!db) {
          db = new FakeDB(name);
          databases.set(name, db);
        }
        request.result = db;
        if (created && request.onupgradeneeded) request.onupgradeneeded();
        queueMicrotask(() => {
          if (request.onsuccess) request.onsuccess();
        });
      });
      return request;
    },
    reset() {
      databases.clear();
    }
  };
}

const fakeIndexedDB = createFakeIndexedDB();
global.indexedDB = fakeIndexedDB;
global.crypto = webcrypto;

function loadOutboxFresh() {
  const path = require.resolve('../kpgs-outbox.js');
  delete require.cache[path];
  return require(path);
}

function payload(overrides = {}) {
  return {
    id: 'LOCAL-1',
    type: 'fire',
    severity: 'high',
    title: 'Fire report — Dunoon',
    location: 'Dunoon',
    description: 'Smoke visible near structures',
    contact: '',
    timestamp: '2026-08-19T00:00:00.000Z',
    trust: 'unverified',
    proposalState: 'pending_proposal',
    synced: false,
    ...overrides
  };
}

function failedStatus(result, name) {
  return result.receipt.stages[name].status;
}

test.beforeEach(() => {
  fakeIndexedDB.reset();
  delete global.fetch;
});

test('pins canonical source and full eight-stage order', () => {
  const outbox = loadOutboxFresh();
  assert.equal(outbox.CANONICAL.commit, '70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a');
  assert.deepEqual(outbox.STAGES, [
    'telemetry',
    'classification',
    'routing',
    'protocolSelection',
    'invariantAudit',
    'pocFocCheck',
    'stateUpdate',
    'distribution'
  ]);
});

test('RED, YELLOW, missing #NB, wrong route/protocol and authority widening fail before mutation', () => {
  const outbox = loadOutboxFresh();
  const cases = [
    [outbox.buildEnvelope('red', { apu_state: 'RED' }), 'pocFocCheck', 'REJECT'],
    [outbox.buildEnvelope('yellow', { apu_state: 'YELLOW' }), 'pocFocCheck', 'HOLD'],
    [outbox.buildEnvelope('nb', { boundary_marker: 'NB' }), 'invariantAudit', 'HOLD'],
    [outbox.buildEnvelope('route', { route: { domain: 'example.com', lane: 'incident-report-outbox' } }), 'routing', 'REJECT'],
    [outbox.buildEnvelope('protocol', { canonical_source_sha: 'wrong' }), 'protocolSelection', 'REJECT'],
    [outbox.buildEnvelope('authority', { authority_effect: 'grant' }), 'invariantAudit', 'REJECT'],
    [outbox.buildEnvelope('foc', { foc_asserted: true }), 'pocFocCheck', 'REJECT']
  ];

  for (const [envelope, stageName, expected] of cases) {
    const result = outbox.preflight(envelope, payload());
    assert.equal(result.admitted, false);
    assert.equal(failedStatus(result, stageName), expected);
    assert.equal(result.receipt.stages.stateUpdate.status, 'NOT_REACHED');
    assert.equal(result.receipt.stages.distribution.status, 'NOT_REACHED');
  }
});

test('local CREATE persists pending proposal across module reload and never claims distribution', async () => {
  let outbox = loadOutboxFresh();
  const envelope = outbox.buildEnvelope('reload-proof');
  const first = await outbox.create(payload(), envelope);

  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  assert.equal(first.record.status, 'pending');
  assert.equal(first.receipt.stages.stateUpdate.status, 'PASS');
  assert.equal(first.receipt.stages.distribution.status, 'NOT_REACHED');
  assert.equal(first.receipt.canonical, false);
  assert.equal(first.receipt.authorityEffect, 'none');
  assert.equal(first.receipt.transportGrantsAuthority, false);

  // Simulate a page/process module reload while the browser's IndexedDB database
  // survives. A fresh adapter instance must recover the same pending proposal.
  outbox = loadOutboxFresh();
  const pending = await outbox.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].updateId, 'reload-proof');
  assert.equal(pending[0].payload.location, 'Dunoon');
});

test('exact replay is idempotent and changed content with same update id rejects', async () => {
  const outbox = loadOutboxFresh();
  const envelope = outbox.buildEnvelope('replay-proof');

  const first = await outbox.create(payload(), envelope);
  const replay = await outbox.create(payload(), envelope);
  const collision = await outbox.create(payload({ description: 'Different governed content' }), envelope);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.code, 'IDEMPOTENT_REPLAY');
  assert.equal(collision.ok, false);
  assert.equal(collision.receipt.code, 'IDEMPOTENCY_COLLISION');
  assert.equal((await outbox.list('pending')).length, 1);
});

test('no configured sink retains proposal and cannot emit completion semantics', async () => {
  const outbox = loadOutboxFresh();
  await outbox.create(payload(), outbox.buildEnvelope('no-sink'));

  const result = await outbox.syncPending({ endpoint: '' });
  assert.equal(result.code, 'SYNC_PENDING_NO_SINK');
  assert.equal(result.complete, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.retained, 1);
  assert.equal((await outbox.list('pending')).length, 1);
});

test('only a successful configured sink response advances distribution PASS', async () => {
  const outbox = loadOutboxFresh();
  await outbox.create(payload(), outbox.buildEnvelope('sink-success'));
  global.fetch = async () => ({ ok: true, status: 200 });

  const result = await outbox.syncPending({ endpoint: 'https://sink.example.test/incidents' });
  assert.equal(result.complete, true);
  assert.equal(result.code, 'SYNC_COMPLETE');
  assert.equal(result.delivered, 1);
  assert.equal(result.retained, 0);
  assert.equal((await outbox.list('pending')).length, 0);

  const delivered = await outbox.list('delivered');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].receipt.stages.distribution.status, 'PASS');
  assert.equal(delivered[0].receipt.transportGrantsAuthority, false);
  assert.equal(delivered[0].receipt.stateClass, 'pending_proposal');
});

test('failed configured transport retains proposal in HOLD for exact replay', async () => {
  const outbox = loadOutboxFresh();
  await outbox.create(payload(), outbox.buildEnvelope('sink-fail'));
  global.fetch = async () => ({ ok: false, status: 503 });

  const result = await outbox.syncPending({ endpoint: 'https://sink.example.test/incidents' });
  assert.equal(result.complete, false);
  assert.equal(result.code, 'SYNC_PENDING');
  assert.equal(result.retained, 1);

  const pending = await outbox.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].receipt.stages.distribution.status, 'HOLD');
  assert.equal(pending[0].receipt.code, 'TRANSPORT_HOLD');
});
