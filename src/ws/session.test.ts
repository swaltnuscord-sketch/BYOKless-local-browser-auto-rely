import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ExtensionSessionManager, type SessionEvents } from "./session.js";

let wss: WebSocketServer;
let port: number;
let manager: ExtensionSessionManager;
let events: {
  onConnect: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onProtocolError: ReturnType<typeof vi.fn>;
};

const TEST_SECRET = "test-shared-secret-1234567890123456";
const HELLO = {
  v: PROTOCOL_VERSION,
  kind: "relay.hello",
  extensionVersion: "2.1.0",
  secret: TEST_SECRET,
};

beforeEach(async () => {
  events = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onProtocolError: vi.fn(),
  };
  manager = new ExtensionSessionManager(
    events as unknown as SessionEvents,
    4 * 1024 * 1024,
    TEST_SECRET,
  );

  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  port = typeof address === "object" && address ? address.port : 0;

  wss.on("connection", (socket: WebSocket) => manager.attach(socket));
});

afterEach(async () => {
  manager.detach();
  // wss.close() waits for every client to go away, so terminate first or the
  // hook hangs on a socket the test never closed.
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (raw: Buffer) =>
      resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>),
    );
  });
}

describe("handshake", () => {
  it("throws during construction if extSharedSecret is missing or empty", () => {
    expect(
      () => new ExtensionSessionManager(events as unknown as SessionEvents, 4 * 1024 * 1024, ""),
    ).toThrow(/extSharedSecret is a required constructor parameter/i);
  });

  it("accepts a supported version and confirms with a session id", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));

    const message = await ack;
    expect(message.kind).toBe("relay.ready");
    expect(message.relayVersion).toBe(PROTOCOL_VERSION);
    expect(typeof message.sessionId).toBe("string");
    expect(message.acceptedProtocolVersions).toContain(PROTOCOL_VERSION);
    expect(manager.connected).toBe(true);
    expect(events.onConnect).toHaveBeenCalledOnce();
  });

  it("refuses an unsupported version and tells the extension what is accepted", async () => {
    const socket = await connect();
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ ...HELLO, v: "1.0" }));

    const message = await reply;
    expect(message.kind).toBe("relay.error");
    expect(message.code).toBe("EXTENSION_VERSION_UNSUPPORTED");
    expect(message.acceptedProtocolVersions).toContain(PROTOCOL_VERSION);
    expect(manager.connected).toBe(false);
  });

  it("refuses a first frame that is not a hello", async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: "relay.result", id: "x", ok: true }));
    await vi.waitFor(() => expect(events.onProtocolError).toHaveBeenCalled());
    expect(manager.connected).toBe(false);
  });

  it("refuses a hello carrying extra fields", async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ ...HELLO, sudo: true }));
    await vi.waitFor(() => expect(events.onProtocolError).toHaveBeenCalled());
    expect(manager.connected).toBe(false);
  });

  it("refuses hello with missing shared secret when secret is required", async () => {
    const secretEvents = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };
    const secretManager = new ExtensionSessionManager(
      secretEvents as unknown as SessionEvents,
      4 * 1024 * 1024,
      "correct-shared-secret-1234567890123456",
    );
    const secretWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => secretWss.once("listening", resolve));
    const sPort = (secretWss.address() as AddressInfo).port;
    secretWss.on("connection", (s: WebSocket) => secretManager.attach(s));

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${sPort}`);
      await new Promise((resolve) => socket.once("open", resolve));
      socket.send(JSON.stringify(HELLO)); // No secret
      await vi.waitFor(() =>
        expect(secretEvents.onProtocolError).toHaveBeenCalledWith(
          "UNAUTHORIZED",
          expect.any(String),
        ),
      );
      expect(secretManager.connected).toBe(false);
    } finally {
      secretManager.detach();
      for (const client of secretWss.clients) client.terminate();
      await new Promise<void>((resolve) => secretWss.close(() => resolve()));
    }
  });

  it("refuses hello with wrong shared secret", async () => {
    const secretEvents = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };
    const secretManager = new ExtensionSessionManager(
      secretEvents as unknown as SessionEvents,
      4 * 1024 * 1024,
      "correct-shared-secret-1234567890123456",
    );
    const secretWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => secretWss.once("listening", resolve));
    const sPort = (secretWss.address() as AddressInfo).port;
    secretWss.on("connection", (s: WebSocket) => secretManager.attach(s));

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${sPort}`);
      await new Promise((resolve) => socket.once("open", resolve));
      socket.send(JSON.stringify({ ...HELLO, secret: "wrong-shared-secret-1234567890123456" }));
      await vi.waitFor(() =>
        expect(secretEvents.onProtocolError).toHaveBeenCalledWith(
          "UNAUTHORIZED",
          expect.any(String),
        ),
      );
      expect(secretManager.connected).toBe(false);
    } finally {
      secretManager.detach();
      for (const client of secretWss.clients) client.terminate();
      await new Promise<void>((resolve) => secretWss.close(() => resolve()));
    }
  });

  it("accepts hello with correct shared secret", async () => {
    const secretEvents = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };
    const correctSecret = "correct-shared-secret-1234567890123456";
    const secretManager = new ExtensionSessionManager(
      secretEvents as unknown as SessionEvents,
      4 * 1024 * 1024,
      correctSecret,
    );
    const secretWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => secretWss.once("listening", resolve));
    const sPort = (secretWss.address() as AddressInfo).port;
    secretWss.on("connection", (s: WebSocket) => secretManager.attach(s));

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${sPort}`);
      await new Promise((resolve) => socket.once("open", resolve));
      const ack = nextMessage(socket);
      socket.send(JSON.stringify({ ...HELLO, secret: correctSecret }));
      const msg = await ack;
      expect(msg.kind).toBe("relay.ready");
      expect(secretManager.connected).toBe(true);
    } finally {
      secretManager.detach();
      for (const client of secretWss.clients) client.terminate();
      await new Promise<void>((resolve) => secretWss.close(() => resolve()));
    }
  });

  it("refuses unsupported version even when secret is correct", async () => {
    const secretEvents = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };
    const correctSecret = "correct-shared-secret-1234567890123456";
    const secretManager = new ExtensionSessionManager(
      secretEvents as unknown as SessionEvents,
      4 * 1024 * 1024,
      correctSecret,
    );
    const secretWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => secretWss.once("listening", resolve));
    const sPort = (secretWss.address() as AddressInfo).port;
    secretWss.on("connection", (s: WebSocket) => secretManager.attach(s));

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${sPort}`);
      await new Promise((resolve) => socket.once("open", resolve));
      const reply = nextMessage(socket);
      socket.send(JSON.stringify({ ...HELLO, v: "1.0", secret: correctSecret }));
      const msg = await reply;
      expect(msg.kind).toBe("relay.error");
      expect(msg.code).toBe("EXTENSION_VERSION_UNSUPPORTED");
      expect(secretManager.connected).toBe(false);
    } finally {
      secretManager.detach();
      for (const client of secretWss.clients) client.terminate();
      await new Promise<void>((resolve) => secretWss.close(() => resolve()));
    }
  });

  it("replaces an existing extension rather than running two", async () => {
    const first = await connect();
    nextMessage(first);
    first.send(JSON.stringify(HELLO));
    await vi.waitFor(() => expect(manager.connected).toBe(true));

    const second = await connect();
    const ack = nextMessage(second);
    second.send(JSON.stringify(HELLO));
    await ack;

    expect(events.onConnect).toHaveBeenCalledTimes(2);
  });
});

