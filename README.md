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
| `packages/seat-readers` | Readers that turn a seat's generation record into `turn`s: `claude-jsonl`, `codex-rollout`, `agy-jsonl`, `pi-jsonl` and a plain-text fallback behind one `detect`/`follow` interface; cursor = UTF-8 byte length of complete lines; `generationId[0]` identifies the occupant. |
| `packages/seat-source-openrig` | The only code that knows daemon routes (GET only). Fills the `x-openrig` extension (seat detail and the `x-openrig.event` kind, see `seat-protocol`). Snapshots (`/api/ps`, `/api/rigs/:id/nodes`, `/api/attention`, `/api/queue/list`) plus the `/api/events` stream become `host`, `rig`, `seat`, `attention` and `work` upserts and deletes; resumes from the daemon's event sequence, and does a full resync on a gap or a restarted log. |
| `packages/seat-gateway` | Read-only Hono server: `GET /capabilities`, `GET /stream`, `GET /snapshot`. See below. |

Planned: `seat-ui`.

## Seat gateway (read-only by default)

`packages/seat-gateway` serves the protocol from an OpenRig daemon so that clients stop polling it.
It runs server-side because OpenRig refuses a foreign browser `Origin`; the gateway does the same.

| Route | Content |
|---|---|
| `GET /capabilities` | Protocol version, served kinds (including `x-openrig.event`), extensions (`x-openrig`) with `extensionVersions`, harnesses seen, features. Each daemon route is probed (a 404 turns that feature and its kind off) and the answer is reused for 30 s. `features.act` is `false` and there is no `actions` list unless the operator enables `act.send` (see below). |
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
daemon, always with a bounded `replay` (default 2000, `replay=0` plus `Last-Event-ID` when resuming; the daemon's log is unbounded), never writes tmux and
never opens the daemon's database. Request bodies of queue items are not copied into the protocol.

**`send` action (off by default).** With `act.send: true` the gateway declares `{id: "send", input: {text, maxLength}, danger: false}` on every `seat`, lists it in `/capabilities` (`features.act: true`, `actions`) and serves `POST /act` (same bearer as every route). It calls the daemon's `POST /api/transport/send` and nothing else; the config needs `act.sender` (a registered non-seat address such as `cockpit@<rig>`, sent as `x-openrig-session`, which the daemon treats as an unverified claim; a seat name is refused) and `act.idempotencyFile`. Never sent: `x-openrig-occupant-generation`, `force` or any override. The daemon token (`daemonTokenFile`, 0600) goes only to the literal loopback IP, with no redirects.
- At most one send per `idempotencyKey`: the gateway's own table (a 0600 file, written before the daemon is called, holding a hash of the request and never the text) returns the stored response with `replayed: true`. A new key for the same text is a new send; the same key for a different request is refused. OpenRig's `deliveryId` is not relied on (it does not de-duplicate in draft-aware mode). A send in flight when the gateway stopped comes back as `failed`. Keys are kept for `act.retentionDays` (default 7) whatever the count; a table full of unexpired keys (`act.maxKeys`) answers 503 instead of evicting. The entry is fsynced (file, rename, directory) before the daemon is called, and if that fails nothing is sent. One gateway per table file: `<file>.lock` makes a second process refuse to start.
- Refused before anything is sent: unknown seat, a seat that is `needs-input`, `blocked`, `stopped`, `unknown` or held, text over `act.maxLength` (default 4000).
- Outcomes: `delivered` and `rendered-unconfirmed` are `completed`; `retained` is `accepted` (the daemon holds it; do not resend); a refusal with `inputPhase: not_reached` is `rejected` with the daemon's reason code; anything else (`attempted`, `written`, no answer, an unexpected status) is `failed`. The gateway never retries on its own; a person decides and uses a new key. Daemon free text is not copied into the response.
- Sends to one seat are serialized.

**`x-openrig` text and replay.** With `xOpenrig.includeText` off no daemon free text reaches any field, core or extension: work titles read `Queue item <id>`, attention titles `Request for a person: <id>` (or `Update ...`) with no impact. `xOpenrig.includeText: true` adds the daemon's free text (error text, prompt reason or
summary, hold reason, event summaries, work title, attention title and impact). It is **sensitive**: the daemon may put message content or
credentials in it. Enable it only on loopback-only deployments you trust; it is advertised as
`features["x-openrig.text"]` in `/capabilities`. `xOpenrig.replay` is the number of newest daemon events asked for on a
cold start (`/api/events?replay=N`, never omitted); the budget counts ALL daemon event types, so fewer mapped events may
remain, and the gateway keeps the newest 200 mapped ones. A reconnect within the same daemon process resumes with
`Last-Event-ID`; a restarted daemon drops the cursor and the kept events and replays the budget again.

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
`allowedHosts`, `hostId`, `hostName`, `tombstoneLimit` (default 5000), `xOpenrig` (`includeText`, default `false`; `replay`, default 2000). A leading `~/` in the token paths is
expanded. `packages/seat-gateway/examples/` has a `systemd --user` unit and a config to copy.

