import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  decodeFrame,
  HelloAckEnvelopeSchema,
  HelloEnvelopeSchema,
  MAX_FRAME_BYTES,
  PongEnvelopeSchema,
  ResultEnvelopeSchema,
  WS_COMMAND,
  WS_PONG,
  WS_READY,
} from "./rpc.js";
import { PROTOCOL_VERSION } from "./version.js";

const validHello = {
  v: PROTOCOL_VERSION,
  kind: "relay.hello",
  extensionVersion: "2.1.0",
};

describe("inbound frame guards", () => {
  it("accepts a valid hello", () => {
    expect(HelloEnvelopeSchema.safeParse(validHello).success).toBe(true);
  });

  it("rejects a hello carrying extra fields", () => {
    // strictObject: an extension sending an unexpected field may be a
    // different build than we think, which is exactly when to refuse.
    expect(HelloEnvelopeSchema.safeParse({ ...validHello, sneaky: 1 }).success).toBe(false);
  });

  it("rejects a missing or wrong-typed version", () => {
    expect(HelloEnvelopeSchema.safeParse({ ...validHello, v: undefined }).success).toBe(false);
    expect(HelloEnvelopeSchema.safeParse({ ...validHello, v: 21 }).success).toBe(false);
  });

  it("accepts a valid command and result pair", () => {
    const command = {
      v: PROTOCOL_VERSION,
      kind: WS_COMMAND,
      id: "c1",
      tool: "click",
      args: { ref: "e:51b2" },
      deadlineMs: 10_000,
    };
    expect(CommandEnvelopeSchema.safeParse(command).success).toBe(true);

    const result = { v: PROTOCOL_VERSION, kind: "relay.result", id: "c1", ok: true, data: {} };
    expect(ResultEnvelopeSchema.safeParse(result).success).toBe(true);
  });

  it("rejects a command with no deadline", () => {
    const { deadlineMs: _drop, ...noDeadline } = {
      v: PROTOCOL_VERSION,
      kind: WS_COMMAND,
      id: "c1",
      tool: "click",
      args: {},
      deadlineMs: 1,
    };
    expect(CommandEnvelopeSchema.safeParse(noDeadline).success).toBe(false);
  });

  it("rejects an unbounded command deadline", () => {
    const command = {
      v: PROTOCOL_VERSION,
      kind: WS_COMMAND,
      id: "c1",
      tool: "click",
      args: {},
      deadlineMs: 10_000_000,
    };
    expect(CommandEnvelopeSchema.safeParse(command).success).toBe(false);
  });

  it("validates the ready ack", () => {
    const ack = {
      v: PROTOCOL_VERSION,
      kind: WS_READY,
      relayVersion: PROTOCOL_VERSION,
      sessionId: "s1",
      acceptedProtocolVersions: ["2.1"],
    };
    expect(HelloAckEnvelopeSchema.safeParse(ack).success).toBe(true);
    expect(HelloAckEnvelopeSchema.safeParse({ ...ack, sessionId: "" }).success).toBe(false);
  });

  it("validates a pong", () => {
    expect(PongEnvelopeSchema.safeParse({ v: PROTOCOL_VERSION, kind: WS_PONG }).success).toBe(true);
  });
});

describe("decodeFrame", () => {
  it("parses a JSON frame from a string and a Buffer", () => {
    const frame = JSON.stringify(validHello);
    expect(decodeFrame(frame)).toEqual({ ok: true, value: validHello });
    expect(decodeFrame(Buffer.from(frame, "utf8"))).toEqual({ ok: true, value: validHello });
  });

  it("reports malformed JSON instead of throwing", () => {
    expect(decodeFrame("{not json")).toEqual({ ok: false, reason: "malformed" });
    expect(decodeFrame("")).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a frame over the byte cap", () => {
    const huge = JSON.stringify({ v: "2.1.0", pad: "x".repeat(MAX_FRAME_BYTES) });
    expect(decodeFrame(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("measures bytes, not characters", () => {
    // A multi-byte payload can pass a .length check and still blow the budget.
    const multiByte = JSON.stringify({ pad: "\u00e9".repeat(MAX_FRAME_BYTES / 2) });
    expect(decodeFrame(multiByte)).toEqual({ ok: false, reason: "too_large" });
  });

  it("honours a custom cap", () => {
    expect(decodeFrame('{"a":1}', 4)).toEqual({ ok: false, reason: "too_large" });
    expect(decodeFrame('{"a":1}', 100)).toEqual({ ok: true, value: { a: 1 } });
  });
});
