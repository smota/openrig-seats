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
