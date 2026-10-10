import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, loadConfig } from "./config.js";

const TOKEN = "a".repeat(48);

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
  const tokenPath = join(dir, "relay.token");
  writeFileSync(tokenPath, `${TOKEN}\n`, "utf8");
  return { dir, env: { RELAY_TOKEN_PATH: tokenPath, EXT_SHARED_SECRET: "s".repeat(48) } };
}

describe("loadConfig", () => {
  it("defaults to loopback and a sane port", () => {
    const { env } = workspace();
    const { config } = loadConfig(env);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8765);
  });

  it("keeps dev tools off unless explicitly enabled", () => {
    const { env } = workspace();
    expect(loadConfig(env).config.devToolsEnabled).toBe(false);
    expect(loadConfig({ ...env, ENABLE_DEV_TOOLS: "1" }).config.devToolsEnabled).toBe(true);
    // Anything other than exactly "1" stays off.
    expect(loadConfig({ ...env, ENABLE_DEV_TOOLS: "true" }).config.devToolsEnabled).toBe(false);
  });

  it("trims the token file and never puts the token in the config", () => {
    const { env } = workspace();
    const { config, token } = loadConfig(env);
    expect(token).toBe(TOKEN);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(Object.keys(config)).not.toContain("token");
  });

  it("refuses a non-loopback bind address", () => {
    const { env } = workspace();
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com"]) {
      expect(() => loadConfig({ ...env, RELAY_HOST: host }), host).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...env, RELAY_HOST: "0.0.0.0" })).toThrow(/loopback/i);
  });

  it("accepts the loopback spellings", () => {
    const { env } = workspace();
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
      expect(loadConfig({ ...env, RELAY_HOST: host }).config.host).toBe(host);
    }
  });

  it("refuses to start without a token file", () => {
    expect(() =>
      loadConfig({ RELAY_TOKEN_PATH: join(tmpdir(), "definitely-not-here.token") }),
    ).toThrow(/gen:secrets/);
  });

  it("refuses a short token, which a public tunnel could brute force", () => {
    const { dir } = workspace();
    const short = join(dir, "short.token");
    writeFileSync(short, "tooshort", "utf8");
    expect(() => loadConfig({ RELAY_TOKEN_PATH: short })).toThrow(/at least 32/);
  });

  it("rejects a malformed port instead of falling back", () => {
    const { env } = workspace();
    expect(() => loadConfig({ ...env, RELAY_PORT: "not-a-number" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, RELAY_PORT: "70000" })).toThrow(ConfigError);
  });

  it("rejects an unknown log level", () => {
    const { env } = workspace();
    expect(() => loadConfig({ ...env, LOG_LEVEL: "chatty" })).toThrow(ConfigError);
  });

  it("treats an empty tunnel url as unset rather than a bad url", () => {
    const { env } = workspace();
    expect(loadConfig({ ...env, TUNNEL_URL: "" }).config.tunnelUrl).toBeUndefined();
  });

  it("validates the tunnel url when one is given", () => {
    const { env } = workspace();
    expect(loadConfig({ ...env, TUNNEL_URL: "https://relay.example" }).config.tunnelUrl).toBe(
      "https://relay.example",
    );
    expect(() => loadConfig({ ...env, TUNNEL_URL: "not a url" })).toThrow(ConfigError);
  });

  it("leaves the token file untouched", () => {
    const { env } = workspace();
    loadConfig(env);
    expect(readFileSync(env.RELAY_TOKEN_PATH as string, "utf8")).toBe(`${TOKEN}\n`);
  });
  it("refuses to start without EXT_SHARED_SECRET", () => {
    const { env } = workspace();
    const noSecret = { ...env };
    delete noSecret.EXT_SHARED_SECRET;
    expect(() => loadConfig(noSecret)).toThrow(/EXT_SHARED_SECRET/);
  });

  it("refuses a short EXT_SHARED_SECRET (<32 chars)", () => {
    const { env } = workspace();
    expect(() => loadConfig({ ...env, EXT_SHARED_SECRET: "tooshort" })).toThrow(/at least 32/);
  });
});

describe("isLoopbackHost", () => {
  it("is true only for loopback spellings", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});
