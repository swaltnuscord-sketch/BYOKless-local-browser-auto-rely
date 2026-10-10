import { z } from "zod";

/**
 * The frozen Phase 1 tool contract.
 *
 * This module is the single source of truth for what the relay advertises.
 * `tools.snapshot.json` is generated from it and CI fails on any unversioned
 * change, so treat every edit here as a contract change.
 *
 * MCP `outputSchema` is deliberately omitted: the SDK's validateToolOutput()
 * is a no-op without one, which lets `structuredContent` reach the model.
 */

export const PRODUCTION_TOOL_NAMES = [
  "start_task",
  "resume_task",
  "complete_task",
  "navigate",
  "go_back",
  "click",
  "type",
  "key_press",
  "scroll",
  "select_option",
  "hover",
  "wait",
  "read_page",
  "find",
  "extract_state",
  "tab_list",
  "tab_switch",
  "tab_close",
  "pause_for_human",
  "act_batch",
] as const;

/** Opt-in diagnostics. Never advertised unless ENABLE_DEV_TOOLS=1. */
export const DEV_TOOL_NAMES = [
  "dev_ping",
  "dev_echo",
  "dev_sleep",
  "dev_echo_args",
  "dev_destructive_noop",
] as const;

export const ToolNameSchema = z.enum(PRODUCTION_TOOL_NAMES);
export const DevToolNameSchema = z.enum(DEV_TOOL_NAMES);
export const AnyToolNameSchema = z.enum([...PRODUCTION_TOOL_NAMES, ...DEV_TOOL_NAMES]);

export type ToolName = z.infer<typeof ToolNameSchema>;
export type DevToolName = z.infer<typeof DevToolNameSchema>;
export type AnyToolName = z.infer<typeof AnyToolNameSchema>;

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Any tool that changes browser state is `openWorldHint: true`. */
const open: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function readOnly(idempotent: boolean): ToolAnnotations {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

function destructive(): ToolAnnotations {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  /** Raw shape, as `McpServer.registerTool` expects. */
  readonly inputSchema: z.ZodRawShape;
  /**
   * The strict schema itself, for callers that need to hand it to a validator
   * rather than call it. Registering this instead of the raw shape keeps
   * `additionalProperties: false` in the advertised JSON Schema *and* makes the
   * validator reject undeclared keys, which the SDK's own raw-shape wrapper
   * silently strips.
   */
  readonly strictSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Permissive sibling of {@link strictSchema}, for handing to a transport that
   * must not filter the payload before the policy layer sees it. The MCP SDK
   * wraps a raw shape in its own permissive object and drops undeclared keys,
   * so registering the strict schema makes the SDK reject first with a generic
   * zod message. Registering this instead lets `ToolDispatcher` produce the
   * refusal, which can name the keys the tool actually accepts.
   */
  readonly looseSchema: z.ZodObject<z.ZodRawShape>;
  /** Strict parse: rejects unknown and mistyped arguments. */
  parseArgs(value: unknown): Record<string, unknown>;
}

/**
 * Normalizes tool arguments by stripping keys with null or undefined values.
 * This ensures that when LLMs send `null` for optional schema properties,
 * Zod `.optional()` doesn't fail with type mismatch errors.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value !== null && value !== undefined) {
      if (typeof value === "object" && !Array.isArray(value) && value !== null) {
        result[key] = normalizeToolArgs(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function makeLooseShape(shape: z.ZodRawShape): z.ZodRawShape {
  const loose: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(shape)) {
    loose[key] = (schema as z.ZodTypeAny).nullish();
  }
  return loose as z.ZodRawShape;
}

function define(
  title: string,
  description: string,
  annotations: ToolAnnotations,
  inputSchema: z.ZodRawShape,
  looseInputSchema?: z.ZodRawShape,
  passthrough = false,
): Omit<ToolDefinition, "name"> {
  // strictObject, not object: a silently ignored typo in `max_action` would
  // otherwise leave the model believing a budget was enforced.
  const strictSchema = passthrough
    ? z.object(inputSchema).passthrough()
    : z.strictObject(inputSchema);
  return {
    title,
    description,
    annotations,
    inputSchema,
    strictSchema,
    looseSchema: z.object(makeLooseShape(looseInputSchema ?? inputSchema)).passthrough(),
    parseArgs: (v) => strictSchema.parse(normalizeToolArgs(v)),
  };
}

const HttpUrlSchema = z.url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "url must use http or https" },
);

/** Element reference from a `read_page` snapshot, e.g. `e:51b2`. */
const RefSchema = z.string().regex(/^e:[0-9a-z]{2,16}$/i, "expected an element ref like e:51b2");

const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
    "expected a hostname",
  );

const WaitShape = {
  reason: z.string().min(1).max(500).optional(),
  timeout_ms: z.number().int().min(1).max(30_000).optional().default(5_000),
};

