import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeferredPrompt, type PromptOutcome } from "./prompt-acceptance";

/**
 * The worker answers each prompt request exactly once: preflight accept,
 * preflight reject, or async throw — whichever lands first.
 */
function collect(): {
  outcomes: PromptOutcome[];
  deferred: ReturnType<typeof createDeferredPrompt>;
} {
  const outcomes: PromptOutcome[] = [];
  const deferred = createDeferredPrompt((outcome) => outcomes.push(outcome));
  return { outcomes, deferred };
}

test("preflight accept answers once and swallows a later async failure", () => {
  const { outcomes, deferred } = collect();
  deferred.preflightResult(true);
  deferred.onAsyncFailure(new Error("late boom"));
  deferred.preflightResult(false);

  assert.deepEqual(outcomes, [{ kind: "accepted" }]);
  assert.equal(deferred.isSettled(), true);
});

test("preflight reject answers once and swallows the SDK re-throw", () => {
  const { outcomes, deferred } = collect();
  deferred.preflightResult(false);
  deferred.onAsyncFailure(new Error("preflight boom"));

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.kind, "rejected");
  assert.ok(outcomes[0]!.error.length > 0);
  assert.equal(deferred.isSettled(), true);
});

test("an async throw without preflight answers exactly once", () => {
  const { outcomes, deferred } = collect();
  deferred.onAsyncFailure(new Error("no model"));
  deferred.onAsyncFailure(new Error("again"));
  deferred.preflightResult(true);

  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.error, "no model");
});

test("non-Error failures are stringified", () => {
  const { outcomes, deferred } = collect();
  deferred.onAsyncFailure("plain string failure");
  const outcome = outcomes[0]!;
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected")
    assert.equal(outcome.error, "plain string failure");
});
