import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Heartbeat } from "./heartbeat.js";

describe("Heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pings on interval and terminates if no pong", () => {
    const ws = Object.assign(new EventEmitter(), {
      ping: vi.fn(),
      terminate: vi.fn(),
    }) as unknown as import("ws").WebSocket;

    const heartbeat = new Heartbeat(ws, 20000);
    heartbeat.start();

    // 20s pass - ping sent
    vi.advanceTimersByTime(20000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.terminate).not.toHaveBeenCalled();

    // Another 20s pass - no pong received!
    vi.advanceTimersByTime(20000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).toHaveBeenCalledTimes(1); // Didn't send a second ping

    heartbeat.stop();
  });

  it("keeps alive if pong is received", () => {
    const ws = Object.assign(new EventEmitter(), {
      ping: vi.fn(),
      terminate: vi.fn(),
    }) as unknown as import("ws").WebSocket;

    const heartbeat = new Heartbeat(ws, 20000);
    heartbeat.start();

    // 20s pass - ping sent
    vi.advanceTimersByTime(20000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Receive pong
    ws.emit("pong");

    // Another 20s pass - second ping sent
    vi.advanceTimersByTime(20000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(2);

    heartbeat.stop();
  });
});
