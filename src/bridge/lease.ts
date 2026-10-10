/**
 * Session lease manager.
 *
 * Ensures only one MCP session can actively control the relay at a time.
 * If a session is idle for `ttlMs`, its lease expires automatically,
 * allowing another session to take over.
 */
export class SessionLease {
  #currentSessionId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /**
   * Attempt to acquire or renew the lease.
   * @returns true if acquired/renewed, false if held by another active session.
   */
  acquire(sessionId: string): boolean {
    if (this.#currentSessionId !== null && this.#currentSessionId !== sessionId) {
      return false; // Another session holds the lease
    }

    this.#currentSessionId = sessionId;
    this.touch();
    return true;
  }

  /**
   * Reset the idle timer for the current lease.
   * Called automatically on acquire, and should be called on activity.
   */
  touch(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#currentSessionId = null;
      this.#timer = null;
    }, this.#ttlMs);
    // Ensure timer doesn't keep the Node event loop alive unnecessarily
    if (this.#timer.unref) {
      this.#timer.unref();
    }
  }

  /**
   * Explicitly release the lease.
   */
  release(sessionId: string): void {
    if (this.#currentSessionId === sessionId) {
      this.#currentSessionId = null;
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
    }
  }

  /**
   * Gets the ID of the session that currently holds the lease, if any.
   */
  get current(): string | null {
    return this.#currentSessionId;
  }
}
