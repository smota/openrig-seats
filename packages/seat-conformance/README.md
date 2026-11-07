# seat-conformance

Static snapshot of the OpenRig daemon surfaces the seat gateway depends on, extracted from OpenRig
source: route mounts and registrations (events SSE with `Last-Event-ID`, attention, ps, rigs and
nodes, queue `list` and `open-human-updates`, `transport/send`, sessions `generation-record`), the
`transport/send` outcome set and failure-reason to HTTP-status map, the `RigEvent` variant names, and the node fields (`NodeInventoryEntry`, `activityState`, `needsInput`, `AgentActivity`) and event fields the `x-openrig` extension reads (`REQUIRED_NODE_FIELDS`, `REQUIRED_EVENT_FIELDS`).

- `snapshots/openrig-surfaces.json` is checked in and was extracted at the commit in `/openrig-compat.json`.
- `OPENRIG_CHECKOUT=<path> npm test` re-extracts from a read-only OpenRig checkout at the commit in
  `openrig-compat.json` and fails on any removal, rename or changed status code. Additions pass.
  `OPENRIG_CHECKOUT` is required: without it the checkout test fails with a message saying so.
  Routes are keyed by file, router variable, method and path, and the sources are parsed with the
  TypeScript compiler so commented-out code never counts.
- `OPENRIG_CHECKOUT=<path> OPENRIG_SEATS_LIVE=1 npm test` also runs `test/live.test.ts` (GET only, skipped by default).

## Bump the pin

1. Check out the new OpenRig revision read-only somewhere (never inside a running OpenRig install).
2. `OPENRIG_CHECKOUT=<path> npm test`. Failures list what was removed or renamed: decide whether the
   gateway adapts (then update `REQUIRED_*` in `src/extract.ts` if needed) or the bump is rejected.
3. `OPENRIG_CHECKOUT=<path> npm run snapshot` rewrites the snapshot (including additions).
4. Update `commit` and `subject` of the `pinned` entry in `/openrig-compat.json`; keep the old one
   with `"role": "previous"`.
5. `npm test` from the repo root.
