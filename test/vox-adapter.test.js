import assert from "node:assert/strict";
import test from "node:test";
import { VoxAdapter } from "../src/vox-adapter.js";

test("uses the voxBaseUrl key stored by extension settings", () => {
  const adapter = new VoxAdapter({
    voxBaseUrl: "http://127.0.0.1:4174/",
    apiToken: "",
  });
  assert.equal(adapter.baseUrl, "http://127.0.0.1:4174");
});

test("keeps baseUrl compatibility for application adapters", () => {
  const adapter = new VoxAdapter({ baseUrl: "http://localhost:4174" });
  assert.equal(adapter.baseUrl, "http://localhost:4174");
});

test("fails with a useful error when no VOX URL is configured", () => {
  assert.throws(
    () => new VoxAdapter({}),
    /VOX API URL is not configured/,
  );
});
