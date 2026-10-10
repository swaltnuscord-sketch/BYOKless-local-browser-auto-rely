import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Relay configuration.
 *
 * Everything is validated once, at startup, and the process refuses to start on
 * anything unsafe. A relay that silently falls back to an insecure default is
 * worse than one that will not boot.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const ConfigSchema = z.strictObject({
  /**
   * The relay holds the owner's Chrome profile. It is reachable only over
   * loopback; a tunnel terminates TLS elsewhere and forwards to this port.
   */
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
  logFile: z.string().min(1),
  stateDbPath: z.string().min(1),
  /** Path to the bearer token file. The token value never appears in env. */
  tokenPath: z.string().min(1),
  /** Public HTTPS origin ChatGPT connects to. */
  tunnelUrl: z.url().optional(),
  allowedOrigins: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  devToolsEnabled: z.boolean().default(false),
  rateLimitWindowMs: z.number().int().positive().default(60_000),
  rateLimitMax: z.number().int().positive().default(120),
  maxFrameBytes: z
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new ConfigError(
      `RELAY_HOST must be a loopback address (got "${host}"). ` +
        "The relay drives the owner's own Chrome profile and must never listen on a public interface.",
    );
  }
}

function readToken(tokenPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(tokenPath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Could not read the token file at "${tokenPath}": ${err instanceof Error ? err.message : String(err)}. Run: pnpm gen:secrets`,
    );
  }

  const token = raw.trim();
  if (token.length < 32) {
    // A short token makes brute force over a public tunnel plausible.
    throw new ConfigError(
      `The token in "${tokenPath}" is only ${token.length} characters; at least 32 are required.`,
    );
  }
  return token;
}

export interface LoadResult {
  readonly config: Config;
  /** Held in memory, never logged, never returned to a client. */
  readonly token: string;
  readonly extSharedSecret: string;
}

function loadEnvIfPresent(): void {
  if (typeof process.loadEnvFile !== "function") return;
  let curr = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(curr, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return;
      } catch {
        return;
      }
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadResult {
  if (env === process.env) {
    loadEnvIfPresent();
  }
  const port = Number(env.RELAY_PORT ?? "8765");
  const result = ConfigSchema.safeParse({
    host: env.RELAY_HOST ?? "127.0.0.1",
    port,
    logLevel: env.LOG_LEVEL ?? "info",
    logFile: env.LOG_FILE ?? "logs/relay.log",
    stateDbPath: env.STATE_DB_PATH ?? "state/relay.db",
    tokenPath: env.RELAY_TOKEN_PATH ?? "state/relay.token",
    tunnelUrl: env.TUNNEL_URL || env.PUBLIC_URL || undefined,
    allowedOrigins: env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    allowedHosts: env.ALLOWED_HOSTS
      ? env.ALLOWED_HOSTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    devToolsEnabled: env.ENABLE_DEV_TOOLS === "1",
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 120),
    maxFrameBytes: Number(env.MAX_FRAME_BYTES ?? 4 * 1024 * 1024),
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid relay configuration: ${issues}`);
  }

  requireLoopback(result.data.host);
  const token = readToken(result.data.tokenPath);

  const extSharedSecret = (env.EXT_SHARED_SECRET ?? "").trim();
  if (!extSharedSecret || extSharedSecret.length < 32) {
    throw new ConfigError(
      "EXT_SHARED_SECRET must be set in .env with at least 32 characters (256 bits). Run: pnpm gen:secrets",
    );
  }

  return { config: result.data, token, extSharedSecret };
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}
