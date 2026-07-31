import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../content/vox-bridge.js", import.meta.url),
  "utf8",
);

function createBridge(runtime) {
  const listeners = [];
  const posted = [];
  const removed = [];
  const location = {
    protocol: "http:",
    hostname: "localhost",
    origin: "http://localhost:4173",
  };
  const window = {
    addEventListener(type, listener, capture) {
      listeners.push({ type, listener, capture });
    },
    removeEventListener(type, listener, capture) {
      removed.push({ type, listener, capture });
    },
    postMessage(message, origin) {
      posted.push({ message, origin });
    },
  };
  const context = vm.createContext({
    chrome: runtime === undefined ? {} : { runtime },
    location,
    window,
  });
  vm.runInContext(source, context);
  return {
    context,
    listeners,
    location,
    posted,
    removed,
    window,
  };
}

async function request(bridge, type, requestId = "request-1") {
  const entry = bridge.listeners.at(-1);
  assert.equal(entry?.capture, true);
  let stopped = false;
  await entry.listener({
    source: bridge.window,
    origin: bridge.location.origin,
    data: {
      source: "vox-style-video",
      protocol: "vox-chatgpt/1",
      type,
      requestId,
    },
    stopImmediatePropagation() {
      stopped = true;
    },
  });
  return {
    stopped,
    response: bridge.posted.at(-1)?.message,
  };
}

test("stale VOX bridge reports an invalidated extension context without throwing", async () => {
  const bridge = createBridge(undefined);
  const result = await request(bridge, "CHECK_EXTENSION");
  assert.equal(result.stopped, true);
  assert.equal(result.response.type, "CHECK_EXTENSION_RESULT");
  assert.equal(result.response.ok, false);
  assert.equal(result.response.code, "EXTENSION_CONTEXT_INVALIDATED");
});

test("current VOX bridge returns its loaded extension version", async () => {
  const bridge = createBridge({
    id: "extension-id",
    getManifest: () => ({ version: "0.6.1" }),
    sendMessage: async () => ({ ok: true }),
  });
  const result = await request(bridge, "CHECK_EXTENSION");
  assert.equal(result.response.ok, true);
  assert.equal(result.response.data.extensionVersion, "0.6.1");
});

test("re-injection removes the previous capture listener", () => {
  const bridge = createBridge({
    id: "extension-id",
    getManifest: () => ({ version: "0.6.1" }),
    sendMessage: async () => ({ ok: true }),
  });
  vm.runInContext(source, bridge.context);
  assert.equal(bridge.removed.length, 1);
  assert.equal(bridge.removed[0].capture, true);
  assert.equal(bridge.listeners.length, 2);
});
