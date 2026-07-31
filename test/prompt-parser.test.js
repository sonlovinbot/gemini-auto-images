import assert from "node:assert/strict";
import test from "node:test";
import {
  assignReferences,
  buildOutputName,
  parsePrompts,
} from "../src/prompt-parser.js";

test("splits multi-line prompt blocks on blank lines", () => {
  assert.deepEqual(
    parsePrompts("first line\ncontinues\n\nsecond prompt"),
    ["first line\ncontinues", "second prompt"],
  );
});

test("uses each non-empty line when no blank separator exists", () => {
  assert.deepEqual(parsePrompts("one\ntwo\nthree"), ["one", "two", "three"]);
});

test("builds deterministic indexed output names", () => {
  assert.equal(buildOutputName("portrait.png", 1, 4), "portrait-002.png");
});

test("preserves reference order in shared and matched modes", () => {
  const references = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(assignReferences(references, 1, "shared"), references);
  assert.deepEqual(assignReferences(references, 1, "matched"), [{ name: "b" }]);
});
