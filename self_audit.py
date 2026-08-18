#!/usr/bin/env python3
"""Static KPGS proof for CrisisConnect's governed incident outbox.

This deliberately proves source invariants only. It does not claim a live remote
incident-delivery sink exists or that any incident has been externally verified.
"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
failures: list[str] = []
checks: list[str] = []


def require(path: str, needle: str, label: str) -> None:
    text = (ROOT / path).read_text(encoding="utf-8")
    if needle not in text:
        failures.append(f"{path}: missing {label}")
    else:
        checks.append(f"{path}: {label}")


def forbid(path: str, needle: str, label: str) -> None:
    text = (ROOT / path).read_text(encoding="utf-8")
    if needle in text:
        failures.append(f"{path}: forbidden {label}")
    else:
        checks.append(f"{path}: no {label}")


for required in ("index.html", "index.css", "app.js", "outbox.js", "sw.js", "manifest.json"):
    if not (ROOT / required).exists():
        failures.append(f"missing required file: {required}")
    else:
        checks.append(f"file:{required}")

# Canonical contract pin and exact membrane.
require("outbox.js", "70f40324978ee8c3c1a8a77a29e6ac84c7f6bf3a", "canonical Introduction-to-MCP commit pin")
require("outbox.js", "schema: 'kpgs.progressive-update.v1'", "Progressive Update schema")
require("outbox.js", "receiptSchema: 'kpgs.swfus.receipt.v1'", "SWFUS receipt schema")
require("outbox.js", "boundaryMarker: '#NB'", "literal #NB boundary")
for stage in (
    "TELEMETRY",
    "CLASSIFICATION",
    "ROUTING",
    "PROTOCOL_SELECTION",
    "INVARIANT_AUDIT",
    "POC_FOC_CHECK",
    "STATE_UPDATE",
    "DISTRIBUTION",
):
    require("outbox.js", f"'{stage}'", f"stage {stage}")

# Durable local state is pending proposal only; transport never grants authority.
require("outbox.js", "state_class: 'pending_proposal'", "pending_proposal classification")
require("outbox.js", "authority_effect: 'none'", "authority containment")
require("outbox.js", "transport_grants_authority: false", "transport non-authority")
require("outbox.js", "canonical: false", "non-canonical receipt")
require("outbox.js", "incident testimony classified as pending_proposal, never verified incident truth", "truth boundary wording")
require("outbox.js", "root.indexedDB.open(DB_NAME, DB_VERSION)", "IndexedDB durable outbox")
require("outbox.js", "incident pending proposal persisted durably in IndexedDB outbox", "local state receipt")
require("outbox.js", "no upstream delivery receipt exists yet", "distribution NOT_REACHED boundary")
require("outbox.js", "value.disposition !== 'APPLIED' || value.synchronized !== true", "remote APPLIED+synchronized receipt gate")
require("outbox.js", "value.canonical !== false || value.authority_effect !== 'none' || value.transport_grants_authority !== false", "remote authority receipt rejection")
require("outbox.js", "await deleteRecord(record.update_id)", "dequeue only after valid remote receipt")

# The service worker must not claim success merely because background sync ran.
require("sw.js", "importScripts('/outbox.js')", "shared governed outbox runtime")
require("sw.js", "result.status === 'complete' && result.delivered > 0 && result.pending === 0", "SYNC_COMPLETE delivery condition")
require("sw.js", "type: 'OUTBOX_PENDING'", "pending background-sync message")
require("sw.js", "type: 'OUTBOX_FAILED'", "failed background-sync message")
forbid("sw.js", "client.postMessage({ type: 'SYNC_COMPLETE', ts:", "unconditional fake SYNC_COMPLETE")

# Page wording/state must distinguish local persistence from external delivery.
require("app.js", "Report saved locally as an unverified pending proposal", "local-save user wording")
require("app.js", "Online connectivity is not synchronization", "online != synced invariant")
require("app.js", "No governed remote sync endpoint is configured yet", "no-endpoint disclosure")
require("app.js", "incrementSyncedCount(Number(event.data.delivered))", "synced counter tied to confirmed delivery")
forbid("app.js", "Incident reported successfully", "false remote-report success wording")
forbid("app.js", "Simulate sync", "simulated sync path")

if failures:
    print("KPGS CrisisConnect outbox proof: FAIL")
    for item in failures:
        print(f" - {item}")
    sys.exit(1)

print("KPGS CrisisConnect outbox proof: PASS")
for item in checks:
    print(f" + {item}")
print("BOUNDARY: STATIC SOURCE PROOF != LIVE REMOTE DELIVERY OR INCIDENT VERIFICATION")
