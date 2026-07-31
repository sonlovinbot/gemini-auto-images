import { PROTOCOL } from "./constants.js";

export function validateBatch(batch) {
  const errors = [];
  if (!batch || typeof batch !== "object") errors.push("batch must be an object");
  if (batch?.protocol !== PROTOCOL) errors.push(`protocol must be ${PROTOCOL}`);
  for (const key of ["batchId", "projectId"]) {
    if (typeof batch?.[key] !== "string" || !batch[key]) errors.push(`${key} is required`);
  }
  if (!Array.isArray(batch?.tasks)) errors.push("tasks must be an array");
  batch?.tasks?.forEach((task, index) => {
    for (const key of ["taskId", "beatId", "prompt"]) {
      if (typeof task?.[key] !== "string" || !task[key]) errors.push(`tasks[${index}].${key} is required`);
    }
    if (!Array.isArray(task?.references)) errors.push(`tasks[${index}].references must be an array`);
  });
  return { valid: errors.length === 0, errors };
}

export function normalizeTask(batch, task) {
  return {
    ...task,
    protocol: PROTOCOL,
    batchId: batch.batchId,
    projectId: batch.projectId,
    attempt: Number.isInteger(task.attempt) ? task.attempt : 1,
    references: task.references.map((reference, order) => ({ ...reference, order }))
  };
}
