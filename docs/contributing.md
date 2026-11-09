# Develop and contribute

Extend the current implementation. Reuse its functions, tests and fixture patterns.
Keep one concern per change and preserve unrelated work.

## Local checks

Use Node 22 or 24 and npm 10+. From the repository root:

```sh
npm ci
npm run build
npm test
npm test -w @openrig-seats/seat-gateway -- minimal-example
npm run check
```

Default tests use fictional fixtures and the checked-in conformance snapshot.
They need no accounts, source checkout or running daemon. The example test is part
of the gateway Vitest suite and also runs under `npm test`.

`npm run check` typechecks package sources and tests. After changing protocol schemas,
run `npm run generate` to regenerate TypeScript types, then repeat the checks.

## Verify against OpenRig source

Use a separate source checkout at the [compatibility pin](../openrig-compat.json):

```sh
OPENRIG_CHECKOUT=/path/to/openrig npm test
```

This reads source; it does not operate a daemon. If explicitly set, an invalid checkout
fails rather than silently skipping validation. See [seat-conformance](../packages/seat-conformance/README.md)
for snapshot refresh and pin updates.

Live tests are a separate opt-in using `OPENRIG_SEATS_LIVE=1` and
`OPENRIG_SEATS_LIVE_URL=http://127.0.0.1:<port>`. They issue GET requests only.
Use them only with an operator-approved isolated daemon. Default checks never need them.
`OPENRIG_SEATS_LIVE_TOKEN_FILE` optionally supplies its token file.

The gateway soak defaults to three seconds. To extend it:

```sh
SEAT_GATEWAY_SOAK_MS=3600000 npm test -w @openrig-seats/seat-gateway -- soak
```

## Changes and review

Write a regression test before changing behavior. Use real gateway/client code with
fictional fixtures where possible. A simulated test proves that path only; report
native or live verification separately. Include actual commands, results and any
checks that failed or were not run. Keep credentials and personal data out of evidence.
Commit and PR text must have no AI attribution lines or session links.

For changes proposed to [OpenRig upstream](https://github.com/mvschwarz/openrig), follow
[its CONTRIBUTING.md](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md):
report bugs with a small reproduction; discuss behavior changes first; get maintainer
agreement on integration scope before building upstream work. Small obvious fixes need
no issue. Keep upstream versioning and release-note decisions with its maintainers.
