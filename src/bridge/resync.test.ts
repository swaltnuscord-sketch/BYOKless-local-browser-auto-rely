import { describe, expect, it, vi } from "vitest";
import { ResyncTracker } from "./resync.js";

describe("ResyncTracker", () => {
  it("tracks and untracks requests", () => {
    const tracker = new ResyncTracker();
    const rejectFn = vi.fn();

    tracker.track("req-1", rejectFn);
    tracker.untrack("req-1");

    tracker.reconcile([]);
    expect(rejectFn).not.toHaveBeenCalled();
  });

  it("rejects tracked requests that the extension does not know about", () => {
    const tracker = new ResyncTracker();
    const rejectFn1 = vi.fn();
    const rejectFn2 = vi.fn();

    tracker.track("req-1", rejectFn1);
    tracker.track("req-2", rejectFn2);

    // Reconcile, extension says it only knows about req-2
    tracker.reconcile(["req-2"]);

    expect(rejectFn1).toHaveBeenCalledTimes(1);
    const err = rejectFn1.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ResyncError");

    expect(rejectFn2).not.toHaveBeenCalled();
  });

  it("clears all tracked requests", () => {
    const tracker = new ResyncTracker();
    const rejectFn1 = vi.fn();
    const rejectFn2 = vi.fn();

    tracker.track("req-1", rejectFn1);
    tracker.track("req-2", rejectFn2);

    tracker.clearAll(new Error("Halted"));

    expect(rejectFn1).toHaveBeenCalledTimes(1);
    expect(rejectFn2).toHaveBeenCalledTimes(1);
    const err1 = rejectFn1.mock.calls[0]?.[0] as Error | undefined;
    expect(err1?.message).toBe("Halted");
    const err2 = rejectFn2.mock.calls[0]?.[0] as Error | undefined;
    expect(err2?.message).toBe("Halted");

    tracker.reconcile([]);
    expect(rejectFn1).toHaveBeenCalledTimes(1); // not called again
  });
});
