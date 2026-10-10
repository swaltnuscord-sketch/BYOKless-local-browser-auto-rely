import { describe, expect, it } from "vitest";
import {
  canonicalErrorCode,
  ERROR_CATALOG,
  ErrorCodeSchema,
  errorCatalogEntry,
  isErrorCode,
  isRetryable,
  PRD_APPENDIX_B_CODES,
  ProtocolError,
} from "./errors.js";

describe("ErrorCodeSchema & PRD Appendix B", () => {
  it("includes all 16 Appendix B catalogue codes", () => {
    expect(PRD_APPENDIX_B_CODES).toHaveLength(16);
    for (const code of PRD_APPENDIX_B_CODES) {
      expect(isErrorCode(code), `Appendix B code ${code} must exist`).toBe(true);
    }
  });

  it("rejects an unknown code", () => {
    expect(ErrorCodeSchema.safeParse("NOT_A_REAL_CODE").success).toBe(false);
  });
});

describe("ERROR_CATALOG", () => {
  it("has an entry for every code", () => {
    for (const code of ErrorCodeSchema.options) {
      expect(ERROR_CATALOG[code], `missing catalogue entry for ${code}`).toBeDefined();
    }
  });

  it("gives every entry a PRD-traceable retryable verdict and hint", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(typeof entry.retryable, code).toBe("boolean");
      expect(entry.hint.length, code).toBeGreaterThan(0);
      expect(entry.prdRetryable, code).toMatch(/^(Yes|No|Maybe|Later)$/);
    }
  });

  it("maps PRD retryable answers to the documented booleans", () => {
    // PRD Appendix B: "No" and "Later" are terminal; "Yes" and "Maybe" are retryable.
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      const expected = entry.prdRetryable === "Yes" || entry.prdRetryable === "Maybe";
      expect(entry.retryable, code).toBe(expected);
    }
  });
});

describe("canonicalErrorCode mapping", () => {
  it("maps legacy codes to Appendix B E_* codes", () => {
    expect(canonicalErrorCode("EXTENSION_NOT_CONNECTED")).toBe("E_NOT_CONNECTED");
    expect(canonicalErrorCode("ACTION_TIMEOUT")).toBe("E_TIMEOUT_ACTION");
    expect(canonicalErrorCode("ELEMENT_NOT_FOUND")).toBe("E_NOT_FOUND");
    expect(canonicalErrorCode("BUDGET_EXCEEDED")).toBe("E_BUDGET");
    expect(canonicalErrorCode("STEP_LIMIT_EXCEEDED")).toBe("E_BUDGET");
    expect(canonicalErrorCode("ACTION_FAILED")).toBe("E_NAV_FAILED");
    expect(canonicalErrorCode("BAD_REQUEST")).toBe("BAD_REQUEST");
    expect(canonicalErrorCode("E_NOT_CONNECTED")).toBe("E_NOT_CONNECTED");
  });
});

describe("isRetryable", () => {
  it("answers for every code and rejects anything else", () => {
    expect(isRetryable("E_TIMEOUT_ACTION")).toBe(true);
    expect(isRetryable("ACTION_TIMEOUT")).toBe(true);
    expect(isRetryable("E_HALTED")).toBe(false);
    expect(isRetryable("NO_ACTIVE_TASK")).toBe(false);
    expect(isRetryable("NOPE" as never)).toBe(false);
  });
});

describe("isErrorCode / errorCatalogEntry", () => {
  it("narrows unknown strings", () => {
    expect(isErrorCode("E_NOT_CONNECTED")).toBe(true);
    expect(isErrorCode("ACTION_TIMEOUT")).toBe(true);
    expect(isErrorCode("aCTION_TIMEOUT" as never)).toBe(false);
    expect(errorCatalogEntry("E_TIMEOUT_ACTION")?.retryable).toBe(true);
    expect(errorCatalogEntry("E_BUDGET")?.retryable).toBe(false);
    expect(errorCatalogEntry("nope" as never)).toBeUndefined();
  });
});

describe("ProtocolError", () => {
  it("serialises to the transport error contract with canonical Appendix B code", () => {
    const err = new ProtocolError("EXTENSION_NOT_CONNECTED", { taskId: "t-1" });
    const wire = err.toWire();
    expect(wire.code).toBe("E_NOT_CONNECTED");
    expect(wire.retryable).toBe(true);
    expect(wire.hint).toBe(ERROR_CATALOG.EXTENSION_NOT_CONNECTED.hint);
    expect(wire.details).toEqual({ taskId: "t-1" });
  });

  it("treats a lost connection as retryable so the model survives a reconnect (ERR-03)", () => {
    // PRD.md:659 — E_NOT_CONNECTED | Extension not connected | Yes | Ask user to check extension; retry
    expect(ERROR_CATALOG.E_NOT_CONNECTED.prdRetryable).toBe("Yes");
    expect(ERROR_CATALOG.E_NOT_CONNECTED.retryable).toBe(true);
    expect(ERROR_CATALOG.EXTENSION_NOT_CONNECTED.prdRetryable).toBe("Yes");
    expect(ERROR_CATALOG.EXTENSION_NOT_CONNECTED.retryable).toBe(true);
    // The raw code must answer the same as the canonical one, so no caller can
    // read a pre-normalised code and receive the old terminal verdict.
    expect(isRetryable("EXTENSION_NOT_CONNECTED")).toBe(true);
    expect(isRetryable("E_NOT_CONNECTED")).toBe(true);
    expect(canonicalErrorCode("EXTENSION_NOT_CONNECTED")).toBe("E_NOT_CONNECTED");
    // Hint and flag must not contradict each other — that contradiction is how
    // the original drift survived review.
    expect(ERROR_CATALOG.E_NOT_CONNECTED.hint).toMatch(/retry/i);
  });

  it("keeps hint and retryable out of the payload so the relay owns them", () => {
    const err = new ProtocolError("E_TIMEOUT_ACTION", { retryable: false, hint: "lie" });
    expect(err.toWire().retryable).toBe(true);
    expect(err.toWire().hint).toBe(ERROR_CATALOG.E_TIMEOUT_ACTION.hint);
  });

  it("omits details when none were supplied", () => {
    expect("details" in new ProtocolError("INTERNAL").toWire()).toBe(false);
  });

  it("is a real Error so it survives a throw/catch boundary", () => {
    const err = new ProtocolError("INTERNAL");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProtocolError");
    expect(err.message).toBe(ERROR_CATALOG.INTERNAL.message);
  });

  it("rejects a code outside the catalogue", () => {
    expect(() => new ProtocolError("MADE_UP" as never)).toThrow(/unknown error code/i);
  });
});
