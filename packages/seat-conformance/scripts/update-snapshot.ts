// Regenerates snapshots/openrig-surfaces.json from the OpenRig checkout in OPENRIG_CHECKOUT (required).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../src/extract.js";
import { resolveOpenRigPath } from "../src/paths.js";

const root = resolveOpenRigPath();
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../snapshots/openrig-surfaces.json");
const snapshot = buildSnapshot(root);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`snapshot written from ${root} (${snapshot.openrigCommit ?? "no git"}): ${out}`);
