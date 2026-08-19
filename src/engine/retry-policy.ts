export interface RetryPolicyConfig {
  maxAttemptsPerStep: number;
  /** Presupuesto TOTAL de aperturas reales de un contacto, incluso a través de Resume. */
  maxOpenConversationAttempts?: number;
  backoff: {
    initialDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
  };
  timeouts: {
    openConversationMs: number;
    imageLoadMs: number;
    previewMs: number;
    confirmationMs: number;
    composerMs: number;
    reconciliationMs: number;
  };
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttemptsPerStep: 3,
  maxOpenConversationAttempts: 2,
  backoff: {
    initialDelayMs: 750,
    multiplier: 1.8,
    maxDelayMs: 4_000
  },
  timeouts: {
    openConversationMs: 40_000,
    imageLoadMs: 15_000,
    previewMs: 20_000,
    confirmationMs: 30_000,
    composerMs: 10_000,
    reconciliationMs: 6_000
  }
};

export function retryDelayMs(attempt: number, policy: RetryPolicyConfig = DEFAULT_RETRY_POLICY): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    policy.backoff.maxDelayMs,
    Math.round(policy.backoff.initialDelayMs * policy.backoff.multiplier ** exponent)
  );
}
