import { TASK_STATES } from "./constants.js";

const transitions = new Map([
  [TASK_STATES.QUEUED, [TASK_STATES.CLAIMING, TASK_STATES.CANCELED]],
  [TASK_STATES.CLAIMING, [TASK_STATES.UPLOADING, TASK_STATES.FAILED, TASK_STATES.PAUSED, TASK_STATES.CANCELED]],
  [TASK_STATES.UPLOADING, [TASK_STATES.SUBMITTING, TASK_STATES.FAILED, TASK_STATES.PAUSED, TASK_STATES.CANCELED]],
  [TASK_STATES.SUBMITTING, [TASK_STATES.WAITING, TASK_STATES.FAILED]],
  [TASK_STATES.WAITING, [TASK_STATES.COLLECTING, TASK_STATES.FAILED, TASK_STATES.PAUSED, TASK_STATES.CANCELED]],
  [TASK_STATES.COLLECTING, [TASK_STATES.RETURNING, TASK_STATES.FAILED]],
  [TASK_STATES.RETURNING, [TASK_STATES.COMPLETED, TASK_STATES.FAILED]],
  [TASK_STATES.PAUSED, [TASK_STATES.CLAIMING, TASK_STATES.UPLOADING, TASK_STATES.WAITING, TASK_STATES.CANCELED]],
  [TASK_STATES.FAILED, [TASK_STATES.CLAIMING, TASK_STATES.CANCELED]],
  [TASK_STATES.COMPLETED, []],
  [TASK_STATES.CANCELED, []]
]);

export function canTransition(from, to) {
  return transitions.get(from)?.includes(to) ?? false;
}

export function transition(checkpoint, to, patch = {}) {
  if (!canTransition(checkpoint.state, to)) {
    throw new Error(`Invalid task transition: ${checkpoint.state} -> ${to}`);
  }
  return {
    ...checkpoint,
    ...patch,
    state: to,
    updatedAt: new Date().toISOString()
  };
}

export function isTerminal(state) {
  return state === TASK_STATES.COMPLETED || state === TASK_STATES.CANCELED;
}

export function nextRecoveryAction(checkpoint) {
  switch (checkpoint?.state) {
    case TASK_STATES.SUBMITTING:
      return "inspect_submission";
    case TASK_STATES.WAITING:
      return "observe_result";
    case TASK_STATES.COLLECTING:
      return "collect_result";
    case TASK_STATES.RETURNING:
      return "retry_result_delivery";
    case TASK_STATES.CLAIMING:
    case TASK_STATES.UPLOADING:
      return "reconcile_then_continue";
    default:
      return "reconcile";
  }
}
