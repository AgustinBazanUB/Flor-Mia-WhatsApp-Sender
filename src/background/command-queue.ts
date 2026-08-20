import { recordCommandDuration, recordQueueDepth } from "../performance/runtime-metrics";

export type CommandPriority = "critical" | "pause" | "status" | "normal" | "diagnostic";

const PRIORITY_WEIGHT: Record<CommandPriority, number> = {
  critical: 500,
  pause: 400,
  status: 300,
  normal: 200,
  diagnostic: 100
};

interface PendingCommand<T> {
  sequence: number;
  priority: CommandPriority;
  label: string;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface CommandQueueSnapshot {
  depth: number;
  running: boolean;
  runningLabel: string | null;
  runningPriority: CommandPriority | null;
}

export class AsyncCommandQueue {
  private pending: Array<PendingCommand<unknown>> = [];
  private running = false;
  private runningLabel: string | null = null;
  private runningPriority: CommandPriority | null = null;
  private sequence = 0;

  run<T>(
    operation: () => Promise<T>,
    options: { priority?: CommandPriority; label?: string } = {}
  ): Promise<T> {
    const priority = options.priority ?? "normal";
    const label = options.label ?? "command";
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({
        sequence: this.sequence++,
        priority,
        label,
        operation,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.pending.sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || a.sequence - b.sequence);
      recordQueueDepth(this.pending.length + (this.running ? 1 : 0));
      void this.pump();
    });
    return result;
  }

  snapshot(): CommandQueueSnapshot {
    return {
      depth: this.pending.length + (this.running ? 1 : 0),
      running: this.running,
      runningLabel: this.runningLabel,
      runningPriority: this.runningPriority
    };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) {
      recordQueueDepth(0);
      return;
    }
    this.running = true;
    this.runningLabel = next.label;
    this.runningPriority = next.priority;
    recordQueueDepth(this.pending.length + 1);
    const started = performance.now();
    try {
      next.resolve(await next.operation());
    } catch (error) {
      next.reject(error);
    } finally {
      recordCommandDuration(performance.now() - started);
      this.running = false;
      this.runningLabel = null;
      this.runningPriority = null;
      recordQueueDepth(this.pending.length);
      void this.pump();
    }
  }
}
