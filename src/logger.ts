import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";

/**
 * Redaction is the last line of defence for the tunnel path token.
 *
 * The token is in the URL ChatGPT uses to reach this relay, so it can end up
 * in a log line through an error message, a stack trace, or a request URL that
 * something logs verbatim. If it ever lands in the log file, anyone who can
 * read that file can drive the owner's browser.
 */

const TOKEN_PLACEHOLDER = "[redacted]";

export interface LoggerOptions {
  readonly level: string;
  readonly file: string;
  /** The secret to scrub. Never logged itself. */
  readonly token: string;
}

/**
 * Build a pino instance whose serializers cannot leak the tunnel path token.
 *
 * Two layers, because one is not enough: `redact` covers the known pino paths,
 * and `formatters`/message rewriting covers tokens that appear anywhere else,
 * such as inside an interpolated error string.
 */
export function createLogger({ level, file, token }: LoggerOptions): pino.Logger {
  mkdirSync(dirname(file), { recursive: true });

  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      return token.length > 0 ? value.split(token).join(TOKEN_PLACEHOLDER) : value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = scrub(v);
      }
      return out;
    }
    return value;
  };

  const base: pino.LoggerOptions = {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "*.token",
        "*.path",
        "*.url",
        "*.href",
      ],
      censor: TOKEN_PLACEHOLDER,
    },
    formatters: {
      // Deep-clone through the scrubber on every log call, so a token that
      // rides along in an error object or a URL string is caught too.
      log(object: Record<string, unknown>) {
        return scrub(object) as Record<string, unknown>;
      },
      bindings() {
        return {};
      },
    },
  };

  // sync: true is deliberate. A pino async destination (sonic-boom) is not
  // flushed on a cold start, and a startup failure calls process.exit() before
  // anything is written. The exit hook then calls flushSync() on a stream that
  // was never made ready, throwing "sonic boom is not ready yet" and hiding the
  // real error (e.g. EADDRINUSE). Synchronous writes cost little at the relay's
  // volume and guarantee the fatal line reaches the log before exit.
  const destination = pino.destination({ dest: file, sync: true });
  const logger = pino(base, destination);

  // A string interpolated into a log call bypasses the object formatter
  // entirely, so wrap the string-taking levels too. Scoped to the levels we
  // actually use rather than every level on the prototype.
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    const original = logger[level].bind(logger) as (...args: unknown[]) => void;
    logger[level] = ((msg?: unknown, ...rest: unknown[]) => {
      // pino special-cases a bare Error argument and lifts it onto an `err`
      // key, so scrub its own fields rather than relying on the formatter.
      const first =
        msg instanceof Error
          ? {
              type: msg.name,
              message: scrub(msg.message),
              stack: scrub(msg.stack ?? ""),
            }
          : scrub(msg);
      original(first, ...rest.map(scrub));
    }) as pino.Logger[typeof level];
  }

  return logger;
}

export const REDACTED = TOKEN_PLACEHOLDER;
