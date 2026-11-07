import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { assertLoopbackUrl, type DaemonClient } from "./daemon.js";
import { ROUTES } from "./routes.js";

/** The narrow ws interface used by the read-only terminal bridge. */
export interface TerminalSocket extends EventEmitter {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (error?: Error) => void): void;
  pong(data: Buffer, mask: boolean, cb?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
export type TerminalSocketConstructor = new (url: string, options: { headers: Record<string, string>; maxPayload: number; handshakeTimeout: number; followRedirects: false; perMessageDeflate: false; autoPong: false }) => TerminalSocket;
const WebSocket = createRequire(import.meta.url)("ws") as TerminalSocketConstructor;

/** Missing, invalid or unreachable settings fail closed; never retain an old true answer. */
export async function terminalUiEnabled(daemon: DaemonClient, signal?: AbortSignal): Promise<boolean> {
  try {
    const value = await daemon.getJson(ROUTES.uiEnabled, signal);
    return typeof value === "object" && value !== null && (value as { value?: unknown }).value === true;
  } catch { return false; }
}

/** A dedicated output subscription; only the bridge's reconstructed scroll messages may be sent on it. */
export function openTerminal(opts: { baseUrl: string; token?: string; principal: string; session: string; maxFrameBytes: number }): TerminalSocket {
  const url = assertLoopbackUrl(opts.baseUrl);
  url.protocol = "ws:";
  url.pathname = ROUTES.terminal(opts.session);
  url.search = "";
  url.hash = "";
  return new WebSocket(url.href, {
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "x-openrig-session": opts.principal },
    maxPayload: opts.maxFrameBytes,
    handshakeTimeout: 10_000,
    followRedirects: false,
    perMessageDeflate: false,
    autoPong: false,
  });
}
