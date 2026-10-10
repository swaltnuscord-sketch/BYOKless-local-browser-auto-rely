/**
 * In-flight deduplication.
 *
 * Coalesces identical in-flight mutating calls within a dedupe window
 * to protect against client (model/connector) retries.
 */
export class Deduplicator {
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #windowMs: number;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  /**
   * Executes a task, deduping it if an identical task is already in-flight.
   * Identical tasks are defined by their `key`.
   */
  dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        const res = await task();
        setTimeout(() => {
          this.#inFlight.delete(key);
        }, this.#windowMs).unref?.();
        return res;
      } catch (err) {
        this.#inFlight.delete(key);
        throw err;
      }
    })();

    this.#inFlight.set(key, promise);
    return promise;
  }
}
