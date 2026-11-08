import type { Capabilities } from "@openrig-seats/seat-protocol";
import type { Snapshot } from "./ui.js";

// Vite embeds the checked-in, valid wire fixtures; no fixture server or daemon is needed.
const files = import.meta.glob<Record<string, unknown>>("../../seat-protocol/schemas/fixtures/valid/**/*.json", { eager: true, import: "default" });
const get = (path: string) => files[`../../seat-protocol/schemas/fixtures/valid/${path}`]!;
export function fixtureData(): { capabilities: Capabilities; snapshot: Snapshot } {
  const capabilities = structuredClone(get("capabilities/with-actions.json")) as unknown as Capabilities;
  capabilities.kinds = ["host", "rig", "seat", "turn", "attention", "work", "x-acme.approval"];
  capabilities.features.terminal = true;
  capabilities.terminal = get("terminal/minimal.json") as unknown as NonNullable<Capabilities["terminal"]>;
  return {
    capabilities,
    snapshot: { cursor: "fixture-cursor", kinds: {
      host: [get("host/minimal.json")], rig: [get("rig/with-count.json")], seat: [get("seat/full.json")],
      turn: [get("turn/all-parts.json")], attention: [get("attention/with-actions.json")], work: [get("work/assigned.json")],
      "x-acme.approval": [get("stream-envelope/extension-generic-card.json").data as Record<string, unknown>],
    } },
  };
}
