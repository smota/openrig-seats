# seat-conformance

Static snapshot of the OpenRig daemon surfaces the seat gateway depends on, extracted from OpenRig
source: route mounts and registrations (events SSE with `Last-Event-ID`, attention, ps, rigs and
nodes, queue `list` and `open-human-updates`, `transport/send`, sessions `generation-record`), the
`transport/send` outcome set and failure-reason to HTTP-status map, the `RigEvent` variant names, and the node fields (`NodeInventoryEntry`, `activityState`, `needsInput`, `AgentActivity`) and event fields the `x-openrig` extension reads (`REQUIRED_NODE_FIELDS`, `REQUIRED_EVENT_FIELDS`).

- `snapshots/openrig-surfaces.json` is checked in and was extracted at the commit in `/openrig-compat.json`.
- `OPENRIG_CHECKOUT=<path> npm test` re-extracts from a read-only OpenRig checkout at the commit in
  `openrig-compat.json` and fails on any removal, rename or changed status code. Additions pass.
  Without `OPENRIG_CHECKOUT`, tests validate the checked-in snapshot and extractors; checkout
  re-extraction and source mutations are explicitly skipped. An explicitly supplied invalid path
  still fails. Offline success does not establish compatibility with an untested OpenRig revision.
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
5. `OPENRIG_CHECKOUT=<path> npm test` from the repo root. Also run `npm test` without that variable
   to check the clean-clone path.

`openrig-compat.json` also records the repository version, protocol version, schema major version
and JSON Schema dialect. The `seat-protocol` compatibility test runs under root `npm test` and
checks these against the manifest, `PROTOCOL_VERSION`, schema filenames and schema declarations.
Update the compatibility matrix in the root README and `CHANGELOG.md` when changing the pin or
protocol. A snapshot command still requires `OPENRIG_CHECKOUT`; it never guesses a local path.


## Optional Core app job

The current snapshot also extracts the actual `/api/apps` facade routes and literal
`/v1/capabilities` discovery values (contract major, job/forms/assurance, stable
submissions, result reads and refresh). Tests mutate actual source syntax to catch
major/route changes. An older checkout without this facade is classified as job
unavailable while its legacy contract is still checked; runtime discovery disables
only the new job. Gateway protocol 1.0 is independent of Core app contract v1.

With an explicit built `OPENRIG_CHECKOUT`, the existing gateway action suite runs
additional whole-job fixtures. It imports that checkout's built Core owners and
own native SQLite/Hono dependencies, migrates a private temporary SQLite file and
serves the real app routes over private loopback HTTP. Only unrelated inventory
reads use the existing fictional daemon. It provisions a fictional registered
actor/app locally, then verifies answer binding, lost-receipt/gateway-restart
recovery, encoded actor links, actual result/events/polling and permission status.
Transport is stubbed; no installed daemon, native provider or real credential is
used. Build that checkout first and isolate provider/config namespaces when running.
This is HTTP/SQLite and source proof, not native harness or deployed-daemon proof.

The exact current pin is the local reviewed Core integration commit
`56218f7717c035fcb7d73d28750330c1824f5122`, not a published release claim. The earlier reviewed app job
checkpoint `a1e6593b16f956321ae320b679e5c1b9ea999ade` and integration checkpoint
`812eecf9b6ad6853624e072da274665b7f3c92d2` remain historical evidence.
Pre-pin comparison detected one retired legacy reason, `override_input_unknown`
(409), removed upstream by `b29a70f14fc11797d46cbd9f12d4e61a523c3d06` (#2800): a
deliberate override now proceeds when input is unreadable. The gateway never
requests dangerous overrides; its tested payload remains exactly
`{session,text,deliveryId,verify}`. This boundary was explicitly reviewed before
regenerating the exact new snapshot. Removal detection and mutation assertions
were not filtered or weakened. The old revision remains in the compatibility file
as historical previous evidence; no broad version range is implied.
