import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLease } from "./lease.js";

describe("SessionLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows acquiring and releasing a lease", () => {
    const lease = new SessionLease(1000);

    expect(lease.current).toBeNull();
    expect(lease.acquire("session-1")).toBe(true);
    expect(lease.current).toBe("session-1");

    lease.release("session-1");
    expect(lease.current).toBeNull();
  });

  it("prevents another session from acquiring an active lease", () => {
    const lease = new SessionLease(1000);

    expect(lease.acquire("session-1")).toBe(true);
    expect(lease.acquire("session-2")).toBe(false);
    expect(lease.current).toBe("session-1");
  });

  it("expires the lease after idle TTL", () => {
    const lease = new SessionLease(1000);

    lease.acquire("session-1");

    vi.advanceTimersByTime(500);
    expect(lease.current).toBe("session-1");

    vi.advanceTimersByTime(501);
    expect(lease.current).toBeNull();

    // Now session 2 can acquire
    expect(lease.acquire("session-2")).toBe(true);
  });

  it("extends the lease when touched", () => {
    const lease = new SessionLease(1000);

    lease.acquire("session-1");

    vi.advanceTimersByTime(800);
    lease.touch(); // Restarts the 1000ms timer

    vi.advanceTimersByTime(500);
    expect(lease.current).toBe("session-1"); // 1300ms total elapsed, but touched

    vi.advanceTimersByTime(501);
    expect(lease.current).toBeNull();
  });
});
