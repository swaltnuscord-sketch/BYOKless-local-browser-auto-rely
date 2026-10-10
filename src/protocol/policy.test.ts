import { describe, expect, it } from "vitest";
import {
  checkBudget,
  DEFAULT_MAX_ACTIONS,
  DEFAULT_TASK_LIMITS,
  HARD_MAX_ACTIONS,
  isDomainAllowed,
  MAX_ACTION_DEADLINE_MS,
  MIN_ACTION_DEADLINE_MS,
  resolveDeadline,
  resolveTaskLimits,
} from "./policy.js";

describe("resolveTaskLimits", () => {
  it("defaults rather than leaving the budget undefined", () => {
    expect(resolveTaskLimits({})).toEqual(DEFAULT_TASK_LIMITS);
    expect(DEFAULT_TASK_LIMITS.maxActions).toBe(DEFAULT_MAX_ACTIONS);
  });

  it("accepts a lower budget than the default", () => {
    expect(resolveTaskLimits({ maxActions: 10 }).maxActions).toBe(10);
  });

  it("rejects a request above the hard ceiling instead of clamping it", () => {
    // Rejecting beats silently clamping: the model asked for something we will
    // not do, and it should have to notice.
    expect(() => resolveTaskLimits({ maxActions: HARD_MAX_ACTIONS + 1 })).toThrow();
    expect(() => resolveTaskLimits({ maxActions: 0 })).toThrow();
    expect(() => resolveTaskLimits({ maxActions: -5 })).toThrow();
  });
});

describe("checkBudget", () => {
  const limits = { maxActions: 3, maxSteps: 2, allowedDomains: [] };

  it("allows work inside the budget", () => {
    expect(checkBudget({ actionsUsed: 0, stepsUsed: 0 }, limits)).toEqual({ ok: true });
    expect(checkBudget({ actionsUsed: 2, stepsUsed: 1 }, limits, 1)).toEqual({ ok: true });
  });

  it("refuses the action that would cross the action budget", () => {
    expect(checkBudget({ actionsUsed: 2, stepsUsed: 0 }, limits, 2)).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      used: 2,
      limit: 3,
    });
  });

  it("counts a whole batch against the budget before any of it runs", () => {
    expect(checkBudget({ actionsUsed: 2, stepsUsed: 0 }, limits, 50).ok).toBe(false);
  });

  it("refuses once the step limit is reached", () => {
    expect(checkBudget({ actionsUsed: 0, stepsUsed: 2 }, limits)).toEqual({
      ok: false,
      code: "STEP_LIMIT_EXCEEDED",
      used: 2,
      limit: 2,
    });
  });

  it("reports the action budget first, so the caller sees the binding limit", () => {
    const both = { maxActions: 1, maxSteps: 1, allowedDomains: [] };
    const decision = checkBudget({ actionsUsed: 1, stepsUsed: 1 }, both);
    expect(decision).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  it("fails closed on a corrupt counter rather than granting budget", () => {
    expect(checkBudget({ actionsUsed: -100, stepsUsed: -100 }, limits)).toMatchObject({
      ok: false,
      code: "INTERNAL",
    });
    expect(checkBudget({ actionsUsed: 0.5, stepsUsed: 0 }, limits).ok).toBe(false);
    expect(checkBudget({ actionsUsed: 0, stepsUsed: 0 }, limits, -5).ok).toBe(false);
  });
});

describe("isDomainAllowed", () => {
  it("denies everything when no allowlist is declared", () => {
    // ERR-04: an empty allowlist used to mean "unrestricted", which made the
    // allowlist display-only and left a logged-in profile fully reachable.
    const decision = isDomainAllowed("https://anything.example", []);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it("allows an exact host", () => {
    expect(isDomainAllowed("https://app.example.com", ["app.example.com"]).ok).toBe(true);
  });

  it("refuses subdomains of an allowed host by default", () => {
    expect(isDomainAllowed("https://eu.app.example.com", ["app.example.com"]).ok).toBe(false);
  });

  it("allows subdomains when explicit wildcard is configured", () => {
    expect(isDomainAllowed("https://eu.app.example.com", ["*.app.example.com"]).ok).toBe(true);
    expect(isDomainAllowed("https://app.example.com", ["*.app.example.com"]).ok).toBe(true);
  });

  it("does not let a lookalike host inherit the permission", () => {
    // The classic suffix-matching bug: "evil-app.example.com" must not pass
    // a check for "app.example.com".
    expect(isDomainAllowed("https://evil-app.example.com", ["app.example.com"]).ok).toBe(false);
    expect(isDomainAllowed("https://example.com.attacker.net", ["example.com"]).ok).toBe(false);
  });

  it("ignores case and a trailing dot", () => {
    expect(isDomainAllowed("https://APP.Example.com", ["app.example.com"]).ok).toBe(true);
    expect(isDomainAllowed("https://app.example.com", ["app.example.com."]).ok).toBe(true);
  });

  it("refuses an unparseable url rather than defaulting to allow", () => {
    const decision = isDomainAllowed("not a url", ["example.com"]);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/could not be parsed/i);
  });

  it("refuses when nothing matches", () => {
    expect(isDomainAllowed("https://other.org", ["example.com"]).ok).toBe(false);
  });
});

describe("resolveDeadline", () => {
  it("defaults when unset", () => {
    expect(resolveDeadline()).toBeGreaterThan(0);
  });

  it("clamps into the enforced band", () => {
    expect(resolveDeadline(1)).toBe(MIN_ACTION_DEADLINE_MS);
    expect(resolveDeadline(999_999_999)).toBe(MAX_ACTION_DEADLINE_MS);
  });

  it("truncates a fractional deadline", () => {
    expect(resolveDeadline(1_500.9)).toBe(1_500);
  });
});