describe("sending commands", () => {
  it("delivers a command frame and resolves on the matching result", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    const sessionId = (await ack).sessionId as string;

    const resultPromise = manager.send({
      id: "c1",
      tool: "click",
      args: { ref: "e:51b2" },
      deadlineMs: 5_000,
    });

    const command = (await nextMessage(socket)) as Record<string, unknown>;
    expect(command.kind).toBe("relay.command");
    expect(command.tool).toBe("click");
    expect(command.v).toBe(PROTOCOL_VERSION);

    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "relay.result",
        id: "c1",
        ok: true,
        data: { clicked: true },
      }),
    );

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(sessionId).toBeTruthy();
  });

  it("resolves a failure result rather than rejecting", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;

    const pending = manager.send({ id: "c1", tool: "click", args: {}, deadlineMs: 5_000 });
    await nextMessage(socket);
    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: "relay.result",
        id: "c1",
        ok: false,
        error: { code: "ACTION_FAILED" },
      }),
    );

    expect((await pending).ok).toBe(false);
  });

  it("rejects immediately when nothing is connected", async () => {
    await expect(
      manager.send({ id: "c1", tool: "click", args: {}, deadlineMs: 5_000 }),
    ).rejects.toThrow(/not connected/i);
  });

  it("times out a command the extension never answers", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;

    await expect(
      manager.send({ id: "c1", tool: "click", args: {}, deadlineMs: 150 }),
    ).rejects.toThrow(/did not settle|timeout/i);
    expect(manager.pendingCount).toBe(0);
  });

  it("ignores a result for an unknown command id", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;

    socket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, kind: "relay.result", id: "ghost", ok: true }),
    );
    expect(manager.pendingCount).toBe(0);
  });

  it("refuses a post-handshake frame that is not a valid result", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;

    socket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, kind: "relay.command", id: "x", tool: "click" }),
    );
    await vi.waitFor(() =>
      expect(events.onProtocolError).toHaveBeenCalledWith("BAD_REQUEST", expect.any(String)),
    );
  });
});

describe("disconnect", () => {
  it("fails every in-flight command when the extension goes away", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;

    const pending = manager.send({ id: "c1", tool: "click", args: {}, deadlineMs: 30_000 });
    await nextMessage(socket);
    socket.close();

    await expect(pending).rejects.toThrow(/not connected/i);
    expect(manager.connected).toBe(false);
    expect(manager.pendingCount).toBe(0);
  });

  it("reports the disconnect once", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;
    expect(events.onConnect).toHaveBeenCalledOnce();

    socket.close();
    await vi.waitFor(() => expect(events.onDisconnect).toHaveBeenCalledOnce());
  });

  it("rejects new commands after a disconnect", async () => {
    const socket = await connect();
    const ack = nextMessage(socket);
    socket.send(JSON.stringify(HELLO));
    await ack;
    socket.close();
    await vi.waitFor(() => expect(manager.connected).toBe(false));

    await expect(
      manager.send({ id: "c1", tool: "click", args: {}, deadlineMs: 1_000 }),
    ).rejects.toThrow();
  });
});
