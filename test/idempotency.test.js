import assert from "node:assert/strict";
import test from "node:test";
import { createIdempotencyKey, sha256 } from "../src/idempotency.js";

test("idempotency key is stable and attempt-specific", async () => {
  const input = { projectId: "p", beatId: "b", prompt: "hello", attempt: 1 };
  const first = await createIdempotencyKey(input);
  assert.equal(first, await createIdempotencyKey(input));
  assert.notEqual(first, await createIdempotencyKey({ ...input, attempt: 2 }));
});

test("hashes binary bytes rather than their object label", async () => {
  const bytes = Uint8Array.from([1, 2, 3]).buffer;
  assert.notEqual(await sha256(bytes), await sha256("[object ArrayBuffer]"));
});
