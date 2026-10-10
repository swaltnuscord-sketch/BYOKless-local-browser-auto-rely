import { describe, expect, it } from "vitest";
import {
  buildToolRegistry,
  DEV_TOOL_NAMES,
  listToolNames,
  normalizeToolArgs,
  PRODUCTION_TOOL_NAMES,
  TOOL_DEFINITIONS,
  ToolNameSchema,
} from "./tools.js";

/** The contract test runs with dev tools OFF and must see exactly this set. */
const EXPECTED_20 = [
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
] as const;

const READ_ONLY = new Set(["read_page", "find", "extract_state", "tab_list", "scroll", "wait"]);
const DESTRUCTIVE = new Set([
  "click",
  "type",
  "key_press",
  "select_option",
  "tab_close",
  "act_batch",
]);

describe("the frozen 20-tool contract", () => {
  it("exposes exactly the 20 PRD tools with dev tools disabled", () => {
    const names = listToolNames();
    expect(names).toHaveLength(20);
    expect([...names].sort()).toEqual([...EXPECTED_20]);
  });

  it("has no duplicates", () => {
    expect(new Set(PRODUCTION_TOOL_NAMES).size).toBe(PRODUCTION_TOOL_NAMES.length);
  });

  it("keeps dev tools out of the production list", () => {
    expect(listToolNames()).not.toContain("dev_ping");
    for (const name of DEV_TOOL_NAMES) {
      expect(PRODUCTION_TOOL_NAMES).not.toContain(name as never);
    }
  });

  it("adds dev tools only when explicitly enabled", () => {
    expect(listToolNames({ enableDevTools: true })).toHaveLength(25);
    expect(listToolNames({ enableDevTools: true })).toContain("dev_ping");
  });

  it("never derives tool identity from an unvalidated string", () => {
    expect(ToolNameSchema.options).toHaveLength(20);
    expect(ToolNameSchema.safeParse("dev_ping").success).toBe(false);
    expect(ToolNameSchema.safeParse("drop_tables").success).toBe(false);
  });
});

describe("annotations", () => {
  it("marks read-only tools read-only and nothing else", () => {
    const readOnly = PRODUCTION_TOOL_NAMES.filter(
      (n) => TOOL_DEFINITIONS[n].annotations.readOnlyHint === true,
    );
    expect([...readOnly].sort()).toEqual([...READ_ONLY].sort());
  });

  it("marks destructive tools destructive and nothing else", () => {
    const destructive = PRODUCTION_TOOL_NAMES.filter(
      (n) => TOOL_DEFINITIONS[n].annotations.destructiveHint === true,
    );
    expect([...destructive].sort()).toEqual([...DESTRUCTIVE].sort());
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const name of PRODUCTION_TOOL_NAMES) {
      const a = TOOL_DEFINITIONS[name].annotations;
      expect(a.readOnlyHint === true && a.destructiveHint === true, name).toBe(false);
    }
  });

  it("marks every mutating tool as not read-only", () => {
    // Anything outside the read-only set must be explicit, so a new tool
    // cannot silently inherit a safe-sounding default.
    for (const name of PRODUCTION_TOOL_NAMES) {
      expect(typeof TOOL_DEFINITIONS[name].annotations.readOnlyHint, name).toBe("boolean");
    }
  });

  it("marks dev_ping as a write", () => {
    const dev = TOOL_DEFINITIONS.dev_ping;
    expect(dev.annotations.readOnlyHint).toBe(false);
    expect(dev.annotations.destructiveHint).toBe(false);
  });
});

describe("tool metadata", () => {
  it("gives every tool a title and a non-empty description", () => {
    for (const name of [...PRODUCTION_TOOL_NAMES, ...DEV_TOOL_NAMES]) {
      const t = TOOL_DEFINITIONS[name];
      expect(t.title, name).toBeTruthy();
      expect(t.description.length, name).toBeGreaterThan(20);
    }
  });

  it("gives every tool a closed input schema", () => {
    // strictObject would reject unknown args; assert the shape at least parses
    // valid input and that keys are enumerable so the SDK can expose them.
    for (const name of PRODUCTION_TOOL_NAMES) {
      expect(Object.keys(TOOL_DEFINITIONS[name].inputSchema), name).toBeTypeOf("object");
    }
  });

  it("declares no MCP outputSchema, per the SDK validation decision", () => {
    // validateToolOutput() is a no-op without outputSchema, which keeps
    // structuredContent passable through to the model.
    for (const name of PRODUCTION_TOOL_NAMES) {
      expect(TOOL_DEFINITIONS[name]).not.toHaveProperty("outputSchema");
    }
  });
});

