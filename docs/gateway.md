# Gateway behavior

The gateway projects OpenRig state through the seat protocol. It is read-only by default.
See the [implementation guide](implementation.md) to run it and the [configuration reference](configuration.md) for all settings.

`packages/seat-gateway` serves the protocol from an OpenRig daemon so that clients stop polling it.
It runs server-side because OpenRig refuses a foreign browser `Origin`; the gateway does the same.

| Route | Content |
|---|---|
| `GET /capabilities` | Protocol version, served kinds (including `x-openrig.event`), extensions (`x-openrig`) with `extensionVersions`, harnesses seen, features. Each daemon route is probed (a 404 turns that feature and its kind off) and the answer is reused for 30 s. `features.act` is `false` and there is no `actions` list unless the operator enables `act.send` (see below). |
| `GET /terminal/:seatId` | Optional read-only terminal WebSocket; raw ANSI output, scroll-only JSON input. Same bearer, Origin and Host checks. Off by default. |
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

**Terminal view (off by default).** Set `terminal.enabled: true` and
`terminal.principal: "viewer@<rig>"` to enable `GET /terminal/:seatId` (an encoded protocol seat
ID). The principal is fixed gateway configuration and must be a non-seat address; client
principal and occupant-generation headers are never forwarded. The gateway checks the daemon's
`GET /api/config/ui.enabled` on every capability request and terminal attach, failing closed.
The daemon must have its web UI WebSocket enabled (changing `ui.enabled` requires a daemon
restart). With either flag off, `features.terminal` is false and no terminal descriptor is served.
The daemon connection uses `GET /api/terminal/:sessionName`, bearer authentication, no redirects
and the fixed `x-openrig-session` principal. No terminal content is logged or stored.
Scroll frames are conflated per viewer: only the latest offset is kept (offsets above 10,000 lines are clamped to
10,000). At most one scroll is in flight to the daemon per viewer; it is released by the first daemon output frame
that arrives at least 150 ms after the scroll was sent, or after 2 s, and forwarded scrolls are at least 100 ms
apart. So one viewer causes at most about 6 daemon captures per second whatever the pane prints, and the gateway
forwards at most 20 scrolls per second across all viewers. Terminal authorization is refused (403) until one full
resync has read every rig's seats; after that it stays allowed on the last-known seats even if a later resync fails
(a seat created in that window is not yet known, which the daemon's own checks still cover). A daemon output frame over
`terminal.maxFrameBytes` still closes that viewer's connection (the protocol has no in-band notice for raw ANSI output).
`features.terminal` reflects the stored `ui.enabled` value, which only takes effect after a daemon restart; a
connection attempt fails safe if the daemon does not actually serve the WebSocket.

Clients receive raw ANSI text frames; only JSON `{type:"scroll",offset:N}` is accepted upstream
(integer 0–100000; the gateway clamps above 10,000; zero returns to live). Keys, text, paste, resize and binary input are dropped.
Unknown fields are stripped from scroll frames. The daemon owns terminal geometry; the gateway
never requests a resize or input. Terminal output can contain sensitive session content, so enable
it only for trusted gateway clients. Handshakes require an Authorization header; URL tokens are
not accepted. Native browser WebSocket cannot set that header.

Limits: `terminal.maxViewers` defaults to 8 (1–1024), including pending handshakes;
`terminal.maxFrameBytes` defaults to 262144 (128–1048576), applied to both WebSocket peers with
compression and automatic pong replies disabled (ping replies use the same bounded send budget). Each peer's queued output is capped at one frame budget; slow viewers,
binary daemon output and oversized frames are disconnected. Only the newest scroll is retained
while the daemon handshake is pending, which times out after 10 seconds. Disconnect or shutdown
releases the viewer and upstream connection. Tests use fake daemons and in-memory sockets only.

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


## Tests

**Tests.** `npm test` runs against a mock daemon built from recorded-shape fixtures
(`packages/seat-source-openrig/test`): mapping validated against the schemas, reconnect, daemon restart
and sequence gap, gateway restart, slow and stalled clients, auth, Origin and Host checks, and a soak.
`SEAT_GATEWAY_SOAK_MS=3600000 npm test -w @openrig-seats/seat-gateway -- soak` runs the soak for an hour
(default 3 s). `OPENRIG_SEATS_LIVE=1 OPENRIG_SEATS_LIVE_URL=http://127.0.0.1:<port>` adds GET-only live tests
against a daemon (`OPENRIG_SEATS_LIVE_TOKEN_FILE` optionally names the daemon token file).
