import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-store-"));
  store = new TaskStore(join(dir, "relay.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("create and read", () => {
  it("stores a task and reads it back", () => {
    store.create("t1", "find the docs", { maxActions: 10, maxSteps: 5 }, 1_000);
    const row = store.get("t1");
    expect(row).toMatchObject({
      id: "t1",
      goal: "find the docs",
      status: "active",
      actionsUsed: 0,
      stepsUsed: 0,
      createdAt: 1_000,
    });
  });

  it("returns undefined for an unknown task", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("refuses a duplicate id rather than silently overwriting", () => {
    store.create("t1", "first");
    expect(() => store.create("t1", "second")).toThrow();
    expect(store.get("t1")?.goal).toBe("first");
  });

  it("applies default limits when none are given", () => {
    store.create("t1", "g");
    expect(store.get("t1")).toMatchObject({ maxActions: 200, maxSteps: 200 });
  });
});

describe("active task", () => {
  it("finds the active task", () => {
    store.create("t1", "g", {}, 1);
    store.create("t2", "g", {}, 2);
    expect(store.active()?.id).toBe("t2");
  });

  it("ignores completed tasks", () => {
    store.create("t1", "g", {}, 1);
    store.complete("t1", true, "done", 2);
    expect(store.active()).toBeUndefined();
  });

  it("is undefined when there are no tasks", () => {
    expect(store.active()).toBeUndefined();
  });
});

describe("spend", () => {
  it("accumulates usage", () => {
    store.create("t1", "g");
    expect(store.spend("t1", 2, 1)).toBe(true);
    expect(store.spend("t1", 3, 1)).toBe(true);
    expect(store.get("t1")).toMatchObject({ actionsUsed: 5, stepsUsed: 2 });
  });

  it("reports failure for an unknown task so callers fail closed", () => {
    expect(store.spend("nope", 1, 1)).toBe(false);
  });
});

describe("complete", () => {
  it("marks the task complete and records the outcome", () => {
    store.create("t1", "g", {}, 1);
    expect(store.complete("t1", true, "found it", 500)).toBe(true);
    expect(store.get("t1")).toMatchObject({
      status: "complete",
      success: true,
      summary: "found it",
      completedAt: 500,
    });
  });

  it("records a failure as false, not null", () => {
    store.create("t1", "g");
    store.complete("t1", false, "gave up");
    expect(store.get("t1")?.success).toBe(false);
  });

  it("refuses to complete an already complete task", () => {
    store.create("t1", "g");
    store.complete("t1", true, "done");
    expect(store.complete("t1", true, "again")).toBe(false);
  });

  it("reports failure for an unknown task", () => {
    expect(store.complete("nope", true, "s")).toBe(false);
  });
});

describe("allowedDomains", () => {
  it("round-trips a list", () => {
    store.create("t1", "g", { allowedDomains: ["example.com", "docs.example.com"] });
    expect(store.allowedDomains("t1")).toEqual(["example.com", "docs.example.com"]);
  });

  it("defaults to empty, meaning unrestricted", () => {
    store.create("t1", "g");
    expect(store.allowedDomains("t1")).toEqual([]);
  });

  it("returns empty for an unknown task rather than throwing", () => {
    expect(store.allowedDomains("nope")).toEqual([]);
  });

  it("returns undefined when the stored json is corrupt, instead of throwing", () => {
    store.create("t1", "g", { allowedDomains: ["example.com"] });

    // Corrupt the column behind the store's back, the way a bad migration or a
    // truncated write would. A malformed column must not crash the relay.
    const db = new DatabaseSync(join(dir, "relay.db"));
    db.exec("UPDATE tasks SET allowed = '{not json' WHERE id = 't1'");
    db.close();

    expect(store.allowedDomains("t1")).toBeUndefined();
  });

  it("returns undefined for non-string entries in the allowlist", () => {
    store.create("t1", "g", { allowedDomains: ["example.com"] });
    const db = new DatabaseSync(join(dir, "relay.db"));
    db.exec(`UPDATE tasks SET allowed = '["example.com", 42, null]' WHERE id = 't1'`);
    db.close();

    expect(store.allowedDomains("t1")).toBeUndefined();
  });
});

describe("persistence", () => {
  it("survives a reopen, so resume_task works after a restart", () => {
    store.create("t1", "survive me", { maxActions: 7 }, 1);
    store.spend("t1", 3, 1);
    store.close();

    store = new TaskStore(join(dir, "relay.db"));
    expect(store.get("t1")).toMatchObject({
      goal: "survive me",
      actionsUsed: 3,
      maxActions: 7,
    });
  });

  it("lists tasks newest first", () => {
    store.create("t1", "g", {}, 1);
    store.create("t2", "g", {}, 2);
    store.create("t3", "g", {}, 3);
    expect(store.list().map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
  });
});
