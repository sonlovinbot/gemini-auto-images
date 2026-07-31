import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL } from "../src/constants.js";
import { normalizeTask, validateBatch } from "../src/protocol.js";

const batch = {
  protocol: PROTOCOL,
  batchId: "batch-1",
  projectId: "project-1",
  tasks: [{
    taskId: "task-1",
    beatId: "beat-1",
    prompt: "A self-contained prompt",
    references: [{ id: "b" }, { id: "a" }]
  }]
};

test("accepts a valid vox-chatgpt/1 batch", () => {
  assert.deepEqual(validateBatch(batch), { valid: true, errors: [] });
});

test("rejects an incompatible protocol", () => {
  const result = validateBatch({ ...batch, protocol: "vox-chatgpt/2" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /vox-chatgpt\/1/);
});

test("normalizes reference order without mutating identity", () => {
  const task = normalizeTask(batch, batch.tasks[0]);
  assert.deepEqual(task.references.map(({ id, order }) => ({ id, order })), [
    { id: "b", order: 0 },
    { id: "a", order: 1 }
  ]);
});
