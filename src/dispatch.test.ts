import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError } from "./protocol/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolDispatcher, type ToolOutcome } from "./dispatch.js";
import { TaskStore } from "./tasks/store.js";
import { ExtensionSessionManager, type SessionEvents } from "./ws/session.js";

let dir: string;
let store: TaskStore;
let session: ExtensionSessionManager;
let dispatcher: ToolDispatcher;
let send: ReturnType<typeof vi.fn>;
let usage: Array<[string, string, string | undefined]>;
const extraStores: TaskStore[] = [];

const ok = (summary = "done") => ({ ok: true, data: { summary } });
const fail = () => ({ ok: false, error: { code: "ACTION_FAILED" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dispatch-"));
  extraStores.length = 0;
  store = new TaskStore(join(dir, "relay.db"));
  session = new ExtensionSessionManager(
    {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    } as unknown as SessionEvents,
    undefined,
    "test-shared-secret-12345",
  );

  // Stub the transport: these tests are about the policy layer above it.
  send = vi.fn(async () => ok());
  vi.spyOn(session, "send").mockImplementation(send as never);

  usage = [];
  dispatcher = new ToolDispatcher({
    store,
    session,
    // Mirrors main.ts: a connected extension sits on example.com, so an
    // auto-started task inherits that hostname as its scope.
    getActiveTabHostname: async () => "example.com",
    onUsage: (tool, outcome, code) => usage.push([tool, outcome, code]),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const extra of extraStores) extra.close();
  extraStores.length = 0;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startTask(limits: Record<string, unknown> = {}): Promise<string> {
  const outcome = await dispatcher.dispatch("start_task", { goal: "g", ...limits });
  const structured = (outcome as { structured?: { taskId?: string } }).structured;
  return structured?.taskId ?? "";
}

/** Narrow the dispatch union without sprinkling casts through the suite. */
function codeOf(outcome: unknown): string | undefined {
  return outcome instanceof ProtocolError ? outcome.code : undefined;
}

describe("task lifecycle", () => {
  it("starts a task and reports its budget", async () => {
    const outcome = await dispatcher.dispatch("start_task", { goal: "find docs" });
    expect(outcome).toMatchObject({ structured: { goal: "find docs" } });
    expect(store.active()?.goal).toBe("find docs");
  });

  it("refuses a second concurrent task", async () => {
    await startTask();
    const outcome = await dispatcher.dispatch("start_task", { goal: "another" });
    expect(outcome).toBeInstanceOf(ProtocolError);
    expect((outcome as ProtocolError).code).toBe("BAD_REQUEST");
    expect((outcome as ProtocolError).message).not.toMatch(/no active task/i);
  });

  it("auto-starts a task when an action tool is called with no active task (FR-TK-01)", async () => {
    expect(store.active()).toBeUndefined();
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    expect(send).toHaveBeenCalledOnce();
    const active = store.active();
    expect(active).toBeDefined();
    expect(active?.goal).toBe("Auto-started task");
    expect(active?.actionsUsed).toBe(1);
    expect(active?.stepsUsed).toBe(1);
  });

  it("resumes a known task and reports usage", async () => {
    const id = await startTask();
    store.spend(id, 3, 1);
    const outcome = await dispatcher.dispatch("resume_task", { task_id: id });
    expect(outcome).toMatchObject({ structured: { actionsUsed: 3 } });
  });

  it("refuses to resume an unknown task", async () => {
    expect(codeOf(await dispatcher.dispatch("resume_task", { task_id: "ghost" }))).toBe(
      "TASK_NOT_FOUND",
    );
  });

  it("completes a task and frees the slot", async () => {
    const id = await startTask();
    const outcome = await dispatcher.dispatch("complete_task", {
      task_id: id,
      success: true,
      summary: "found it",
    });
    expect(outcome).toMatchObject({ structured: { success: true } });
    expect(store.active()).toBeUndefined();
    // Now a fresh task is allowed.
    expect(await startTask()).toBeTruthy();
  });

  it("refuses to complete an unknown or already complete task", async () => {
    expect(
      codeOf(
        await dispatcher.dispatch("complete_task", {
          task_id: "ghost",
          success: true,
          summary: "s",
        }),
      ),
    ).toBe("TASK_NOT_FOUND");
    const id = await startTask();
    await dispatcher.dispatch("complete_task", { task_id: id, success: true, summary: "s" });
    expect(
      codeOf(
        await dispatcher.dispatch("complete_task", { task_id: id, success: true, summary: "s" }),
      ),
    ).toBe("TASK_ALREADY_COMPLETE");
  });
});

describe("budget enforcement", () => {
  it("spends one action and one step per action tool", async () => {
    const id = await startTask();
    await dispatcher.dispatch("click", { ref: "e:51b2" });
    expect(store.get(id)).toMatchObject({ actionsUsed: 1, stepsUsed: 1 });
  });

  it("refuses the action that would exceed the budget", async () => {
    const id = await startTask({ max_actions: 2 });
    await dispatcher.dispatch("click", { ref: "e:aa" });
    send.mockClear();

    store.spend(id, 2, 1);
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });

    expect((outcome as ProtocolError).code).toBe("BUDGET_EXCEEDED");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses the step that would exceed the step limit", async () => {
    const id = await startTask({ max_steps: 1 });
    store.spend(id, 0, 1);
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });
    expect((outcome as ProtocolError).code).toBe("STEP_LIMIT_EXCEEDED");
  });

  it("charges a whole batch up front, so an over-budget batch never dispatches", async () => {
    const id = await startTask({ max_actions: 3 });
    store.spend(id, 2, 0);
    const outcome = await dispatcher.dispatch("act_batch", {
      actions: [
        { kind: "click", ref: "e:aa" },
        { kind: "click", ref: "e:bb" },
      ],
    });
    expect((outcome as ProtocolError).code).toBe("BUDGET_EXCEEDED");
    expect(send).not.toHaveBeenCalled();
    expect(store.get(id)?.actionsUsed).toBe(2);
  });

  it("charges the full batch length on success", async () => {
    const id = await startTask({ max_actions: 10 });
    await dispatcher.dispatch("act_batch", {
      actions: [
        { kind: "click", ref: "e:aa" },
        { kind: "type", ref: "e:bb", text: "hi" },
      ],
    });
    expect(store.get(id)?.actionsUsed).toBe(2);
  });

  it("rejects an empty batch before spending anything", async () => {
    await startTask();
    const outcome = await dispatcher.dispatch("act_batch", { actions: [] });
    expect((outcome as ProtocolError).code).toBe("BAD_REQUEST");
    expect(store.active()?.actionsUsed).toBe(0);
  });

  it("charges a step but no action for a read-only tool", async () => {
    const id = await startTask();
    await dispatcher.dispatch("read_page", {});
    // Reading the page must not eat the budget that decides what we may do next.
    expect(store.get(id)).toMatchObject({ actionsUsed: 0, stepsUsed: 1 });
  });
});

