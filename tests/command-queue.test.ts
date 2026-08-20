import { describe, expect, it } from "vitest";
import { AsyncCommandQueue } from "../src/background/command-queue";

describe("AsyncCommandQueue", () => {
  it("serializes operations and continues after a rejection", async () => {
    const queue = new AsyncCommandQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      throw new Error("expected");
    });
    const second = queue.run(async () => { order.push("second"); return 2; });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs a pending Stop before an earlier normal command once the current mutation completes", async () => {
    const queue = new AsyncCommandQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = queue.run(async () => { order.push("running"); await gate; }, { priority: "normal", label: "running" });
    const resume = queue.run(async () => { order.push("resume"); }, { priority: "normal", label: "resume" });
    const stop = queue.run(async () => { order.push("stop"); }, { priority: "critical", label: "stop" });
    await Promise.resolve();
    release();
    await Promise.all([running, resume, stop]);
    expect(order).toEqual(["running", "stop", "resume"]);
  });

  it.each([
    ["Start", "Start"],
    ["Start", "Pause"],
    ["Pause", "Stop"],
    ["Resume", "Stop"],
    ["alarm", "Pause"],
    ["alarm", "Stop"],
    ["initialize", "initialize"]
  ])("serializes %s + %s with a maximum of one mutation in flight", async (firstName, secondName) => {
    const queue = new AsyncCommandQueue();
    let concurrent = 0;
    let maximum = 0;
    const order: string[] = [];
    const mutation = (name: string) => queue.run(async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
      concurrent -= 1;
    });
    await Promise.all([mutation(firstName), mutation(secondName)]);
    expect(maximum).toBe(1);
    expect(order).toEqual([`${firstName}:start`, `${firstName}:end`, `${secondName}:start`, `${secondName}:end`]);
  });
});
