# seat-ui

A small reference viewer for **any seat-protocol v1 source**. The browser uses
plain TypeScript and DOM, the protocol client, and JSON Schema validation. There
are no source-specific fields, verbs, daemon routes, or extension handlers.
Unknown kinds render as generic cards with their title, summary and actions.

## Build and explore the fixtures

From the repository root, with Node 22 or 24 and npm 10+:

```sh
npm install
npm run build -w @openrig-seats/seat-protocol
npm run build -w @openrig-seats/seat-ui
npm start -w @openrig-seats/seat-ui
```

Open `http://127.0.0.1:5173` and choose **Explore fixtures**. The demo embeds valid
JSON fixtures from `packages/seat-protocol/schemas/fixtures/valid`; it makes no
gateway requests. Actions return explicitly simulated results and the terminal
shows explicitly simulated text. Select a seat to inspect turns, attention,
work, forms and terminal. `npm run dev -w @openrig-seats/seat-ui` also serves this
fixture demo with Vite during development.

`dist/` is a static site containing HTML, JavaScript and CSS. It can be hosted
under a subdirectory using a static file server. The included standalone server
serves those files and supplies the browser transport adapter described below.
No changes to seat-gateway or seat-protocol are required.

## Connect to a live gateway

Build dependencies in this order when also building the gateway:

```sh
npm run build -w @openrig-seats/seat-protocol
npm run build -w @openrig-seats/seat-source-openrig
npm run build -w @openrig-seats/seat-gateway
npm run build -w @openrig-seats/seat-ui
# Run seat-gateway with your existing configuration in another terminal.
SEAT_GATEWAY_URL=http://127.0.0.1:8088 npm start -w @openrig-seats/seat-ui
```

The standalone server binds `127.0.0.1:5173`; `PORT` changes the port. Leave the
web form's **Gateway URL** at `/gateway`, enter the gateway bearer token and
choose **Connect**. The fixed upstream is chosen by the operator with
`SEAT_GATEWAY_URL`, never by a browser request. The adapter forwards only
capabilities, snapshot, cursor stream and action requests. It refuses foreign
Origins and non-loopback Host headers, and never follows upstream redirects.
It does not require a gateway `allowedOrigins` entry: the browser talks to its
same-origin standalone server, which makes the upstream request without Origin.

The token stays in memory: the password field is cleared at connection time;
only Authorization headers carry it. No cookies, browser storage, token URLs,
configuration files, or token logs are used. **Disconnect** aborts streams and
forgets the active connection. A reload starts disconnected. Use HTTPS if you
choose a remote gateway URL.

For another source that already permits browser CORS, you can enter its HTTP(S)
base URL directly. It must allow the UI origin, bearer and Last-Event-ID headers,
and JSON action requests. The existing seat-gateway does not provide browser
CORS responses, so use the included standalone adapter with it. Vite's dev
server is for the fixture demo or a directly accessible CORS source; it does not
provide the standalone `/gateway` adapter.

## Protocol behavior

The viewer loads capabilities, then an atomic full snapshot, then streams from
that snapshot's opaque cursor using the protocol client. Reconnection reuses the
last cursor. Deletes remove items and a reset clears the mirror before replay.
Forms and their drafts survive unrelated stream updates. Action definitions are
taken from capabilities and each entity, with the entity's declaration taking
precedence for the same action ID. Actions are offered only when `features.act`
is true. Every submit gets a new UUID; automatic transport retries reuse that
UUID. Dangerous actions require confirmation.

Objects, nested objects, enums and primitive schemas get native labelled
controls. Optional properties have include checkboxes; **Edit input as JSON**
allows additional properties and other valid values. Arrays, combinators,
references and other complex schemas use a JSON editor. All input is validated
against the full JSON Schema 2020-12 declaration with Ajv and standard formats.
Boolean `true` permits arbitrary JSON; `false` disables submission. Unresolvable
references fail closed with an explanation; schemas are never fetched remotely.
The standalone Content Security Policy permits `unsafe-eval` solely because Ajv
compiles declared schemas at runtime. It permits no inline scripts. A host with
a stricter policy must permit that compilation or action input forms are
unavailable.

The terminal panel appears only when `features.terminal` and the read-only
terminal descriptor advertise it. Native browser WebSocket cannot set an
Authorization header. The standalone server therefore adapts authenticated
fetch at the **declared terminal path** to an upstream WebSocket, framing text
as SSE for the browser. A validated integer offset becomes the only outgoing
frame: `{type:"scroll",offset:N}`. Changing the offset aborts and reopens the
subscription; zero returns to live output. There are no key, paste, resize or
editable-terminal controls or handlers. Direct browser connections without the
adapter show an explanation instead of attempting insecure authentication.

Terminal frames render as inert text in a scrollable `pre` (ANSI escapes are
not interpreted). Only the newest received frame is displayed; there is no
terminal history or replay buffer. The adapter enforces the advertised frame
and viewer limits, additionally capped at 1 MiB and eight viewers, disconnects
slow consumers, and closes the upstream when the browser cancels. Gateway-side
scroll limits still apply. Terminals and their contents are never stored.
Question parts show their protocol options as text; only explicitly declared
actions produce submissions.

## Verify

```sh
npm test -w @openrig-seats/seat-ui
npm run check -w @openrig-seats/seat-ui
npm run build -w @openrig-seats/seat-ui
```

Vitest/jsdom renders the valid core, capabilities and action fixtures, generic
extension cards, generated/validated forms, inert XSS fixtures, cursor/reset/
delete behavior and terminal visibility. Injected fetch and socket tests cover
header authentication, action retry keys and the scroll-only terminal bridge
without using a running daemon or opening sockets.
