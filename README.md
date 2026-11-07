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

Planned: `seat-source-openrig`, `seat-gateway`, `seat-ui`.

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
