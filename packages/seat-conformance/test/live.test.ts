// Opt-in live check: GET requests only, skipped unless OPENRIG_SEATS_LIVE=1.
// OPENRIG_SEATS_LIVE_URL defaults to http://127.0.0.1:7433; OPENRIG_SEATS_LIVE_TOKEN (optional) is
// sent as a bearer and never printed. Prefer a daemon started on a temporary OPENRIG_HOME.
import { describe, expect, it } from "vitest";

const enabled = process.env.OPENRIG_SEATS_LIVE === "1";
const base = process.env.OPENRIG_SEATS_LIVE_URL ?? "http://127.0.0.1:7433";
const headers: Record<string, string> = process.env.OPENRIG_SEATS_LIVE_TOKEN
  ? { authorization: `Bearer ${process.env.OPENRIG_SEATS_LIVE_TOKEN}` }
  : {};

describe.skipIf(!enabled)("live daemon (GET only)", () => {
  for (const path of ["/api/ps", "/api/attention", "/api/rigs", "/api/queue/open-human-updates"]) {
    it(`GET ${path} answers JSON`, async () => {
      const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("json");
      await res.json();
    });
  }

  it("GET /api/events?replay=0 opens an event stream", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events?replay=0`, { headers, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ctl.abort();
  });
});
