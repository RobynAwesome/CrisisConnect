/* CrisisConnect governed offline outbox
 * Canonical source: RobynAwesome/Introduction-to-MCP
 * @ 70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a
 * APU -> Progressive Update -> #NB -> bounded CRUD -> SWFUS
 *
 * This module is intentionally usable in both Window and ServiceWorker scopes.
 * Incident reports are pending proposals/testimony, never verified incident truth.
 */
(function (root) {
  'use strict';

  const CONTRACT = Object.freeze({
    repository: 'RobynAwesome/Introduction-to-MCP',
    commit: '70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a',
    schema: 'kpgs.progressive-update.v1',
    receiptSchema: 'kpgs.swfus.receipt.v1',
    boundaryMarker: '#NB',
    domain: 'crisisconnect.kopanolabs.com',
    lane: 'incident-report-outbox'
  });

  const STAGES = Object.freeze([
    'TELEMETRY',
    'CLASSIFICATION',
    'ROUTING',
    'PROTOCOL_SELECTION',
    'INVARIANT_AUDIT',
    'POC_FOC_CHECK',
    'STATE_UPDATE',
    'DISTRIBUTION'
  ]);

  const DB_NAME = 'crisisconnect-governed-outbox-v1';
  const DB_VERSION = 1;
  const OUTBOX_STORE = 'outbox';
  const SETTINGS_STORE = 'settings';
  const ENDPOINT_KEY = 'sync_endpoint';

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    const token = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${token}`;
  }

  function nonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function stageMap() {
    return STAGES.map(stage => ({
      stage,
      status: 'NOT_REACHED',
      reason: 'prior governance gate stopped progression'
    }));
  }

  function setStage(receipt, name, status, reason) {
    const target = receipt.stages.find(item => item.stage === name);
    if (!target) throw new Error(`Unknown KPGS stage: ${name}`);
    target.status = status;
    target.reason = reason;
  }

  function receiptId(updateId, disposition, suffix) {
    // Receipt IDs are stable for a single local mutation attempt. The stable
    // update identity, not this UI-friendly ID, controls exact replay upstream.
    return `cc-swfus-${updateId}-${disposition.toLowerCase()}${suffix ? `-${suffix}` : ''}`;
  }

  function createReceipt(update, disposition) {
    return {
      schema: CONTRACT.receiptSchema,
      receipt_id: receiptId(update.update_id || 'missing', disposition),
      update_id: update.update_id || '',
      node_id: update.node_id || '',
      operation: 'CREATE',
      disposition,
      stages: stageMap(),
      synchronized: false,
      canonical: false,
      authority_effect: 'none',
      transport_grants_authority: false,
      canonical_authority_changed: false,
      state_digest: null,
      evidence_refs: [],
      correlation_id: update.correlation_id || '',
      boundary_marker: update.boundary_marker || '',
      replayed: false,
      created_at: nowIso()
    };
  }

  function stop(update, stageName, disposition, status, reason) {
    const receipt = createReceipt(update, disposition);
    const passedBefore = STAGES.slice(0, STAGES.indexOf(stageName));
    for (const name of passedBefore) {
      // Only stages explicitly populated by validateUpdate are converted to PASS.
      // This function is also used for storage failures after preflight.
      const source = update.__preflightStages && update.__preflightStages[name];
      if (source) setStage(receipt, name, source.status, source.reason);
    }
    setStage(receipt, stageName, status, reason);
    return receipt;
  }

  function normalizeReport(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
    const type = nonEmpty(report.type) ? report.type.trim() : '';
    const severity = nonEmpty(report.severity) ? report.severity.trim() : '';
    const location = nonEmpty(report.location) ? report.location.trim() : '';
    const description = nonEmpty(report.description) ? report.description.trim() : '';
    if (!type || !severity || !location || !description) return null;
    return {
      id: nonEmpty(report.id) ? report.id.trim() : makeId('incident-local'),
      type,
      severity,
      title: nonEmpty(report.title) ? report.title.trim() : `${type} — ${location}`,
      location,
      description,
      contact: nonEmpty(report.contact) ? report.contact.trim() : '',
      time: nonEmpty(report.time) ? report.time : 'just now',
      trust: 'unverified',
      timestamp: nonEmpty(report.timestamp) ? report.timestamp : nowIso(),
      synced: false
    };
  }

  function createUpdate(report, overrides) {
    const updateId = nonEmpty(overrides && overrides.update_id)
      ? overrides.update_id.trim()
      : makeId('cc-report');
    const correlationId = nonEmpty(overrides && overrides.correlation_id)
      ? overrides.correlation_id.trim()
      : updateId;
    return Object.assign({
      schema: CONTRACT.schema,
      update_id: updateId,
      node_id: `crisisconnect:incident-report-outbox:${updateId}`,
      domain: CONTRACT.domain,
      lane: CONTRACT.lane,
      protocol: CONTRACT.schema,
      canonical_source_sha: CONTRACT.commit,
      apu_state: 'GREEN',
      boundary_marker: CONTRACT.boundaryMarker,
      crud_intent: 'CREATE',
      state_class: 'pending_proposal',
      authority_effect: 'none',
      foc_asserted: false,
      poc_evidence_refs: ['runtime://crisisconnect/report-form/validated'],
      correlation_id: correlationId,
      source: 'crisisconnect-report-form',
      report
    }, overrides || {});
  }

  function validateUpdate(update) {
    const receipt = createReceipt(update, 'HELD');
    update.__preflightStages = {};
    const pass = (name, reason) => {
      setStage(receipt, name, 'PASS', reason);
      update.__preflightStages[name] = { status: 'PASS', reason };
    };

    if (!nonEmpty(update.update_id) || !nonEmpty(update.node_id)) {
      return stop(update, 'TELEMETRY', 'REJECTED', 'REJECT', 'stable update_id and node_id are required');
    }
    pass('TELEMETRY', 'stable local incident proposal identity admitted');

    if (update.state_class !== 'pending_proposal' || update.authority_effect !== 'none') {
      return stop(update, 'CLASSIFICATION', 'REJECTED', 'REJECT', 'incident outbox admits pending_proposal with authority_effect=none only');
    }
    pass('CLASSIFICATION', 'incident testimony classified as pending_proposal, never verified incident truth');

    if (update.domain !== CONTRACT.domain || update.lane !== CONTRACT.lane) {
      return stop(update, 'ROUTING', 'REJECTED', 'REJECT', 'domain/lane must route to CrisisConnect incident-report-outbox');
    }
    pass('ROUTING', `${CONTRACT.domain} / ${CONTRACT.lane}`);

    if (update.protocol !== CONTRACT.schema || update.schema !== CONTRACT.schema || update.canonical_source_sha !== CONTRACT.commit) {
      return stop(update, 'PROTOCOL_SELECTION', 'REJECTED', 'REJECT', 'canonical progressive-update protocol/source SHA mismatch');
    }
    pass('PROTOCOL_SELECTION', `${CONTRACT.schema} pinned to ${CONTRACT.commit}`);

    const apu = String(update.apu_state || 'UNSPECIFIED').toUpperCase();
    if (update.crud_intent !== 'CREATE') {
      return stop(update, 'INVARIANT_AUDIT', 'REJECTED', 'REJECT', 'incident outbox pilot is bounded to CRUD CREATE');
    }
    if (update.boundary_marker !== CONTRACT.boundaryMarker) {
      return stop(update, 'INVARIANT_AUDIT', 'HELD', 'HOLD', 'literal #NB boundary marker is required before durable outbox mutation');
    }
    if (apu === 'RED') {
      return stop(update, 'INVARIANT_AUDIT', 'REJECTED', 'REJECT', 'APU RED rejects durable local mutation');
    }
    if (apu !== 'GREEN') {
      return stop(update, 'INVARIANT_AUDIT', 'HELD', 'HOLD', 'durable local mutation requires APU GREEN');
    }
    pass('INVARIANT_AUDIT', 'literal #NB present; CREATE bounded; APU GREEN; authority remains none');

    if (update.foc_asserted === true) {
      return stop(update, 'POC_FOC_CHECK', 'REJECTED', 'REJECT', 'explicit FOC cannot cross the local outbox mutation membrane');
    }
    const normalized = normalizeReport(update.report);
    if (!normalized || !Array.isArray(update.poc_evidence_refs) || update.poc_evidence_refs.length === 0) {
      return stop(update, 'POC_FOC_CHECK', 'HELD', 'HOLD', 'validated local report-form evidence is required; incident truth itself is not asserted');
    }
    update.report = normalized;
    pass('POC_FOC_CHECK', 'local report schema/form evidence admitted; testimony remains unverified');

    receipt.disposition = 'HELD';
    receipt.receipt_id = receiptId(update.update_id, 'HELD', 'preflight');
    return receipt;
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
          store.createIndex('created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
  }

  async function withStore(storeName, mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = fn(store, tx);
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  async function putRecord(record) {
    await withStore(OUTBOX_STORE, 'readwrite', store => {
      store.put(record);
    });
  }

  async function deleteRecord(updateId) {
    await withStore(OUTBOX_STORE, 'readwrite', store => {
      store.delete(updateId);
    });
  }

  async function listPending() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE, 'readonly');
        const store = tx.objectStore(OUTBOX_STORE);
        const request = store.getAll();
        request.onsuccess = () => {
          const rows = (request.result || [])
            .filter(row => row.status === 'pending')
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          resolve(rows);
        };
        request.onerror = () => reject(request.error || new Error('Outbox read failed'));
      });
    } finally {
      db.close();
    }
  }

  async function configureEndpoint(endpoint) {
    const value = nonEmpty(endpoint) ? endpoint.trim() : '';
    await withStore(SETTINGS_STORE, 'readwrite', store => {
      store.put({ key: ENDPOINT_KEY, value });
    });
    return value;
  }

  async function configuredEndpoint() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, 'readonly');
        const request = tx.objectStore(SETTINGS_STORE).get(ENDPOINT_KEY);
        request.onsuccess = () => resolve(request.result && nonEmpty(request.result.value) ? request.result.value.trim() : '');
        request.onerror = () => reject(request.error || new Error('Settings read failed'));
      });
    } finally {
      db.close();
    }
  }

  async function enqueueReport(report, overrides) {
    const normalized = normalizeReport(report);
    const update = createUpdate(normalized || report, overrides);
    const preflight = validateUpdate(update);
    const failedStage = preflight.stages.find(item => item.status === 'HOLD' || item.status === 'REJECT');
    if (failedStage) {
      return { persisted: false, update, receipt: preflight };
    }

    try {
      const receipt = createReceipt(update, 'HELD');
      for (const name of STAGES.slice(0, 6)) {
        const source = update.__preflightStages[name];
        setStage(receipt, name, source.status, source.reason);
      }
      setStage(receipt, 'STATE_UPDATE', 'PASS', 'incident pending proposal persisted durably in IndexedDB outbox');
      setStage(receipt, 'DISTRIBUTION', 'NOT_REACHED', 'no upstream delivery receipt exists yet');
      receipt.disposition = 'HELD';
      receipt.synchronized = false;
      receipt.evidence_refs = ['indexeddb://crisisconnect-governed-outbox-v1/outbox', ...update.poc_evidence_refs];
      receipt.receipt_id = receiptId(update.update_id, 'HELD', 'local');
      receipt.created_at = nowIso();

      const record = {
        update_id: update.update_id,
        update,
        report: update.report,
        local_receipt: receipt,
        status: 'pending',
        attempts: 0,
        last_error: null,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      await putRecord(record);
      return { persisted: true, update, receipt, record };
    } catch (error) {
      const receipt = stop(update, 'STATE_UPDATE', 'REJECTED', 'REJECT', `IndexedDB persistence failed: ${error && error.message ? error.message : 'unknown error'}`);
      return { persisted: false, update, receipt, error };
    }
  }

  function validRemoteReceipt(value, record) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schema !== CONTRACT.receiptSchema) return false;
    if (value.update_id !== record.update_id) return false;
    if (value.node_id !== record.update.node_id) return false;
    if (value.operation !== 'CREATE') return false;
    if (value.disposition !== 'APPLIED' || value.synchronized !== true) return false;
    if (value.canonical !== false || value.authority_effect !== 'none' || value.transport_grants_authority !== false) return false;
    if (value.canonical_authority_changed !== false) return false;
    if (value.boundary_marker !== CONTRACT.boundaryMarker) return false;
    if (!Array.isArray(value.stages) || value.stages.length !== STAGES.length) return false;
    return value.stages.every((stage, index) => stage && stage.stage === STAGES[index] && nonEmpty(stage.status));
  }

  async function syncPending(explicitEndpoint) {
    const rows = await listPending();
    if (rows.length === 0) {
      return { status: 'empty', pending: 0, delivered: 0, failed: 0 };
    }

    const endpoint = nonEmpty(explicitEndpoint) ? explicitEndpoint.trim() : await configuredEndpoint();
    if (!endpoint) {
      return {
        status: 'pending',
        reason: 'NO_ENDPOINT',
        pending: rows.length,
        delivered: 0,
        failed: 0
      };
    }

    let delivered = 0;
    let failed = 0;
    for (const record of rows) {
      record.attempts += 1;
      record.updated_at = nowIso();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': record.update_id,
            'X-KPGS-Source-SHA': CONTRACT.commit
          },
          body: JSON.stringify(record.update)
        });
        if (!response.ok) {
          record.last_error = `HTTP_${response.status}`;
          await putRecord(record);
          failed += 1;
          continue;
        }
        const receipt = await response.json();
        if (!validRemoteReceipt(receipt, record)) {
          record.last_error = 'INVALID_SWFUS_RECEIPT';
          await putRecord(record);
          failed += 1;
          continue;
        }

        await deleteRecord(record.update_id);
        delivered += 1;
      } catch (error) {
        record.last_error = error && error.message ? error.message : 'NETWORK_FAILURE';
        await putRecord(record);
        failed += 1;
      }
    }

    const remaining = await listPending();
    return {
      status: remaining.length === 0 && delivered > 0 ? 'complete' : 'pending',
      pending: remaining.length,
      delivered,
      failed
    };
  }

  root.CrisisOutbox = Object.freeze({
    CONTRACT,
    STAGES,
    enqueueReport,
    listPending,
    configureEndpoint,
    configuredEndpoint,
    syncPending,
    validateUpdate,
    createUpdate,
    validRemoteReceipt
  });
})(typeof self !== 'undefined' ? self : globalThis);
