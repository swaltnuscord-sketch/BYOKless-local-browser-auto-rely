import { createHash, randomUUID } from "node:crypto";
import {
  checkBudget,
  DEFAULT_TASK_LIMITS,
  isDomainAllowed,
  listToolNames,
  MAX_BATCH_ACTIONS,
  normalizeToolArgs,
  PROTOCOL_VERSION,
  ProtocolError,
  resolveDeadline,
  resolveTaskLimits,
  type TaskLimits,
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolName,
} from "./protocol/index.js";
import { Deduplicator } from "./bridge/dedupe.js";
import { TabQueue } from "./bridge/queue.js";
import { formatToolMarkdown } from "./mcp/format/markdown.js";
import { formatStructuredContent } from "./mcp/format/structured.js";
import type { TaskStore } from "./tasks/store.js";
import type { ExtensionSessionManager } from "./ws/session.js";

/**
 * Routes MCP tool calls to the extension.
 *
 * This is the trust boundary's policy layer. Every check that can refuse work
 * happens here, before a command is put on the wire, because an action that has
 * already reached the browser cannot be undone.
 */

export interface ToolOutcome {
  readonly text: string;
  readonly structured?: Record<string, unknown>;
}

/**
 * Turn a schema failure into a refusal the model can act on.
 *
 * Listing the allowed keys matters: a model that sent `max_action` needs to be
 * told `max_actions` exists, not merely that something was wrong.
 */
function invalidArguments(
  definition: ToolDefinition,
  issues: readonly { path: PropertyKey[]; message: string; code?: string }[],
  rawArgs: Record<string, unknown>,
) {
  const allowed = Object.keys(definition.inputSchema);
  const receivedKeys = Object.keys(rawArgs);
  const receivedTypes = Object.fromEntries(
    Object.entries(rawArgs).map(([k, v]) => [
      k,
      v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
    ]),
  );
  const detail = issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      const code = issue.code ? `[${issue.code}] ` : "";
      return `${at}: ${code}${issue.message}`;
    })
    .join("; ");

  return new ProtocolError("BAD_REQUEST", {
    tool: definition.name,
    allowedKeys: allowed,
    receivedKeys,
    receivedTypes,
    issuePaths: issues.map((i) => i.path.map(String).join(".") || "(root)"),
    issueCodes: issues.map((i) => i.code ?? "custom"),
    message: `Invalid arguments for ${definition.name}. Allowed keys: ${allowed.join(", ") || "(none)"}. Received keys: ${receivedKeys.join(", ") || "(none)"}. ${detail}`,
    hint: `Call ${definition.name} with only the listed keys and valid types.`,
  });
}

/**
 * How long an identical mutating call stays refused after an *uncertain* outcome.
 *
 * ChatGPT gives up on a call at roughly 60s, but our own deadline fires at 25s
 * and the extension may still be mid-action. A model that retries on its own
 * timeout would otherwise send a second command for an action that may already
 * have run: a double click, a double form submit. The window is deliberately
 * wider than the deadline because the uncertainty outlives it.
 */
const UNCERTAIN_COOLDOWN_MS = 30_000;

export interface DispatchDeps {
  readonly store: TaskStore;
  readonly session: ExtensionSessionManager;
  readonly enableDevTools?: boolean;
  readonly onUsage?: (tool: string, outcome: "ok" | "error", code?: string) => void;
  /**
   * Hostname of the tab the agent currently owns, used to scope an auto-started task.
   *
   * Returns a bare hostname (`example.com`), never a full origin: `isDomainAllowed`
   * compares against hostnames and wildcard patterns, so handing it `https://example.com`
   * would silently match nothing and deny every navigation.
   *
   * Fails open to `null` — callers must treat `null` as "no scope", which after the
   * empty-allowlist rule change means navigation stays denied rather than unrestricted.
   */
  readonly getActiveTabHostname?: () => Promise<string | null>;
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Stable identity for "the same call again".
 *
 * Uses SHA-256 over canonical JSON so `{a,b}` and `{b,a}` produce identical hashes.
 */
function callFingerprint(tool: string, args: Record<string, unknown>): string {
  const canonical = canonicalJson(args);
  const hash = createHash("sha256").update(`${tool}:${canonical}`).digest("hex");
  return `${tool}:${hash}`;
}

/** Tools that do not need an active task. */
const TASK_FREE = new Set([
  "start_task",
  "resume_task",
  "tab_list",
  "dev_ping",
  "dev_echo",
  "dev_sleep",
  "dev_echo_args",
  "dev_destructive_noop",
]);

/** Tools that change the page and therefore consume action budget. */
const CONSUMES_ACTION = new Set([
  "navigate",
  "go_back",
  "click",
  "type",
  "key_press",
  "scroll",
  "select_option",
  "hover",
  "wait",
  "tab_switch",
  "tab_close",
  "act_batch",
]);

export class ToolDispatcher {
  isReady(): boolean {
    return this.#session.connected;
  }
  readonly #store: TaskStore;
  readonly #session: ExtensionSessionManager;
  readonly #enableDevTools: boolean;
  readonly #onUsage: DispatchDeps["onUsage"];
  readonly #getActiveTabHostname: DispatchDeps["getActiveTabHostname"];
  /**
   * Fingerprints of mutating calls whose outcome is unknown, mapped to the time
   * the refusal expires. Survives client aborts: a caller hanging up cannot
   * un-send a command, so the guard has to outlive the HTTP request.
   */
  readonly #uncertain = new Map<string, number>();
  readonly #tabQueue = new TabQueue();
  readonly #deduplicator = new Deduplicator(30_000);

