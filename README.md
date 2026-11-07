# openrig-seats

A small, stable protocol for looking at and talking to the agent "seats" of an
[OpenRig](https://github.com/mvschwarz/openrig) deployment from outside the terminal (web UIs, chat
channels, voice), plus the tests that keep it honest against OpenRig itself.

**Status: pre-1.0.** Nothing here is published to npm yet; the protocol may still change before 1.0.

## Relation to OpenRig

This repository follows the ideas in OpenRig discussion
[#2691](https://github.com/mvschwarz/openrig/discussions/2691). It is an independent project: it uses
only OpenRig's existing HTTP routes and makes no change to OpenRig. The OpenRig maintainers have not
reviewed or endorsed it. Packages follow OpenRig's tooling and use `seat-*` names so that any of them
can move into OpenRig later with a scope rename (OpenRig packages use the `@openrig/*` scope; these use
`@openrig-seats/*`).

## Packages

| Package | Content |
|---|---|
| `packages/seat-protocol` | JSON Schemas (2020-12) for `host`, `rig`, `seat`, `turn`, `attention`, `work`, the stream envelope, declared actions, `POST /act` and `GET /capabilities`; valid and invalid fixtures; generated TypeScript types; a dependency-free client (fetch plus SSE parsing, cursor resume). |
| `packages/seat-conformance` | A checked-in snapshot of the OpenRig routes, `transport/send` outcome and failure map, and `RigEvent` names the gateway depends on, re-extracted from an OpenRig checkout; the test fails on any removal or rename. |
| `packages/seat-readers` | Readers that turn a seat's generation record into `turn`s: `claude-jsonl`, `codex-rollout` and a plain-text fallback behind one `detect`/`follow` interface; cursor = UTF-8 byte length of complete lines; `generationId[0]` identifies the occupant. |
| `packages/seat-source-openrig` | The only code that knows daemon routes (GET only). Snapshots (`/api/ps`, `/api/rigs/:id/nodes`, `/api/attention`, `/api/queue/list`) plus the `/api/events` stream become `host`, `rig`, `seat`, `attention` and `work` upserts and deletes; resumes from the daemon's event sequence, and does a full resync on a gap or a restarted log. |
| `packages/seat-gateway` | Read-only Hono server: `GET /capabilities`, `GET /stream`, `GET /snapshot`. See below. |

Planned: `seat-ui` and `POST /act`.

## Seat gateway (read-only)

`packages/seat-gateway` serves the protocol from an OpenRig daemon so that clients stop polling it.
It runs server-side because OpenRig refuses a foreign browser `Origin`; the gateway does the same.

| Route | Content |
|---|---|
| `GET /capabilities` | Protocol version, served kinds, harnesses seen, features. Each daemon route is probed (a 404 turns that feature and its kind off) and the answer is reused for 30 s. `features.act` is `false`: there is no `/act` in this version. |
| `GET /stream` | SSE of the stream envelope `{cursor, kind, id, op, data}`; the SSE `id` is the cursor. Resume with `Last-Event-ID` (or `?cursor=`). |
| `GET /snapshot/:kind`, `GET /snapshot?kind=` | Current items of one kind plus the cursor they are consistent with; without a kind, all served kinds. |

**Cursors.** The cache keeps the latest operation per item, each stamped with a sequence number; a client
resuming after N receives exactly the entries newer than N, in order. Nothing is skipped (the latest state
of every change is there) and nothing repeats (sequence numbers are never reused). A client that falls
behind is not buffered for: it reads the newest state when it catches up, so intermediate states may be
conflated and memory stays bounded by live items plus a tombstone limit. A cursor from before a gateway
restart (cursors carry a per-start epoch), from the future, or older than the pruned tombstones is
answered with a `reset` control message (SSE `event: control`, schema `stream-control`, no id) and then the
full state. The same happens to an open stream that missed a pruned delete. `seat-protocol`'s client
surfaces it (`onReset`, a yielded item) and `Mirror.apply` clears on it. A client that accepts no bytes for 30 s is dropped.

**State.** The gateway's state is a cache rebuilt from the daemon on every start. It follows the daemon's
`seq`: after a reconnect it resumes with `Last-Event-ID` but always re-reads every snapshot first; a changed
daemon process identity (`/healthz` pid), a gap or a backwards sequence also forgets the sequence. A
failed refresh is retried on a bounded backoff. Redirects from the daemon are never followed. The queue
route cannot be paged: a full page marks `work` incomplete (the host reports it) and suspends deletes. While the daemon is
down the host is `offline` and cached items stay readable. The gateway only issues GET requests to the
daemon, always with `replay=0` or `Last-Event-ID` (the daemon's log is unbounded), never writes tmux and
never opens the daemon's database. Request bodies of queue items are not copied into the protocol.

**Security.**
- Binds `127.0.0.1` by default; any other address is refused unless `allowNonLoopback` is set.
- Every route needs `Authorization: Bearer <token>`; the token is read from a file that must be mode 0600
  (`tokenFile`) and is compared in constant time. Tokens are never put in argv, URLs or logs.
- A request with an `Origin` header is refused unless the origin is in `allowedOrigins` (empty by default);
  a `Host` that is not loopback or in `allowedHosts` is refused (DNS rebinding).
- The daemon URL must be a literal loopback IP. The optional daemon token (`daemonTokenFile`, 0600) is sent
  only there, as a header, and is only needed if you point the gateway at routes that require it.

**Run.**

```
npm install && npm run build
umask 077; openssl rand -hex 32 > ~/.config/seat-gateway/token
node packages/seat-gateway/dist/main.js --config ~/.config/seat-gateway/config.json
```

Config keys (JSON): `daemonUrl` (default `http://127.0.0.1:7433`), `daemonTokenFile`, `tokenFile`
(required), `listen` (`host`, `port`; default `127.0.0.1:8088`), `allowNonLoopback`, `allowedOrigins`,
`allowedHosts`, `hostId`, `hostName`, `tombstoneLimit` (default 5000). A leading `~/` in the token paths is
expanded. `packages/seat-gateway/examples/` has a `systemd --user` unit and a config to copy.

**Tests.** `npm test` runs against a mock daemon built from recorded-shape fixtures
(`packages/seat-source-openrig/test`): mapping validated against the schemas, reconnect, daemon restart
and sequence gap, gateway restart, slow and stalled clients, auth, Origin and Host checks, and a soak.
`SEAT_GATEWAY_SOAK_MS=3600000 npm test -w @openrig-seats/seat-gateway -- soak` runs the soak for an hour
(default 3 s). `OPENRIG_SEATS_LIVE=1 OPENRIG_SEATS_LIVE_URL=http://127.0.0.1:<port>` adds GET-only live tests
against a daemon (`OPENRIG_SEATS_LIVE_TOKEN_FILE` optionally names the daemon token file).

## Develop

Node `^22 || ^24`, npm 10+.

```
npm install
OPENRIG_CHECKOUT=<path to OpenRig at the pinned commit> npm test   # no network, no daemon
npm run check    # typechecks sources and tests
npm run generate # regenerates seat-protocol types from the schemas
```

`openrig-compat.json` lists the OpenRig commits this repository was tested against; see
`packages/seat-conformance/README.md` for how to bump the pin. Default tests never touch a running
daemon; an opt-in live test (GET only) is described there.

## License

Apache-2.0, see `LICENSE`.
