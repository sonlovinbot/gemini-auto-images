import { ALARM_NAME, GEMINI_ORIGIN, ERROR_CODES, TASK_STATES } from "./src/constants.js";
import { createIdempotencyKey, sha256 } from "./src/idempotency.js";
import { normalizeTask, validateBatch } from "./src/protocol.js";
import { appendLog, getLogs, getRuntime, getSettings, saveRuntime, saveSettings } from "./src/storage.js";
import { nextRecoveryAction, transition } from "./src/state-machine.js";
import { VoxAdapter } from "./src/vox-adapter.js";
import { blobToDataUrl, deleteBlob, getBlob, putBlob } from "./src/blob-store.js";

let runnerPromise = null;
let manualRunnerPromise = null;
let voxPanelPreparingUntil = 0;
const RESULT_DOWNLOAD_KEY = "autoGeminiImages.armedResultDownload.v1";
const RESULT_DOWNLOAD_TIMEOUT_MS = 120000;

async function readArmedResultDownload() {
  try {
    const stored = await chrome.storage.session.get(RESULT_DOWNLOAD_KEY);
    return stored?.[RESULT_DOWNLOAD_KEY] || null;
  } catch {
    return null;
  }
}

async function writeArmedResultDownload(value) {
  try {
    if (value) {
      await chrome.storage.session.set({ [RESULT_DOWNLOAD_KEY]: value });
    } else {
      await chrome.storage.session.remove(RESULT_DOWNLOAD_KEY);
    }
  } catch {
    // Losing the filename reinforcement must not crash generation.
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    const armed = await readArmedResultDownload();
    if (!armed || Date.now() - armed.armedAt > RESULT_DOWNLOAD_TIMEOUT_MS) {
      if (armed) await writeArmedResultDownload(null);
      suggest();
      return;
    }
    if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) {
      suggest();
      return;
    }
    if (Number.isInteger(armed.downloadId) && armed.downloadId !== item.id) {
      suggest();
      return;
    }
    armed.downloadId = item.id;
    armed.detectedAt = Date.now();
    armed.actualOriginalFilename = item.filename || "";
    await writeArmedResultDownload(armed);
    suggest({
      filename: armed.filename,
      conflictAction: "uniquify",
    });
  })().catch(() => suggest());
  return true;
});

async function startStoredResultDownload({ blobId, filename, saveAs }) {
  if (!blobId || !filename) {
    throw new Error("Missing result blob or download filename.");
  }
  const stored = await getBlob(blobId);
  if (!stored?.blob) throw new Error("Stored result image was not found.");
  const token = crypto.randomUUID();
  await writeArmedResultDownload({
    token,
    filename,
    saveAs: Boolean(saveAs),
    armedAt: Date.now(),
    downloadId: null,
  });
  const url = await blobToDataUrl(stored.blob);
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: Boolean(saveAs),
      conflictAction: "uniquify",
    });
  } catch (error) {
    await writeArmedResultDownload(null);
    throw error;
  }
  const armed = await readArmedResultDownload();
  if (armed?.token === token && !Number.isInteger(armed.downloadId)) {
    armed.downloadId = downloadId;
    await writeArmedResultDownload(armed);
  }
  return { token, downloadId, requestedFilename: filename };
}

async function getResultDownloadStatus(downloadId) {
  if (!Number.isInteger(downloadId)) throw new Error("Invalid download ID.");
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) throw new Error("Chrome download item was not found.");
  if (item.state === "complete" || item.state === "interrupted") {
    const armed = await readArmedResultDownload();
    if (armed?.downloadId === downloadId) await writeArmedResultDownload(null);
  }
  return {
    state: item.state,
    error: item.error || "",
    filename: item.filename || "",
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
  };
}

async function log(level, event, details = {}) {
  await appendLog({ level, event, ...details });
}

async function injectVoxBridgeIntoOpenTabs() {
  const tabs = await chrome.tabs.query({
    url: [
      "http://localhost/*",
      "http://127.0.0.1/*",
    ],
  });
  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/vox-bridge.js"],
        }),
      ),
  );
}