describe("domain allowlist", () => {
  function dispatcherFor(domains: string[]): ToolDispatcher {
    const cleanName = domains.join("-").replace(/[*:/\\]/g, "_");
    const scoped = new TaskStore(join(dir, `scoped-${cleanName}.db`));
    scoped.create("scoped", "g", { allowedDomains: domains }, Date.now());
    // Windows will not delete a temp dir while a sqlite handle is still open.
    extraStores.push(scoped);
    return new ToolDispatcher({ store: scoped, session });
  }

  it("denies any url when no allowlist is declared", async () => {
    // ERR-04: an empty allowlist used to be unrestricted, which made the allowlist
    // display-only. A task that declares no scope now gets no reach.
    await startTask();
    const outcome = await dispatcher.dispatch("navigate", { url: "https://anywhere.example" });
    expect(codeOf(outcome)).toBe("BAD_REQUEST");
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks a url outside the allowlist and never dispatches it", async () => {
    const scoped = dispatcherFor(["example.com"]);
    const outcome = await scoped.dispatch("navigate", { url: "https://evil.test" });
    expect(outcome).toBeInstanceOf(ProtocolError);
    expect((outcome as ProtocolError).code).toBe("BAD_REQUEST");
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a url inside the allowlist", async () => {
    const scoped = dispatcherFor(["*.example.com"]);
    const outcome = await scoped.dispatch("navigate", { url: "https://app.example.com/login" });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not let a lookalike host inherit the permission", async () => {
    const scoped = dispatcherFor(["example.com"]);
    const outcome = await scoped.dispatch("navigate", { url: "https://evil-example.com" });
    expect(outcome).toBeInstanceOf(ProtocolError);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not block a non-navigating tool that carries no url", async () => {
    const scoped = dispatcherFor(["example.com"]);
    const outcome = await scoped.dispatch("click", { ref: "e:51b2" });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
  });
});

