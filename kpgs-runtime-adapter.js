/*
 * CrisisConnect runtime adapter for the governed durable incident outbox.
 *
 * This script intentionally sits beside the existing Adaptive PWA engine. It
 * intercepts only incident proposal CREATE and delivery-attempt controls. It
 * does not dispatch responders, verify incidents, or replace the existing UI.
 */
(function () {
  'use strict';

  const OUTBOX = () => window.CrisisOutbox;
  const PROFILE_KEY = 'cc_pilot_profile';

  function $(selector) {
    return document.querySelector(selector);
  }

  function showNotice(message, type) {
    const container = $('#toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type || 'info'}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 300);
    }, 4200);
  }

  function newUpdateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `cc-${window.crypto.randomUUID()}`;
    }
    return `cc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function updatePilotCounts(field, delta) {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      const profile = raw ? JSON.parse(raw) : {};
      profile[field] = (profile[field] || 0) + delta;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {
      // Pilot counters are convenience projection state, never outbox authority.
    }
  }

  function proposalRow(record) {
    const report = record.payload;
    const row = document.createElement('div');
    row.className = 'incident-item';
    row.dataset.kpgsUpdateId = record.updateId;
    row.innerHTML = `
      <div class="incident-severity ${escapeClass(report.severity || 'medium')}"></div>
      <div class="incident-info">
        <h4>${escapeHtml(report.title || 'Pending incident proposal')}</h4>
        <p>${escapeHtml(report.location || 'Location pending')} · local pending proposal</p>
      </div>
      <span class="trust-badge unverified">unverified</span>
      <span class="incident-time">pending</span>
    `;
    return row;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[ch]);
  }

  function escapeClass(value) {
    return String(value).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'medium';
  }

  function renderProposal(record) {
    for (const selector of ['#incidentList', '#fullIncidentList']) {
      const list = $(selector);
      if (!list) continue;
      if (list.querySelector(`[data-kpgs-update-id="${CSS.escape(record.updateId)}"]`)) continue;
      list.prepend(proposalRow(record));
    }
  }

  async function renderDurableState() {
    const outbox = OUTBOX();
    if (!outbox) return;
    const pending = await outbox.list('pending');

    const banner = $('#offlineQueueBanner');
    const queueCount = $('#queueCount');
    const queueBadge = $('#queueBadge');
    const statQueued = $('#statQueued');
    const umpQueueBadge = $('#umpQueueBadge');
    const count = pending.length;

    if (banner) banner.classList.toggle('visible', count > 0);
    if (queueCount) queueCount.textContent = String(count);
    if (queueBadge) {
      queueBadge.textContent = String(count);
      queueBadge.classList.toggle('hidden', count === 0);
    }
    if (statQueued) statQueued.textContent = String(count);
    if (umpQueueBadge) {
      umpQueueBadge.textContent = String(count);
      umpQueueBadge.classList.toggle('is-hidden', count === 0);
    }

    pending.forEach(renderProposal);
  }

  function formPayload(form) {
    const type = form.querySelector('#incidentType');
    const severity = form.querySelector('#incidentSeverity');
    const location = form.querySelector('#incidentLocation');
    const description = form.querySelector('#incidentDescription');
    const contact = form.querySelector('#reporterContact');
    const locationValue = location ? location.value.trim() : '';
    const typeLabel = type && type.selectedOptions && type.selectedOptions[0]
      ? type.selectedOptions[0].text
      : 'Report';

    return {
      id: `LOCAL-${Date.now()}`,
      type: type ? type.value : '',
      severity: severity ? severity.value : 'medium',
      title: `${typeLabel || 'Report'} — ${locationValue}`,
      location: locationValue,
      description: description ? description.value.trim() : '',
      contact: contact ? contact.value.trim() : '',
      time: 'just now',
      trust: 'unverified',
      proposalState: 'pending_proposal',
      timestamp: new Date().toISOString(),
      synced: false
    };
  }

  async function submitProposal(form) {
    const outbox = OUTBOX();
    if (!outbox) {
      showNotice('Local proposal store unavailable — report was not submitted', 'error');
      return;
    }

    const updateId = newUpdateId();
    const payload = formPayload(form);
    const result = await outbox.create(payload, outbox.buildEnvelope(updateId));
    if (!result.ok) {
      const failed = Object.values(result.receipt.stages)
        .find(value => value.status === 'HOLD' || value.status === 'REJECT');
      showNotice(failed?.detail || 'Proposal held before local persistence', 'error');
      return;
    }

    form.reset();
    updatePilotCounts('reports_count', result.replay ? 0 : 1);
    renderProposal(result.record);
    await renderDurableState();
    showNotice(
      result.replay
        ? 'This proposal was already saved locally — no duplicate created'
        : 'Report saved on this device as a pending proposal — no dispatch or verification confirmed',
      'warning'
    );

    if (navigator.onLine) requestDeliveryAttempt();
  }

  async function requestDeliveryAttempt() {
    if (!('serviceWorker' in navigator)) {
      showNotice('Delivery service unavailable — proposal remains saved locally', 'warning');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    if ('SyncManager' in window && reg.sync) {
      try {
        await reg.sync.register('cc-offline-queue');
        return;
      } catch (_) {
        // Fall through to direct message; local durability is already established.
      }
    }

    const worker = navigator.serviceWorker.controller || reg.active;
    if (worker) {
      worker.postMessage({ type: 'PROCESS_OUTBOX' });
    } else {
      showNotice('Delivery worker unavailable — proposal remains saved locally', 'warning');
    }
  }

  async function forceDeliveryAttempt() {
    const outbox = OUTBOX();
    if (!outbox) return;
    const count = await outbox.countPending();
    if (count === 0) {
      showNotice('No pending local proposals', 'info');
      return;
    }
    if (!navigator.onLine) {
      showNotice('Still offline — pending proposals remain safely on this device', 'warning');
      return;
    }
    showNotice(`Checking configured delivery path for ${count} pending proposal(s)…`, 'info');
    await requestDeliveryAttempt();
  }

  function installEventMembrane() {
    // Capture phase deliberately runs before the legacy simulated handlers. The
    // existing UI remains rendered by app.js while mutation semantics are owned
    // by the governed adapter.
    document.addEventListener('submit', event => {
      if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'reportForm') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      submitProposal(event.target).catch(error => {
        console.warn('[CC/KPGS] Proposal persistence failed:', error);
        showNotice('Proposal could not be stored — no submission claim was made', 'error');
      });
    }, true);

    document.addEventListener('click', event => {
      const target = event.target instanceof Element
        ? event.target.closest('#forceSync, #syncAll')
        : null;
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      forceDeliveryAttempt().catch(error => {
        console.warn('[CC/KPGS] Delivery attempt held:', error);
        showNotice('Delivery attempt failed — proposals remain saved locally', 'warning');
      });
    }, true);

    window.addEventListener('online', () => renderDurableState().catch(() => {}));
    window.addEventListener('offline', () => renderDurableState().catch(() => {}));
  }

  function installWorkerReceiptListener() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', event => {
      if (!event.data) return;
      if (event.data.type === 'SYNC_COMPLETE') {
        updatePilotCounts('synced_count', Number(event.data.delivered || 0));
        showNotice('Configured sink confirmed proposal delivery — incident verification is still separate', 'success');
        renderDurableState().catch(() => {});
      } else if (event.data.type === 'SYNC_PENDING') {
        showNotice(event.data.detail || 'No upstream delivery confirmed — proposal remains local', 'warning');
        renderDurableState().catch(() => {});
      }
    });
  }

  function init() {
    if (!OUTBOX()) {
      console.error('[CC/KPGS] kpgs-outbox.js was not loaded; governed mutation membrane unavailable.');
      return;
    }
    installEventMembrane();
    installWorkerReceiptListener();
    renderDurableState().catch(error => console.warn('[CC/KPGS] Outbox hydration held:', error));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
