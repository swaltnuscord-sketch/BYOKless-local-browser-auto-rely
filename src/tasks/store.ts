import { DatabaseSync } from "node:sqlite";

/**
 * Task persistence on node:sqlite.
 *
 * Tasks must survive a relay restart: a dropped connection mid-task should be
 * recoverable with resume_task, not lose the operator's budget and history.
 *
 * node:sqlite is used over a native dependency so the relay adds no compiled
 * third-party code to a process that can drive a real browser.
 */

export interface TaskRow {
  readonly id: string;
  readonly goal: string;
  readonly origin: "auto" | "explicit";
  readonly status: "active" | "complete";
  readonly success: boolean | null;
  readonly summary: string | null;
  readonly actionsUsed: number;
  readonly stepsUsed: number;
  readonly maxActions: number;
  readonly maxSteps: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export type TaskLimitsInput = {
  readonly maxActions?: number;
  readonly maxSteps?: number;
  readonly allowedDomains?: readonly string[];
};

export class TaskStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        goal          TEXT NOT NULL,
        origin        TEXT NOT NULL DEFAULT 'explicit' CHECK (origin IN ('auto', 'explicit')),
        status        TEXT NOT NULL CHECK (status IN ('active', 'complete')),
        success       INTEGER,
        summary       TEXT,
        actions_used  INTEGER NOT NULL DEFAULT 0,
        steps_used    INTEGER NOT NULL DEFAULT 0,
        max_actions   INTEGER NOT NULL,
        max_steps     INTEGER NOT NULL,
        allowed       TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        completed_at  INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT NOT NULL,
        tool          TEXT NOT NULL,
        target        TEXT,
        outcome       TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  create(
    id: string,
    goal: string,
    limits: TaskLimitsInput = {},
    now = Date.now(),
    origin: "auto" | "explicit" = "explicit",
  ): void {
    this.#db
      .prepare(
        `INSERT INTO tasks (id, goal, origin, status, max_actions, max_steps, allowed, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        goal,
        origin,
        limits.maxActions ?? 200,
        limits.maxSteps ?? 200,
        JSON.stringify(limits.allowedDomains ?? []),
        now,
      );
  }

  adopt(id: string, goal: string, limits: TaskLimitsInput = {}): boolean {
    const result = this.#db
      .prepare(
        "UPDATE tasks SET goal = ?, origin = 'explicit', max_actions = ?, max_steps = ?, allowed = ? WHERE id = ? AND status = 'active'",
      )
      .run(
        goal,
        limits.maxActions ?? 200,
        limits.maxSteps ?? 200,
        JSON.stringify(limits.allowedDomains ?? []),
        id,
      );
    return Number(result.changes) > 0;
  }

  get(id: string): TaskRow | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : undefined;
  }

  /** The single active task. The relay only ever drives one at a time. */
  active(): TaskRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
  }

  list(): TaskRow[] {
    const rows = this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Record<
      string,
      unknown
    >[];
    return rows.map(toRow);
  }

  /** Spend budget. Returns false when the row is gone, so callers fail closed. */
  spend(id: string, actions: number, steps: number): boolean {
    const result = this.#db
      .prepare(
        "UPDATE tasks SET actions_used = actions_used + ?, steps_used = steps_used + ? WHERE id = ?",
      )
      .run(actions, steps, id);
    return Number(result.changes) > 0;
  }

  complete(id: string, success: boolean, summary: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare(
        "UPDATE tasks SET status = 'complete', success = ?, summary = ?, completed_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(success ? 1 : 0, summary, now, id);
    return Number(result.changes) > 0;
  }

  allowedDomains(id: string): string[] | undefined {
    const row = this.#db.prepare("SELECT allowed FROM tasks WHERE id = ?").get(id) as
      | { allowed: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.allowed);
      if (!Array.isArray(parsed)) return undefined;
      for (const v of parsed) {
        if (typeof v !== "string") return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  audit(
    taskId: string,
    tool: string,
    target: string | null,
    outcome: string,
    timestamp = Date.now(),
  ): void {
    this.#db
      .prepare(
        "INSERT INTO audit_log (task_id, tool, target, outcome, timestamp) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, tool, target, outcome, timestamp);
  }
}

function toRow(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    goal: String(row.goal),
    origin: row.origin === "auto" ? "auto" : "explicit",
    status: row.status === "complete" ? "complete" : "active",
    success: row.success === null || row.success === undefined ? null : Boolean(row.success),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    actionsUsed: Number(row.actions_used),
    stepsUsed: Number(row.steps_used),
    maxActions: Number(row.max_actions),
    maxSteps: Number(row.max_steps),
    createdAt: Number(row.created_at),
    completedAt:
      row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  };
}