const ScrollDirectionSchema = z.enum(["up", "down", "top", "bottom"]);

const BatchActionShapes = {
  click: { kind: z.literal("click") as z.ZodLiteral<"click">, ref: RefSchema },
  type: {
    kind: z.literal("type") as z.ZodLiteral<"type">,
    ref: RefSchema,
    text: z.string().max(10_000),
    submit: z.boolean().optional(),
  },
  key_press: {
    kind: z.literal("key_press") as z.ZodLiteral<"key_press">,
    key: z.string().min(1).max(64),
  },
  hover: { kind: z.literal("hover") as z.ZodLiteral<"hover">, ref: RefSchema },
  select_option: {
    kind: z.literal("select_option") as z.ZodLiteral<"select_option">,
    ref: RefSchema,
    value: z.string().min(1),
  },
  scroll: {
    kind: z.literal("scroll") as z.ZodLiteral<"scroll">,
    direction: ScrollDirectionSchema,
    amount: z.number().int().min(1).max(20).optional(),
  },
  wait: { kind: z.literal("wait") as z.ZodLiteral<"wait">, ...WaitShape },
  navigate: { kind: z.literal("navigate") as z.ZodLiteral<"navigate">, url: HttpUrlSchema },
};

const StrictBatchActionSchema = z.discriminatedUnion("kind", [
  z.strictObject(BatchActionShapes.click),
  z.strictObject(BatchActionShapes.type),
  z.strictObject(BatchActionShapes.key_press),
  z.strictObject(BatchActionShapes.hover),
  z.strictObject(BatchActionShapes.select_option),
  z.strictObject(BatchActionShapes.scroll),
  z.strictObject(BatchActionShapes.wait),
  z.strictObject(BatchActionShapes.navigate),
]);

const LooseBatchActionSchema = z.discriminatedUnion("kind", [
  z.object(BatchActionShapes.click).passthrough(),
  z.object(BatchActionShapes.type).passthrough(),
  z.object(BatchActionShapes.key_press).passthrough(),
  z.object(BatchActionShapes.hover).passthrough(),
  z.object(BatchActionShapes.select_option).passthrough(),
  z.object(BatchActionShapes.scroll).passthrough(),
  z.object(BatchActionShapes.wait).passthrough(),
  z.object(BatchActionShapes.navigate).passthrough(),
]);

