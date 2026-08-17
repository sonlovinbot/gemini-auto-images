import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url)));
const executor = fs.readFileSync(
  new URL("../sidepanel/gemini-executor.js", import.meta.url),
  "utf8",
);
const panel = fs.readFileSync(
  new URL("../sidepanel/sidepanel.html", import.meta.url),
  "utf8",
);
const panelScript = fs.readFileSync(
  new URL("../sidepanel/sidepanel.js", import.meta.url),
  "utf8",
);
const background = fs.readFileSync(
  new URL("../background.js", import.meta.url),
  "utf8",
);
const selectors = JSON.parse(
  fs.readFileSync(
    new URL("../config/gemini-selectors.json", import.meta.url),
    "utf8",
  ),
);

test("uses MAIN-world scripting like the working reference executor", () => {
  assert.ok(manifest.permissions.includes("scripting"));
  assert.match(executor, /chrome\.scripting\.executeScript/);
  assert.match(executor, /world:\s*"MAIN"/);
});

test("records a baseline before dispatching the upload and prompt", () => {
  const baseline = executor.indexOf('record("baseline"');
  const mode = executor.indexOf('record("image-mode"');
  const upload = executor.indexOf('record("upload-dispatch"');
  const submit = executor.indexOf('record("submit-click"');
  assert.ok(baseline >= 0 && mode > baseline && upload > mode && submit > upload);
});

