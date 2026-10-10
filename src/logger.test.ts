import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

const TOKEN = "s".repeat(48);

/**
 * pino's destination is async in production, so the test waits for the bytes
 * to land rather than reshaping the logger to be synchronous.
 */
async function readLog(dir: string, file: string): Promise<string> {
  const target = join(dir, file);
  await vi.waitFor(
    () => {
      expect(readFileSync(target, "utf8")).not.toBe("");
    },
    { timeout: 5_000, interval: 20 },
  );
  return readFileSync(target, "utf8");
}

describe("createLogger", () => {
  it("never writes the tunnel token, even when interpolated into a message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const file = join(dir, "relay.log");
    const logger = createLogger({ level: "trace", file, token: TOKEN });

    logger.info(`connecting to https://relay.example/mcp?path=${TOKEN}`);
    logger.info({ path: `/mcp?path=${TOKEN}` });
    logger.info({ nested: { url: `wss://relay.example/ws?path=${TOKEN}` } });
    logger.info([`array item ${TOKEN}`]);
    logger.error(new Error(`boom while using ${TOKEN}`));

    const contents = await readLog(dir, "relay.log");

    expect(contents).not.toContain(TOKEN);
    expect(contents).toContain("[redacted]");
  });

  it("still logs ordinary messages, so redaction cannot silence the relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const file = join(dir, "relay.log");
    const logger = createLogger({ level: "trace", file, token: TOKEN });

    logger.info(`first ${TOKEN}`);
    logger.info("second line still recorded");

    const contents = await readLog(dir, "relay.log");
    expect(contents).toContain("second line still recorded");
    expect(contents).not.toContain(TOKEN);
  });

  it("redacts an authorization header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const file = join(dir, "relay.log");
    const logger = createLogger({ level: "trace", file, token: TOKEN });

    logger.info({ req: { headers: { authorization: `Bearer ${TOKEN}` } } });
    const contents = await readLog(dir, "relay.log");

    expect(contents).not.toContain(`Bearer ${TOKEN}`);
  });

  it("survives non-string values on the scrub path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const file = join(dir, "relay.log");
    const logger = createLogger({ level: "trace", file, token: TOKEN });

    logger.info({ count: 3, on: true, missing: null, nested: { deep: [1, 2] } });
    const contents = await readLog(dir, "relay.log");

    expect(contents).toContain('"count":3');
  });

  it("creates the log directory if it does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const relative = join("deep", "nested", "relay.log");
    const logger = createLogger({ level: "info", file: join(dir, relative), token: TOKEN });

    logger.info("created the directory");
    expect(await readLog(dir, relative)).toContain("created the directory");
  });

  it("keeps every repeated token redacted across many lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    const file = join(dir, "relay.log");
    const logger = createLogger({ level: "trace", file, token: TOKEN });

    for (let i = 0; i < 50; i++) {
      logger.info(`line ${i} ${TOKEN}`);
    }

    const contents = await readLog(dir, "relay.log");
    expect(contents).not.toContain(TOKEN);
    expect(contents).toContain("line 49");
  });
});
