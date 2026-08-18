/*
 * CrisisConnect KPGS Progressive Update Adapter
 * Canonical source:
 * RobynAwesome/Introduction-to-MCP@70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a
 *
 * This browser/worker adapter can persist pending incident proposals. It cannot
 * verify incident truth, dispatch responders, or grant crisis-response authority.
 */
(function (root) {
  'use strict';

  const CANONICAL_SOURCE = Object.freeze({
    repository: 'RobynAwesome/Introduction-to-MCP',
    commit: '70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a',
    contract: 'kpgs.progressive-update.v1',
    chain: 'APU -> Progressive Update -> #NB -> bounded CRUD -> SWFUS'
  });

  const DB_NAME = 'crisisconnect-kpgs-v1';
  const DB_VERSION = 1;
  const OUTBOX_STORE = 'incident_outbox';
  const STAGE_ORDER = Object.freeze([
    'telemetry',
    'classification',
    'routing',
    'protocolSelection',
    'invariantAudit',
    'pocFocCheck',
    'stateUpdate',
    'distribution'
  ]);

  function stage(status, detail) {
    return { status, detail };
  }

  function newUpdateId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    const random = Math.random().toString(16).slice(2);
    return `cc-${Date.now().toString(36)}-${random}`;
  }

  function newReceipt(updateId) {
    const stages = {};
    STAGE_ORDER.forEach((name) => {
      stages[name] = stage('NOT_REACHED', `${name} not reached.`);
    });
    return {
      schema: 'crisisconnect.kpgs.incident-outbox.v1',
      updateId,
      canonicalSource: CANONICAL_SOURCE,
      canonical: false,
      authorityEffect: 'none',
      transportGrantsAuthority: false,
      outcome: 'READY',
      code: 'KPGS_PREFLIGHT',
      stages,
      evidenceRefs: [],
      replay: false,
      transportReceipt: null
    };
  }

  function stop(receipt, stageName, outcome, code, detail) {
    receipt.stages[stageName] = stage(outcome, detail);
    receipt.outcome = outcome;
    receipt.code = code;
    return { admitted: false, receipt };
  }

  function defaultEnvelope(updateId) {
    return {
      update_id: updateId,
      domain: 'crisisconnect.kopanolabs.com',
      lane: 'incident-report-outbox',
      protocol: CANONICAL_SOURCE.contract,
      canonical_source_sha: CANONICAL_SOURCE.commit,
      apu_state: 'GREEN',
      boundary_marker: '#NB',
      crud_intent: 'CREATE',
      state_class: 'pending_proposal',
      authority_effect: 'none',
      foc_asserted: false
    };
  }

  function preflightIncidentReport(report, envelopeOverrides) {
    const updateId = envelopeOverrides && envelopeOverrides.update_id
      ? envelopeOverrides.update_id
      : newUpdateId();
    const envelope = Object.assign(defaultEnvelope(updateId), envelopeOverrides || {});
    const receipt = newReceipt(envelope.update_id || null);

    if (typeof envelope.update_id !== 'string' || !envelope.update_id.trim()) {
      return stop(receipt, 'telemetry', 'REJECT', 'INVALID_UPDATE_ID', 'A stable update_id is required before local mutation.');
    }
    receipt.stages.telemetry = stage('PASS', 'Stable local update identity admitted.');

    if (envelope.state_class === 'constitutional_truth') {
      return stop(receipt, 'classification', 'REJECT', 'AUTHORITATIVE_STATE_FORBIDDEN', 'A citizen incident report cannot self-promote into constitutional or verified truth.');
    }
    if (envelope.state_class !== 'pending_proposal' || envelope.authority_effect !== 'none') {
      return stop(receipt, 'classification', 'REJECT', 'INVALID_STATE_CLASS', 'Incident outbox accepts pending_proposal with authority_effect=none only.');
    }
    receipt.stages.classification = stage('PASS', 'Report classified as a non-authoritative pending proposal.');

    if (envelope.domain !== 'crisisconnect.kopanolabs.com' || envelope.lane !== 'incident-report-outbox') {
      return stop(receipt, 'routing', 'REJECT', 'ROUTING_SCOPE_MISMATCH', 'Report is outside the CrisisConnect incident outbox lane.');
    }
    receipt.stages.routing = stage('PASS', 'Routed to CrisisConnect local incident-report outbox.');

    if (envelope.protocol !== CANONICAL_SOURCE.contract || envelope.canonical_source_sha !== CANONICAL_SOURCE.commit) {
      return stop(receipt, 'protocolSelection', 'REJECT', 'CANONICAL_PROTOCOL_MISMATCH', 'Progressive update protocol/source pin does not match Introduction-to-MCP.');
    }
    receipt.stages.protocolSelection = stage('PASS', 'Pinned canonical progressive-update protocol selected.');

    if (envelope.crud_intent !== 'CREATE') {
      return stop(receipt, 'invariantAudit', 'REJECT', 'CRUD_SCOPE_MISMATCH', 'This pilot is bounded to CREATE local incident proposals.');
    }
    if (envelope.boundary_marker !== '#NB') {
      return stop(receipt, 'invariantAudit', 'HOLD', 'NB_BOUNDARY_REQUIRED', 'Literal #NB is required before local outbox mutation.');
    }
    if (envelope.apu_state === 'RED') {
      return stop(receipt, 'invariantAudit', 'REJECT', 'APU_RED', 'APU RED rejects local mutation.');
    }
    if (envelope.apu_state !== 'GREEN') {
      return stop(receipt, 'invariantAudit', 'HOLD', 'APU_NOT_GREEN', 'Local outbox CREATE requires APU GREEN.');
    }
    receipt.stages.invariantAudit = stage('PASS', 'Literal #NB present; CREATE bounded; APU GREEN; authority remains none.');

    if (envelope.foc_asserted === true) {
      return stop(receipt, 'pocFocCheck', 'REJECT', 'FOC_ASSERTED', 'Explicit FOC cannot cross the local mutation membrane.');
    }

    const required = ['id', 'type', 'severity', 'location', 'description', 'timestamp'];
    const missing = required.filter((key) => !report || typeof report[key] !== 'string' || !report[key].trim());
    if (missing.length) {
      return stop(receipt, 'pocFocCheck', 'HOLD', 'LOCAL_FORM_EVIDENCE_INCOMPLETE', `Missing local report fields: ${missing.join(', ')}.`);
    }

    receipt.evidenceRefs = [
      'browser://crisisconnect/report-form/submitted',
      'browser://crisisconnect/report-fields/validated',
      'browser://crisisconnect/indexeddb/available'
    ];
    receipt.stages.pocFocCheck = stage('PASS', 'Local form structure is sufficient for a pending proposal only; incident truth remains unverified.');
    receipt.stages.stateUpdate = stage('READY', 'IndexedDB pending-proposal CREATE is admitted.');
    receipt.outcome = 'READY';
    receipt.code = 'LOCAL_PERSISTENCE_READY';

    return { admitted: true, envelope, receipt };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'update_id' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('queued_at', 'queued_at', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      const tx = db.transaction(OUTBOX_STORE, mode);
      const store = tx.objectStore(OUTBOX_STORE);
      const value = await fn(store);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
      return value;
    } finally {
      db.close();
    }
  }

  async function queueIncidentReport(report, envelopeOverrides) {
    const preflight = preflightIncidentReport(report, envelopeOverrides);
    if (!preflight.admitted) return preflight;

    const { envelope, receipt } = preflight;
    const record = {
      update_id: envelope.update_id,
      status: 'pending',
      queued_at: new Date().toISOString(),
      attempts: 0,
      payload: report,
      envelope,
      receipt
    };

    try {
      await withStore('readwrite', async (store) => {
        const existing = await requestResult(store.get(record.update_id));
        if (existing) {
          const samePayload = JSON.stringify(existing.payload) === JSON.stringify(record.payload);
          if (!samePayload) throw new Error('update_id collision with different payload');
          record.receipt = Object.assign({}, existing.receipt, {
            replay: true,
            code: 'IDEMPOTENT_REPLAY'
          });
          return;
        }
        await requestResult(store.add(record));
      });

      if (!record.receipt.replay) {
        record.receipt.stages.stateUpdate = stage('PASS', 'Pending incident proposal persisted durably in IndexedDB.');
        record.receipt.stages.distribution = stage('NOT_REACHED', 'No upstream sink has confirmed delivery.');
        record.receipt.outcome = 'APPLIED';
        record.receipt.code = 'LOCAL_OUTBOX_APPLIED';
        await withStore('readwrite', async (store) => {
          await requestResult(store.put(record));
        });
      }
      return { admitted: true, envelope, receipt: record.receipt, record };
    } catch (error) {
      receipt.stages.stateUpdate = stage('HOLD', `Local persistence failed: ${error.message || error}.`);
      receipt.outcome = 'HOLD';
      receipt.code = 'LOCAL_PERSISTENCE_FAILED';
      return { admitted: false, envelope, receipt, error };
    }
  }

  async function listOutbox() {
    return withStore('readonly', async (store) => {
      const all = await requestResult(store.getAll());
      return all.sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
    });
  }

  async function listPendingOutbox() {
    const all = await listOutbox();
    return all.filter((record) => record.status === 'pending');
  }

  async function countPendingOutbox() {
    const pending = await listPendingOutbox();
    return pending.length;
  }

  async function markDeliveryAttempt(updateId, detail) {
    return withStore('readwrite', async (store) => {
      const record = await requestResult(store.get(updateId));
      if (!record) return null;
      record.attempts = (record.attempts || 0) + 1;
      record.last_attempt = new Date().toISOString();
      record.last_transport_detail = detail || null;
      await requestResult(store.put(record));
      return record;
    });
  }

  async function markDelivered(updateId, transportReceipt) {
    if (!transportReceipt || transportReceipt.ok !== true || !transportReceipt.endpoint) {
      throw new Error('A successful endpoint transport receipt is required before distribution PASS.');
    }
    return withStore('readwrite', async (store) => {
      const record = await requestResult(store.get(updateId));
      if (!record) return null;
      record.status = 'delivered';
      record.delivered_at = new Date().toISOString();
      record.transport_receipt = transportReceipt;
      record.receipt = Object.assign({}, record.receipt, {
        outcome: 'APPLIED',
        code: 'SWFUS_DISTRIBUTION_CONFIRMED',
        transportReceipt,
        stages: Object.assign({}, record.receipt.stages, {
          distribution: stage('PASS', 'Configured upstream sink returned success for this exact update.')
        })
      });
      await requestResult(store.put(record));
      return record;
    });
  }

  root.CCKpgs = Object.freeze({
    CANONICAL_SOURCE,
    STAGE_ORDER,
    DB_NAME,
    OUTBOX_STORE,
    newUpdateId,
    preflightIncidentReport,
    queueIncidentReport,
    listOutbox,
    listPendingOutbox,
    countPendingOutbox,
    markDeliveryAttempt,
    markDelivered
  });
})(globalThis);