describe("result handling", () => {
  it("returns a structured success", async () => {
    await startTask();
    send.mockResolvedValueOnce(ok("clicked the button"));
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });
    expect(outcome).toMatchObject({ text: "clicked the button" });
  });

  it("turns an extension failure into a retryable ACTION_FAILED", async () => {
    await startTask();
    send.mockResolvedValueOnce(fail());
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });
    const error = outcome as ProtocolError;
    expect(error.code).toBe("ACTION_FAILED");
    expect(error.retryable).toBe(true);
  });

  it("reports a transport failure as INTERNAL without crashing", async () => {
    await startTask();
    send.mockRejectedValueOnce(new Error("socket exploded"));
    const outcome = await dispatcher.dispatch("click", { ref: "e:51b2" });
    expect((outcome as ProtocolError).code).toBe("INTERNAL");
  });

  it("propagates EXTENSION_NOT_CONNECTED from the transport", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("EXTENSION_NOT_CONNECTED"));
    expect(codeOf(await dispatcher.dispatch("click", { ref: "e:51b2" }))).toBe(
      "EXTENSION_NOT_CONNECTED",
    );
  });

  it("serves tab_list without an active task", async () => {
    send.mockResolvedValueOnce(ok("[]"));
    expect(await dispatcher.dispatch("tab_list", {})).not.toBeInstanceOf(ProtocolError);
  });

  it("wraps read_page content in untrusted_page_content markers and contains no steering text (FR-CN-03)", async () => {
    send.mockResolvedValueOnce({
      ok: true,
      data: { summary: "Read complete", content: "Page heading and links" },
    });
    const outcome = await dispatcher.dispatch("read_page", { format: "text" });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    const res = outcome as ToolOutcome;
    expect(res.text).toContain("<untrusted_page_content>");
    expect(res.text).toContain("Page heading and links");
    expect(res.text).toContain("</untrusted_page_content>");
    expect(res.text.toLowerCase()).not.toContain("do not stop");
    expect(res.text.toLowerCase()).not.toContain("keep going");
  });

  it("answers dev_ping from relay state", async () => {
    const outcome = await dispatcher.dispatch("dev_ping", {});
    expect(outcome).toMatchObject({
      structured: {
        relayVersion: "2.1.0",
        extensionConnected: false,
        devToolsEnabled: false,
        toolCount: 20,
      },
    });
  });
});

describe("usage reporting", () => {
  it("records success and failure separately", async () => {
    await startTask();
    await dispatcher.dispatch("click", { ref: "e:aa" });
    send.mockResolvedValueOnce(fail());
    await dispatcher.dispatch("click", { ref: "e:bb" });

    expect(usage).toEqual([
      ["click", "ok", undefined],
      ["click", "error", "ACTION_FAILED"],
    ]);
  });

  it("normalizes null values for optional start_task parameters without BAD_REQUEST", async () => {
    const outcome = await dispatcher.dispatch("start_task", {
      goal: "Search for electronics",
      max_actions: null,
      max_steps: null,
      allowed_domains: null,
      success_criteria: null,
    });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    const success = outcome as ToolOutcome;
    expect(success.text).toContain("Task");
    expect(success.structured?.goal).toBe("Search for electronics");
  });

  it("includes metadata-only diagnostics on validation failure and never leaks values", async () => {
    const outcome = await dispatcher.dispatch("start_task", {
      goal: "Search",
      unknown_field_xyz: "SUPER_SECRET_VALUE",
    });
    expect(outcome).toBeInstanceOf(ProtocolError);
    const err = outcome as ProtocolError;
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.details?.receivedKeys).toContain("unknown_field_xyz");
    expect(err.details?.receivedTypes).toEqual({
      goal: "string",
      unknown_field_xyz: "string",
    });
    // Never leak actual secret values in error details
    expect(JSON.stringify(err.details)).not.toContain("SUPER_SECRET_VALUE");
  });

  it("executes dev_echo_args and returns key names and value types", async () => {
    const outcome = await dispatcher.dispatch("dev_echo_args", {
      first: "hello",
      count: 42,
      flag: true,
      list: [1, 2],
    });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    const res = outcome as ToolOutcome;
    expect(res.structured?.keys).toEqual(["first", "count", "flag", "list"]);
    expect(res.structured?.types).toEqual({
      first: "string",
      count: "number",
      flag: "boolean",
      list: "array",
    });
  });

  it("executes dev_destructive_noop successfully", async () => {
    const outcome = await dispatcher.dispatch("dev_destructive_noop", {
      reason: "Testing destructive prompt",
    });
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    const res = outcome as ToolOutcome;
    expect(res.structured?.destructive).toBe(true);
    expect(res.structured?.executed).toBe(true);
  });
});