**Tests.** `npm test` runs against a mock daemon built from recorded-shape fixtures
(`packages/seat-source-openrig/test`): mapping validated against the schemas, reconnect, daemon restart
and sequence gap, gateway restart, slow and stalled clients, auth, Origin and Host checks, and a soak.
`SEAT_GATEWAY_SOAK_MS=3600000 npm test -w @openrig-seats/seat-gateway -- soak` runs the soak for an hour
(default 3 s). `OPENRIG_SEATS_LIVE=1 OPENRIG_SEATS_LIVE_URL=http://127.0.0.1:<port>` adds GET-only live tests
against a daemon (`OPENRIG_SEATS_LIVE_TOKEN_FILE` optionally names the daemon token file).

## Native session readers

`createAgyReader` reads Antigravity CLI (`agy`, `antigravity`) JSONL from
`<home>/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl`.
This format was verified read-only against live files on this machine. `USER_INPUT`
records provide user prose; `PLANNER_RESPONSE` provides assistant prose, thinking
status and tool names. `GENERIC` records provide status only: their opaque content
may be tool output. Calls have no native call IDs, so tool parts describe the
requested action as pending without claiming execution or pairing results. A planner
record marked `DONE` does not establish that its tools completed. Errors provide status only.
This is Antigravity's format, **not** Gemini CLI's separate JSON session format;
`gemini` is not auto-selected.

`createPiReader` reads Pi v3 session JSONL from
`<home>/.pi/agent/sessions/<encoded-project>/<session>.jsonl`, also verified against
live files. `message` entries map user/assistant prose, thinking status, `toolCall`
and `toolResult` blocks (paired by `toolCallId`), stop/error states. Metadata,
custom entries, system prompts and branch/compaction summaries are ignored.
These are append-order records; this reader does not reconstruct the active branch
of Pi's session tree. All checked-in fixtures are minimal synthetic data.

Both readers use the existing complete-line UTF-8 byte cursor and generation reset
rules, and are registered by `createReaders`. Their `includeText` option defaults
to `false`; `true` adds only user/assistant prose. Tool arguments, tool output,
thought content, signatures and error text are never emitted. Existing Claude,
Codex and plain-text readers retain their existing text behavior.

`discoverAgySessions({home})` and `discoverPiSessions({home})` return sorted native
session paths using directory entries only. Alternatively pass `{root}` to name
the Antigravity `brain` or Pi `sessions` directory directly (takes precedence over
`home`). A home or root must be injected; there is no implicit user home. Missing
roots return an empty list; symlink entries are excluded. Discovery does not open
transcripts. Callers read the discovered file and pass its suffix through the
existing `GenerationRecord` interface; the reader itself performs no file I/O.

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
