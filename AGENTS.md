# Work on openrig-seats

Provide a small seat protocol, gateway and reference UI for OpenRig seats.
Make adoption clear while preserving working behavior and compatibility evidence.

## Layout

| Path | Responsibility |
|---|---|
| `packages/seat-protocol/` | JSON Schemas, generated types, client, SSE, protocol constants. |
| `packages/seat-source-openrig/` | Daemon HTTP snapshots/events mapped to protocol entities. |
| `packages/seat-gateway/` | Authenticated gateway, state cache, optional send and terminal. |
| `packages/seat-ui/` | Protocol-driven browser UI and standalone adapter server. |
| `packages/seat-readers/` | Native session records mapped to turns; injected-root discovery. |
| `packages/seat-conformance/` | Source extraction and checked-in OpenRig contract snapshot. |
| `examples/minimal/` | Fictional fixture -> real gateway -> seat-ui reference setup. |
| `docs/` | Integration, configuration, behavior and contributor guides. |
| `openrig-compat.json` | Tested OpenRig pin and protocol/schema declarations. |

## Principles

- Continuity over creation: read the relevant implementation, docs and tests first. Reuse existing functions, tests and patterns before adding mechanisms.
- Fail closed: preserve authentication, loopback, Origin/Host, path, size and capability checks. Unsupported or uncertain operations must refuse honestly.
- Tests first: reproduce behavioral changes with a failing test, then make the smallest fix. Use fictional fixtures; never record secrets, real phone numbers, JIDs or personal data.
- Verification honesty: run relevant commands and report their real output, exit status and limits. Separate fixture, source-checkout and live evidence.
- One concern per change: preserve unrelated edits and avoid incidental refactors.
- Keep commits and PRs free of AI attribution lines and session links.
- Keep tests isolated. Never operate a running OpenRig daemon or service as part of routine checks.

## Build, test and run

Use Node 22 or 24 and npm 10+. From the repository root:

```sh
npm ci
npm run build
npm test
npm test -w @openrig-seats/seat-gateway -- minimal-example
npm run check
node examples/minimal/main.mjs
```

The example uses fictional fixtures without accounts or external services; see
[examples/minimal/README.md](examples/minimal/README.md). Default tests need no daemon.
For schema edits, run `npm run generate` and verify the resulting types and tests.
For compatibility changes, read [seat-conformance](packages/seat-conformance/README.md)
and validate against an explicit read-only `OPENRIG_CHECKOUT`. Do not claim compatibility
with a release or revision that has not been checked.

## Upstream context

When changing an integration boundary, consult [OpenRig upstream](https://github.com/mvschwarz/openrig)
and the relevant contract before editing:

- Harness identity or runtime behavior: [harness-runner-contract.md](https://github.com/mvschwarz/openrig/blob/main/docs/reference/harness-runner-contract.md).
- Rig and seat declarations: [rig-spec.md](https://github.com/mvschwarz/openrig/blob/main/docs/reference/rig-spec.md).
- Human notifications, replies or attribution: [Gateway Relay](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-relay.md) and [gateway participants](https://github.com/mvschwarz/openrig/blob/f5b62726ff759a857eeb76e2cbd654493fedba2f/docs/reference/gateway-participants.md). The seat gateway has its own boundary; it does not implement Relay custody.

For upstream contributions, follow [CONTRIBUTING.md](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md):
use a small bug reproduction, discuss behavior changes first, obtain maintainer scope
agreement for integrations, and keep one concern per PR. Small obvious fixes need no
issue. Report what changed, actual verification and remaining uncertainty.
Read [local contribution details](docs/contributing.md) for this repository's checks.
