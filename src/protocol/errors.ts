import { z } from "zod";

/**
 * PRD Appendix B error catalogue.
 *
 * `retryable` is derived from the PRD's four answers and must never be supplied
 * by a caller: the relay owns retry policy, extensions own detection.
 */

export const PRD_APPENDIX_B_CODES = [
  "E_HALTED",
  "E_BUSY",
  "E_NOT_CONNECTED",
  "E_TIMEOUT_ACTION",
  "E_STALE_ELEMENT",
  "E_OBSCURED",
  "E_NOT_FOUND",
  "E_NOT_INTERACTABLE",
  "E_BLOCKED_DOMAIN",
  "E_NEEDS_APPROVAL",
  "E_STUCK",
  "E_BUDGET",
  "E_NAV_FAILED",
  "E_CAPTCHA",
  "E_DIALOG",
  "E_TAB_CLOSED",
] as const;

export const SYSTEM_ERROR_CODES = [
  "BAD_REQUEST",
  "NO_ACTIVE_TASK",
  "TASK_NOT_FOUND",
  "TASK_ALREADY_COMPLETE",
  "TOOL_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "EXTENSION_NOT_CONNECTED",
  "EXTENSION_VERSION_UNSUPPORTED",
  "ACTION_TIMEOUT",
  "ACTION_FAILED",
  "BUDGET_EXCEEDED",
  "STEP_LIMIT_EXCEEDED",
  "ELEMENT_NOT_FOUND",
  "EXTRACTION_FAILED",
  "HUMAN_REQUIRED",
  "INTERNAL",
] as const;

export const ERROR_CODES = [...PRD_APPENDIX_B_CODES, ...SYSTEM_ERROR_CODES] as const;

/** Zod mirror of {@link ERROR_CODES}, for use inside object schemas. */
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = (typeof ERROR_CODES)[number];
export type PrdAppendixBCode = (typeof PRD_APPENDIX_B_CODES)[number];

/** The PRD Appendix B retry answers, kept verbatim for traceability. */
export type PrdRetryable = "Yes" | "No" | "Maybe" | "Later";

export interface ErrorCatalogEntry {
  /** PRD Appendix B message shown to the model. */
  readonly message: string;
  /** "No"/"Later" are terminal; "Yes"/"Maybe" may be retried. */
  readonly prdRetryable: PrdRetryable;
  readonly retryable: boolean;
  /** Operator-facing recovery guidance, never page content. */
  readonly hint: string;
}

