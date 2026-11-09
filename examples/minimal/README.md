# Minimal gateway and seat-ui

Run one fixture gateway and the existing seat-ui in a few minutes. No OpenRig
daemon, accounts or external services are needed. All data is fictional.

## Run from a clean clone

Use Node 22 or 24 and npm 10+. Dependency installation needs registry access;
the running example needs only loopback connections.

```sh
git clone https://github.com/smota/openrig-seats.git
cd openrig-seats
npm ci
npm run build
node examples/minimal/main.mjs
```

Open <http://127.0.0.1:5173>. Leave **Gateway URL** at `/gateway`. Enter
`fictional-demo-bearer` in the token field and choose **Connect**. Select the
fictional seat to inspect its turn. This public fixture bearer is not a secret;
never use it with real data. Choose **Connect**, rather than **Explore fixtures**,
to exercise the gateway.

```text
browser :5173 -> seat-ui /gateway -> seat-gateway :8088 -> fixture Store
```

The example reuses `createApp`, `Store`, the protocol's valid fixtures and the
seat-ui standalone server. It does not call daemon routes. Actions and terminal
access are disabled. The snapshot and SSE stream contain the same fixture data;
the fixtures stay static until the process stops.

Press Ctrl-C to stop both servers. `GATEWAY_PORT` sets the gateway port (default
8088); `PORT` sets the UI port (default 5173). If a port is in use, the example
exits with a one-line hint naming the variable to change. Choose unused ports:

```sh
GATEWAY_PORT=18088 PORT=15173 node examples/minimal/main.mjs
```

Then open <http://127.0.0.1:15173>. These environment variables configure only
servers created by this example.

## Test

From the repository root:

```sh
npm test -w @openrig-seats/seat-gateway -- minimal-example
```

The existing Vitest runner tests startup, port conflicts and the same fixture wiring through seat-ui's
adapter: authentication, capability flags, snapshot relationships, SSE and cursor
resume. Startup tests use ephemeral loopback ports; no test contacts a daemon. Root `npm test`
includes it.

## Use an existing local OpenRig daemon instead

Stop the fixture example first. Follow the [implementation guide](../../docs/implementation.md)
to configure a separate real gateway against your existing daemon, then run:

```sh
node packages/seat-gateway/dist/main.js --config /path/to/your/gateway-config.json
```

In another terminal:

```sh
SEAT_GATEWAY_URL=http://127.0.0.1:8088 npm start -w @openrig-seats/seat-ui
```

Use that gateway's own bearer in the UI. The fixture bearer is never appropriate
for a real gateway. See [seat-ui's live gateway instructions](../../packages/seat-ui/README.md#connect-to-a-live-gateway).
This path is optional and is not used by the example test. No daemon startup,
restart or configuration changes are required by this example.
