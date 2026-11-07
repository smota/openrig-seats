import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretFile } from "@openrig-seats/seat-source-openrig";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/index.js";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "seat-gw-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("secret files", () => {
  it("reads a 0600 file and trims it", () => {
    const f = join(dir, "t");
    writeFileSync(f, "value\n", { mode: 0o600 });
    chmodSync(f, 0o600);
    expect(readSecretFile(f)).toBe("value");
  });

  it("refuses a file readable by group or others without echoing its content", () => {
    const f = join(dir, "t");
    writeFileSync(f, "do-not-print", { mode: 0o644 });
    chmodSync(f, 0o644);
    let message = "";
    try {
      readSecretFile(f);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/chmod 600/);
    expect(message).not.toContain("do-not-print");
  });

  it("refuses missing, empty and non-file paths", () => {
    expect(() => readSecretFile(join(dir, "missing"))).toThrow(/not readable/);
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n", { mode: 0o600 });
    expect(() => readSecretFile(empty)).toThrow(/empty/);
    expect(() => readSecretFile(dir)).toThrow(/regular file/);
  });
});

describe("config", () => {
  it("applies safe defaults", () => {
    const c = parseConfig({ tokenFile: "/run/secrets/gw" });
    expect(c).toMatchObject({ daemonUrl: "http://127.0.0.1:7433", listen: { host: "127.0.0.1", port: 8088 }, allowNonLoopback: false, allowedOrigins: [], hostId: "local" });
  });

  it("expands a leading ~/ in token paths", () => {
    expect(parseConfig({ tokenFile: "~/t", daemonTokenFile: "~/d" }).tokenFile).toMatch(/^\/.+\/t$/);
    expect(parseConfig({ tokenFile: "~/t" }).tokenFile.startsWith("~")).toBe(false);
  });

  it("rejects bad shapes", () => {
    expect(() => parseConfig(null)).toThrow();
    expect(() => parseConfig({})).toThrow(/tokenFile/);
    expect(() => parseConfig({ tokenFile: "x", listen: { port: 70000 } })).toThrow(/port/);
    expect(() => parseConfig({ tokenFile: "x", allowedOrigins: [1] })).toThrow(/allowedOrigins/);
  });

  it("loads a JSON file and gives errors that carry no file content", () => {
    const f = join(dir, "c.json");
    writeFileSync(f, JSON.stringify({ tokenFile: "x", hostName: "acme-host" }));
    expect(loadConfig(f).hostName).toBe("acme-host");
    writeFileSync(f, "{ secret-looking-garbage");
    expect(() => loadConfig(f)).toThrow(/not valid JSON/);
    expect(() => loadConfig(join(dir, "none"))).toThrow(/not readable/);
  });
});

describe("xOpenrig config", () => {
  const base = { tokenFile: "t" };
  it("defaults to no text and a 2000 event budget", () => {
    expect(parseConfig(base).xOpenrig).toEqual({ includeText: false, replay: 2000 });
  });
  it("accepts includeText and replay, rejects bad values", () => {
    expect(parseConfig({ ...base, xOpenrig: { includeText: true, replay: 10 } }).xOpenrig).toEqual({ includeText: true, replay: 10 });
    expect(() => parseConfig({ ...base, xOpenrig: { includeText: "yes" } })).toThrow(/includeText/);
    expect(() => parseConfig({ ...base, xOpenrig: { replay: -1 } })).toThrow(/replay/);
    expect(() => parseConfig({ ...base, xOpenrig: [] })).toThrow(/xOpenrig/);
  });
});

describe("terminal config", () => {
  it("defaults off with bounded viewers and frames", () => {
    expect(parseConfig({ tokenFile: "t" }).terminal).toEqual({ enabled: false, maxViewers: 8, maxFrameBytes: 262144 });
  });
  it("requires a fixed principal when enabled and validates finite limits", () => {
    for (const terminal of [[], { enabled: "yes" }, { enabled: true }, { principal: "bad\nheader" }, { maxViewers: 0 }, { maxViewers: 1025 }, { maxFrameBytes: 0 }, { maxFrameBytes: 1048577 }]) expect(() => parseConfig({ tokenFile: "t", terminal })).toThrow(/terminal/);
    expect(parseConfig({ tokenFile: "t", terminal: { enabled: true, principal: "viewer@acme", maxViewers: 2, maxFrameBytes: 1024 } }).terminal).toMatchObject({ enabled: true, principal: "viewer@acme" });
  });
});
