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

## Client

```ts
import { createSeatClient, Mirror } from "@openrig-seats/seat-protocol";
const client = createSeatClient({ baseUrl: "http://127.0.0.1:8088", token });
const mirror = new Mirror();
for await (const env of client.stream({ cursor: saved })) mirror.apply(env);
await client.act({ kind: "attention", id: "a1", action: "allow" });
```

No runtime dependencies; uses `fetch`, and reconnects with the last cursor.
