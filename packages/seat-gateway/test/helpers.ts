import { Gateway, parseConfig, type GatewayOptions } from "../src/index.js";
import { MockDaemon } from "../../seat-source-openrig/test/mock-daemon.js";

export { MockDaemon };
export { waitFor } from "../../seat-source-openrig/test/helpers.js";

export const TOKEN = "gateway-test-token";

export interface Running {
  gateway: Gateway;
  url: string;
  logs: string[];
  stop: () => Promise<void>;
}

export async function startGateway(daemon: MockDaemon, extra: Partial<GatewayOptions> = {}, config: Record<string, unknown> = {}): Promise<Running> {
  const logs: string[] = [];
  const gateway = new Gateway({
    config: parseConfig({ daemonUrl: daemon.url, tokenFile: "unused", listen: { host: "127.0.0.1", port: 0 }, hostId: "host-1", hostName: "acme-host", ...config }),
    token: TOKEN,
    source: { debounceMs: 5, reconnectMinMs: 10, reconnectMaxMs: 40, resyncIntervalMs: 0 },
    log: (m) => logs.push(m),
    ...extra,
  });
  const addr = await gateway.start();
  return { gateway, url: `http://${addr.host}:${addr.port}`, logs, stop: () => gateway.stop() };
}

export const auth = { authorization: `Bearer ${TOKEN}` };

/** Reads SSE frames from a response until `stop` returns true. Returns the parsed ids and event names. */
export async function readFrames(res: Response, until: (frames: Frame[]) => boolean, ms = 4000): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + ms;
  try {
    while (Date.now() < end && !until(frames)) {
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 50))]);
      if (r === null) continue;
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = { id: undefined, event: "message", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) f.id = line.slice(3).trim();
          else if (line.startsWith("event:")) f.event = line.slice(6).trim();
          else if (line.startsWith("data:")) f.data += line.slice(5).trim();
          else if (line.startsWith(":")) f.comment = line.slice(1).trim();
        }
        frames.push(f);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

export interface Frame {
  id: string | undefined;
  event: string;
  data: string;
  comment?: string;
}

export const seqOf = (cursor: string) => Number(cursor.split(".")[1]);