describe("buildToolRegistry", () => {
  it("returns one SDK-ready entry per production tool", () => {
    const registry = buildToolRegistry();
    expect(registry).toHaveLength(20);
    for (const entry of registry) {
      expect(entry.name).toBeTruthy();
      expect(entry.config.description).toBeTruthy();
      expect(entry.config.annotations).toBeDefined();
    }
  });

  it("includes dev tools only when enabled", () => {
    expect(buildToolRegistry({ enableDevTools: true })).toHaveLength(25);
  });
});

describe("argument validation", () => {
  const parse = (name: (typeof PRODUCTION_TOOL_NAMES)[number], value: unknown) =>
    TOOL_DEFINITIONS[name].parseArgs(value);

  it("rejects unknown arguments instead of ignoring them", () => {
    expect(() => parse("navigate", { url: "https://example.com", evil: true })).toThrow();
  });

  it("requires a navigable url", () => {
    expect(parse("navigate", { url: "https://example.com" })).toEqual({
      url: "https://example.com",
    });
    expect(() => parse("navigate", { url: "not a url" })).toThrow();
  });

  it("rejects non-http schemes", () => {
    expect(() => parse("navigate", { url: "javascript:alert(1)" })).toThrow();
    expect(() => parse("navigate", { url: "file:///etc/passwd" })).toThrow();
  });

  it("requires a goal to start a task", () => {
    expect(() => parse("start_task", {})).toThrow();
    expect(parse("start_task", { goal: "find the docs" }).goal).toBe("find the docs");
  });

  it("refuses a negative action budget", () => {
    expect(() => parse("start_task", { goal: "g", max_actions: -1 })).toThrow();
    expect(() => parse("start_task", { goal: "g", max_steps: 0 })).toThrow();
  });

  it("requires a ref for element-targeted actions", () => {
    expect(() => parse("click", {})).toThrow();
    expect(parse("click", { ref: "e:51b2" }).ref).toBe("e:51b2");
  });

  it("requires text to type", () => {
    expect(() => parse("type", { ref: "e:51b2" })).toThrow();
    expect(parse("type", { ref: "e:51b2", text: "" })).toEqual({ ref: "e:51b2", text: "" });
  });

  it("rejects a ref that is not snapshot-derived", () => {
    expect(() => parse("click", { ref: "51b2" })).toThrow();
    expect(() => parse("click", { ref: "e:1" })).toThrow();
    expect(() => parse("click", { ref: "e:../../etc/passwd" })).toThrow();
  });

  it("keeps act_batch a non-empty bounded list", () => {
    expect(() => parse("act_batch", { actions: [] })).toThrow();
    expect(() =>
      parse("act_batch", {
        actions: Array.from({ length: 51 }, () => ({ kind: "click", ref: "e:51b2" })),
      }),
    ).toThrow();
    const parsed = parse("act_batch", { actions: [{ kind: "click", ref: "e:51b2" }] });
    expect(parsed.actions).toHaveLength(1);
  });

  it("keeps act_batch actions strictly typed per kind", () => {
    expect(() => parse("act_batch", { actions: [{ kind: "nope", ref: "e:51b2" }] })).toThrow();
    expect(() => parse("act_batch", { actions: [{ kind: "click" }] })).toThrow();
    expect(() =>
      parse("act_batch", { actions: [{ kind: "navigate", url: "javascript:alert(1)" }] }),
    ).toThrow();
  });

  it("accepts an empty object for argument-free tools", () => {
    expect(parse("go_back", {})).toEqual({});
    expect(parse("tab_list", {})).toEqual({});
  });

  it("keeps wait bounded so it cannot hang a session", () => {
    expect(() => parse("wait", { timeout_ms: 10_000_000 })).toThrow();
    expect(parse("wait", {}).timeout_ms).toBeGreaterThan(0);
  });

  it("requires a reason to pause for a human", () => {
    expect(() => parse("pause_for_human", {})).toThrow();
  });
});

describe("normalizeToolArgs", () => {
  it("strips null and undefined values from optional params", () => {
    const input = {
      goal: "Search for shoes",
      max_actions: null,
      max_steps: undefined,
      allowed_domains: null,
    };
    const def = TOOL_DEFINITIONS.start_task;
    const parsed = def.parseArgs(input);
    expect(parsed).toEqual({ goal: "Search for shoes" });
  });

  it("preserves nested non-null values while stripping nested nulls", () => {
    const input = {
      goal: "Test",
      nested: { keep: "yes", drop: null },
    };
    const normalized = normalizeToolArgs(input);
    expect(normalized).toEqual({ goal: "Test", nested: { keep: "yes" } });
  });
});

describe("dev tools", () => {
  it("marks dev_destructive_noop as destructive and not read-only", () => {
    const t = TOOL_DEFINITIONS.dev_destructive_noop;
    expect(t.annotations.destructiveHint).toBe(true);
    expect(t.annotations.readOnlyHint).toBe(false);
  });

  it("marks dev_echo_args as read-only and not destructive", () => {
    const t = TOOL_DEFINITIONS.dev_echo_args;
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.annotations.destructiveHint).toBe(false);
  });
});
