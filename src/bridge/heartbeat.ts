import type { WebSocket } from "ws";

/**
 * WebSocket heartbeat manager.
 * Sends a ping every 20s. If no pong is received before the next ping,
 * terminates the connection.
 */
export class Heartbeat {
  readonly #ws: WebSocket;
  readonly #intervalMs: number;
  readonly #onTimeout: () => void;
  #isAlive = true;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(ws: WebSocket, intervalMs = 20000, onTimeout?: () => void) {
    this.#ws = ws;
    this.#intervalMs = intervalMs;
    this.#onTimeout =
      onTimeout ??
      (() => {
        this.#ws.terminate();
      });
  }

  start(): void {
    this.#isAlive = true;

    this.#ws.on("pong", () => {
      this.#isAlive = true;
    });

    this.#timer = setInterval(() => {
      if (!this.#isAlive) {
        this.#onTimeout();
        return;
      }
      this.#isAlive = false;
      this.#ws.ping();
    }, this.#intervalMs);

    if (this.#timer.unref) {
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
