import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type CommandEnvelope,
  decodeFrame,
  encodeFrame,
  HelloAckEnvelopeSchema,
  HelloEnvelopeSchema,
  isSupportedExtensionProtocolVersion,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  type ResultEnvelope,
  ResultEnvelopeSchema,
  SUPPORTED_EXTENSION_PROTOCOL_VERSIONS,
  VersionRejectedEnvelopeSchema,
} from "../protocol/index.js";
import type { WebSocket } from "ws";
import { Heartbeat } from "../bridge/heartbeat.js";
import { ResyncTracker } from "../bridge/resync.js";

/**
 * Tracks the one connected extension and routes commands to it.
 *
 * Only a single extension may hold the browser at a time: two connections
 * racing to click would make settling detection meaningless, so a new
 * connection replaces the old one rather than queueing behind it.
 */

export interface PendingCommand {
  readonly resolve: (value: ResultEnvelope) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface SessionEvents {
  onConnect(sessionId: string, socket: WebSocket): void;
  onDisconnect(sessionId: string): void;
  onProtocolError(code: string, detail: string): void;
}

export class ExtensionSessionManager {
  #socket: WebSocket | null = null;
  #sessionId: string | null = null;
  #heartbeat: Heartbeat | null = null;
  readonly #resyncTracker = new ResyncTracker();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #events: SessionEvents;
  readonly #maxFrameBytes: number;
  readonly #extSharedSecret: string;

  constructor(events: SessionEvents, maxFrameBytes = MAX_FRAME_BYTES, extSharedSecret: string) {
    if (
      !extSharedSecret ||
      typeof extSharedSecret !== "string" ||
      extSharedSecret.trim().length === 0
    ) {
      throw new Error(
        "extSharedSecret is a required constructor parameter; refusing to fail open without authentication",
      );
    }
    this.#events = events;
    this.#maxFrameBytes = maxFrameBytes;
    this.#extSharedSecret = extSharedSecret;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#sessionId !== null;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Wire a socket to the session lifecycle. The first frame must be a hello;
   * anything else closes the connection before it can carry a command.
   */
  attach(socket: WebSocket): void {
    let handshaken = false;

    socket.on("message", (raw: Buffer) => {
      const decoded = decodeFrame(raw, this.#maxFrameBytes);
      if (!decoded.ok) {
        this.#events.onProtocolError(
          "BAD_REQUEST",
          decoded.reason === "too_large"
            ? "frame exceeded the size cap"
            : "frame was not valid JSON",
        );
        socket.close(1003, "invalid frame");
        return;
      }

      if (!handshaken) {
        const hello = HelloEnvelopeSchema.safeParse(decoded.value);
        if (!hello.success) {
          this.#events.onProtocolError("BAD_REQUEST", "first frame was not a valid hello");
          socket.close(1002, "expected hello");
          return;
        }

        // 1. Independent secret check (SEC-08)
        if (this.#extSharedSecret !== null) {
          const secretCandidate = hello.data.secret ?? "";
          const expectedBuf = Buffer.from(this.#extSharedSecret, "utf8");
          const candidateBuf = Buffer.from(secretCandidate, "utf8");
          const secretValid =
            candidateBuf.length === expectedBuf.length &&
            timingSafeEqual(candidateBuf, expectedBuf);

          if (!secretValid) {
            this.#events.onProtocolError(
              "UNAUTHORIZED",
              "extension shared secret missing or invalid",
            );
            socket.close(1008, "unauthorized");
            return;
          }
        }

        // 2. Independent version check
        if (!isSupportedExtensionProtocolVersion(hello.data.v)) {
          // Refuse rather than negotiate: a half-understood contract is worse
          // than no connection when the contract drives a real browser.
          socket.send(
            encodeFrame(
              VersionRejectedEnvelopeSchema.parse({
                v: PROTOCOL_VERSION,
                kind: "relay.error",
                code: "EXTENSION_VERSION_UNSUPPORTED",
                message: `protocol ${hello.data.v} is not supported by this relay`,
                acceptedProtocolVersions: [...SUPPORTED_EXTENSION_PROTOCOL_VERSIONS],
              }),
            ),
          );
          this.#events.onProtocolError(
            "EXTENSION_VERSION_UNSUPPORTED",
            `extension offered ${hello.data.v}`,
          );
          socket.close(1002, "unsupported protocol version");
          return;
        }

        handshaken = true;
        const sessionId = randomUUID();
        // Last writer wins: one browser, one controller.
        this.detach();
        this.#socket = socket;
        this.#sessionId = sessionId;

        this.#heartbeat = new Heartbeat(socket, 20_000, () => {
          this.detach();
          socket.terminate();
        });
        this.#heartbeat.start();

        socket.send(
          encodeFrame(
            HelloAckEnvelopeSchema.parse({
              v: PROTOCOL_VERSION,
              kind: "relay.ready",
              relayVersion: PROTOCOL_VERSION,
              sessionId,
              acceptedProtocolVersions: [...SUPPORTED_EXTENSION_PROTOCOL_VERSIONS],
            }),
          ),
        );
        this.#events.onConnect(sessionId, socket);
        return;
      }

      const result = ResultEnvelopeSchema.safeParse(decoded.value);
      if (!result.success) {
        this.#events.onProtocolError("BAD_REQUEST", "frame was not a valid result envelope");
        return;
      }
      this.settle(result.data);
    });

    socket.on("close", () => {
      if (this.#socket === socket) this.detach();
    });

    socket.on("error", () => {
      if (this.#socket === socket) this.detach();
    });
  }

  settle(result: ResultEnvelope): void {
    const pending = this.#pending.get(result.id);
    if (!pending) return;
    this.#resyncTracker.untrack(result.id);
    this.#pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  detach(): void {
    const sessionId = this.#sessionId;
    const socket = this.#socket;
    this.#socket = null;
    this.#sessionId = null;

    if (this.#heartbeat) {
      this.#heartbeat.stop();
      this.#heartbeat = null;
    }

    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#resyncTracker.untrack(id);
      // Fail every in-flight command rather than leaving the model waiting.
      pending.reject(new ProtocolError("EXTENSION_NOT_CONNECTED", { commandId: id }));
    }

    if (socket && sessionId) {
      this.#events.onDisconnect(sessionId);
    }
  }

  /**
   * Send a command and wait for its result.
   *
   * The wait is bounded by the command's own `deadlineMs`, which is also what
   * the extension is told. One source of truth on purpose: a separate timeout
   * argument would let the relay wait longer than it asked the extension to
   * work, and is easy to forget to pass.
   */
  send(command: Omit<CommandEnvelope, "v" | "kind">): Promise<ResultEnvelope> {
    const socket = this.#socket;
    if (!socket || !this.#sessionId) {
      return Promise.reject(new ProtocolError("EXTENSION_NOT_CONNECTED"));
    }

    return new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.id);
        this.#resyncTracker.untrack(command.id);
        reject(new ProtocolError("ACTION_TIMEOUT", { commandId: command.id }));
      }, command.deadlineMs);

      this.#pending.set(command.id, { resolve, reject, timer });
      this.#resyncTracker.track(command.id, (err) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(err);
      });

      try {
        socket.send(
          encodeFrame({
            v: PROTOCOL_VERSION,
            kind: "relay.command",
            ...command,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        this.#resyncTracker.untrack(command.id);
        reject(new ProtocolError("EXTENSION_NOT_CONNECTED", { cause: String(error) }));
      }
    });
  }
}
