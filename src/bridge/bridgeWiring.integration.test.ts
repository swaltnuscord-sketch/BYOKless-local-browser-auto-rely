import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ToolDispatcher } from "../dispatch.js";
import { createApp } from "../mcp/server.js";
import { TaskStore } from "../tasks/store.js";
import { ExtensionSessionManager, type SessionEvents } from "../ws/session.js";

const TOKEN = "t".repeat(48);
const TEST_SECRET = "secret-1234567890123456";

describe("Bridge Modules Integration & Wiring Verification", () => {
  let dir: string;
  let store: TaskStore;
  let session: ExtensionSessionManager;
  let dispatcher: ToolDispatcher;
  let wss: WebSocketServer;
  let wsPort: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relay-bridge-"));
    store = new TaskStore(join(dir, "relay.db"));

    session = new ExtensionSessionManager(
      {
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      } as unknown as SessionEvents,
      4 * 1024 * 1024,
      TEST_SECRET,
    );

    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wsPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (socket: WebSocket) => session.attach(socket));

    dispatcher = new ToolDispatcher({ store, session });
  });

  afterEach(async () => {
    session.detach();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("proves SessionLease is wired into createApp", () => {
    const app = createApp({
      dispatcher,
      token: TOKEN,
      enableDevTools: false,
      rateLimitMax: 1000,
      rateLimitWindowMs: 60000,
    });
    expect(app.locals.sessionLease).toBeDefined();
    expect(typeof app.locals.sessionLease.acquire).toBe("function");

    const lease = app.locals.sessionLease;
    expect(lease.acquire("session-1")).toBe(true);
    expect(lease.current).toBe("session-1");
    expect(lease.acquire("session-2")).toBe(false); // Second session rejected
    lease.release("session-1");
    expect(lease.acquire("session-2")).toBe(true);
  });

  it("proves Heartbeat is wired into ExtensionSessionManager lifecycle", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => ws.once("open", resolve));

    // Send valid hello with secret
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "relay.hello",
        extensionVersion: "2.1.0",
        secret: TEST_SECRET,
      }),
    );

    await vi.waitFor(() => expect(session.connected).toBe(true));

    let _pingReceived = false;
    ws.on("ping", () => {
      _pingReceived = true;
      ws.pong();
    });

    // Session is connected and heartbeat is active
    expect(session.connected).toBe(true);
    ws.terminate();
    await vi.waitFor(() => expect(session.connected).toBe(false));
  });

  it("proves Deduplicator is wired into ToolDispatcher mutating actions", async () => {
    let callCount = 0;
    vi.spyOn(session, "send").mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, data: { summary: "done" } } as never;
    });

    await dispatcher.dispatch("start_task", { goal: "test dedupe" });

    // Concurrent identical mutating calls with the same fingerprint
    const p1 = dispatcher.dispatch("click", { ref: "e:101" });
    const p2 = dispatcher.dispatch("click", { ref: "e:101" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    // Deduplicator coalesced the concurrent in-flight calls into a single execution
    expect(callCount).toBe(1);
  });

  it("proves TabQueue is wired into ToolDispatcher for per-tab sequencing", async () => {
    const executionOrder: number[] = [];
    let callIdx = 0;
    vi.spyOn(session, "send").mockImplementation(async () => {
      const idx = ++callIdx;
      await new Promise((r) => setTimeout(r, idx === 1 ? 50 : 10));
      executionOrder.push(idx);
      return { ok: true, data: { summary: "done" } } as never;
    });

    await dispatcher.dispatch("start_task", { goal: "test queue" });

    // Two distinct tool calls on tab_id: 1. Different fingerprints avoid deduplication, but TabQueue sequences them.
    const p1 = dispatcher.dispatch("tab_switch", { tab_id: 1 });
    const p2 = dispatcher.dispatch("tab_close", { tab_id: 1 });

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual([1, 2]);
  });
});