async function pageMessage(tabId, type, payload = {}) {
  const response = await chrome.tabs.sendMessage(tabId, {
    scope: "auto-gemini-images:page",
    type,
    payload
  });
  if (!response?.ok) {
    const error = new Error(response?.error?.message || `Gemini page command failed: ${type}`);
    error.code = response?.error?.code || ERROR_CODES.INTERNAL_ERROR;
    throw error;
  }
  return response.data;
}

async function ensureGeminiTab(runtime, newConversation = false) {
  if (!newConversation && runtime.geminiTabId) {
    const existing = await chrome.tabs.get(runtime.geminiTabId).catch(() => null);
    if (existing?.url?.startsWith(GEMINI_ORIGIN)) {
      if (runtime.focusGeminiRequested) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
        await saveRuntime({ focusGeminiRequested: false });
      }
      return existing;
    }
  }
  const tabs = await chrome.tabs.query({ url: `${GEMINI_ORIGIN}/*` });
  if (!newConversation && tabs[0]) {
    if (runtime.focusGeminiRequested) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    }
    await saveRuntime({ geminiTabId: tabs[0].id, conversationUrl: tabs[0].url });
    return tabs[0];
  }
  const tab = await chrome.tabs.create({ url: `${GEMINI_ORIGIN}/app`, active: true });
  await saveRuntime({ geminiTabId: tab.id, conversationUrl: tab.url });
  return tab;
}

async function waitForPage(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pong = await pageMessage(tabId, "PING").catch(() => null);
    if (pong) return pong;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const error = new Error("Gemini tab did not become ready.");
  error.code = ERROR_CODES.GEMINI_UI_UNSUPPORTED;
  throw error;
}

async function reportProgress(adapter, task, state, details = {}) {
  await adapter.progress(task.taskId, {
    batchId: task.batchId,
    projectId: task.projectId,
    beatId: task.beatId,
    attempt: task.attempt,
    idempotencyKey: task.idempotencyKey,
    state,
    details
  });
}

async function checkpointTask(activeTask, to, patch = {}) {
  const next = transition(activeTask, to, patch);
  await saveRuntime({ activeTask: next, status: to });
  return next;
}

async function fetchResult(candidate) {
  const response = await fetch(candidate.src, { credentials: "include" });
  if (!response.ok) {
    const error = new Error(`Generated image returned ${response.status}.`);
    error.code = ERROR_CODES.RESULT_FETCH_FAILED;
    throw error;
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size === 0) {
    const error = new Error("Generated result was not a valid image.");
    error.code = ERROR_CODES.RESULT_INVALID;
    throw error;
  }
  return blob;
}

async function prepareVoxBatchForPanel(batch, knownTaskIds = []) {
  const known = new Set(Array.isArray(knownTaskIds) ? knownTaskIds : []);
  const createdBlobIds = [];
  try {
    const tasks = [];
    for (const task of batch.tasks || []) {
      if (
        known.has(task.taskId) ||
        ["completed", "canceled"].includes(task.state)
      ) {
        tasks.push({ ...task, references: [] });
        continue;
      }
      const references = [];
      for (const reference of [...(task.references || [])].sort(
        (left, right) => Number(left.order || 0) - Number(right.order || 0),
      )) {
        const url = String(reference.url || "").trim();
        if (!url) {
          throw Object.assign(
            new Error(`VOX reference ${reference.name || reference.id} has no URL.`),
            { code: "VOX_REFERENCE_URL_MISSING" },
          );
        }
        let response;
        try {
          response = await fetch(url, { credentials: "include" });
        } catch (error) {
          throw Object.assign(
            new Error(
              `Could not fetch VOX reference ${reference.name || reference.id}: ${error.message}`,
            ),
            { code: "VOX_REFERENCE_FETCH_FAILED" },
          );
        }
        if (!response.ok) {
          throw Object.assign(
            new Error(
              `VOX reference ${reference.name || reference.id} returned ${response.status}.`,
            ),
            { code: "VOX_REFERENCE_FETCH_FAILED" },
          );
        }
        const blob = await response.blob();
        const type = String(reference.type || blob.type || "").toLowerCase();
        if (!blob.size || !type.startsWith("image/")) {
          throw Object.assign(
            new Error(`VOX reference ${reference.name || reference.id} is not a valid image.`),
            { code: "VOX_REFERENCE_INVALID" },
          );
        }
        const name = String(
          reference.name ||
          `reference-${Number(reference.order || references.length) + 1}.png`,
        );
        const blobId = await putBlob(blob, {
          kind: "vox-reference",
          batchId: batch.batchId,
          taskId: task.taskId,
          referenceId: reference.id || "",
          name,
        });
        createdBlobIds.push(blobId);
        references.push({
          id: reference.id || "",
          blobId,
          name,
          type,
          size: blob.size,
          order: Number(reference.order || references.length),
        });
      }
      tasks.push({ ...task, references });
    }
    return { ...batch, tasks };
  } catch (error) {
    for (const blobId of createdBlobIds) {
      await deleteBlob(blobId).catch(() => {});
    }
    throw error;
  }
}

