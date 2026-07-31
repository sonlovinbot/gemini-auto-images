import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATES } from "../src/constants.js";
import { canTransition, nextRecoveryAction, transition } from "../src/state-machine.js";

test("allows the sequential happy path", () => {
  const path = [
    TASK_STATES.CLAIMING,
    TASK_STATES.UPLOADING,
    TASK_STATES.SUBMITTING,
    TASK_STATES.WAITING,
    TASK_STATES.COLLECTING,
    TASK_STATES.RETURNING,
    TASK_STATES.COMPLETED
  ];
  let checkpoint = { state: TASK_STATES.QUEUED };
  for (const state of path) checkpoint = transition(checkpoint, state);
  assert.equal(checkpoint.state, TASK_STATES.COMPLETED);
});

test("never transitions from waiting directly to completed", () => {
  assert.equal(canTransition(TASK_STATES.WAITING, TASK_STATES.COMPLETED), false);
  assert.throws(() => transition({ state: TASK_STATES.WAITING }, TASK_STATES.COMPLETED));
});

test("submission recovery inspects before repeating", () => {
  assert.equal(nextRecoveryAction({ state: TASK_STATES.SUBMITTING }), "inspect_submission");
});
