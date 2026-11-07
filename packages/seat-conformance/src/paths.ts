/**
 * The OpenRig checkout to extract from. `OPENRIG_CHECKOUT` is required: this repository records the
 * pinned commit in openrig-compat.json but never a local path.
 */
export function resolveOpenRigPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.OPENRIG_CHECKOUT;
  if (!p) {
    throw new Error(
      "OPENRIG_CHECKOUT is not set. Point it at a read-only OpenRig checkout at the commit listed in openrig-compat.json " +
        "(see packages/seat-conformance/README.md), for example: OPENRIG_CHECKOUT=/path/to/openrig npm test",
    );
  }
  return p;
}
