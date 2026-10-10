import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deduplicator } from "./dedupe.js";

describe("Deduplicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces identical in-flight calls", async () => {
    const dedupe = new Deduplicator(1000);
    let calls = 0;

    const task = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "result";
    };

    const p1 = dedupe.dedupe("key1", task);
    const p2 = dedupe.dedupe("key1", task);

    expect(p1).toBe(p2); // Same promise

    vi.advanceTimersByTime(50);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(calls).toBe(1);
  });

  it("retains the lock for the duration of the dedupe window", async () => {
    const dedupe = new Deduplicator(1000);
    let calls = 0;

    const task = async () => {
      calls++;
      return "result";
    };

    const p1 = dedupe.dedupe("key1", task);
    await p1;

    // Call it again immediately, should still use the in-flight dedupe lock
    const p2 = dedupe.dedupe("key1", async () => {
      calls++;
      return "result2";
    });

    const r2 = await p2;
    expect(r2).toBe("result"); // Returned the cached result
    expect(calls).toBe(1); // Task was not called again

    // Advance time past the window
    vi.advanceTimersByTime(1000);

    const p3 = dedupe.dedupe("key1", async () => {
      calls++;
      return "result3";
    });

    const r3 = await p3;
    expect(r3).toBe("result3");
    expect(calls).toBe(2);
  });
});