function entry(message: string, prdRetryable: PrdRetryable, hint: string): ErrorCatalogEntry {
  return {
    message,
    prdRetryable,
    retryable: prdRetryable === "Yes" || prdRetryable === "Maybe",
    hint,
  };
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  // --- PRD Appendix B Catalogue ---
  E_HALTED: entry("User kill switch active.", "No", "Do not retry; ask the user"),
  E_BUSY: entry("Another session holds the lease.", "Later", "Wait or ask the user"),
  E_NOT_CONNECTED: entry(
    "The browser extension is not connected to the relay.",
    "Yes",
    "Ask user to check extension; retry",
  ),
  E_TIMEOUT_ACTION: entry(
    "The action did not settle within the deadline.",
    "Maybe",
    "Re-read state before retrying",
  ),
  E_STALE_ELEMENT: entry("Element changed or removed.", "Yes", "Use the fresh snapshot provided"),
  E_OBSCURED: entry(
    "Element covered by another.",
    "Yes",
    "Close overlay / scroll / choose another",
  ),
  E_NOT_FOUND: entry("No such element id.", "Yes", "Use find or extract_state"),
  E_NOT_INTERACTABLE: entry(
    "Element is disabled, readonly, or hidden.",
    "No",
    "Choose another control",
  ),
  E_BLOCKED_DOMAIN: entry(
    "Policy blocked navigation to this domain.",
    "No",
    "Ask user to allow the domain",
  ),
  E_NEEDS_APPROVAL: entry(
    "High-risk action awaiting human approval.",
    "Yes",
    "Tell user to approve in the extension",
  ),
  E_STUCK: entry("Repeated no-progress actions detected.", "No", "Summarize and ask the user"),
  E_BUDGET: entry(
    "The task reached its action or step budget limit.",
    "Later",
    "Summarize; ask user to continue",
  ),
  E_NAV_FAILED: entry("Navigation or page crash occurred.", "Maybe", "Try a different URL"),
  E_CAPTCHA: entry("Challenge or payment frame detected.", "No", "Use pause_for_human"),
  E_DIALOG: entry("Unhandled JS dialog present on the page.", "Maybe", "Report the dialog text"),
  E_TAB_CLOSED: entry("The controlled agent tab was closed.", "Yes", "Navigate to reopen"),

  // --- System & Relay Protocol Codes ---
  BAD_REQUEST: entry(
    "Tool arguments are missing or malformed.",
    "No",
    "Check the tool schema and send only declared arguments.",
  ),
  NO_ACTIVE_TASK: entry(
    "No active task. Call start_task or resume_task first.",
    "No",
    "Start a task before issuing navigation or action tools.",
  ),
  TASK_NOT_FOUND: entry(
    "The requested task id is unknown.",
    "No",
    "List known tasks and resume the one you meant.",
  ),
  TASK_ALREADY_COMPLETE: entry(
    "The task is already complete.",
    "No",
    "Read the recorded result, or start a new task.",
  ),
  TOOL_NOT_FOUND: entry(
    "The requested tool is not registered.",
    "No",
    "Use one of the tools from the advertised contract.",
  ),
  EXTENSION_NOT_CONNECTED: entry(
    "The browser extension is not connected to the relay.",
    "Yes",
    "Ask user to check extension; retry",
  ),
  EXTENSION_VERSION_UNSUPPORTED: entry(
    "The connected extension speaks an unsupported protocol version.",
    "Later",
    "Reload the extension so it re-reads the current contract version.",
  ),
  SESSION_NOT_FOUND: entry(
    "The MCP session is unknown or has expired.",
    "Maybe",
    "Re-run the MCP initialize handshake to open a new session.",
  ),
  ACTION_TIMEOUT: entry(
    "The action did not settle within the deadline.",
    "Maybe",
    "Re-read state before retrying",
  ),
  ACTION_FAILED: entry(
    "The action was attempted but did not take effect.",
    "Maybe",
    "Re-read the page to confirm current state, then decide whether to retry.",
  ),
  BUDGET_EXCEEDED: entry(
    "The task exceeded its declared action budget.",
    "Later",
    "Ask the operator to raise the budget or narrow the task.",
  ),
  STEP_LIMIT_EXCEEDED: entry(
    "The task exceeded its step limit.",
    "Later",
    "Ask the operator to raise the step limit or narrow the task.",
  ),
  ELEMENT_NOT_FOUND: entry(
    "No element matched the reference.",
    "Maybe",
    "Take a fresh read_page snapshot; element refs are not stable across changes.",
  ),
  EXTRACTION_FAILED: entry(
    "The requested state could not be extracted from the page.",
    "Maybe",
    "Retry the extraction, or narrow the selector to something observable.",
  ),
  HUMAN_REQUIRED: entry(
    "The task needs a human decision before it can continue.",
    "Later",
    "Use pause_for_human and wait for the operator to respond.",
  ),
  INTERNAL: entry(
    "The relay hit an unexpected internal error.",
    "Maybe",
    "Retry once; if it persists, inspect the relay logs for the correlation id.",
  ),
};

/** Normalizes internal legacy error codes to PRD Appendix B canonical wire codes. */
export function canonicalErrorCode(code: ErrorCode): ErrorCode {
  switch (code) {
    case "EXTENSION_NOT_CONNECTED":
      return "E_NOT_CONNECTED";
    case "ACTION_TIMEOUT":
      return "E_TIMEOUT_ACTION";
    case "ELEMENT_NOT_FOUND":
      return "E_NOT_FOUND";
    case "BUDGET_EXCEEDED":
    case "STEP_LIMIT_EXCEEDED":
      return "E_BUDGET";
    case "ACTION_FAILED":
      return "E_NAV_FAILED";
    default:
      return code;
  }
}

export interface ProtocolErrorWire {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly hint: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

export function errorCatalogEntry(code: ErrorCode): ErrorCatalogEntry {
  return ERROR_CATALOG[code];
}

export function isRetryable(code: unknown): boolean {
  return isErrorCode(code) && ERROR_CATALOG[code].retryable;
}

/**
 * A tool failure that should be reported to the model as data.
 *
 * Per PRD §11 these are returned as `isError: true` results, never as
 * JSON-RPC protocol errors, so the model can reason about them and retry.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly canonicalCode: ErrorCode;

  constructor(
    code: ErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    if (!isErrorCode(code)) {
      throw new Error(`ProtocolError: unknown error code "${String(code)}"`);
    }
    super(ERROR_CATALOG[code].message);
    this.name = "ProtocolError";
    this.code = code;
    this.canonicalCode = canonicalErrorCode(code);
  }

  get retryable(): boolean {
    return ERROR_CATALOG[this.code].retryable;
  }

  get hint(): string {
    return ERROR_CATALOG[this.code].hint;
  }

  toWire(): ProtocolErrorWire {
    const wire: ProtocolErrorWire = {
      code: this.canonicalCode,
      message: this.message,
      retryable: this.retryable,
      hint: this.hint,
    };
    return this.details === undefined ? wire : { ...wire, details: this.details };
  }
}
