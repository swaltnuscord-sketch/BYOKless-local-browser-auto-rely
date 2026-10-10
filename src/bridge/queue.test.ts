import { describe, expect, it } from "vitest";
import { TabQueue } from "./queue.js";

describe("TabQueue", () => {
  it("serializes calls for the same tab in arrival order", async () => {
    const queue = new TabQueue();
    const log: number[] = [];

    const p1 = queue.enqueue(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push(1);
    });

    const p2 = queue.enqueue(1, async () => {
      log.push(2);
    });

    await Promise.all([p1, p2]);
    expect(log).toEqual([1, 2]);
  });

  it("does not block execution for different tabs", async () => {
    const queue = new TabQueue();
    const log: number[] = [];

    const p1 = queue.enqueue(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push(1);
    });

    const p2 = queue.enqueue(2, async () => {
      log.push(2);
    });

    await Promise.all([p1, p2]);
    // Task 2 finishes before Task 1 because they are on different tabs
    expect(log).toEqual([2, 1]);
  });

  it("continues processing even if a previous task failed", async () => {
    const queue = new TabQueue();
    const log: number[] = [];

    const p1 = queue.enqueue(1, async () => {
      throw new Error("fail");
    });

    const p2 = queue.enqueue(1, async () => {
      log.push(2);
    });

    await expect(p1).rejects.toThrow("fail");
    await p2;
    expect(log).toEqual([2]);
  });
});