  constructor(deps: DispatchDeps) {
    this.#store = deps.store;
    this.#session = deps.session;
    this.#enableDevTools = deps.enableDevTools === true;
    this.#onUsage = deps.onUsage;
    this.#getActiveTabHostname = deps.getActiveTabHostname;
  }

  #record(tool: string, outcome: "ok" | "error", code?: string): void {
    this.#onUsage?.(tool, outcome, code);
  }

  #limitsFor(taskId: string): TaskLimits {
    const row = this.#store.get(taskId);
    const domains = this.#store.allowedDomains(taskId);
    if (domains === undefined) {
      throw new ProtocolError("INTERNAL", { reason: "Task allowlist is corrupt" });
    }
    return resolveTaskLimits({
      maxActions: row?.maxActions,
      maxSteps: row?.maxSteps,
      allowedDomains: domains,
    });
  }

  /**
   * Run a tool.
   *
   * Returns a tool-level failure as data rather than throwing: per PRD section
   * 11 the model has to be able to read the code and decide whether to retry.
   */
  async dispatch(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome | ProtocolError> {
    try {
      // Validate here rather than trusting the transport. MCP already applies
      // the same strict schema, but dispatch is also called directly, and a
      // silently dropped `max_action` would leave the model believing a budget
      // was in force when the default was being used instead.
      const definition = TOOL_DEFINITIONS[tool as ToolName];
      if (!definition) throw new ProtocolError("TOOL_NOT_FOUND", { tool });

      const normalized = normalizeToolArgs(args);
      const parsed = definition.strictSchema.safeParse(normalized);
      if (!parsed.success) throw invalidArguments(definition, parsed.error.issues, args);

      this.#guardAgainstDoubleExecute(tool, parsed.data);

      return await this.#run(tool, parsed.data);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#record(tool, "error", error.code);
        return error;
      }
      this.#record(tool, "error", "INTERNAL");
      return new ProtocolError("INTERNAL", { tool });
    }
  }

  /**
   * Refuse a retry of a mutating call whose previous outcome is unknown.
   *
   * Only mutating tools are guarded: re-reading the page is free, re-clicking is
   * not. A successful call clears its own guard immediately so ordinary repeated
   * actions are unaffected.
   */
  #guardAgainstDoubleExecute(tool: string, args: Record<string, unknown>): void {
    if (!CONSUMES_ACTION.has(tool)) return;

    const now = Date.now();
    const fingerprint = callFingerprint(tool, args);
    const expiresAt = this.#uncertain.get(fingerprint);
    if (expiresAt === undefined) return;

    if (expiresAt <= now) {
      this.#uncertain.delete(fingerprint);
      return;
    }

    throw new ProtocolError("E_BUSY", {
      tool,
      reason:
        "an identical call was already sent and may still be executing; " +
        "read the page to check whether it took effect before retrying",
      retryAfterMs: expiresAt - now,
    });
  }

  #markUncertain(fingerprint: string): void {
    this.#uncertain.set(fingerprint, Date.now() + UNCERTAIN_COOLDOWN_MS);
  }

  async #run(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    switch (tool) {
      case "start_task":
        return this.#startTask(args);
      case "resume_task":
        return this.#resumeTask(args);
      case "complete_task":
        return this.#completeTask(args);
      case "dev_echo_args": {
        const keys = Object.keys(args);
        const types = Object.fromEntries(
          Object.entries(args).map(([k, v]) => [
            k,
            v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
          ]),
        );
        return {
          text: `dev_echo_args: received ${keys.length} argument(s) [${keys.map((k) => `${k}: ${types[k]}`).join(", ") || "none"}]`,
          structured: { keys, types },
        };
      }
      case "dev_destructive_noop": {
        return {
          text: `dev_destructive_noop executed (no-op). Reason: ${String(args.reason ?? "none")}`,
          structured: { destructive: true, executed: true, reason: args.reason },
        };
      }
      case "dev_ping":
        return this.#devPing();
      case "dev_echo":
        return {
          text: String(args.message ?? JSON.stringify(args)),
          structured: args,
        };
      case "dev_sleep": {
        const sec = Number(args.seconds ?? 1);
        await new Promise((resolve) => setTimeout(resolve, sec * 1000));
        return {
          text: `slept for ${sec} seconds`,
          structured: { seconds: sec },
        };
      }
      case "tab_list":
        return this.#forward(tool, args);
      default:
        return this.#forwardGuarded(tool, args);
    }
  }

  #startTask(args: Record<string, unknown>): ToolOutcome {
    const goal = String(args.goal ?? "");
    const limits = resolveTaskLimits({
      maxActions: args.max_actions as number | undefined,
      maxSteps: args.max_steps as number | undefined,
      allowedDomains: args.allowed_domains as string[] | undefined,
    });

    // A second concurrent task would make "the active tab" ambiguous. BAD_REQUEST
    // rather than NO_ACTIVE_TASK, whose message is the opposite of the problem.
    const existing = this.#store.active();
    if (existing) {
      if (existing.origin === "auto") {
        this.#store.adopt(existing.id, goal, limits);
        return {
          text: `Task ${existing.id} adopted.\nGoal: ${goal}\nAction budget: ${limits.maxActions}\nStep budget: ${limits.maxSteps}`,
          structured: {
            taskId: existing.id,
            goal,
            maxActions: limits.maxActions,
            maxSteps: limits.maxSteps,
          },
        };
      }
      throw new ProtocolError("BAD_REQUEST", {
        reason: `task ${existing.id} is still active; complete it or resume it instead`,
        activeTaskId: existing.id,
      });
    }

    const id = randomUUID();
    this.#store.create(id, goal, limits);
    return {
      text: `Task ${id} started.\nGoal: ${goal}\nAction budget: ${limits.maxActions}\nStep budget: ${limits.maxSteps}`,
      structured: { taskId: id, goal, maxActions: limits.maxActions, maxSteps: limits.maxSteps },
    };
  }

  #resumeTask(args: Record<string, unknown>): ToolOutcome {
    const id = String(args.task_id ?? "");
    const row = this.#store.get(id);
    if (!row) throw new ProtocolError("TASK_NOT_FOUND", { taskId: id });
    if (row.status === "complete") throw new ProtocolError("TASK_ALREADY_COMPLETE", { taskId: id });
    return {
      text: `Task ${id} resumed.\nGoal: ${row.goal}\nActions used: ${row.actionsUsed}/${row.maxActions}\nSteps used: ${row.stepsUsed}/${row.maxSteps}`,
      structured: {
        taskId: id,
        goal: row.goal,
        actionsUsed: row.actionsUsed,
        maxActions: row.maxActions,
        stepsUsed: row.stepsUsed,
        maxSteps: row.maxSteps,
      },
    };
  }

  #completeTask(args: Record<string, unknown>): ToolOutcome {
    const id = String(args.task_id ?? "");
    const row = this.#store.get(id);
    if (!row) throw new ProtocolError("TASK_NOT_FOUND", { taskId: id });
    if (row.status === "complete") throw new ProtocolError("TASK_ALREADY_COMPLETE", { taskId: id });

    const success = args.success === true;
    const summary = String(args.summary ?? "");
    if (!this.#store.complete(id, success, summary)) {
      throw new ProtocolError("INTERNAL", { taskId: id });
    }
    return {
      text: `Task ${id} completed: ${success ? "success" : "failure"}.`,
      structured: { taskId: id, success },
    };
  }

  #devPing(): ToolOutcome {
    const devToolsEnabled = this.#enableDevTools;
    const toolCount = listToolNames({ enableDevTools: devToolsEnabled }).length;
    return {
      text: `relay ${PROTOCOL_VERSION} ok, extension connected: ${this.#session.connected}, devTools: ${devToolsEnabled ? "enabled" : "disabled"}, tools: ${toolCount}`,
      structured: {
        relayVersion: PROTOCOL_VERSION,
        extensionConnected: this.#session.connected,
        devToolsEnabled,
        toolCount,
      },
    };
  }

  /** Tools with no task requirement. */
  #forward(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    return this.#send(tool, args, 1, resolveDeadline());
  }

  /** Tools that need an active task, budget, and domain checks. */
  async #forwardGuarded(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    if (TASK_FREE.has(tool)) return this.#forward(tool, args);

    let task = this.#store.active();
    if (!task) {
      // FR-TK-01: Auto-start a default task when an action tool is called with no active task
      const autoId = randomUUID();
      const autoGoal = "Auto-started task";
      // An empty allowlist now denies navigation, so an auto-task must inherit a scope
      // from the page it starts on. `null` (extension not connected, or no active tab)
      // leaves the list empty, which is deliberately fail-closed: the model has to call
      // start_task with allowed_domains instead of inheriting an unrestricted session.
      const activeHostname = await this.#getActiveTabHostname?.();
      const autoLimits = {
        maxActions: DEFAULT_TASK_LIMITS.maxActions,
        maxSteps: DEFAULT_TASK_LIMITS.maxSteps,
        allowedDomains: activeHostname ? [activeHostname] : [],
      };
      this.#store.create(autoId, autoGoal, autoLimits, Date.now(), "auto");
      task = this.#store.active();
      if (!task) throw new ProtocolError("INTERNAL", { taskId: autoId });
    }

    // Every guarded call spends a step; only tools that change the page spend
    // action budget. Reading the page to decide what to do next must not cost
    // the budget that decides whether we may still do it.
    const consumesAction = CONSUMES_ACTION.has(tool);
    const actionCount = tool === "act_batch" ? this.#batchSize(args) : 1;
    const limits = this.#limitsFor(task.id);

    if (consumesAction) {
      // Budget is checked before dispatch, never after.
      const decision = checkBudget(
        { actionsUsed: task.actionsUsed, stepsUsed: task.stepsUsed },
        limits,
        actionCount,
      );
      if (!decision.ok) {
        throw new ProtocolError(decision.code, { used: decision.used, limit: decision.limit });
      }
    }

    // A page URL supplied by the model must stay inside the task allowlist.
    const url = typeof args.url === "string" ? args.url : null;
    if (url) {
      const allowed = isDomainAllowed(url, limits.allowedDomains);
      if (!allowed.ok) {
        throw new ProtocolError("BAD_REQUEST", { reason: allowed.reason });
      }
    }

    if (!this.#store.spend(task.id, consumesAction ? actionCount : 0, 1)) {
      throw new ProtocolError("INTERNAL", { taskId: task.id });
    }

    return this.#send(tool, args, actionCount, resolveDeadline());
  }

  #batchSize(args: Record<string, unknown>): number {
    const actions = args.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new ProtocolError("BAD_REQUEST", { reason: "act_batch needs at least one action" });
    }
    if (actions.length > MAX_BATCH_ACTIONS) {
      throw new ProtocolError("BAD_REQUEST", { reason: `at most ${MAX_BATCH_ACTIONS} actions` });
    }
    return actions.length;
  }

  async #send(
    tool: string,
    args: Record<string, unknown>,
    actionCount: number,
    deadlineMs: number,
  ): Promise<ToolOutcome> {
    const id = randomUUID();
    const fingerprint = callFingerprint(tool, args);

    const taskRunner = async (): Promise<ToolOutcome> => {
      let result: Awaited<ReturnType<ExtensionSessionManager["send"]>>;
      try {
        result = await this.#session.send({ id, tool, args, deadlineMs });
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "EXTENSION_NOT_CONNECTED") {
          // Action was not sent to browser: outcome is definite, do NOT arm uncertain guard
          throw error;
        }
        // Timeout, abort, or a dropped socket post-send. Arm uncertain guard.
        this.#markUncertain(fingerprint);
        throw error;
      }

      if (!result.ok) {
        // Recorded by dispatch(), which owns the single reporting path.
        this.#markUncertain(fingerprint);
        throw new ProtocolError("ACTION_FAILED", { tool, actionCount });
      }

      // Settled cleanly: no uncertainty, so drop any guard for this exact call.
      this.#uncertain.delete(fingerprint);
      this.#record(tool, "ok");
      const data = (result.data ?? {}) as Record<string, unknown>;
      const dataObj = { tool, actionCount, ...data };
      const text = formatToolMarkdown(tool, dataObj);
      const structured = formatStructuredContent(tool, dataObj);
      return { text, structured };
    };

    const isMutating = CONSUMES_ACTION.has(tool);
    const tabId =
      typeof args.tab_id === "number"
        ? args.tab_id
        : typeof args.tabId === "number"
          ? args.tabId
          : undefined;

    const queuedTask =
      tabId !== undefined ? () => this.#tabQueue.enqueue(tabId, taskRunner) : taskRunner;

    if (isMutating) {
      return this.#deduplicator.dedupe(fingerprint, queuedTask);
    }
    return queuedTask();
  }
}
