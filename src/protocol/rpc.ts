import { z } from "zod";

/**
 * Relay <-> extension RPC envelopes.
 *
 * The relay is the only trusted party; the extension is a local client that
 * may be running stale code. Every inbound frame is parsed with a strict
 * schema before any handler sees it.
 */

export const WS_READY = "relay.ready";
export const WS_COMMAND = "relay.command";
export const WS_RESULT = "relay.result";
export const WS_ERROR = "relay.error";
export const WS_PING = "relay.ping";
export const WS_PONG = "relay.pong";

/**
 * MAX_FRAME_BYTES is a hard cap on a single WS message.
 *
 * A page snapshot is the only legitimately large payload; 4 MiB leaves room
 * for a full HTML document while refusing to buffer an unbounded frame.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const ProtocolVersionSchema = z.string().min(1).max(32);

/** Relay -> extension: a validated, budget-checked action to perform. */
export const CommandEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_COMMAND),
  id: z.string().min(1).max(128),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
  /** Per-command deadline; the extension must abandon the action past it. */
  deadlineMs: z.number().int().positive().max(120_000),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/** Extension -> relay: the outcome of a command. Never trusted without parse. */
export const ResultEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_RESULT),
  id: z.string().min(1).max(128),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

/** Extension -> relay: opening handshake, sent immediately after connect. */
export const HelloEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("relay.hello"),
  extensionVersion: z.string().min(1).max(32),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(256).optional(),
});
export type HelloEnvelope = z.infer<typeof HelloEnvelopeSchema>;

export const HelloAckEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_READY),
  relayVersion: z.string().min(1).max(32),
  sessionId: z.string().min(1).max(128),
  acceptedProtocolVersions: z.array(z.string().min(1)),
});
export type HelloAckEnvelope = z.infer<typeof HelloAckEnvelopeSchema>;

/** The relay's refusal of an unsupported extension build. */
export const VersionRejectedEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_ERROR),
  code: z.literal("EXTENSION_VERSION_UNSUPPORTED"),
  message: z.string().min(1).max(500),
  acceptedProtocolVersions: z.array(z.string().min(1)),
});
export type VersionRejectedEnvelope = z.infer<typeof VersionRejectedEnvelopeSchema>;

export const PingEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_PING),
});
export const PongEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal(WS_PONG),
});

export function encodeFrame(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Decode and size-check an inbound frame.
 *
 * Callers must handle both the `ok` and the `error` result; a malformed frame
 * is an attack surface, not a programming error to throw on.
 */
export function decodeFrame(
  raw: string | Buffer,
  maxBytes: number = MAX_FRAME_BYTES,
): { ok: true; value: unknown } | { ok: false; reason: "too_large" | "malformed" } {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > maxBytes) return { ok: false, reason: "too_large" };

  try {
    return { ok: true, value: JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
