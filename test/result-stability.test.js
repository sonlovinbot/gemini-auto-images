import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceScanStagnation,
  advanceCandidateStability,
  candidateFingerprint,
} from "../src/result-stability.js";

const candidate = {
  src: "https://chatgpt.com/image",
  imageKey: "chatgpt-file:new",
  turnId: "conversation-turn-6",
  width: 941,
  height: 1672,
  ready: true,
};

test("accepts a ready candidate after five stable scans while Stop remains visible", () => {
  let state = { key: "", count: 0 };
  for (let index = 0; index < 4; index += 1) {
    state = advanceCandidateStability(state, {
      candidate,
      generating: true,
    });
    assert.equal(state.candidate, null);
  }
  state = advanceCandidateStability(state, { candidate, generating: true });
  assert.equal(state.candidate, candidate);
  assert.equal(state.required, 5);
});

test("accepts a ready candidate after two stable scans once generation is idle", () => {
  let state = advanceCandidateStability(
    { key: "", count: 0 },
    { candidate, generating: false },
  );
  assert.equal(state.candidate, null);
  state = advanceCandidateStability(state, { candidate, generating: false });
  assert.equal(state.candidate, candidate);
  assert.equal(state.required, 2);
});

test("resets stability when image dimensions change", () => {
  const first = advanceCandidateStability(
    { key: "", count: 0 },
    { candidate, generating: true },
  );
  const changed = {
    ...candidate,
    width: 1024,
  };
  const second = advanceCandidateStability(first, {
    candidate: changed,
    generating: true,
  });
  assert.equal(first.count, 1);
  assert.equal(second.count, 1);
  assert.notEqual(candidateFingerprint(candidate), candidateFingerprint(changed));
});

test("never accepts an incomplete candidate", () => {
  let state = { key: "", count: 0 };
  const incomplete = { ...candidate, ready: false };
  for (let index = 0; index < 10; index += 1) {
    state = advanceCandidateStability(state, {
      candidate: incomplete,
      generating: false,
    });
  }
  assert.equal(state.count, 0);
  assert.equal(state.candidate, null);
});

test("counts unchanged scanner snapshots and resets when the DOM changes", () => {
  const scan = {
    candidate: null,
    candidateCount: 0,
    turnCount: 8,
    generating: true,
  };
  const first = advanceScanStagnation(
    { fingerprint: "", count: 0 },
    scan,
  );
  const second = advanceScanStagnation(first, scan);
  const changed = advanceScanStagnation(second, {
    ...scan,
    turnCount: 9,
  });
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(changed.count, 1);
});
