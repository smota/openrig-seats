# Contributing

- Open an issue before a protocol change: the protocol is the product, and within a major version
  only additions are allowed.
- Keep `seat-protocol` free of runtime dependencies.
- Every schema change needs valid and invalid fixtures under
  `packages/seat-protocol/schemas/fixtures/`, and `npm run generate` for the types.
- Run `npm test` and `npm run check` before sending a change. No secrets, tokens or private
  transcripts in fixtures, tests or issues.
- Report security problems privately to the repository owner rather than in a public issue.
