/**
 * A per-tab FIFO mutex.
 *
 * Ensures that if multiple mutating tools (e.g. click, type) are invoked
 * rapidly against the same tab, they execute sequentially. This is vital
 * for CDP operations where interleaving inputs causes race conditions and
 * breaks the "settling" checks.
 */
export class TabQueue {
  readonly #queues = new Map<number, Promise<void>>();

  /**
   * Enqueue a task to be executed sequentially for the given tabId.
   */
  async enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
    const current = this.#queues.get(tabId) ?? Promise.resolve();

    const next = (async () => {
      try {
        // Wait for the previous task to finish, even if it failed.
        await current;
      } catch {
        // Ignored; we only care about sequencing.
      }
      return task();
    })();

    // Update the queue to point to this task's completion.
    this.#queues.set(
      tabId,
      next.then(
        () => {},
        () => {},
      ),
    );

    return next;
  }

  /**
   * Number of tabs currently tracked.
   */
  get size(): number {
    return this.#queues.size;
  }
}