describe("Double-execute guard (uncertain outcome)", () => {
  const CLICK = { ref: "e:42" };

  it("refuses an identical mutating retry after a deadline timeout", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("ACTION_TIMEOUT", { commandId: "c1" }));

    const first = await dispatcher.dispatch("click", CLICK);
    expect(first).toBeInstanceOf(ProtocolError);
    expect(codeOf(first)).toBe("ACTION_TIMEOUT");

    // The command already reached the extension, so a retry must not re-send it.
    send.mockClear();
    const retry = await dispatcher.dispatch("click", CLICK);
    expect(retry).toBeInstanceOf(ProtocolError);
    expect(codeOf(retry)).toBe("E_BUSY");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an identical mutating retry after a failed result envelope", async () => {
    await startTask();
    send.mockResolvedValueOnce(fail());

    const first = await dispatcher.dispatch("click", CLICK);
    expect(codeOf(first)).toBe("ACTION_FAILED");

    send.mockClear();
    const retry = await dispatcher.dispatch("click", CLICK);
    expect(codeOf(retry)).toBe("E_BUSY");
    expect(send).not.toHaveBeenCalled();
  });

  it("still allows a different mutating call while the guard is armed", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("ACTION_TIMEOUT"));
    await dispatcher.dispatch("click", CLICK);

    const other = await dispatcher.dispatch("click", { ref: "e:99" });
    expect(other).not.toBeInstanceOf(ProtocolError);
  });

  it("does not guard read-only calls: an identical read may repeat", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("ACTION_TIMEOUT"));
    await dispatcher.dispatch("read_page", { format: "text" });

    const again = await dispatcher.dispatch("read_page", { format: "text" });
    expect(again).not.toBeInstanceOf(ProtocolError);
  });

  it("clears the guard once the identical call settles successfully", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("ACTION_TIMEOUT"));
    await dispatcher.dispatch("click", CLICK);

    send.mockResolvedValueOnce(ok());
    // The guard is armed, so this success cannot happen yet...
    expect(codeOf(await dispatcher.dispatch("click", CLICK))).toBe("E_BUSY");

    // A different call settles fine and clears only its own fingerprint.
    send.mockResolvedValueOnce(ok());
    await dispatcher.dispatch("click", { ref: "e:7" });

    expect(codeOf(await dispatcher.dispatch("click", CLICK))).toBe("E_BUSY");
  });

  it("treats reordered argument keys as the same call", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("ACTION_TIMEOUT"));
    await dispatcher.dispatch("type", {
      ref: "e:42",
      text: "hello",
    });

    send.mockClear();
    const retry = await dispatcher.dispatch("type", {
      text: "hello",
      ref: "e:42",
    });
    expect(codeOf(retry)).toBe("E_BUSY");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not arm the guard when the extension was never connected", async () => {
    await startTask();
    send.mockRejectedValueOnce(new ProtocolError("EXTENSION_NOT_CONNECTED"));
    const first = await dispatcher.dispatch("click", CLICK);
    expect(codeOf(first)).toBe("EXTENSION_NOT_CONNECTED");

    // The retry should attempt to send again, NOT return E_BUSY
    send.mockClear();
    send.mockResolvedValueOnce(ok());
    const retry = await dispatcher.dispatch("click", CLICK);
    expect(codeOf(retry)).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("allows start_task to adopt an auto-started task", async () => {
    // 1. Trigger an action without calling start_task first (auto-starts task)
    const nav = await dispatcher.dispatch("navigate", { url: "https://example.com" });
    expect(codeOf(nav)).toBeUndefined();
    const active = store.active();
    expect(active).toBeDefined();
    expect(active?.goal).toBe("Auto-started task");

    // 2. Calling start_task now should ADOPT the auto-started task rather than throwing BAD_REQUEST
    const outcome = await dispatcher.dispatch("start_task", {
      goal: "Real user goal",
      max_actions: 50,
    });
    expect(codeOf(outcome)).toBeUndefined();
    expect(outcome).toMatchObject({
      structured: {
        taskId: active?.id,
        goal: "Real user goal",
        maxActions: 50,
      },
    });
    expect(store.active()?.goal).toBe("Real user goal");
    expect(store.active()?.maxActions).toBe(50);
  });
});