test("pastes each ordered reference and keeps Gemini drop as a fallback", () => {
  assert.equal(
    (executor.match(/new DragEvent\(eventType/g) || []).length,
    1,
  );
  assert.match(
    executor,
    /for \(let index = 0; index < task\.references\.length; index \+= 1\)/,
  );
  assert.match(executor, /const reference = task\.references\[index\]/);
  assert.match(executor, /document\.querySelector\(selectors\.fileDropZone\)/);
  assert.match(executor, /\["dragenter", "dragover", "drop", "dragleave"\]/);
  assert.match(executor, /dataTransfer: transfer/);
  assert.match(executor, /new ClipboardEvent\("paste"/);
  assert.match(executor, /let uploadMethod = "paste"/);
  assert.match(executor, /uploadMethod = "drop"/);
  assert.doesNotMatch(executor, /input\.files = transfer\.files/);
  assert.match(executor, /Reference \$\{index \+ 1\}\/\$\{task\.references\.length\} is visibly ready/);
  assert.match(executor, /const attachmentPreviews =/);
  assert.match(executor, /image\.naturalWidth > 0/);
  assert.match(executor, /stablePreviewCount >= 3/);
  assert.doesNotMatch(executor, /hasNewAttachment \|\| filenameReady \|\| sendEnabled/);
});

test("decodes reference data URLs locally instead of fetching through Gemini CSP", () => {
  assert.match(executor, /const dataUrlToBlob/);
  assert.match(executor, /atob\(payload\)/);
  assert.match(executor, /blob = dataUrlToBlob\(reference\.dataUrl, reference\.type\)/);
  assert.doesNotMatch(executor, /fetch\(reference\.dataUrl\)/);
});

test("panel exposes queue controls, session diagnostics and download setup", () => {
  for (const id of [
    "pauseQueue",
    "stopQueue",
    "sessionLogs",
    "copyLatestSession",
    "autoDownload",
    "downloadFolder",
  ]) {
    assert.match(panel, new RegExp(`id="${id}"`));
  }
  assert.match(panelScript, /data-action="download"/);
  assert.match(panelScript, /DOWNLOAD_STORED_RESULT/);
  assert.match(background, /chrome\.downloads\.download/);
  assert.match(background, /case "OPEN_FRESH_GEMINI":/);
  assert.match(background, /case "FOCUS_VOX":/);
});

test("reuses Gemini and gates the panel on other pages", () => {
  assert.match(executor, /getCurrentOrExistingGeminiTab/);
  assert.match(panel, /id="wrongPage"/);
  assert.match(panel, /id="moveToGemini"/);
});

test("normalizes editor text before declaring prompt sync failure", () => {
  assert.match(executor, /replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(executor, /normalize\(composer\.innerText/);
});

test("reacquires the Gemini composer after reference upload and guards empty injection results", () => {
  assert.match(executor, /COMPOSER_MISSING_AFTER_UPLOAD/);
  assert.match(executor, /const composer = await waitFor/);
  assert.match(executor, /results\[0\]\.result == null/);
  assert.match(panelScript, /submission\?\.step \|\| "injection"/);
  assert.doesNotMatch(panelScript, /`\$\{submission\.step\}: \$\{submission\.message\}`/);
});

test("enables image mode before upload and refuses a reference count mismatch", () => {
  assert.match(executor, /Enable image generation before uploading references/);
  assert.match(executor, /selectors\.imageModeEnabled/);
  assert.match(executor, /REFERENCE_COUNT_MISMATCH/);
  assert.match(executor, /STALE_ATTACHMENT_CLEAR_FAILED/);
  assert.match(executor, /REFERENCE_NOT_SUBMITTED/);
  assert.match(executor, /referenceInUserTurn/);
  assert.match(executor, /baselineUserMessages/);
  assert.match(executor, /userMessageText/);
  assert.match(executor, /submit-retry/);
  assert.equal(selectors.selectors.attachment, "img.gem-attachment-style-img[alt='attachment'], img[alt='attachment']");
  assert.match(selectors.selectors.attachmentClose, /close attachment/);
});

test("detects Gemini imagegen output from the live generated-image contract", () => {
  assert.equal(
    selectors.selectors.generatedImage,
    "main model-response img[src^='blob:'], main model-response img[src^='data:'], main model-response img[src*='googleusercontent.com'], main model-response img[src*='ggpht.com']",
  );
  assert.equal(
    selectors.selectors.conversationTurn,
    "main user-query, main model-response",
  );
  assert.match(executor, /querySelectorAll\(selectors\.generatedImage\)/);
});

test("falls back to Gemini full-size download when the rendered image is opaque", () => {
  assert.match(executor, /download-generated-image-button/);
  assert.match(executor, /originalCreateObjectURL/);
  assert.match(executor, /HTMLAnchorElement\.prototype\.click/);
  assert.match(executor, /method: "download-intercept"/);
});

test("accepts a fully loaded stable image even while Gemini Stop remains visible", () => {
  assert.match(executor, /imageComplete:\s*image\.complete/);
  assert.match(executor, /width >= 512/);
  assert.match(executor, /height >= 512/);
  assert.match(executor, /ready:/);
  assert.match(panelScript, /advanceCandidateStability/);
  assert.doesNotMatch(panelScript, /!scan\.generating && candidateKey/);
});

test("uses stable Gemini URL identity and only scans new assistant turns", () => {
  assert.match(executor, /return url\.href/);
  assert.match(executor, /imageKeys:/);
  assert.match(executor, /turnIds:/);
  assert.match(executor, /!old\.has\(item\.imageKey\)/);
  assert.match(executor, /!oldTurns\.has\(item\.turnId\)/);
});

test("recovers a submitted task by resuming the scanner without resubmitting", () => {
  assert.match(executor, /pageUrl:\s*location\.href/);
  assert.match(panelScript, /const isRecovery = Boolean\(item\.resume\?\.baseline\)/);
  assert.match(panelScript, /submission_recovered/);
  assert.match(panelScript, /submit count=0/);
  assert.match(panelScript, /stagnation\.count >= 60/);
  assert.match(panelScript, /tabRecoveryCount < 1/);
  assert.match(panelScript, /openConversationRecoveryTab/);
  assert.match(panelScript, /reason: "60-unchanged-scans"/);
});

test("persists draft references outside chrome storage and enables downloads", () => {
  assert.ok(manifest.permissions.includes("downloads"));
  assert.match(panelScript, /kind: "draft-reference"/);
  assert.match(panelScript, /lines: promptLines\.map/);
  assert.match(panelScript, /references: line\.references/);
  assert.match(panelScript, /previewUrl: URL\.createObjectURL\(record\.blob\)/);
});

test("maps bulk prompts to lines with up to five ordered references each", () => {
  assert.match(panelScript, /prompt\.className = "line-prompt"/);
  assert.match(panelScript, /syncPromptLinesFromBulk/);
  assert.match(panelScript, /async function addPrimaryFiles/);
  assert.match(panelScript, /async function addReferencesToLine/);
  assert.match(panelScript, /line\.references\.length >= 5/);
  assert.match(panelScript, /references: referencesByLine\[index\] \|\| \[\]/);
  assert.match(panelScript, /row\.references\.length \? "line-references" : "none"/);
  assert.match(panelScript, /QUEUE_MIGRATED_ONE_TO_ONE/);
});

test("verifies Chrome completed the requested download folder path", () => {
  assert.match(background, /chrome\.downloads\.onDeterminingFilename/);
  assert.match(background, /suggest\(\{\s*filename: armed\.filename/);
  assert.match(background, /chrome\.downloads\.search/);
  assert.match(panelScript, /download_completed/);
  assert.match(panelScript, /download_folder_mismatch/);
});

test("shows new and active queue work before old failures", () => {
  assert.match(panelScript, /function orderedQueueItems/);
  assert.match(panelScript, /item\.id === runner\.currentItemId/);
  assert.match(panelScript, /if \(item\.status === "queued"\) return 1/);
  assert.match(panelScript, /String\(right\.createdAt \|\| ""\)\.localeCompare/);
  assert.match(panelScript, /queue = \[\.\.\.newItems, \.\.\.queue\]/);
});
