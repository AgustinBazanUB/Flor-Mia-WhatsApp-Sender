import type {
  ContactAdapter,
  ContactStep,
  StepExecutionContext,
  StepExecutionResult,
  StepReconciliationResult
} from "./types";

export class StepExecutor {
  constructor(private readonly adapter: ContactAdapter) {}

  execute(step: ContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    return step.kind === "image"
      ? this.adapter.sendImage(step, context)
      : this.adapter.sendText(step, context);
  }

  reconcile(step: ContactStep, context: StepExecutionContext): Promise<StepReconciliationResult> {
    return this.adapter.reconcile(step, context);
  }
}
