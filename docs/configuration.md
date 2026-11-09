# Configuration reference

Pass a JSON file to `node packages/seat-gateway/dist/main.js --config <path>`.
Paths beginning with `~/` expand to the gateway user's home directory.
See the [implementation guide](implementation.md) for setup and the
[existing config example](../packages/seat-gateway/examples/seat-gateway.config.json).

## Gateway

| Key | Default | Meaning / bounds |
|---|---|---|
| `tokenFile` | Required | Gateway client bearer file; must be owner-only (`0600` or stricter). |
| `daemonUrl` | `http://127.0.0.1:7433` | Existing daemon HTTP URL; literal loopback IP. Redirects are refused. |
| `daemonTokenFile` | Unset | Optional daemon bearer file, owner-only (`0600` or stricter). |
| `listen.host` | `127.0.0.1` | Gateway bind address. Literal loopback unless explicitly overridden. |
| `listen.port` | `8088` | Integer 0–65535; zero selects an available port. |
| `allowNonLoopback` | `false` | Explicitly permit a non-loopback bind. |
| `allowedOrigins` | `[]` | Allowed request Origins. Requests without Origin can pass. |
| `allowedHosts` | `[]` | Extra accepted Host values; loopback names are accepted already. |
| `hostId` | `local` | Stable host identifier in protocol entities. |
| `hostName` | `openrig` | Display name; the example config uses a fictional Acme name. |
| `tombstoneLimit` | `5000` | Non-negative number of deleted items retained for cursor resume. |
| `xOpenrig.includeText` | `false` | Carry sensitive daemon free text; advertised in capabilities. |
| `xOpenrig.replay` | `2000` | Cold-start event budget, integer 0–100000; counts all daemon event types. |

## Optional send action

| Key | Default | Meaning / bounds |
|---|---|---|
| `act.send` | `false` | Enable declared seat send actions and `POST /act`. |
| `act.sender` | Unset | Required when enabled; registered non-seat OpenRig address. |
| `act.idempotencyFile` | Unset | Required when enabled; durable request-hash/response table, one gateway per file. |
| `act.maxLength` | `4000` | Text length limit, integer 1–20000. |
| `act.maxKeys` | `5000` | Integer 1–1000000; full unexpired tables refuse new sends. |
| `act.retentionDays` | `7` | Integer 1–3650; keys remain until expiry. |

The action never retries an uncertain send by itself. The same key replays its
stored result; a new key permits a new send. Read [send semantics](gateway.md)
before enabling it.

## Optional terminal view

| Key | Default | Meaning / bounds |
|---|---|---|
| `terminal.enabled` | `false` | Enable read-only terminal WebSocket. |
| `terminal.principal` | Unset | Required when enabled; fixed non-seat OpenRig address. |
| `terminal.maxViewers` | `8` | Integer 1–1024, including pending handshakes. |
| `terminal.maxFrameBytes` | `262144` | Integer 128–1048576; applies to both peers. |

The daemon must already have its web UI WebSocket enabled. Authorization fails
closed until a full seat sync. Only scroll frames pass upstream; no input or resize
is sent. See [terminal behavior and limits](gateway.md).

## seat-ui server

| Environment variable | Default | Meaning |
|---|---|---|
| `SEAT_GATEWAY_URL` | `http://127.0.0.1:8088` | Fixed upstream HTTP(S) URL, no embedded credentials, query or fragment. HTTP requires loopback; remote URLs require HTTPS. |
| `PORT` | `5173` | Loopback UI server port. |

The browser uses `/gateway` with this server. Vite's development server supports
the embedded fixture demo but has no `/gateway` adapter. See
[seat-ui](../packages/seat-ui/README.md) for transport, validation and resource limits.

The minimal example adds `GATEWAY_PORT` and `PORT` for its own local listeners;
see [its README](../examples/minimal/README.md). These are example settings, not
gateway CLI environment variables.
