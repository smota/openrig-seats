# Changelog

## Unreleased

- Build shared package dependencies before consumers so a clean clone builds in the required order.

- Add a fixture-backed gateway and seat-ui example, checked by the existing test runner.
- Reorganize adoption docs and add repository agent guidance.
- Declare protocol/schema compatibility and detect drift during `npm test`.
- Make default conformance tests use the checked-in snapshot; validate an upstream source checkout when explicitly supplied.

## 0.1.0 development history — not a release

No release tags or published packages exist in the current git history. Package
manifests use `0.1.0`; the private workspace root uses `0.0.0`. The entries below
reconstruct development history, newest first. They do not assert releases.

### 2026-11-08

- Add reference seat-ui, declared-action forms and browser transport; bound reads,
  caches and terminal frames; document threat model (`0d1e2f7`, `88a72a5`, `a6f197e`).
- Add seat-ui and downstream cockpit screenshots (`6ee8caf`).
- Add read-only terminal; harden sync authorization, scroll limits and frame handling
  (`e22f0e0`, `571c6f5`, `ce006cb`, `8f5c5de`).
- Add native agy and pi readers; harden discovery, symlink refusal and read windows
  (`5812287`, `f6ceccb`, `11a28c1`, `76845e9`).

### 2026-11-07

- Add opt-in sends with durable idempotency (`ef22526`).
- Add `x-openrig` extension with daemon free text off by default (`ce8e06e`).
- Add read-only gateway over an OpenRig source (`8fd82b9`).
- Add Claude and Codex transcript readers (`7813dab`).
- Add protocol schemas, client and OpenRig conformance snapshot (`27b189b`).
