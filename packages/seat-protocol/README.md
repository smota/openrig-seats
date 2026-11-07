# seat-protocol (v1, pre-1.0)

Schemas live in `schemas/*.v1.schema.json` (JSON Schema 2020-12); `schemas/fixtures/{valid,invalid}/<schema>/`
holds the examples the tests check. `src/types.generated.ts` is generated (`npm run generate`; a test
fails when it is stale).

## Wire shape

| Endpoint | Content |
|---|---|
| `GET /capabilities` | `{protocol:{version}, kinds, extensions, harnesses, features}` |
| `GET /stream` | SSE. Each message: `id: <cursor>`, `data: <stream envelope>`. Resume with `Last-Event-ID` header or `?cursor=`; no gaps, no duplicates. |
| `POST /act` | `{idempotencyKey, kind, id, action, input?}` returns `{idempotencyKey, status, replayed, result?, error?}`. One execution per key. |

Stream envelope: `{cursor, kind, id, op: "upsert"|"delete", data}`. Kinds: `host`, `rig`, `seat`,
`turn`, `attention`, `work`. Items carry `id`, `updatedAt` and optional `title`, `summary` and declared
`actions: [{id, label, input?: JSONSchema, danger?}]`, so a UI draws buttons and forms without knowing
the verbs. Turn parts: `text`, `tool`, `question` (ACP-style options), `status`, with AG-UI style
`phase: start|content|end`.

## Extension rules

- Extra kinds are named `x-<ns>.<name>` (for example `x-acme.approval`) and carry at least `id` and `updatedAt`.
- Readers ignore unknown fields and skip unknown part types. Schemas never close objects.
- A reader renders any kind it does not know as a generic card (title, summary, actions): see `toGenericCard`.
- Within a major version only additions; cursors are opaque.
- Namespaces in use are listed in `capabilities.extensions`; `capabilities.extensionVersions` (optional) gives each one's `major.minor`.

## Extension `x-openrig` (version 1.0)

What the OpenRig daemon reports beyond the core fields. A client that does not know it ignores it.

- `seat["x-openrig"]` (schema `x-openrig-seat`, `version` required). Structured by default: `sessionName`, `rigName`,
  `podNamespace`, `sessionStatus`, `lifecycleState`, `startupStatus`, `intentionallyStopped`, `needsAttention`,
  `arbitratedNeedsInput`, `activity`, `display`, `needsInputCount`, `promptKind` (`permission_prompt`,
  `selection_prompt`, `other`), `held` and `heldReasonCode` (`excluded_from_subset`, `other`), `errorCategory`
  (`startup_failed`, `launch_unconfirmed`, `unknown`), `pendingWorkCount`, `inProgressWorkCount`. Categories and codes
  come from allowlists and known daemon values, never from daemon text.
- Kind `x-openrig.event` (schema `x-openrig-event`): `eventType` (`message`, `claim`, `handoff`, `close`, `prompt`;
  `answer` is reserved: the daemon's event carries no authoritative answer marker, so a closed item is always `close`),
  `daemonEvent`, `seq`, `summary`, `fromSession`, `toSession`, `fromSeatId`, `toSeatId`, `workId`. By default `summary`
  is built from fixed metadata (`<eventType> <workId>`). The newest 200 mapped events are kept.
- **Free text is off by default.** When the gateway operator sets `xOpenrig.includeText` the extension also carries
  `heldReason`, `lastError`, `promptSummary`, the event `summary` as the daemon wrote it, and the core seat `activity`
  falls back to the daemon's activity reason. This text is SENSITIVE (the daemon may put message content or credentials
  in it) and UNTRUSTED: bounded (300 characters, event summary 140), single-line, render as text only. Use it on
  loopback-only deployments. `capabilities.features["x-openrig.text"]` says whether it is on. The raw needs-input
  `prompt` is never read, and message bodies and transcript content are never carried.

## Client

```ts
import { createSeatClient, Mirror } from "@openrig-seats/seat-protocol";
const client = createSeatClient({ baseUrl: "http://127.0.0.1:8088", token });
const mirror = new Mirror();
for await (const env of client.stream({ cursor: saved })) mirror.apply(env);
await client.act({ kind: "attention", id: "a1", action: "allow" });
```

No runtime dependencies; uses `fetch`, and reconnects with the last cursor.

## Optional read-only terminal

When `features.terminal` is true, `capabilities.terminal` (schema `terminal`) declares a
WebSocket endpoint at `/terminal/{seatId}`, its frame byte limit and viewer limit. Replace
`{seatId}` with an encoded protocol seat ID. Authenticate the handshake with the same
`Authorization: Bearer` header as other routes; tokens in URLs are not supported. Clients
need a WebSocket implementation that supports handshake headers.

Server frames are raw UTF-8 ANSI terminal text, not stream envelopes or JSON. Client frames
are JSON `{ "type": "scroll", "offset": 0 }` (schema `terminal-scroll`); offset is an integer
0–100000 lines above the live bottom, with zero returning to live output. The schema keeps 100000 for
compatibility; the gateway clamps larger offsets to 10,000 and rate-limits scrolls. The gateway
reconstructs this allowlist and drops every other input type, including keys, text, paste and
resize. Extra fields are ignored. A slow viewer or oversized frame closes the connection;
reconnect to obtain a fresh daemon snapshot. There is no terminal replay cursor.
