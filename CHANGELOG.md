# Changelog

## 2.0.0 — 2026-09-07

Production release. Breaking: new flat options object (see README "Migrating from 1.x").

- Incremental updates instead of broadcasting the full document on every change.
- Two-way sync protocol on connect so late joiners and offline edits reconcile.
- Debounced, retried persistence with `flush()` and unload handling.
- Awareness heartbeat, no echo of remote awareness, clean removal on disconnect/destroy.
- Automatic reconnect with exponential backoff.
- Chunking for payloads above the broadcast size limit.
- Private channel support and example `realtime.messages` policies.
- `persistMode: 'update'`, `extraRow`, `schema`, `persist`, and `load`/`save` hooks.
- Update-mode saves verify a row was written, so RLS denials surface as errors instead of silent no-ops.
- `destroy()` lets the awareness goodbye leave the socket before closing the channel, and peers answer `sync-request` with their awareness so newcomers see cursors immediately.
- Typed events; dropped the `events`, `debounce`, and `js-base64` dependencies.
- Test suite against an in-memory Realtime simulator.

## 1.0.0 — 2024-06-08

Initial proof of concept.