async function saveManualState(patch) {
  const runtime = await getRuntime();
  const manualTask = {
    ...(runtime.manualTask || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveRuntime({ manualTask, status: `manual:${manualTask.state || "idle"}` });
  return manualTask;
}

async function runManualTask(payload) {
  const settings = await getSettings();
  const taskId = crypto.randomUUID();
  try {
    await saveManualState({
      taskId,
      state: TASK_STATES.CLAIMING,
      prompt: payload.prompt,
      aspectRatio: payload.aspectRatio,
      references: payload.references,
      resultBlobId: null,
      result: null,
      error: null,
      startedAt: new Date().toISOString()
    });
    await log("info", "manual_task_started", {
      taskId,
      referenceCount: payload.references.length
    });

    const runtime = await getRuntime();
    const tab = await ensureGeminiTab({ ...runtime, focusGeminiRequested: true }, true);
    const page = await waitForPage(tab.id);
    if (page.blocked) throw Object.assign(new Error(page.blocked.message), { code: page.blocked.code });

    await saveManualState({ state: TASK_STATES.UPLOADING });
    await log("info", "manual_baseline_recording", { taskId });
    const baseline = await pageMessage(tab.id, "RECORD_BASELINE");
    const references = [];
    for (const [order, reference] of payload.references.entries()) {
      const stored = await getBlob(reference.blobId);
      if (!stored?.blob) {
        throw Object.assign(new Error(`Reference ${reference.name} is missing from local storage.`), {
          code: ERROR_CODES.REFERENCE_FETCH_FAILED
        });
      }
      references.push({
        id: reference.blobId,
        name: reference.name,
        type: reference.type,
        order,
        url: await blobToDataUrl(stored.blob)
      });
    }
    await log("info", "manual_references_uploading", {
      taskId,
      names: references.map((reference) => reference.name)
    });
    const uploaded = await pageMessage(tab.id, "UPLOAD_REFERENCES", { references });

    const promptHash = await sha256(payload.prompt);
    await saveManualState({
      state: TASK_STATES.SUBMITTING,
      baseline,
      uploadedReferences: uploaded
    });
    await log("info", "manual_prompt_submitting", { taskId, promptHash });
    const submission = await pageMessage(tab.id, "SUBMIT_PROMPT", {
      prompt: payload.prompt,
      promptHash
    });

    await saveManualState({ state: TASK_STATES.WAITING, submission });
    await log("info", "manual_generation_waiting", { taskId });
    const candidate = await pageMessage(tab.id, "WAIT_FOR_RESULT", {
      baseline,
      timeoutMs: settings.generationTimeoutMs
    });

    await saveManualState({ state: TASK_STATES.COLLECTING, candidate });
    await log("info", "manual_result_collecting", { taskId, candidate });
    const blob = await fetchResult(candidate);
    const checksum = await sha256(await blob.arrayBuffer());
    const resultBlobId = await putBlob(blob, {
      kind: "manual-result",
      taskId,
      checksum
    });
    await saveManualState({
      state: TASK_STATES.COMPLETED,
      resultBlobId,
      result: {
        checksum,
        type: blob.type,
        size: blob.size,
        width: candidate.width,
        height: candidate.height,
        name: payload.outputName || `chatgpt-${taskId}.png`
      }
    });
    await log("info", "manual_task_completed", {
      taskId,
      checksum,
      size: blob.size
    });
  } catch (error) {
    const code = error.code || ERROR_CODES.INTERNAL_ERROR;
    await saveManualState({
      state: TASK_STATES.FAILED,
      error: { code, message: error.message || String(error) }
    });
    await log("error", "manual_task_failed", {
      taskId,
      code,
      message: error.message || String(error)
    });
  }
}

function scheduleManualTask(payload) {
  if (manualRunnerPromise) {
    throw new Error("A manual Gemini task is already running.");
  }
  manualRunnerPromise = runManualTask(payload).finally(() => {
    manualRunnerPromise = null;
  });
}

async function executeTask(adapter, task, tabId, settings) {
  let active = {
    ...task,
    state: TASK_STATES.CLAIMING,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await saveRuntime({ activeTask: active, status: active.state });
  await reportProgress(adapter, task, active.state);

  active = await checkpointTask(active, TASK_STATES.UPLOADING);
  await reportProgress(adapter, task, active.state);
  const baseline = await pageMessage(tabId, "RECORD_BASELINE");
  const references = await pageMessage(tabId, "UPLOAD_REFERENCES", { references: task.references });
  active = { ...active, baseline, references, updatedAt: new Date().toISOString() };
  await saveRuntime({ activeTask: active });

  active = await checkpointTask(active, TASK_STATES.SUBMITTING, { submissionPending: true });
  await reportProgress(adapter, task, active.state, { referenceCount: references.length });
  const submission = await pageMessage(tabId, "SUBMIT_PROMPT", {
    prompt: task.prompt,
    promptHash: task.promptHash
  });
  active = await checkpointTask(active, TASK_STATES.WAITING, {
    submissionPending: false,
    submission
  });
  await reportProgress(adapter, task, active.state);

  const candidate = await pageMessage(tabId, "WAIT_FOR_RESULT", {
    baseline,
    timeoutMs: settings.generationTimeoutMs
  });
  active = await checkpointTask(active, TASK_STATES.COLLECTING, { candidate });
  await reportProgress(adapter, task, active.state);

  const blob = await fetchResult(candidate);
  const checksum = await sha256(await blob.arrayBuffer());
  active = await checkpointTask(active, TASK_STATES.RETURNING, {
    result: { checksum, type: blob.type, size: blob.size, width: candidate.width, height: candidate.height }
  });
  await reportProgress(adapter, task, active.state);

  const confirmation = await adapter.result(task.taskId, {
    batchId: task.batchId,
    projectId: task.projectId,
    beatId: task.beatId,
    attempt: task.attempt,
    idempotencyKey: task.idempotencyKey,
    expectedOutputName: task.expectedOutputName,
    checksum,
    mimeType: blob.type,
    byteLength: blob.size,
    width: candidate.width,
    height: candidate.height
  }, blob);
  if (!confirmation?.saved) {
    const error = new Error("VOX did not confirm that the image was saved.");
    error.code = ERROR_CODES.RESULT_SAVE_UNCONFIRMED;
    throw error;
  }
  active = await checkpointTask(active, TASK_STATES.COMPLETED, { confirmation });
  await log("info", "task_completed", { taskId: task.taskId, beatId: task.beatId });
  return active;
}

async function failActiveTask(adapter, error) {
  const runtime = await getRuntime();
  const task = runtime.activeTask;
  if (!task) return;
  const code = error.code || ERROR_CODES.INTERNAL_ERROR;
  await saveRuntime({
    status: TASK_STATES.FAILED,
    activeTask: { ...task, state: TASK_STATES.FAILED, error: { code, message: error.message } }
  });
  await adapter.fail(task.taskId, {
    batchId: task.batchId,
    attempt: task.attempt,
    idempotencyKey: task.idempotencyKey,
    code,
    message: error.message
  }).catch(() => {});
  await log("error", "task_failed", { taskId: task.taskId, code, message: error.message });
}

async function runBatch() {
  const runtime = await getRuntime();
  if (!runtime.activeBatchId || runtime.pauseRequested || runtime.stopRequested) return;
  const settings = await getSettings();
  const adapter = new VoxAdapter(settings);
  try {
    const batch = await adapter.getBatch(runtime.activeBatchId);
    const validation = validateBatch(batch);
    if (!validation.valid) throw Object.assign(new Error(validation.errors.join("; ")), { code: ERROR_CODES.UNSUPPORTED_PROTOCOL });
    const claimed = await adapter.claim(batch.batchId);
    const rawTask = claimed?.task || claimed;
    if (!rawTask?.taskId) {
      await saveRuntime({ status: "idle", activeTask: null });
      return;
    }
    const task = normalizeTask(batch, rawTask);
    task.promptHash ||= await sha256(task.prompt);
    task.idempotencyKey ||= await createIdempotencyKey(task);
    const tab = await ensureGeminiTab(runtime, !runtime.conversationUrl);
    const page = await waitForPage(tab.id);
    if (page.blocked) throw Object.assign(new Error(page.blocked.message), { code: page.blocked.code });
    await executeTask(adapter, task, tab.id, settings);
    await saveRuntime({ activeTask: null, status: "running" });
    chrome.alarms.create(ALARM_NAME, { when: Date.now() + 1000 });
  } catch (error) {
    await failActiveTask(adapter, error);
    if (!(await getRuntime()).activeTask) {
      await saveRuntime({ status: "error" });
      await log("error", "batch_error", { code: error.code || ERROR_CODES.INTERNAL_ERROR, message: error.message });
    }
  }
}

function scheduleRun() {
  runnerPromise ||= runBatch().finally(() => {
    runnerPromise = null;
  });
  return runnerPromise;
}

async function recover() {
  const runtime = await getRuntime();
  if (!runtime.activeBatchId || runtime.pauseRequested || runtime.stopRequested) return;
  if (runtime.executorMode === "sidepanel") return;
  const action = nextRecoveryAction(runtime.activeTask);
  await log("info", "recovery_started", { action, taskId: runtime.activeTask?.taskId });
  // Ambiguous submission is never automatically repeated. The normal runner
  // resumes only when no task is active; task-specific recovery follows in V0.2.
  if (runtime.activeTask) {
    await saveRuntime({ status: runtime.activeTask.state });
    return;
  }
  return scheduleRun();
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "OPEN_SIDE_PANEL": {
      if (!sender?.tab?.windowId) {
        throw new Error("Could not identify the VOX Chrome window.");
      }
      voxPanelPreparingUntil = Date.now() + 30000;
      const preparing = saveRuntime({
        voxPreparing: true,
        voxPreparingUntil: voxPanelPreparingUntil,
        status: "panel_preparing",
      });
      const opening = chrome.sidePanel.open({ windowId: sender.tab.windowId });
      try {
        await Promise.all([preparing, opening]);
        return { opened: true };
      } catch (error) {
        voxPanelPreparingUntil = 0;
        await saveRuntime({
          voxPreparing: false,
          voxPreparingUntil: 0,
          status: "panel_open_failed",
        }).catch(() => {});
        throw error;
      }
    }
    case "GET_STATUS": {
      const runtime = await getRuntime();
      return {
        runtime: {
          ...runtime,
          voxPreparing:
            (Boolean(runtime.voxPreparing) &&
              Number(runtime.voxPreparingUntil || 0) > Date.now()) ||
            Date.now() < voxPanelPreparingUntil,
        },
        settings: await getSettings(),
        logs: await getLogs(),
      };
    }
    case "START_MANUAL_TASK": {
      const prompt = String(message.prompt || "").trim();
      const references = Array.isArray(message.references) ? message.references : [];
      if (!prompt) throw new Error("Prompt is required.");
      scheduleManualTask({
        prompt,
        references,
        aspectRatio: message.aspectRatio || "9:16",
        outputName: message.outputName || "chatgpt-manual.png"
      });
      return { ok: true };
    }
    case "CLEAR_MANUAL_TASK":
      await saveRuntime({ manualTask: null, status: "idle" });
      return { ok: true };
    case "DOWNLOAD_STORED_RESULT":
      return startStoredResultDownload({
        blobId: message.blobId,
        filename: message.filename,
        saveAs: message.saveAs,
      });
    case "GET_RESULT_DOWNLOAD_STATUS":
      return getResultDownloadStatus(message.downloadId);
    case "OPEN_DOWNLOAD_SETTINGS":
      await chrome.tabs.create({ url: "chrome://settings/downloads" });
      return { ok: true };
    case "OPEN_FRESH_GEMINI": {
      const runtime = await getRuntime();
      const tab = await ensureGeminiTab(
        { ...runtime, focusGeminiRequested: true },
        true,
      );
      await log("info", "fresh_chatgpt_opened", {
        tabId: tab.id,
        reason: message.reason || "retry",
      });
      return tab;
    }
    case "FOCUS_VOX": {
      const tabs = await chrome.tabs.query({
        url: [
          "http://localhost/*",
          "http://127.0.0.1/*",
        ],
      });
      const tab = tabs[0];
      if (!tab?.id) throw new Error("Không tìm thấy tab VOX đang mở.");
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return { focused: true, tabId: tab.id };
    }
    case "GET_VOX_BATCH": {
      const settings = await getSettings();
      const batchId = String(message.batchId || "").trim();
      if (!batchId) throw new Error("VOX batch ID is required.");
      const batch = await new VoxAdapter(settings).getBatch(batchId);
      return prepareVoxBatchForPanel(batch, message.knownTaskIds);
    }
    case "GET_VOX_BATCH_STATUS": {
      const settings = await getSettings();
      const batchId = String(message.batchId || "").trim();
      if (!batchId) throw new Error("VOX batch ID is required.");
      return new VoxAdapter(settings).getBatch(batchId);
    }
    case "CLAIM_VOX_TASK": {
      const settings = await getSettings();
      const batchId = String(message.batchId || "").trim();
      if (!batchId) throw new Error("VOX batch ID is required.");
      return new VoxAdapter(settings).claim(batchId);
    }
    case "VOX_TASK_PROGRESS": {
      const settings = await getSettings();
      const taskId = String(message.taskId || "").trim();
      if (!taskId) throw new Error("VOX task ID is required.");
      return new VoxAdapter(settings).progress(taskId, message.payload || {});
    }
    case "VOX_TASK_RESULT": {
      const settings = await getSettings();
      const taskId = String(message.taskId || "").trim();
      const blobId = String(message.blobId || "").trim();
      if (!taskId || !blobId) throw new Error("VOX task and result blob IDs are required.");
      const stored = await getBlob(blobId);
      if (!stored?.blob) throw new Error("Stored VOX result image was not found.");
      const confirmation = await new VoxAdapter(settings).result(
        taskId,
        message.metadata || {},
        stored.blob,
      );
      const runtime = await getRuntime();
      if (runtime.activeBatchId) {
        const batch = await new VoxAdapter(settings)
          .getBatch(runtime.activeBatchId)
          .catch(() => null);
        if (batch && ["completed", "canceled"].includes(batch.state)) {
          await saveRuntime({
            activeBatchId: null,
            activeTask: null,
            status: batch.state,
          });
        }
      }
      return confirmation;
    }
    case "VOX_TASK_FAIL": {
      const settings = await getSettings();
      const taskId = String(message.taskId || "").trim();
      if (!taskId) throw new Error("VOX task ID is required.");
      return new VoxAdapter(settings).fail(taskId, message.payload || {});
    }
    case "VOX_TASK_CANCEL": {
      const settings = await getSettings();
      const taskId = String(message.taskId || "").trim();
      if (!taskId) throw new Error("VOX task ID is required.");
      return new VoxAdapter(settings).cancel(taskId);
    }
    case "SAVE_SETTINGS":
      return { settings: await saveSettings(message.settings || {}) };
    case "START_BATCH": {
      voxPanelPreparingUntil = 0;
      const panelOpenPromise =
        message.initiatedByVox && sender?.tab?.windowId
          ? chrome.sidePanel
              .open({ windowId: sender.tab.windowId })
              .then(() => true)
              .catch(() => false)
          : Promise.resolve(false);
      if (message.settings?.voxBaseUrl) {
        await saveSettings({
          voxBaseUrl: message.settings.voxBaseUrl,
          apiToken: message.settings.apiToken || ""
        });
      }
      const runtimeBeforeStart = await getRuntime();
      const sameBatch = runtimeBeforeStart.activeBatchId === message.batchId;
      await saveRuntime({
        activeBatchId: message.batchId,
        activeTask: null,
        executorMode: "sidepanel",
        voxExecutionMode:
          message.executionMode === "manual" ? "manual" : "auto",
        voxOpenNewChat: message.openNewChat !== false,
        voxResetWorkspace: message.resetWorkspace !== false,
        voxPreparing: false,
        voxPreparingUntil: 0,
        status: "panel_pending",
        pauseRequested: false,
        stopRequested: false,
        conversationUrl: sameBatch ? runtimeBeforeStart.conversationUrl : null,
        focusGeminiRequested: Boolean(message.initiatedByVox)
      });
      await log("info", "batch_started", {
        batchId: message.batchId,
        source: message.initiatedByVox ? "vox_bridge" : "sidepanel"
      });
      const panelOpened = await panelOpenPromise;
      {
        const current = await getRuntime();
        await ensureGeminiTab(
          { ...current, focusGeminiRequested: true },
          Boolean(current.voxOpenNewChat) && !sameBatch,
        );
      }
      await chrome.runtime.sendMessage({
        scope: "auto-gemini-images:sidepanel",
        type: "VOX_BATCH_AVAILABLE",
        batchId: message.batchId,
        executionMode:
          message.executionMode === "manual" ? "manual" : "auto",
        resetWorkspace: message.resetWorkspace !== false,
      }).catch(() => {});
      return {
        accepted: true,
        executorMode: "sidepanel",
        panelOpened,
        executionMode:
          message.executionMode === "manual" ? "manual" : "auto",
      };
    }
    case "PAUSE":
      await saveRuntime({ pauseRequested: true, status: TASK_STATES.PAUSED });
      return { ok: true };
    case "RESUME":
      await saveRuntime({ pauseRequested: false, stopRequested: false, status: "running" });
      recover();
      return { ok: true };
    case "STOP": {
      const runtime = await getRuntime();
      const settings = await getSettings();
      if (runtime.activeTask) {
        await new VoxAdapter(settings).cancel(runtime.activeTask.taskId).catch(() => {});
      }
      await saveRuntime({ stopRequested: true, status: TASK_STATES.CANCELED, activeTask: null });
      return { ok: true };
    }
    case "FOCUS_GEMINI": {
      const runtime = await getRuntime();
      if (runtime.geminiTabId) await chrome.tabs.update(runtime.geminiTabId, { active: true });
      return { ok: true };
    }
    default:
      return null;
  }
}

chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ windowId: tab.windowId }));
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void injectVoxBridgeIntoOpenTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void recover();
  void injectVoxBridgeIntoOpenTabs().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) recover();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.scope !== "auto-gemini-images:background") return;
  handleMessage(message, _sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: { message: error.message, code: error.code } }));
  return true;
});

// Unpacked-extension reloads invalidate content-script runtime objects in
// already open VOX tabs. Re-inject a current bridge whenever this service
// worker instance starts so the user does not have to discover the reload
// order manually.
void injectVoxBridgeIntoOpenTabs().catch(() => {});
