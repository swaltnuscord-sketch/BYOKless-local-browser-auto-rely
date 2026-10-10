import { z } from "zod";

/**
 * Task budgets and limits.
 *
 * The relay owns every ceiling. The model may propose a lower limit but never
 * raise one above these ceilings, so a misbehaving or injected instruction
 * cannot talk the relay into an unbounded loop.
 */

export const DEFAULT_MAX_ACTIONS = 200;
export const DEFAULT_MAX_STEPS = 200;

/** Hard ceilings. A start_task request above these is rejected, not clamped. */
export const HARD_MAX_ACTIONS = 1_000;
export const HARD_MAX_STEPS = 1_000;

/** Per-action settle deadline bounds. */
export const MIN_ACTION_DEADLINE_MS = 250;
export const MAX_ACTION_DEADLINE_MS = 45_000;
export const DEFAULT_ACTION_DEADLINE_MS = 25_000;

/** A single action may not spend more than this share of the action budget. */
export const MAX_BATCH_ACTIONS = 50;

export const TaskLimitsSchema = z.strictObject({
  maxActions: z.number().int().positive().max(HARD_MAX_ACTIONS).default(DEFAULT_MAX_ACTIONS),
  maxSteps: z.number().int().positive().max(HARD_MAX_STEPS).default(DEFAULT_MAX_STEPS),
  allowedDomains: z.array(z.string().min(1).max(253)).max(50).default([]),
});
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;

export const DEFAULT_TASK_LIMITS: TaskLimits = TaskLimitsSchema.parse({});

export interface TaskUsage {
  readonly actionsUsed: number;
  readonly stepsUsed: number;
}

export type BudgetDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "BUDGET_EXCEEDED" | "STEP_LIMIT_EXCEEDED" | "INTERNAL";
      readonly used: number;
      readonly limit: number;
    };

/**
 * Decide whether one more step and `actionCount` more actions are affordable.
 *
 * Checked before dispatch, not after: an over-budget action must never reach
 * the browser, because there is no undo for a click that has already fired.
 */
export function checkBudget(usage: TaskUsage, limits: TaskLimits, actionCount = 1): BudgetDecision {
  // Fail closed on a corrupt counter. A negative count would otherwise hand
  // out an effectively unbounded budget, and a fractional one would let
  // 0.5 spent slip past a limit of 0. A counter we cannot trust means we
  // refuse the action, not that we reset it.
  if (
    !Number.isInteger(usage.actionsUsed) ||
    !Number.isInteger(usage.stepsUsed) ||
    !Number.isInteger(actionCount) ||
    usage.actionsUsed < 0 ||
    usage.stepsUsed < 0 ||
    actionCount < 0
  ) {
    return {
      ok: false,
      code: "INTERNAL",
      used: 0,
      limit: limits.maxActions,
    };
  }

  if (usage.actionsUsed + actionCount > limits.maxActions) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      used: usage.actionsUsed,
      limit: limits.maxActions,
    };
  }
  if (usage.stepsUsed + 1 > limits.maxSteps) {
    return {
      ok: false,
      code: "STEP_LIMIT_EXCEEDED",
      used: usage.stepsUsed,
      limit: limits.maxSteps,
    };
  }
  return { ok: true };
}

/** Resolve the limits for a new task, rejecting requests above the ceiling. */
export function resolveTaskLimits(requested: Partial<TaskLimits> = {}): TaskLimits {
  return TaskLimitsSchema.parse(requested);
}

export interface DomainDecision {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Domain allowlist check.
 *
 * An empty allowlist denies all navigation. A task that declares no scope gets no
 * reach: otherwise the "allowlist" is a display-only field and any model can steer a
 * logged-in profile wherever it likes. By default, domain matching requires an exact
 * hostname match: a subdomain does NOT inherit its parent's permission unless an explicit
 * wildcard pattern (e.g., `*.example.com`) is specified.
 * Extension-side policy engine enforcement gates CDP navigation in session.ts.
 */
export function isDomainAllowed(url: string, allowedDomains: readonly string[]): DomainDecision {
  if (allowedDomains.length === 0) {
    return {
      ok: false,
      reason: "this task declares no allowed domains; start a task with allowed_domains to browse",
    };
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "url could not be parsed" };
  }

  for (const raw of allowedDomains) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, "");
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (hostname === base || hostname.endsWith(`.${base}`)) {
        return { ok: true };
      }
    } else if (entry === hostname) {
      return { ok: true };
    }
  }
  return { ok: false, reason: `${hostname} is not in the task allowlist` };
}

/** Clamp a requested deadline into the enforced band. */
export function resolveDeadline(requested?: number): number {
  if (requested === undefined) return DEFAULT_ACTION_DEADLINE_MS;
  return Math.min(MAX_ACTION_DEADLINE_MS, Math.max(MIN_ACTION_DEADLINE_MS, Math.trunc(requested)));
}
