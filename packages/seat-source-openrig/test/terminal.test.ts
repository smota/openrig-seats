import { describe, expect, it } from "vitest";
import { DaemonClient, terminalUiEnabled } from "../src/index.js";

describe("terminal daemon setting", () => {
  it("probes the pinned config route with bearer auth and never follows redirects", async () => {
    let path = "";
    let init: RequestInit | undefined;
    const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", token: "private", fetch: async (url, options) => { path = String(url); init = options; return Response.json({ value: true, source: "file", defaultValue: false }); } });
    expect(await terminalUiEnabled(daemon)).toBe(true);
    expect(path).toBe("http://127.0.0.1:7433/api/config/ui.enabled");
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer private" } });
  });
  it("requires an actual boolean true and fails closed on HTTP or transport errors", async () => {
    for (const body of [{ value: false }, { value: "true" }, {}, null]) {
      const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: async () => Response.json(body) });
      expect(await terminalUiEnabled(daemon)).toBe(false);
    }
    for (const status of [403, 404, 500]) {
      const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: async () => new Response(null, { status }) });
      expect(await terminalUiEnabled(daemon)).toBe(false);
    }
    const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: async () => { throw new Error("secret"); } });
    expect(await terminalUiEnabled(daemon)).toBe(false);
  });
});
