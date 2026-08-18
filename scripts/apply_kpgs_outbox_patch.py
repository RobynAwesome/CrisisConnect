from pathlib import Path

APP = Path('app.js')
INDEX = Path('index.html')

app = APP.read_text(encoding='utf-8')

# 1. Service-worker message semantics: success only means configured sink receipt,
# never incident verification or responder dispatch.
old_listener = """          navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data.type === 'SYNC_COMPLETE') {
              toast('Offline queue synced successfully', 'success');
              state.lastSync = new Date();
              updateSyncDisplay();
            }
          });"""
new_listener = """          navigator.serviceWorker.addEventListener('message', async (event) => {
            if (event.data.type === 'SYNC_COMPLETE') {
              await hydrateOutbox();
              toast('Configured sink confirmed proposal delivery — incident verification is still separate', 'success');
              state.lastSync = new Date();
              updateSyncDisplay();
            } else if (event.data.type === 'SYNC_PENDING') {
              await hydrateOutbox();
              toast(event.data.detail || 'Proposal remains saved locally — no upstream delivery confirmed', 'warning');
            }
          });"""
if old_listener in app:
    app = app.replace(old_listener, new_listener, 1)
elif new_listener not in app:
    raise SystemExit('service-worker listener anchor not found')

# 2. Replace report submission with the canonical local pending-proposal lane.
start = app.index('  /* ── 9. Report Form')
end = app.index('  /* ── 10. Offline Queue', start)
report_block = r'''  /* ── 9. Governed Incident Proposal / Durable Outbox ───────── */
  async function hydrateOutbox() {
    if (!window.CrisisOutbox) {
      state.offlineQueue = [];
      updateQueueBanner();
      return;
    }
    state.offlineQueue = await window.CrisisOutbox.list('pending');
    updateQueueBanner();
  }

  function newUpdateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `cc-${window.crypto.randomUUID()}`;
    }
    return `cc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function requestOutboxSync() {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    if ('SyncManager' in window && reg.sync) {
      try {
        await reg.sync.register('cc-offline-queue');
        return;
      } catch (_) {
        // Fall through to direct SW message. The outbox remains durable either way.
      }
    }
    const worker = navigator.serviceWorker.controller || reg.active;
    if (worker) worker.postMessage({ type: 'PROCESS_OUTBOX' });
  }

  function initReportForm() {
    const form = $('#reportForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!window.CrisisOutbox) {
        toast('Local proposal store unavailable — report was not submitted', 'error');
        return;
      }

      const report = {
        id: `INC-${String(state.incidents.length + 1).padStart(3, '0')}`,
        type: $('#incidentType').value,
        severity: $('#incidentSeverity').value,
        title: `${$('#incidentType').selectedOptions[0]?.text || 'Report'} — ${$('#incidentLocation').value}`,
        location: $('#incidentLocation').value,
        description: $('#incidentDescription').value,
        contact: $('#reporterContact').value,
        time: 'just now',
        trust: 'unverified',
        proposalState: 'pending_proposal',
        timestamp: new Date().toISOString(),
        synced: false
      };

      const updateId = newUpdateId();
      const envelope = window.CrisisOutbox.buildEnvelope(updateId);
      const result = await window.CrisisOutbox.create(report, envelope);

      if (!result.ok) {
        const failedStage = Object.values(result.receipt.stages)
          .find(value => value.status === 'HOLD' || value.status === 'REJECT');
        toast(failedStage?.detail || 'Governed proposal was held before local persistence', 'error');
        return;
      }

      state.incidents.unshift(report);
      await hydrateOutbox();
      renderIncidents();
      updateStats();
      form.reset();

      toast(
        result.replay
          ? 'This proposal was already saved locally — no duplicate created'
          : 'Report saved on this device as a pending proposal — no dispatch or verification confirmed',
        'warning'
      );

      // Connectivity is permission to attempt transport, not evidence of receipt.
      if (navigator.onLine) {
        requestOutboxSync().catch(err => console.warn('[CC] Outbox sync request held:', err));
      }
    });
  }

'''
app = app[:start] + report_block + app[end:]

# 3. Force-sync must ask the service worker to attempt the durable outbox; it may
# never clear local proposals or announce completion by timer.
start = app.index('  /* ── 15. Force Sync Button')
end = app.index('  /* ── 16. Clock', start)
force_block = r'''  /* ── 15. Governed Delivery Attempt Button ───────────────── */
  function initForceSync() {
    const syncBtn = $('#forceSync');
    const syncAllBtn = $('#syncAll');

    async function doSync() {
      await hydrateOutbox();
      if (state.offlineQueue.length === 0) {
        toast('No pending local proposals', 'info');
        return;
      }
      if (!navigator.onLine) {
        toast('Still offline — pending proposals remain safely on this device', 'warning');
        return;
      }

      toast(`Checking delivery path for ${state.offlineQueue.length} pending proposal(s)…`, 'info');
      try {
        await requestOutboxSync();
      } catch (err) {
        console.warn('[CC] Governed sync request failed:', err);
        toast('Delivery attempt unavailable — proposals remain saved locally', 'warning');
      }
    }

    if (syncBtn) syncBtn.addEventListener('click', doSync);
    if (syncAllBtn) syncAllBtn.addEventListener('click', doSync);
  }

'''
app = app[:start] + force_block + app[end:]

# 4. Hydrate durable queue state after reload. This proves the UI is derived from
# IndexedDB rather than the old in-memory array alone.
old_init = """    initReportForm();
    updateQueueBanner();
    updateSyncDisplay();"""
new_init = """    initReportForm();
    updateQueueBanner();
    hydrateOutbox().catch(err => console.warn('[CC] Outbox hydration failed:', err));
    updateSyncDisplay();"""
if old_init in app:
    app = app.replace(old_init, new_init, 1)
elif new_init not in app:
    raise SystemExit('init hydration anchor not found')

APP.write_text(app, encoding='utf-8')

index = INDEX.read_text(encoding='utf-8')
old_script = '  <script src="app.js"></script>'
new_script = '  <script src="kpgs-outbox.js"></script>\n  <script src="app.js"></script>'
if old_script in index and 'src="kpgs-outbox.js"' not in index:
    index = index.replace(old_script, new_script, 1)
elif 'src="kpgs-outbox.js"' not in index:
    raise SystemExit('index script anchor not found')
INDEX.write_text(index, encoding='utf-8')