const TOOL_DEFINITION_LIST: Readonly<Record<AnyToolName, Omit<ToolDefinition, "name">>> = {
  start_task: define(
    "Start task",
    "Begin a new browsing task with a goal and optional limits. Required before any action tool.",
    open,
    {
      goal: z.string().min(1).max(2_000),
      success_criteria: z.array(z.string().min(1).max(500)).max(20).optional(),
      max_actions: z.number().int().positive().max(1_000).optional(),
      max_steps: z.number().int().positive().max(1_000).optional(),
      allowed_domains: z.array(HostnameSchema).max(50).optional(),
    },
  ),

  resume_task: define(
    "Resume task",
    "Resume a previously started task by id, restoring its counters and budget.",
    open,
    { task_id: z.string().min(1).max(128) },
  ),

  complete_task: define(
    "Complete task",
    "Close the active task and record whether it succeeded.",
    open,
    {
      task_id: z.string().min(1).max(128),
      success: z.boolean(),
      summary: z.string().min(1).max(4_000),
    },
  ),

  navigate: define(
    "Navigate",
    "Navigate the active tab to an absolute http or https URL and wait for it to settle.",
    open,
    { url: HttpUrlSchema },
  ),

  go_back: define(
    "Go back",
    "Navigate the active tab back one entry in session history.",
    open,
    {},
  ),

  click: define(
    "Click",
    "Click the element identified by a read_page reference. Destructive: may submit or navigate.",
    destructive(),
    { ref: RefSchema },
  ),

  type: define(
    "Type",
    "Type text into the element identified by a reference. Destructive: may change stored data.",
    destructive(),
    {
      ref: RefSchema,
      text: z.string().max(10_000),
      submit: z.boolean().optional(),
    },
  ),

  key_press: define(
    "Press key",
    "Press a single key or shortcut on the active tab. Destructive: Enter can submit.",
    destructive(),
    { key: z.string().min(1).max(64) },
  ),

  scroll: define(
    "Scroll",
    "Scroll the active tab up, down, to the top, or to the bottom. Changes the viewport only.",
    readOnly(false),
    {
      direction: ScrollDirectionSchema,
      amount: z.number().int().min(1).max(20).optional(),
    },
  ),

  select_option: define(
    "Select option",
    "Select an option in a native select element. Destructive: changes form state.",
    destructive(),
    { ref: RefSchema, value: z.string().min(1).max(500) },
  ),

  hover: define(
    "Hover",
    "Hover the element identified by a reference to reveal hover-triggered UI.",
    open,
    { ref: RefSchema },
  ),

  wait: define(
    "Wait",
    "Wait for the page to settle for a bounded time, or for a stated reason.",
    readOnly(false),
    WaitShape,
  ),

  read_page: define(
    "Read page",
    "Read the active tab and return a snapshot with element references and visible text.",
    readOnly(true),
    {
      format: z.enum(["text", "html"]).optional(),
      max_chars: z.number().int().min(1).max(200_000).optional(),
    },
  ),

  find: define(
    "Find on page",
    "Search the current snapshot for text and return matching element references.",
    readOnly(true),
    {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(100).optional(),
    },
  ),

  extract_state: define(
    "Extract state",
    "Extract named fields from the page, such as form values or table rows.",
    readOnly(true),
    {
      fields: z
        .record(z.string().min(1).max(100), z.string().min(1).max(500))
        .refine((v) => Object.keys(v).length > 0, { message: "fields must not be empty" }),
    },
  ),

  tab_list: define(
    "List tabs",
    "List every tab in the current window with ids, titles, and URLs.",
    readOnly(true),
    {},
  ),

  tab_switch: define(
    "Switch tab",
    "Make a tab active by id, or return to the active tab when id is omitted.",
    open,
    { tab_id: z.number().int().min(0).optional() },
  ),

  tab_close: define(
    "Close tab",
    "Close a tab by id, or the active tab when id is omitted. Destructive: discards tab state.",
    destructive(),
    { tab_id: z.number().int().min(0).optional() },
  ),

  pause_for_human: define(
    "Pause for human",
    "Pause the task and ask the operator a question. The relay surfaces this in the side panel.",
    open,
    {
      reason: z.string().min(1).max(500),
      question: z.string().min(1).max(1_000).optional(),
    },
  ),

  act_batch: define(
    "Run action batch",
    "Run a bounded sequence of actions in order. Destructive: the batch may contain any action kind.",
    destructive(),
    { actions: z.array(StrictBatchActionSchema).min(1).max(50) },
    { actions: z.array(LooseBatchActionSchema).min(1).max(50) },
  ),

  dev_ping: define(
    "Dev ping",
    "Development-only liveness probe. Not advertised in production.",
    open,
    {},
  ),

  dev_echo: define(
    "Dev echo",
    "Development-only echo probe. Returns its input.",
    readOnly(true),
    { message: z.string().optional(), index: z.number().int().optional() },
    {},
    true,
  ),

  dev_echo_args: define(
    "Dev echo args",
    "Development-only read-only tool that returns argument key names and their value types.",
    readOnly(true),
    {},
    {},
    true,
  ),

  dev_destructive_noop: define(
    "Dev destructive no-op",
    "Development-only no-op tool annotated destructiveHint: true.",
    destructive(),
    { reason: z.string().optional() },
  ),

  dev_sleep: define(
    "Dev sleep",
    "Development-only sleep probe. Waits then returns.",
    readOnly(true),
    { seconds: z.number().int().min(1).max(300) },
  ),
};

// Each definition carries its own name so error messages can identify the tool
// that was actually called, rather than the one the caller thought it called.
// Attached here rather than inside `define` to keep the 21 declarations above
// readable.
const NAMED_DEFINITIONS = Object.fromEntries(
  (Object.entries(TOOL_DEFINITION_LIST) as [AnyToolName, Omit<ToolDefinition, "name">][]).map(
    ([name, definition]) => [name, { ...definition, name }],
  ),
) as Readonly<Record<AnyToolName, ToolDefinition>>;

/** The frozen tool contract, keyed by tool name. */
export const TOOL_DEFINITIONS = NAMED_DEFINITIONS;

export interface ToolRegistryEntry {
  readonly name: AnyToolName;
  readonly config: {
    readonly title: string;
    readonly description: string;
    readonly inputSchema: z.ZodRawShape;
    readonly annotations: ToolAnnotations;
  };
}

export interface ToolSelection {
  readonly enableDevTools?: boolean;
}

export function listToolNames(selection: ToolSelection = {}): AnyToolName[] {
  const names: AnyToolName[] = [...PRODUCTION_TOOL_NAMES];
  if (selection.enableDevTools === true) {
    names.push(...DEV_TOOL_NAMES);
  }
  return names;
}

export function getToolDefinition(name: AnyToolName): ToolDefinition {
  return TOOL_DEFINITIONS[name];
}

export function buildToolRegistry(selection: ToolSelection = {}): ToolRegistryEntry[] {
  return listToolNames(selection).map((name) => {
    const def = TOOL_DEFINITIONS[name];
    return {
      name,
      config: {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
    };
  });
}
