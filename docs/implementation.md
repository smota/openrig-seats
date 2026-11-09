# Integrate with an existing OpenRig setup

Run the fixture [minimal example](../examples/minimal/README.md) first. For live use,
run the gateway beside your existing daemon and the UI beside the gateway.
No OpenRig patch, plugin, agent account or new protocol is required.

```text
Existing OpenRig daemon (literal loopback IP)
                |
     seat-source-openrig (snapshots + SSE)
                |
       seat-gateway :8088
                |
  seat-ui server :5173 (/gateway adapter)
                |
          local browser
```

## 1. Build

From the repository root, with Node 22 or 24 and npm 10+:

```sh
npm ci
npm run build
```

Check [compatibility](../README.md#compatibility) before selecting an OpenRig revision.
The gateway uses existing HTTP routes; it never opens the daemon database or writes tmux.

## 2. Configure the gateway

These commands are for the operator. Keep generated credentials outside the repository.
For a fresh setup, they create a gateway token and copy the example config.
Existing files are preserved; token creation refuses an overwrite:

```sh
mkdir -p "$HOME/.config/seat-gateway"
chmod 700 "$HOME/.config/seat-gateway"
(umask 077; set -C; openssl rand -hex 32 > "$HOME/.config/seat-gateway/token")
test -e "$HOME/.config/seat-gateway/config.json" || cp packages/seat-gateway/examples/seat-gateway.config.json "$HOME/.config/seat-gateway/config.json"
```

Create a new token only for a new setup; retain the existing token when updating.
Edit that config's `daemonUrl` to the literal loopback URL of your existing daemon.
If its routes require authentication, set `daemonTokenFile` to the operator-owned
`0600` file containing its token. Keep both tokens out of tracked files, URLs and logs.
The gateway and daemon tokens serve different boundaries.

Start only the gateway in one terminal:

```sh
node packages/seat-gateway/dist/main.js --config "$HOME/.config/seat-gateway/config.json"
```

This guide does not start, restart or change the existing daemon.
The [configuration reference](configuration.md) lists settings and defaults.
The [gateway guide](gateway.md) explains retries, stale state and security boundaries.

## 3. Start seat-ui

In another terminal:

```sh
SEAT_GATEWAY_URL=http://127.0.0.1:8088 npm start -w @openrig-seats/seat-ui
```

Open `http://127.0.0.1:5173`. Leave Gateway URL at `/gateway` and enter the gateway
bearer through the password field. Choose **Connect**. The token stays in memory;
reload or disconnect clears it. The server forwards authenticated requests to the
fixed gateway without the browser Origin header. No gateway `allowedOrigins` entry is needed.
Vite's development server does not include this adapter.

The gateway starts read-only. Enable send, terminal access or daemon free text only
when the deployment needs them; each has its own controls in the [gateway guide](gateway.md).
See [seat-ui](../packages/seat-ui/README.md) for forms, terminal transport and threat model.

## 4. Build your own client or integration

Reuse `createSeatClient` and `Mirror` from [seat-protocol](../packages/seat-protocol/README.md).
Read capabilities, load a snapshot, then follow its cursor. Honor resets and declared features.
Render unknown extension kinds as generic cards. Never infer an action from display text.
Reuse [seat-readers](../packages/seat-readers/README.md) when native session records are needed.

For OpenRig-side work, consult upstream contracts:

| Change | Upstream reference |
|---|---|
| Seat harness identity or runner behavior | [Harness and runner contract](https://github.com/mvschwarz/openrig/blob/main/docs/reference/harness-runner-contract.md) |
| Team topology and seat declarations | [RigSpec](https://github.com/mvschwarz/openrig/blob/main/docs/reference/rig-spec.md) |
| External human notifications and replies | [Gateway Relay](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md), [gateway participants](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-participants.md) |

Gateway Relay is a separate upstream human-bridge interface. This seat gateway does
not implement its custody or human attribution contract. Use that reference when a
client also needs those operations. Moving upstream documentation does not extend
this repository's tested compatibility pin.
