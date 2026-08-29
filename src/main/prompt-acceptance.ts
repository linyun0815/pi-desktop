/**
 * Exactly-one-completion bookkeeping for the worker's deferred `prompt`
 * command. `session.prompt` is fired without awaiting: acceptance arrives via
 * the SDK's preflight hook (true = queued, false = rejected before start),
 * and a failure can surface asynchronously after the call. Whichever ending
 * happens first answers the correlated request exactly once; later ones are
 * ignored, so a rejected prompt can never double-answer and an accepted one
 * can never be retroactively failed on the wire.
 */
export type PromptOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; error: string }

export interface DeferredPrompt {
  /** Passed to session.prompt as `preflightResult`. */
  preflightResult: (success: boolean) => void
  /** Attached as the catch handler of the session.prompt promise. */
  onAsyncFailure: (error: unknown) => void
  isSettled(): boolean
}

export function createDeferredPrompt(
  answer: (outcome: PromptOutcome) => void,
): DeferredPrompt {
  let settled = false;
  const settle = (outcome: PromptOutcome): void => {
    if (settled) return;
    settled = true;
    answer(outcome);
  };
  return {
    preflightResult: (success) =>
      settle(
        success
          ? { kind: "accepted" }
          : {
              kind: "rejected",
              error: "Pi 拒绝了这条消息，未能开始处理。",
            },
      ),
    onAsyncFailure: (error) =>
      settle({
        kind: "rejected",
        error: error instanceof Error ? error.message : String(error),
      }),
    isSettled: () => settled,
  };
}
