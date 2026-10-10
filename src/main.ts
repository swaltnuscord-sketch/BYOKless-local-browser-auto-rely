import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { listToolNames } from "./protocol/index.js";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { ToolDispatcher } from "./dispatch.js";
import { createLogger } from "./logger.js";
import { createAdminApp, createApp } from "./mcp/server.js";
import { TaskStore } from "./tasks/store.js";
import { ExtensionSessionManager, type SessionEvents } from "./ws/session.js";

async function main() {
  const { config, token, extSharedSecret } = loadConfig();

  const logger = createLogger({
    level: config.logLevel,
    file: config.logFile,
    token,
  });

  mkdirSync(dirname(config.stateDbPath), { recursive: true });
  const store = new TaskStore(config.stateDbPath);

  const sessionEvents: SessionEvents = {
    onConnect(sessionId) {
      logger.info({ sessionId }, "extension connected");
    },
    onDisconnect(sessionId) {
      logger.info({ sessionId }, "extension disconnected");
    },
    onProtocolError(code, detail) {
      logger.error({ code, detail }, "extension protocol error");
    },
  };

  const session = new ExtensionSessionManager(sessionEvents, config.maxFrameBytes, extSharedSecret);

  /**
   * Hostname of the active agent tab, used to scope an auto-started task.
   *
   * Reuses the existing `tab_list` command rather than adding protocol surface.
   * Every failure path — extension disconnected, deadline exceeded, unparseable
   * URL — resolves to `null`, and `null` leaves the auto-task's allowlist empty,
   * which denies navigation. A task never inherits reach it did not declare.
   *
   * Returns a bare hostname because `isDomainAllowed` matches hostnames, not origins.
   */
  const getActiveTabHostname = async (): Promise<string | null> => {
    try {
      const result = await session.send({
        id: `origin-${randomUUID()}`,
        tool: "tab_list",
        args: {},
        deadlineMs: 5_000,
      });
      if (!result.ok || result.data === null || typeof result.data !== "object") return null;
      const payload = result.data as {
        tabs?: Array<{ id?: number; url?: string; active?: boolean }>;
        activeTabId?: number;
      };
      if (!Array.isArray(payload.tabs)) return null;
      const active =
        payload.activeTabId === undefined
          ? payload.tabs.find((t) => t.active === true)
          : payload.tabs.find((t) => t.id === payload.activeTabId);
      if (active?.url === undefined || active.url === "") return null;
      return new URL(active.url).hostname;
    } catch {
      return null;
    }
  };

  const dispatcher = new ToolDispatcher({
    store,
    session,
    enableDevTools: config.devToolsEnabled,
    getActiveTabHostname,
    onUsage(tool, outcome, code) {
      logger.debug({ tool, outcome, code }, "tool usage");
    },
  });

  const app = createApp({
    dispatcher,
    token,
    enableDevTools: config.devToolsEnabled,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    tunnelUrl: config.tunnelUrl,
    allowedOrigins: config.allowedOrigins,
    allowedHosts: config.allowedHosts,
    logger,
  });

  const adminApp = createAdminApp({ dispatcher, sessions: app.locals.sessions });
  const adminPort = config.port === 0 ? 0 : config.port + 1;
  const adminServer = adminApp.listen(adminPort, "127.0.0.1", () => {
    logger.info({ host: "127.0.0.1", port: adminPort }, "admin metrics/readyz listening");
  });

  const toolNames = listToolNames({ enableDevTools: config.devToolsEnabled });
  logger.info(
    {
      devToolsEnabled: config.devToolsEnabled,
      toolCount: toolNames.length,
    },
    "relay tool registration",
  );

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "relay listening");
  });

  const failStartup = (message: string, context: Record<string, unknown>) => {
    logger.fatal(context, message);
    // Mirror to stderr: the operator running `pnpm start` must see the reason
    // without digging into the log file.
    console.error(message);
    process.exit(1);
  };

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      failStartup(
        `Port ${config.port} is already in use. Is the relay already running?`,
        { port: config.port },
      );
    }
    failStartup("server error", { err });
  });

  adminServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      failStartup(
        `Admin port ${adminPort} is already in use. Is the relay already running?`,
        { port: adminPort },
      );
    }
    failStartup("admin server error", { err });
  });

  const wss = new WebSocketServer({ server, path: "/extension" });
  wss.on("error", (err: NodeJS.ErrnoException) => {
    // A port conflict will also emit here since the WSS binds to the same HTTP server.
    if (err.code === "EADDRINUSE") return;
    failStartup("websocket server error", { err });
  });

  wss.on("connection", (socket) => {
    session.attach(socket as never);
  });

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("shutting down, waiting for connections to drain...");

    // Force exit after 5 seconds if connections haven't drained
    const forceExit = setTimeout(() => {
      logger.warn("force quitting after timeout");
      store.close();
      process.exit(1);
    }, 5000).unref();

    // Stop accepting new connections
    wss.close();
    adminServer.close();
    server.close(() => {
      clearTimeout(forceExit);
      store.close();
      logger.info("graceful shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
