import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { assertLoopbackUrl } from "@openrig-seats/seat-source-openrig";
import { DEFAULT_SEND_MAX_LENGTH, type ActConfig } from "./act.js";

export interface GatewayConfig {
  /** Literal loopback URL of the OpenRig daemon. */
  daemonUrl: string;
  /** Optional path of a 0600 file holding the daemon's terminal bearer token. */
  daemonTokenFile?: string;
  /** Path of a 0600 file holding the bearer token clients must send. Required. */
  tokenFile: string;
  listen: { host: string; port: number };
  /** Binding a non-loopback address is refused unless this is true. */
  allowNonLoopback: boolean;
  /** Origins allowed to call the gateway (none by default: a browser page is refused). */
  allowedOrigins: string[];
  /** Extra Host header values accepted (loopback names are always accepted). */
  allowedHosts: string[];
  hostId: string;
  hostName: string;
  tombstoneLimit: number;
  /** Write side. Off by default: with `act.send` unset the gateway is read-only. */
  act: ActConfig;
  /** The `x-openrig` extension. */
  xOpenrig: {
    /** Carry the daemon's free text (error text, prompt reason or summary, hold reason, event summaries). Off by default: sensitive. */
    includeText: boolean;
    /** Events asked of the daemon on a cold start; the budget counts ALL daemon event types. Default 2000. */
    replay: number;
  };
}

/** A leading ~/ means the home directory of the user running the gateway. */
export const expandHome = (p: string) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

const LOOPBACK_BIND = /^(127(\.\d{1,3}){3}|::1|\[::1\])$/;
export const isLoopbackBind = (h: string) => LOOPBACK_BIND.test(h);

export function parseConfig(raw: unknown): GatewayConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const r = raw as Record<string, unknown>;
  const str = (k: string, d?: string): string => {
    const v = r[k] ?? d;
    if (typeof v !== "string" || v === "") throw new Error(`config.${k} must be a non-empty string`);
    return v;
  };
  const listen = (r.listen ?? {}) as Record<string, unknown>;
  const host = typeof listen.host === "string" ? listen.host : "127.0.0.1";
  const port = listen.port === undefined ? 8088 : listen.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("config.listen.port must be an integer 0-65535");
  const allowNonLoopback = r.allowNonLoopback === true;
  if (!allowNonLoopback && !isLoopbackBind(host)) throw new Error("config.listen.host must be a loopback address (set allowNonLoopback to override)");
  const strings = (k: string): string[] => {
    const v = r[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`config.${k} must be an array of strings`);
    return v as string[];
  };
  const daemonUrl = str("daemonUrl", "http://127.0.0.1:7433");
  assertLoopbackUrl(daemonUrl);
  const tombstoneLimit = r.tombstoneLimit === undefined ? 5000 : r.tombstoneLimit;
  if (typeof tombstoneLimit !== "number" || !Number.isInteger(tombstoneLimit) || tombstoneLimit < 0) throw new Error("config.tombstoneLimit must be a non-negative integer");
  const x = (r.xOpenrig ?? {}) as Record<string, unknown>;
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("config.xOpenrig must be an object");
  if (x.includeText !== undefined && typeof x.includeText !== "boolean") throw new Error("config.xOpenrig.includeText must be a boolean");
  const replay = x.replay === undefined ? 2000 : x.replay;
  if (typeof replay !== "number" || !Number.isInteger(replay) || replay < 0 || replay > 100_000) throw new Error("config.xOpenrig.replay must be an integer 0-100000");
  const a = (r.act ?? {}) as Record<string, unknown>;
  if (typeof a !== "object" || a === null || Array.isArray(a)) throw new Error("config.act must be an object");
  if (a.send !== undefined && typeof a.send !== "boolean") throw new Error("config.act.send must be a boolean");
  const send = a.send === true;
  const maxLength = a.maxLength === undefined ? DEFAULT_SEND_MAX_LENGTH : a.maxLength;
  if (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 20_000) throw new Error("config.act.maxLength must be an integer 1-20000");
  const maxKeys = a.maxKeys === undefined ? 5000 : a.maxKeys;
  if (typeof maxKeys !== "number" || !Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1_000_000) throw new Error("config.act.maxKeys must be an integer 1-1000000");
  const retentionDays = a.retentionDays === undefined ? 7 : a.retentionDays;
  if (typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("config.act.retentionDays must be an integer 1-3650");
  if (a.sender !== undefined && (typeof a.sender !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.sender))) throw new Error("config.act.sender must look like name@rig");
  if (a.idempotencyFile !== undefined && (typeof a.idempotencyFile !== "string" || a.idempotencyFile === "")) throw new Error("config.act.idempotencyFile must be a non-empty string");
  if (send && a.sender === undefined) throw new Error("config.act.sender is required when act.send is true (a registered non-seat address such as cockpit@<rig>)");
  if (send && a.idempotencyFile === undefined) throw new Error("config.act.idempotencyFile is required when act.send is true");
  const act: ActConfig = {
    send,
    ...(typeof a.sender === "string" ? { sender: a.sender } : {}),
    maxLength,
    ...(typeof a.idempotencyFile === "string" ? { idempotencyFile: expandHome(a.idempotencyFile) } : {}),
    maxKeys,
    retentionDays,
  };
  return {
    daemonUrl,
    act,
    ...(typeof r.daemonTokenFile === "string" ? { daemonTokenFile: expandHome(r.daemonTokenFile) } : {}),
    tokenFile: expandHome(str("tokenFile")),
    listen: { host, port },
    allowNonLoopback,
    allowedOrigins: strings("allowedOrigins"),
    allowedHosts: strings("allowedHosts"),
    hostId: str("hostId", "local"),
    hostName: str("hostName", "openrig"),
    tombstoneLimit,
    xOpenrig: { includeText: x.includeText === true, replay },
  };
}

export function loadConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error("config file is not readable");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("config file is not valid JSON");
  }
  return parseConfig(json);
}
