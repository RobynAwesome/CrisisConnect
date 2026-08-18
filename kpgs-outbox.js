/*
 * CrisisConnect governed incident outbox.
 *
 * Canonical authority: RobynAwesome/Introduction-to-MCP
 * commit: 70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a
 *
 * This file is a browser/service-worker adapter. It does not verify incidents,
 * dispatch responders, or grant crisis-response authority. Every local report
 * remains a pending proposal until an external system independently verifies it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CrisisOutbox = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CANONICAL = Object.freeze({
    repository: 'RobynAwesome/Introduction-to-MCP',
    commit: '70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a',
    protocol: 'kpgs.progressive-update.v1',
    chain: 'APU -> Progressive Update -> #NB -> bounded CRUD -> SWFUS'
  });

  const ROUTE = Object.freeze({
    domain: 'crisisconnect.kopanolabs.com',
    lane: 'incident-report-outbox'
  });

  const STAGES = Object.freeze([
    'telemetry',
    'classification',
    'routing',
    'protocolSelection',
    'invariantAudit',
    'pocFocCheck',
    'stateUpdate',
    'distribution'
  ]);

  const DB_NAME = 'crisisconnect-kpgs-outbox-v1';
  const DB_VERSION = 1;
  const STORE = 'incident_outbox';

  function stage(status, detail) {
    return { status, detail };
  }

  function freshReceipt(updateId) {
    return {
      schema: 'crisisconnect.kpgs.outbox-receipt.v1',
      updateId: updateId || null,
      canonicalSource: { ...CANONICAL },
      route: { ...ROUTE },
      canonical: false,
      authorityEffect: 'none',
      transportGrantsAuthority: false,
      stateClass: 'pending_proposal',
      outcome: 'READY',
      code: 'KPGS_PREFLIGHT',
      replay: false,
      evidenceRefs: [],
      stages: {
        telemetry: stage('NOT_REACHED', 'Stable update identity not admitted yet.'),
        classification: stage('NOT_REACHED', 'Classification not reached.'),
        routing: stage('NOT_REACHED', 'Routing not reached.'),
        protocolSelection: stage('NOT_REACHED', 'Protocol selection not reached.'),
        invariantAudit: stage('NOT_REACHED', 'Invariant audit not reached.'),
        pocFocCheck: stage('NOT_REACHED', 'POC/FOC check not reached.'),
        stateUpdate: stage('NOT_REACHED', 'Durable local outbox write not reached.'),
        distribution: stage('NOT_REACHED', 'No downstream sink has confirmed delivery.')
      }
    };
  }

  function stop(receipt, stageName, status, code, detail) {
    receipt.stages[stageName] = stage(status, detail);
    receipt.outcome = status;
    receipt.code = code;
    return { admitted: false, receipt };
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  async function sha256(value) {
    const data = new TextEncoder().encode(stableStringify(value));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function buildEnvelope(updateId, overrides) {
    return {
      update_id: updateId,
      protocol: CANONICAL.protocol,
      canonical_source_sha: CANONICAL.commit,
      route: { ...ROUTE },
      apu_state: 'GREEN',
      boundary_marker: '#NB',
      crud_intent: 'CREATE',
      state_class: 'pending_proposal',
      authority_effect: 'none',
      foc_asserted: false,
      ...(overrides || {})
    };
  }

  function preflight(envelope, payload) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return stop(freshReceipt(null), 'telemetry', 'REJECT', 'INVALID_KPGS_ENVELOPE', 'Governed outbox CREATE requires a KPGS object.');
    }

    const updateId = typeof envelope.update_id === 'string' ? envelope.update_id.trim() : '';
    const receipt = freshReceipt(updateId || null);

    if (!updateId || updateId.length > 200) {
      return stop(receipt, 'telemetry', 'REJECT', 'INVALID_UPDATE_ID', 'A stable update_id of 1-200 characters is required before local persistence.');
    }
    receipt.stages.telemetry = stage('PASS', 'Stable update identity admitted for local proposal persistence.');

    if (envelope.state_class !== 'pending_proposal') {
      return stop(receipt, 'classification', 'REJECT', 'STATE_CLASS_FORBIDDEN', 'Incident testimony may enter this lane only as pending_proposal.');
    }
    if (!['GREEN', 'YELLOW', 'RED', 'UNSPECIFIED'].includes(envelope.apu_state)) {
      return stop(receipt, 'classification', 'REJECT', 'INVALID_APU_STATE', 'apu_state must be GREEN, YELLOW, RED or UNSPECIFIED.');
    }
    receipt.stages.classification = stage('PASS', `pending_proposal classified with APU=${envelope.apu_state}.`);

    const route = envelope.route || {};
    if (route.domain !== ROUTE.domain || route.lane !== ROUTE.lane) {
      return stop(receipt, 'routing', 'REJECT', 'ROUTE_MISMATCH', 'The mutation is not routed to the bounded CrisisConnect incident-report outbox lane.');
    }
    receipt.stages.routing = stage('PASS', `${ROUTE.domain} / ${ROUTE.lane} selected.`);

    if (envelope.protocol !== CANONICAL.protocol || envelope.canonical_source_sha !== CANONICAL.commit) {
      return stop(receipt, 'protocolSelection', 'REJECT', 'CANONICAL_PROTOCOL_MISMATCH', 'Canonical progressive-update protocol or pinned source SHA does not match.');
    }
    receipt.stages.protocolSelection = stage('PASS', 'Pinned Introduction-to-MCP progressive-update contract selected.');

    if (envelope.boundary_marker !== '#NB') {
      return stop(receipt, 'invariantAudit', 'HOLD', 'NB_BOUNDARY_REQUIRED', 'The literal #NB boundary_marker is required before durable outbox mutation.');
    }
    if (envelope.crud_intent !== 'CREATE') {
      return stop(receipt, 'invariantAudit', 'REJECT', 'CRUD_SCOPE_MISMATCH', 'The first CrisisConnect pilot is bounded to local outbox CREATE.');
    }
    if (envelope.authority_effect !== 'none') {
      return stop(receipt, 'invariantAudit', 'REJECT', 'AUTHORITY_EFFECT_FORBIDDEN', 'Browser persistence cannot grant crisis-response authority.');
    }
    receipt.stages.invariantAudit = stage('PASS', 'CREATE is bounded, #NB is literal and authority remains none.');

    if (envelope.apu_state === 'RED' || envelope.foc_asserted === true) {
      return stop(receipt, 'pocFocCheck', 'REJECT', 'FOC_OR_APU_RED', 'FOC or APU RED cannot cross the durable-local-mutation membrane.');
    }
    if (envelope.apu_state === 'YELLOW' || envelope.apu_state === 'UNSPECIFIED') {
      return stop(receipt, 'pocFocCheck', 'HOLD', 'APU_NOT_GREEN', 'Durable local proposal CREATE requires APU GREEN.');
    }

    const hasType = Boolean(payload && typeof payload.type === 'string' && payload.type.trim());
    const hasLocation = Boolean(payload && typeof payload.location === 'string' && payload.location.trim());
    const hasDescription = Boolean(payload && typeof payload.description === 'string' && payload.description.trim());
    if (!hasType || !hasLocation || !hasDescription) {
      return stop(receipt, 'pocFocCheck', 'HOLD', 'LOCAL_FORM_EVIDENCE_MISSING', 'Type, location and description are required as local form/schema evidence.');
    }

    receipt.evidenceRefs = [
      'form://incident/type',
      'form://incident/location',
      'form://incident/description'
    ];
    receipt.stages.pocFocCheck = stage('PASS', 'Local form/schema evidence is present; this proves only a user proposal, not incident truth.');
    receipt.stages.stateUpdate = stage('READY', 'IndexedDB transaction is admitted.');
    receipt.outcome = 'READY';
    receipt.code = 'OUTBOX_READY';
    return { admitted: true, receipt };
  }

  function openDB() {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is not available in this runtime.'));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'updateId' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open CrisisConnect outbox.'));
    });
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  async function get(updateId) {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const value = await requestAsPromise(tx.objectStore(STORE).get(updateId));
      await txDone(tx);
      return value || null;
    } finally {
      db.close();
    }
  }

  async function list(statusFilter) {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const values = await requestAsPromise(tx.objectStore(STORE).getAll());
      await txDone(tx);
      const records = values || [];
      return statusFilter ? records.filter(record => record.status === statusFilter) : records;
    } finally {
      db.close();
    }
  }

  async function countPending() {
    return (await list('pending')).length;
  }

  async function create(payload, envelope) {
    const gate = preflight(envelope, payload);
    if (!gate.admitted) return { ok: false, replay: false, receipt: gate.receipt, record: null };

    const updateId = envelope.update_id.trim();
    const digest = await sha256({ payload, envelope });
    const existing = await get(updateId);
    if (existing) {
      if (existing.payloadDigest !== digest) {
        const conflict = freshReceipt(updateId);
        conflict.stages.telemetry = stage('PASS', 'Stable update identity already exists.');
        conflict.stages.classification = stage('PASS', 'Existing record is a pending proposal.');
        conflict.stages.routing = stage('PASS', `${ROUTE.domain} / ${ROUTE.lane} selected.`);
        conflict.stages.protocolSelection = stage('PASS', 'Pinned canonical contract selected.');
        conflict.stages.invariantAudit = stage('REJECT', 'update_id is already bound to different governed content.');
        conflict.outcome = 'REJECT';
        conflict.code = 'IDEMPOTENCY_COLLISION';
        return { ok: false, replay: false, receipt: conflict, record: existing };
      }
      const replayReceipt = JSON.parse(JSON.stringify(existing.receipt));
      replayReceipt.replay = true;
      replayReceipt.code = 'IDEMPOTENT_REPLAY';
      return { ok: true, replay: true, receipt: replayReceipt, record: existing };
    }

    const receipt = JSON.parse(JSON.stringify(gate.receipt));
    receipt.evidenceRefs.push(`sha256:${digest}`);
    const now = new Date().toISOString();
    const record = {
      updateId,
      payloadDigest: digest,
      payload,
      envelope,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      receipt
    };

    const db = await openDB();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(record);
      await txDone(tx);
    } catch (error) {
      const raced = await get(updateId);
      if (raced && raced.payloadDigest === digest) {
        const replayReceipt = JSON.parse(JSON.stringify(raced.receipt));
        replayReceipt.replay = true;
        replayReceipt.code = 'IDEMPOTENT_REPLAY';
        return { ok: true, replay: true, receipt: replayReceipt, record: raced };
      }
      const held = JSON.parse(JSON.stringify(receipt));
      held.stages.stateUpdate = stage('HOLD', `IndexedDB transaction failed: ${error && error.name ? error.name : 'Error'}.`);
      held.stages.distribution = stage('NOT_REACHED', 'No durable local mutation; downstream transport was not attempted.');
      held.outcome = 'HOLD';
      held.code = 'OUTBOX_WRITE_FAILED';
      return { ok: false, replay: false, receipt: held, record: null };
    } finally {
      db.close();
    }

    receipt.stages.stateUpdate = stage('PASS', 'Pending proposal committed durably to IndexedDB.');
    receipt.stages.distribution = stage('NOT_REACHED', 'Local persistence is not downstream delivery; no sink has confirmed receipt.');
    receipt.outcome = 'APPLIED';
    receipt.code = 'LOCAL_PROPOSAL_PERSISTED';
    record.receipt = receipt;
    record.updatedAt = new Date().toISOString();

    const db2 = await openDB();
    try {
      const tx2 = db2.transaction(STORE, 'readwrite');
      tx2.objectStore(STORE).put(record);
      await txDone(tx2);
    } finally {
      db2.close();
    }

    return { ok: true, replay: false, receipt, record };
  }

  async function updateRecord(record) {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async function syncPending(options) {
    const endpoint = options && typeof options.endpoint === 'string' ? options.endpoint.trim() : '';
    const pending = await list('pending');

    if (!endpoint) {
      return {
        code: 'SYNC_PENDING_NO_SINK',
        delivered: 0,
        retained: pending.length,
        complete: false,
        detail: 'No governed upstream sink is configured; proposals remain in the local outbox.'
      };
    }

    let delivered = 0;
    let retained = 0;
    for (const record of pending) {
      record.attempts += 1;
      record.updatedAt = new Date().toISOString();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': record.updateId,
            'X-KPGS-Canonical-Source': CANONICAL.commit
          },
          body: JSON.stringify({
            update_id: record.updateId,
            state_class: 'pending_proposal',
            authority_effect: 'none',
            transport_grants_authority: false,
            payload: record.payload,
            receipt: record.receipt
          })
        });

        if (!response.ok) throw new Error(`HTTP_${response.status}`);

        record.status = 'delivered';
        record.deliveredAt = new Date().toISOString();
        record.receipt.stages.distribution = stage('PASS', 'Configured upstream sink returned a successful transport response. This does not verify incident truth or grant authority.');
        record.receipt.outcome = 'DISTRIBUTED';
        record.receipt.code = 'SINK_CONFIRMED';
        await updateRecord(record);
        delivered += 1;
      } catch (error) {
        record.status = 'pending';
        record.lastTransportError = error && error.message ? error.message : 'transport_failed';
        record.receipt.stages.distribution = stage('HOLD', 'A configured transport attempt failed; proposal retained for exact replay.');
        record.receipt.outcome = 'HOLD';
        record.receipt.code = 'TRANSPORT_HOLD';
        await updateRecord(record);
        retained += 1;
      }
    }

    return {
      code: retained === 0 && delivered > 0 ? 'SYNC_COMPLETE' : 'SYNC_PENDING',
      delivered,
      retained,
      complete: retained === 0 && delivered > 0,
      detail: retained === 0 && delivered > 0
        ? 'Every attempted pending proposal received a successful response from the configured sink.'
        : 'One or more proposals remain pending; no completion claim is emitted.'
    };
  }

  return Object.freeze({
    CANONICAL,
    ROUTE,
    STAGES,
    buildEnvelope,
    preflight,
    create,
    get,
    list,
    countPending,
    syncPending,
    _test: Object.freeze({ stableStringify, sha256 })
  });
});
