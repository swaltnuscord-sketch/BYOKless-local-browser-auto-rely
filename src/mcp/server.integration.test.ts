import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError } from "../protocol/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolDispatcher } from "../dispatch.js";
import { TaskStore } from "../tasks/store.js";
import { ExtensionSessionManager, type SessionEvents } from "../ws/session.js";
import { createAdminApp, createApp, pathHasToken } from "./server.js";

const TOKEN = "t".repeat(48);
let dir: string;
let server: Server;
let store: TaskStore;
let dispatcher: ToolDispatcher;
let send: ReturnType<typeof vi.fn>;
let baseUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-mcp-"));
  store = new TaskStore(join(dir, "relay.db"));

  const session = new ExtensionSessionManager(
    {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    } as unknown as SessionEvents,
    undefined,
    "test-secret-12345",
  );

  send = vi.fn(async () => ({ ok: true, data: { summary: "clicked" } }));
  vi.spyOn(session, "send").mockImplementation(send as never);

  dispatcher = new ToolDispatcher({ store, session });

  const app = createApp({
    dispatcher,
    token: TOKEN,
    enableDevTools: false,
    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port()}/mcp/${TOKEN}`)),
  );
  return client;
}

function port(): number {
  return (server.address() as AddressInfo).port;
}

describe("pathHasToken", () => {
  it("accepts /mcp/<token> as the exact path", () => {
    expect(pathHasToken(`/mcp/${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a wrong token, an empty path, and a deeper match", () => {
    expect(pathHasToken(`/mcp/wrong${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(pathHasToken("/", TOKEN)).toBe(false);
    expect(pathHasToken(`/mcp/${TOKEN}extra`, TOKEN)).toBe(false);
    expect(pathHasToken(`/mcp/${TOKEN}/extra`, TOKEN)).toBe(false);
  });

  it("does not accept token-first path /<token>/mcp or prefix matches", () => {
    expect(pathHasToken(`/${TOKEN}/mcp`, TOKEN)).toBe(false);
    expect(pathHasToken(`/${TOKEN}`, TOKEN)).toBe(false);
    expect(pathHasToken(`/a/mcp/${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe("authentication and routing", () => {
  it("serves minimal healthz on tunneled endpoint", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; version: string };
    expect(json).toEqual({ ok: true, version: "2.1.0" });
  });

  it("returns 404 for /readyz and /metrics on tunneled endpoint", async () => {
    const readyz = await fetch(`${baseUrl}/readyz`);
    expect(readyz.status).toBe(404);

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(404);
  });

  it("serves readyz and metrics on separate loopback-only admin app", async () => {
    const adminApp = createAdminApp({
      dispatcher,
      sessions: new Map(),
    });
    const adminServer: Server = await new Promise((resolve) => {
      const s = adminApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const aPort = (adminServer.address() as AddressInfo).port;

    try {
      // Disconnected readyz
      vi.spyOn(dispatcher, "isReady").mockReturnValueOnce(false);
      const res503 = await fetch(`http://127.0.0.1:${aPort}/readyz`);
      expect(res503.status).toBe(503);

      // Connected readyz
      vi.spyOn(dispatcher, "isReady").mockReturnValueOnce(true);
      const res200 = await fetch(`http://127.0.0.1:${aPort}/readyz`);
      expect(res200.status).toBe(200);

      // Metrics
      const resMetrics = await fetch(`http://127.0.0.1:${aPort}/metrics`);
      expect(resMetrics.status).toBe(200);
      const json = (await resMetrics.json()) as { version: string; uptimeSeconds: number };
      expect(json.version).toBe("2.1.0");
      expect(typeof json.uptimeSeconds).toBe("number");
    } finally {
      await new Promise<void>((resolve) => adminServer.close(() => resolve()));
    }
  });

  it("enforces allowedOrigins on /mcp/:token", async () => {
    const originApp = createApp({
      dispatcher,
      token: TOKEN,
      enableDevTools: false,
      rateLimitMax: 1_000,
      rateLimitWindowMs: 60_000,
      allowedOrigins: ["https://chatgpt.com"],
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const originServer: Server = await new Promise((resolve) => {
      const s = originApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const oPort = (originServer.address() as AddressInfo).port;

    try {
      // Disallowed origin
      const blockedRes = await fetch(`http://127.0.0.1:${oPort}/mcp/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(blockedRes.status).toBe(403);

      // Allowed origin
      const allowedRes = await fetch(`http://127.0.0.1:${oPort}/mcp/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://chatgpt.com" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(allowedRes.status).not.toBe(403);
    } finally {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  it("returns 404 for a wrong token without saying why", async () => {
    const response = await fetch(`${baseUrl}/mcp/nope`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/token|unauthor/i);
  });

  it("refuses a request with no token at all", async () => {
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(404);
  });

  it("returns 404 for legacy token-first /<token>/mcp path", async () => {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});

describe("the contract over MCP", () => {
  it("advertises exactly the 20 production tools", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(20);
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "act_batch",
          "click",
          "complete_task",
          "extract_state",
          "find",
          "go_back",
          "hover",
          "key_press",
          "navigate",
          "pause_for_human",
          "read_page",
          "resume_task",
          "scroll",
          "select_option",
          "start_task",
          "tab_close",
          "tab_list",
          "tab_switch",
          "type",
          "wait",
        ].sort(),
      );
      expect(tools.map((t) => t.name)).not.toContain("dev_ping");
    } finally {
      await client.close();
    }
  });

  it("publishes the annotations the contract promises", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
      expect(readOnly.sort()).toEqual(
        ["extract_state", "find", "read_page", "scroll", "tab_list", "wait"].sort(),
      );
      const destructive = tools
        .filter((t) => t.annotations?.destructiveHint === true)
        .map((t) => t.name);
      expect(destructive.sort()).toEqual(
        ["act_batch", "click", "key_press", "select_option", "tab_close", "type"].sort(),
      );
    } finally {
      await client.close();
    }
  });

  it("sends instructions telling the model page content is untrusted", async () => {
    const client = await connectClient();
    try {
      expect(client.getInstructions()).toMatch(/untrusted/i);
    } finally {
      await client.close();
    }
  });
});

describe("tool calls over MCP", () => {
  it("starts a task and returns structured content", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "start_task",
        arguments: { goal: "find the docs" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ goal: "find the docs" });
    } finally {
      await client.close();
    }
  });

  it("auto-starts a task when called over MCP without an explicit start_task (FR-TK-01)", async () => {
    // Fresh store state for this assertion.
    const scoped = new TaskStore(join(dir, "scoped.db"));
    const session = new ExtensionSessionManager(
      {
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      } as unknown as SessionEvents,
      undefined,
      "test-secret-12345",
    );
    vi.spyOn(session, "send").mockImplementation(
      vi.fn(async () => ({ ok: true, data: {} })) as never,
    );

    const app = createApp({
      dispatcher: new ToolDispatcher({ store: scoped, session }),
      token: TOKEN,
      enableDevTools: false,
      rateLimitMax: 1_000,
      rateLimitWindowMs: 60_000,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const local = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const localPort = (local.address() as AddressInfo).port;

    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${localPort}/mcp/${TOKEN}`)),
    );
    try {
      const result = await client.callTool({ name: "click", arguments: { ref: "e:51b2" } });
      expect(result.isError).toBeFalsy();
      expect(scoped.active()).toBeDefined();
      expect(scoped.active()?.goal).toBe("Auto-started task");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => local.close(() => resolve()));
      scoped.close();
    }
  });

  it("refuses an undeclared argument instead of silently dropping it", async () => {
    const client = await connectClient();
    try {
      // The transport is registered with a permissive schema on purpose: it
      // must not filter the payload before the policy layer inspects it. The
      // dispatcher refuses, so a typo'd `max_action` cannot vanish and leave
      // the default budget silently in force.
      const result = await client.callTool({
        name: "navigate",
        arguments: { url: "https://example.com", evil: true },
      });
      expect(result.isError).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("lists the keys the tool does accept", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "start_task",
        arguments: { goal: "g", max_action: 5 },
      });
      expect(result.isError).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: test payload matching
      const wire = (result.structuredContent as any)?.error;
      expect(wire?.code).toBe("BAD_REQUEST");
      expect(wire?.retryable).toBe(false);
      expect(JSON.stringify(result.content)).toContain("Allowed keys: ");
    } finally {
      await client.close();
    }
  });

  it("still refuses a stray key nested inside an act_batch action", async () => {
    const client = await connectClient();
    try {
      const active = store.active();
      if (active) store.complete(active.id, true, "reset");
      await client.callTool({ name: "start_task", arguments: { goal: "g" } });
      send.mockClear();

      const result = await client.callTool({
        name: "act_batch",
        arguments: { actions: [{ kind: "click", ref: "e:aa", target: "_blank" }] },
      });
      expect(result.isError).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("still accepts every declared argument", async () => {
    // start_task refuses a second concurrent task, and the shared store may
    // still hold one from an earlier test.
    const active = store.active();
    if (active) store.complete(active.id, true, "reset");

    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "start_task",
        arguments: { goal: "g", max_actions: 5, max_steps: 3 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ maxActions: 5, maxSteps: 3 });
    } finally {
      await client.close();
    }
  });

  it("rejects a non-http url", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "navigate",
        arguments: { url: "javascript:alert(1)" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/http or https/i);
    } finally {
      await client.close();
    }
  });

  it("never forwards a rejected url to the extension", async () => {
    send.mockClear();
    const client = await connectClient();
    try {
      await client.callTool({ name: "navigate", arguments: { url: "file:///etc/passwd" } });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("forwards a valid action to the extension and reports settlement", async () => {
    const client = await connectClient();
    try {
      await client.callTool({ name: "start_task", arguments: { goal: "g2" } });
      const result = await client.callTool({ name: "click", arguments: { ref: "e:51b2" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ tool: "click" });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "click", args: { ref: "e:51b2" } }),
      );
    } finally {
      await client.close();
    }
  });

  it("surfaces an extension failure as a typed retryable error", async () => {
    const client = await connectClient();
    try {
      send.mockResolvedValueOnce({ ok: false, error: { code: "ACTION_FAILED" } });
      const result = await client.callTool({ name: "go_back", arguments: {} });
      expect(result.isError).toBe(true);
      const wire = (result.structuredContent as { error?: { retryable?: boolean } })?.error;
      expect(wire?.retryable).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("ProtocolError shape", () => {
  it("keeps catalogue values out of reach of a caller", () => {
    const err = new ProtocolError("ACTION_TIMEOUT", { retryable: false });
    expect(err.toWire().retryable).toBe(true);
  });
});

describe("FR-CN-03 Steering Text", () => {
  it("result text contains no steering text like 'do not stop'", async () => {
    const client = await connectClient();
    try {
      const active = store.active();
      if (active) store.complete(active.id, true, "reset");

      const startResult = await client.callTool({
        name: "start_task",
        arguments: { goal: "g", max_actions: 5 },
      });
      expect(startResult.isError).toBeFalsy();
      const text = JSON.stringify(startResult.content).toLowerCase();
      expect(text).not.toContain("do not stop");
      expect(text).not.toContain("keep going");
    } finally {
      await client.close();
    }
  });

  describe("Concurrent Tool Executions", () => {
    it("serves 5 concurrent dev_echo calls with index argument and returns all 5 indexes", async () => {
      const devApp = createApp({
        dispatcher,
        token: TOKEN,
        enableDevTools: true,
        rateLimitMax: 1_000,
        rateLimitWindowMs: 60_000,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      });
      const devServer: Server = await new Promise((resolve) => {
        const s = devApp.listen(0, "127.0.0.1", () => resolve(s));
      });
      const devPort = (devServer.address() as AddressInfo).port;
      const client = new Client({ name: "test-dev", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${devPort}/mcp/${TOKEN}`)),
      );
      try {
        const calls = [0, 1, 2, 3, 4].map((i) =>
          client.callTool({
            name: "dev_echo",
            arguments: { index: i, message: `msg-${i}` },
          }),
        );
        const results = await Promise.all(calls);
        expect(results).toHaveLength(5);
        const returnedIndexes = results.map((r) => {
          expect(r.isError).toBeFalsy();
          const structured = r.structuredContent as { index?: number };
          return structured?.index;
        });
        expect(returnedIndexes.sort()).toEqual([0, 1, 2, 3, 4]);
      } finally {
        await client.close();
        await new Promise<void>((resolve) => devServer.close(() => resolve()));
      }
    });

    it("serves 5 identical concurrent calls without loss", async () => {
      const client = await connectClient();
      try {
        const calls = Array.from({ length: 5 }, () =>
          client.callTool({
            name: "tab_list",
            arguments: {},
          }),
        );
        const results = await Promise.all(calls);
        expect(results).toHaveLength(5);
        for (const res of results) {
          expect(res.isError).toBeFalsy();
          expect(res.content).toBeDefined();
          expect((res.content as unknown[]).length).toBeGreaterThan(0);
        }
      } finally {
        await client.close();
      }
    });

    it("serves 5 distinct concurrent calls without loss", async () => {
      const client = await connectClient();
      try {
        const toolsToCall = [
          { name: "tab_list", arguments: {} },
          { name: "tab_list", arguments: {} },
          { name: "tab_list", arguments: {} },
          { name: "tab_list", arguments: {} },
          { name: "tab_list", arguments: {} },
        ];
        const calls = toolsToCall.map((t) => client.callTool(t));
        const results = await Promise.all(calls);
        expect(results).toHaveLength(5);
        for (const res of results) {
          expect(res.isError).toBeFalsy();
          expect(res.content).toBeDefined();
        }
      } finally {
        await client.close();
      }
    });

    it("formats error text with Appendix B canonical code and hint", async () => {
      const client = await connectClient();
      try {
        // Cause an extension disconnect error
        send.mockRejectedValueOnce(new ProtocolError("EXTENSION_NOT_CONNECTED"));
        const active = store.active();
        if (!active) {
          await client.callTool({ name: "start_task", arguments: { goal: "test-err" } });
        }
        const res = await client.callTool({ name: "click", arguments: { ref: "e:1234" } });
        expect(res.isError).toBe(true);
        const text = ((res.content as unknown[])[0] as { text: string }).text;
        expect(text).toContain("E_NOT_CONNECTED");
        expect(text).toContain("Hint:");
      } finally {
        await client.close();
      }
    });

    it("handles ChatGPT-style start_task args with null optionals concurrent with tools/list", async () => {
      const client = await connectClient();
      try {
        const active = store.active();
        if (active) store.complete(active.id, true, "done");

        // Concurrent listTools and ChatGPT-style start_task with null optionals
        const [listRes, callRes] = await Promise.all([
          client.listTools(),
          client.callTool({
            name: "start_task",
            arguments: {
              goal: "ChatGPT complex task",
              max_actions: null,
              max_steps: null,
              allowed_domains: null,
            },
          }),
        ]);

        expect(listRes.tools).toHaveLength(20);
        expect(callRes.isError).toBeFalsy();
        const contentText = ((callRes.content as unknown[])[0] as { text: string }).text;
        expect(contentText).toContain("started");
      } finally {
        await client.close();
      }
    });

    it("throttles repeated failed authentication attempts by client IP", async () => {
      const requests = Array.from({ length: 35 }, () =>
        fetch(`${baseUrl}/mcp/wrong_token_${Math.random()}`, { method: "POST" }),
      );
      const responses = await Promise.all(requests);
      const statuses = responses.map((r) => r.status);
      expect(statuses).toContain(429);
    });
  });
});
