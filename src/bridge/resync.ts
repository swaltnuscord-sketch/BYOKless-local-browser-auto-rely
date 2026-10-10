/**
 * In-flight request tracker for reconnect resync (FR-CC-04).
 *
 * Tracks requests sent from relay to extension.
 * When the extension reconnects, it sends a sync message with the IDs
 * of requests it knows about. The relay can then determine which requests
 * were lost in transit and fail them explicitly.
 */
export class ResyncTracker {
  // Map of request ID to a rejection function to fail it
  readonly #inFlight = new Map<string, (error: Error) => void>();

  /**
   * Register an in-flight request.
   * @param id The request ID.
   * @param rejectFn Function to call to reject the pending promise if lost.
   */
  track(id: string, rejectFn: (error: Error) => void): void {
    this.#inFlight.set(id, rejectFn);
  }

  /**
   * Remove a request from tracking (called when a response is received).
   */
  untrack(id: string): void {
    this.#inFlight.delete(id);
  }

  /**
   * Reconcile known in-flight requests against what the extension reports.
   * @param extensionKnownIds List of request IDs the extension is still processing.
   */
  reconcile(extensionKnownIds: string[]): void {
    const knownSet = new Set(extensionKnownIds);

    for (const [id, rejectFn] of this.#inFlight.entries()) {
      if (!knownSet.has(id)) {
        // The extension doesn't know about this request, so it was lost.
        // We reject it with a non-retryable error (FR-CC-04: non-idempotent actions never auto-retried).
        const error = new Error(`Request ${id} lost during disconnect`);
        error.name = "ResyncError";
        rejectFn(error);
        this.#inFlight.delete(id);
      }
    }
  }

  /**
   * Fail all tracked requests (e.g., on a clean halt).
   */
  clearAll(error: Error): void {
    for (const rejectFn of this.#inFlight.values()) {
      rejectFn(error);
    }
    this.#inFlight.clear();
  }
}
