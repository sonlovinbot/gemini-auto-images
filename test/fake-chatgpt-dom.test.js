import assert from "node:assert/strict";
import test from "node:test";
import {
  geminiImageIdentity,
  selectNewImage,
} from "../src/result-detection.js";

test("fake Gemini DOM never returns a baseline image", () => {
  const baseline = ["https://gemini.test/old.png"];
  const fakeDomImages = [
    { src: "https://gemini.test/old.png", width: 2048, height: 2048 },
    { src: "https://gemini.test/new.png", width: 1024, height: 1024 }
  ];
  assert.equal(selectNewImage(baseline, fakeDomImages)?.src, "https://gemini.test/new.png");
});

test("chooses the highest resolution new image candidate", () => {
  const selected = selectNewImage([], [
    { src: "thumbnail", width: 512, height: 512 },
    { src: "original", width: 2048, height: 2048 }
  ]);
  assert.equal(selected?.src, "original");
});

test("returns no result when the fake DOM contains only old images", () => {
  assert.equal(selectNewImage(["old"], [{ src: "old", width: 1024, height: 1024 }]), null);
});

test("normalizes Gemini image URLs before baseline comparison", () => {
  const old = "https://lh3.googleusercontent.com/generated-image";
  const refreshed = "https://lh3.googleusercontent.com/generated-image";
  assert.equal(geminiImageIdentity(old), old);
  assert.equal(geminiImageIdentity(refreshed), old);
  assert.equal(
    selectNewImage([old], [
      {
        src: refreshed,
        width: 941,
        height: 1672,
        turnId: "conversation-turn-10",
      },
    ]),
    null,
  );
});

test("rejects images from assistant turns that existed before submission", () => {
  const selected = selectNewImage(
    [],
    [
      {
        src: "https://gemini.test/wrong.png",
        width: 2048,
        height: 2048,
        turnId: "conversation-turn-10",
        turnIndex: 10,
      },
      {
        src: "https://gemini.test/right.png",
        width: 1024,
        height: 1792,
        turnId: "conversation-turn-12",
        turnIndex: 12,
      },
    ],
    { baselineTurnIds: ["conversation-turn-10"] },
  );
  assert.equal(selected?.src, "https://gemini.test/right.png");
});
