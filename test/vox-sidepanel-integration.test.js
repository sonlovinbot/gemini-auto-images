import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const background = fs.readFileSync(
  new URL("../background.js", import.meta.url),
  "utf8",
);
const panel = fs.readFileSync(
  new URL("../sidepanel/sidepanel.js", import.meta.url),
  "utf8",
);
const bridge = fs.readFileSync(
  new URL("../content/vox-bridge.js", import.meta.url),
  "utf8",
);

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Missing start marker: ${start}`);
  assert.ok(to > from, `Missing end marker: ${end}`);
  return source.slice(from, to);
}

test("routes VOX START_BATCH to the proven side-panel executor only", () => {
  const startCase = between(
    background,
    'case "START_BATCH":',
    'case "PAUSE":',
  );
  assert.match(startCase, /executorMode: "sidepanel"/);
  assert.match(startCase, /VOX_BATCH_AVAILABLE/);
  assert.match(startCase, /ensureGeminiTab/);
  assert.doesNotMatch(startCase, /scheduleRun\(/);
  assert.doesNotMatch(startCase, /recover\(/);
  assert.ok(
    startCase.indexOf("chrome.sidePanel") <
      startCase.indexOf("await saveSettings"),
  );
  assert.match(startCase, /Boolean\(current\.voxOpenNewChat\)/);
});

test("answers a read-only extension check before VOX creates a batch", () => {
  assert.match(bridge, /"CHECK_EXTENSION"/);
  assert.match(bridge, /"CHECK_EXTENSION_RESULT"/);
  assert.match(bridge, /connectionMode: "local-development"/);
  assert.match(bridge, /runtime\.getManifest\(\)\.version/);
  assert.match(bridge, /EXTENSION_CONTEXT_INVALIDATED/);
  assert.match(bridge, /event\.stopImmediatePropagation\(\)/);
  assert.match(bridge, /window\.addEventListener\("message", listener, true\)/);
  assert.match(bridge, /"OPEN_CHATGPT_EXTENSION"/);
  assert.match(bridge, /type: "OPEN_SIDE_PANEL"/);
});

test("re-injects the VOX bridge after an unpacked extension reload", () => {
  assert.match(background, /async function injectVoxBridgeIntoOpenTabs/);
  assert.match(background, /files: \["content\/vox-bridge\.js"\]/);
  assert.match(background, /void injectVoxBridgeIntoOpenTabs\(\)/);
  assert.match(bridge, /previousBridge\?\.listener/);
  assert.match(bridge, /removeEventListener\("message", previousBridge\.listener, true\)/);
});

test("imports each remote task once and preserves VOX reference and task order", () => {
  const intake = between(
    panel,
    "async function importVoxBatch",
    "async function claimVoxQueueItem",
  );
  assert.match(intake, /existingTaskIds/);
  assert.match(intake, /existingTaskIds\.has\(task\.taskId\)/);
  assert.match(intake, /\[\.\.\.task\.references\]\.sort/);
  assert.match(intake, /voxIntegration\(batch, task, index\)/);
  assert.match(intake, /referenceMode: references\.length \? "vox-ordered" : "none"/);
});

test("requeues a failed local item when VOX still has no completed result", () => {
  const intake = between(
    panel,
    "async function importVoxBatch",
    "async function claimVoxQueueItem",
  );
  assert.match(intake, /const existingItem = queue\.find/);
  assert.match(intake, /!\["completed", "canceled"\]\.includes\(task\.state\)/);
  assert.match(intake, /\["failed", "canceled"\]\.includes\(existingItem\.status\)/);
  assert.match(intake, /existingItem\.status = "queued"/);
  assert.match(intake, /firstResumedGeneration\.requiresFreshChat = true/);
  assert.match(intake, /existingItem\.integration =/);
  assert.match(intake, /claimed: false/);
  assert.match(intake, /resumedItems\.push\(existingItem\)/);
});

test("every explicit retry opens a fresh Gemini tab before submission", () => {
  const execute = between(
    panel,
    "async function executeQueueItem",
    "async function runQueue",
  );
  assert.match(execute, /if \(item\.requiresFreshChat\)/);
  assert.match(execute, /sendBackground\("OPEN_FRESH_GEMINI"/);
  assert.match(execute, /retry_new_chat_opened/);
  assert.ok(
    execute.indexOf('sendBackground("OPEN_FRESH_GEMINI"') <
      execute.indexOf("submitGeminiTask("),
  );
  assert.match(panel, /requiresFreshChat: true/);
  assert.match(panel, /resume: null/);
});

test("supports VOX manual intake without auto-running the queue", () => {
  const intake = between(
    panel,
    "async function importVoxBatch",
    "async function claimVoxQueueItem",
  );
  assert.match(intake, /executionMode === "manual"/);
  assert.match(intake, /line\.integration = integration/);
  assert.match(intake, /activateTab\("create"\)/);
  assert.match(intake, /executionMode !== "manual" && run/);
  assert.match(panel, /row\.line\.integration/);
});

test("resets only the previous VOX workspace when a new batch arrives", () => {
  assert.match(panel, /async function resetVoxWorkspaceForBatch/);
  assert.match(panel, /clearItems\(\(item\) => isVoxQueueItem\(item\)\)/);
  assert.match(panel, /await clearPromptDraft\(\)/);
  assert.match(panel, /VOX_WORKSPACE_BUSY/);
});

test("materializes VOX references in IndexedDB before messaging the side panel", () => {
  const prepare = between(
    background,
    "async function prepareVoxBatchForPanel",
    "async function saveManualState",
  );
  assert.match(prepare, /await fetch\(url, \{ credentials: "include" \}\)/);
  assert.match(prepare, /kind: "vox-reference"/);
  assert.match(prepare, /blobId,/);
  assert.match(prepare, /await deleteBlob\(blobId\)/);

  const intake = between(
    panel,
    "async function importVoxBatch",
    "async function claimVoxQueueItem",
  );
  assert.match(intake, /knownTaskIds: \[\.\.\.existingTaskIds\]/);
  assert.match(intake, /if \(!reference\.blobId\)/);
  assert.doesNotMatch(intake, /fetch\(reference\.url/);
});

test("claims the exact queue task before touching Gemini", () => {
  const execute = between(
    panel,
    "async function executeQueueItem",
    "async function runQueue",
  );
  assert.ok(
    execute.indexOf("await claimVoxQueueItem(item)") <
      execute.indexOf("getSelectorConfig()"),
  );
  assert.match(panel, /VOX_CLAIM_ORDER_MISMATCH/);
  assert.match(panel, /expectedTaskId/);
  assert.match(panel, /claimedTaskId/);
});

test("waits for a stale VOX lease instead of failing an empty claim immediately", () => {
  const claim = between(
    panel,
    "async function claimVoxQueueItem",
    "function voxTaskPayload",
  );
  assert.match(background, /case "GET_VOX_BATCH_STATUS":/);
  assert.match(claim, /GET_VOX_BATCH_STATUS/);
  assert.match(claim, /VOX_CLAIM_LEASE_ACTIVE/);
  assert.match(claim, /await waitPausable\(boundedWaitMs\)/);
  assert.ok(
    claim.indexOf("VOX_CLAIM_LEASE_ACTIVE") <
      claim.indexOf('code: "VOX_CLAIM_EMPTY"'),
  );
});

test("persists generated bytes before returning them and completes only after VOX confirms save", () => {
  const execute = between(
    panel,
    "async function executeQueueItem",
    "async function runQueue",
  );
  assert.ok(
    execute.indexOf("pendingVoxResult: {") <
      execute.lastIndexOf("completeVoxResultReturn(item)"),
  );
  const complete = between(
    panel,
    "async function completeVoxResultReturn",
    "async function executeQueueItem",
  );
  assert.ok(
    complete.indexOf('"VOX_TASK_RESULT"') <
      complete.indexOf('status: "completed"'),
  );
  assert.match(complete, /if \(!confirmation\?\.saved\)/);
  assert.match(complete, /RESULT_SAVE_UNCONFIRMED/);
});

test("retries pending VOX result bytes without submitting another prompt", () => {
  const execute = between(
    panel,
    "async function executeQueueItem",
    "async function runQueue",
  );
  assert.ok(
    execute.indexOf('"vox_result_retry"') <
      execute.indexOf("submitGeminiTask("),
  );
  const failure = between(
    panel,
    "async function reportVoxFailure",
    "function scheduleSessionSave",
  );
  assert.match(failure, /item\.pendingVoxResult\?\.blobId/);
  assert.match(failure, /không đánh dấu remote task failed/);
});

test("renews VOX waiting progress while the Gemini scanner is active", () => {
  assert.match(panel, /scanCount % 30 === 0/);
  assert.match(panel, /reportVoxProgress\(\s*item,\s*"waiting"/);
  assert.match(panel, /VOX_PROGRESS_DEFERRED/);
});
