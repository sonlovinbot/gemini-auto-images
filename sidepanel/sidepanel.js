import {
  blobToDataUrl,
  deleteBlob,
  getBlob,
  putBlob,
} from "../src/blob-store.js";
import { sha256 } from "../src/idempotency.js";
import { buildOutputName, parsePrompts } from "../src/prompt-parser.js";
import { validateBatch } from "../src/protocol.js";
import {
  advanceCandidateStability,
  advanceScanStagnation,
} from "../src/result-stability.js";
import {
  collectGeminiResult,
  getCurrentOrExistingGeminiTab,
  scanGeminiResult,
  submitGeminiTask,
  waitForTab,
} from "./gemini-executor.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const QUEUE_KEY = "autoGeminiImages.localQueue.v1";
const SETTINGS_KEY = "autoGeminiImages.runnerSettings.v1";
const SESSIONS_KEY = "autoGeminiImages.sessions.v1";
const DRAFT_KEY = "autoGeminiImages.draft.v1";
const TRANSIENT_STATES = new Set([
  "claiming",
  "uploading_references",
  "submitting",
  "waiting",
  "collecting",
  "returning",
  "running",
]);
const STAGES = [
  "claiming",
  "uploading_references",
  "submitting",
  "waiting",
  "collecting",
  "returning",
  "completed",
];
const DEFAULT_SETTINGS = {
  timeoutMinutes: 10,
  delaySeconds: 2,
  autoDownload: true,
  downloadMode: "auto",
  downloadFolder: "Auto Gemini Images",
};

let selectorConfigPromise;
let promptLines = [];
let queue = [];
let sessions = [];
let sessionSaveTimer = null;
let draftSaveTimer = null;
let runnerSettings = { ...DEFAULT_SETTINGS };
let currentSessionId = "";
let toastTimer = null;
let voxIntakePromise = null;
let panelInitialized = false;
let pendingVoxRequest = null;
const resultUrls = new Map();
const runner = {
  running: false,
  paused: false,
  stopRequested: false,
  currentItemId: "",
};

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeFilename(value, fallback = "gemini-image.png") {
  const safe = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return safe || fallback;
}

function normalizeFolder(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .map((part) => normalizeFilename(part, ""))
    .filter(Boolean)
    .join("/");
}

function stateLabel(state) {
  return {
    queued: "đang chờ",
    claiming: "kết nối",
    uploading_references: "nạp ảnh",
    submitting: "gửi prompt",
    waiting: "chờ ảnh",
    collecting: "lấy ảnh",
    returning: "lưu kết quả",
    completed: "hoàn tất",
    failed: "lỗi",
    canceled: "đã dừng",
    paused: "tạm dừng",
  }[state] || state || "idle";
}

async function updatePageGate() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onGemini = Boolean(tab?.url?.startsWith("https://gemini.google.com/app"));
  $("#mainHeader").hidden = !onGemini;
  $("#wrongPage").hidden = onGemini;
  $("#mainInterface").hidden = !onGemini;
  return onGemini;
}

async function moveToGemini() {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/app*" });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    }
    return;
  }
  await chrome.tabs.create({ url: "https://gemini.google.com/app", active: true });
}

function activateTab(name) {
  $$(".tab-button").forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
}

async function getSelectorConfig() {
  selectorConfigPromise ||= fetch(
    chrome.runtime.getURL("config/gemini-selectors.json"),
  ).then((response) => {
    if (!response.ok) throw new Error(`Selector config failed: ${response.status}`);
    return response.json();
  });
  return selectorConfigPromise;
}

function parsedPrompts() {
  return parsePrompts($("#bulkPrompts").value);
}

function renderPromptCount() {
  const filled = promptLines.filter((line) => line.prompt?.trim()).length;
  $("#promptCount").textContent = `${filled}/${promptLines.length} line có prompt`;
}

function createPromptLine(prompt = "") {
  return {
    id: crypto.randomUUID(),
    prompt,
    references: [],
    integration: null,
    outputName: "",
    aspectRatio: "",
  };
}

function syncPromptLinesFromBulk() {
  const prompts = parsedPrompts();
  while (promptLines.length < prompts.length) {
    promptLines.push(createPromptLine());
  }
  promptLines.forEach((line, index) => {
    line.prompt = prompts[index] || (index < prompts.length ? "" : line.prompt);
  });
  renderPromptLines();
}

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    void chrome.storage.local.set({
      [DRAFT_KEY]: {
        prompts: $("#bulkPrompts").value,
        aspectRatio: $("#aspectRatio").value,
        outputPrefix: $("#outputPrefix").value,
        lines: promptLines.map((line, lineOrder) => ({
          id: line.id,
          prompt: line.prompt || "",
          integration: line.integration || null,
          outputName: line.outputName || "",
          aspectRatio: line.aspectRatio || "",
          lineOrder,
          references: line.references
            .filter((entry) => entry.blobId)
            .map((entry, order) => ({
              blobId: entry.blobId,
              name: entry.file.name,
              type: entry.file.type,
              size: entry.file.size,
              lastModified: entry.file.lastModified,
              width: entry.width,
              height: entry.height,
              order,
            })),
        })),
      },
    });
  }, 250);
}

async function inspectImage(file) {
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    // The browser will still validate the image during upload.
  }
  return { width, height };
}

function sameFile(entry, file) {
  return (
    entry.file.name === file.name &&
    entry.file.size === file.size &&
    entry.file.lastModified === file.lastModified
  );
}

async function storeDraftReference(file) {
  const dimensions = await inspectImage(file);
  const blobId = await putBlob(file, {
    kind: "draft-reference",
    name: file.name,
  });
  return {
    file,
    previewUrl: URL.createObjectURL(file),
    blobId,
    ...dimensions,
  };
}

async function addPrimaryFiles(files) {
  const prompts = parsedPrompts();
  const emptyLines = promptLines.filter((line) => line.references.length === 0);
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      toast(`Bỏ qua ${file.name}: không phải ảnh`);
      continue;
    }
    let line = emptyLines.shift();
    if (!line) {
      line = createPromptLine(prompts[promptLines.length] || "");
      promptLines.push(line);
    }
    if (line.references.some((entry) => sameFile(entry, file))) continue;
    line.references.push(await storeDraftReference(file));
  }
  renderPromptLines();
  scheduleDraftSave();
}

async function addReferencesToLine(line, files) {
  for (const file of files) {
    if (line.references.length >= 5) {
      toast("Mỗi line hỗ trợ tối đa 5 ảnh ref");
      break;
    }
    if (!file.type.startsWith("image/")) {
      toast(`Bỏ qua ${file.name}: không phải ảnh`);
      continue;
    }
    if (line.references.some((entry) => sameFile(entry, file))) continue;
    line.references.push(await storeDraftReference(file));
  }
  renderPromptLines();
  scheduleDraftSave();
}

function referenceUsedByQueue(blobId) {
  return queue.some((item) =>
    (item.references || []).some((reference) => reference.blobId === blobId),
  );
}

function renderPromptLines() {
  const list = $("#referenceList");
  list.replaceChildren();
  const hasVoxDraft = promptLines.some((line) => isVoxPromptLine(line));
  $("#bulkPrompts").readOnly = hasVoxDraft;
  $("#referenceInput").disabled = hasVoxDraft;
  $("#addPromptLine").disabled = hasVoxDraft;
  promptLines.forEach((line, lineIndex) => {
    const lockedVoxLine = isVoxPromptLine(line);
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "prompt-line-head";
    const title = document.createElement("div");
    title.className = "prompt-line-title";
    const strong = document.createElement("strong");
    strong.textContent = lockedVoxLine
      ? `VOX · ${line.outputName || `Line ${lineIndex + 1}`}`
      : `Line ${lineIndex + 1}`;
    const count = document.createElement("span");
    count.textContent = `${line.references.length}/5 ref`;
    title.append(strong, count);
    const actions = document.createElement("div");
    actions.className = "line-actions";
    for (const [label, title, action, disabled] of [
      ["↑", "Đưa line lên", "up", lineIndex === 0],
      ["↓", "Đưa line xuống", "down", lineIndex === promptLines.length - 1],
      ["×", "Xóa line", "remove", false],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `icon-button${action === "remove" ? " remove" : ""}`;
      button.textContent = label;
      button.title = title;
      button.disabled = disabled || lockedVoxLine;
      button.addEventListener("click", () => {
        if (action === "remove") {
          promptLines = promptLines.filter((candidate) => candidate !== line);
          for (const reference of line.references) {
            URL.revokeObjectURL(reference.previewUrl);
            if (!referenceUsedByQueue(reference.blobId)) {
              void deleteBlob(reference.blobId).catch(() => {});
            }
          }
        } else {
          const nextIndex = action === "up" ? lineIndex - 1 : lineIndex + 1;
          [promptLines[lineIndex], promptLines[nextIndex]] = [
            promptLines[nextIndex],
            promptLines[lineIndex],
          ];
        }
        renderPromptLines();
        scheduleDraftSave();
      });
      actions.append(button);
    }
    head.append(title, actions);

    const editor = document.createElement("div");
    editor.className = "prompt-line-editor";
    const stack = document.createElement("div");
    stack.className = "reference-stack";
    line.references.forEach((reference, referenceIndex) => {
      const thumb = document.createElement("div");
      thumb.className = "reference-thumb";
      thumb.style.zIndex = String(referenceIndex + 1);
      thumb.title = `${referenceIndex + 1}. ${reference.file.name}`;
      const image = document.createElement("img");
      image.src = reference.previewUrl;
      image.alt = "";
      const number = document.createElement("span");
      number.className = "reference-number";
      number.textContent = String(referenceIndex + 1);
      const controls = document.createElement("div");
      controls.className = "thumb-controls";
      for (const [label, action, disabled] of [
        ["‹", "left", referenceIndex === 0],
        ["›", "right", referenceIndex === line.references.length - 1],
        ["×", "remove", false],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled || lockedVoxLine;
        button.addEventListener("click", () => {
          if (action === "remove") {
            URL.revokeObjectURL(reference.previewUrl);
            line.references = line.references.filter((candidate) => candidate !== reference);
            if (!referenceUsedByQueue(reference.blobId)) {
              void deleteBlob(reference.blobId).catch(() => {});
            }
          } else {
            const nextIndex = action === "left" ? referenceIndex - 1 : referenceIndex + 1;
            [line.references[referenceIndex], line.references[nextIndex]] = [
              line.references[nextIndex],
              line.references[referenceIndex],
            ];
          }
          renderPromptLines();
          scheduleDraftSave();
        });
        controls.append(button);
      }
      thumb.append(image, number, controls);
      stack.append(thumb);
    });
    const addReference = document.createElement("button");
    addReference.type = "button";
    addReference.className = "add-reference";
    addReference.textContent = line.references.length ? "+ Ref" : "+ Ảnh";
    addReference.disabled = lockedVoxLine || line.references.length >= 5;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp";
    fileInput.multiple = true;
    fileInput.hidden = true;
    addReference.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (event) => {
      void addReferencesToLine(line, event.target.files || []);
      event.target.value = "";
    });
    stack.append(addReference, fileInput);

    const prompt = document.createElement("textarea");
    prompt.className = "line-prompt";
    prompt.rows = 3;
    prompt.placeholder = `Prompt cho line ${lineIndex + 1}`;
    prompt.value = line.prompt || "";
    prompt.readOnly = lockedVoxLine;
    prompt.setAttribute("aria-label", `Prompt line ${lineIndex + 1}`);
    prompt.addEventListener("input", () => {
      line.prompt = prompt.value;
      renderPromptCount();
      scheduleDraftSave();
    });
    editor.append(stack, prompt);
    item.append(head, editor);
    list.append(item);
  });

  const totalReferences = promptLines.reduce(
    (total, line) => total + line.references.length,
    0,
  );
  const filled = promptLines.filter((line) => line.prompt?.trim()).length;
  $("#referenceHint").textContent = promptLines.length
    ? `${promptLines.length} line · ${filled} có prompt · ${totalReferences} ảnh ref.`
    : "Nhập prompt tổng hoặc nạp ảnh để tạo line.";
  renderPromptCount();
}

async function persistQueue() {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

function isVoxQueueItem(item) {
  return item?.integration?.type === "vox";
}

function isVoxPromptLine(line) {
  return line?.integration?.type === "vox";
}

function voxIntegration(batch, task, taskOrder) {
  return {
    type: "vox",
    batchId: batch.batchId,
    projectId: batch.projectId,
    taskId: task.taskId,
    beatId: task.beatId,
    taskOrder,
    attempt: Number(task.attempt || 1),
    idempotencyKey: task.idempotencyKey || "",
    promptHash: task.promptHash || "",
    taskRevision: Number(task.revision || 0),
    claimed: false,
    leaseToken: "",
    leaseExpiresAt: "",
    remoteState: task.state || "queued",
  };
}

function currentVoxTaskIds() {
  return new Set([
    ...queue
      .filter(isVoxQueueItem)
      .map((item) => item.integration.taskId),
    ...promptLines
      .filter(isVoxPromptLine)
      .map((line) => line.integration.taskId),
  ]);
}

function hasVoxBatch(batchId) {
  return (
    queue.some(
      (item) =>
        isVoxQueueItem(item) && item.integration.batchId === batchId,
    ) ||
    promptLines.some(
      (line) =>
        isVoxPromptLine(line) && line.integration.batchId === batchId,
    )
  );
}

async function clearPromptDraft() {
  const blobIds = promptLines.flatMap((line) =>
    line.references.map((reference) => reference.blobId),
  );
  for (const line of promptLines) {
    for (const reference of line.references) {
      if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    }
  }
  promptLines = [];
  $("#bulkPrompts").value = "";
  await cleanupReferenceBlobs(blobIds);
  await chrome.storage.local.remove(DRAFT_KEY);
  renderPromptLines();
}

async function resetVoxWorkspaceForBatch(batchId, resetWorkspace) {
  if (!resetWorkspace || hasVoxBatch(batchId)) return;
  if (runner.running) {
    throw Object.assign(
      new Error("Hãy dừng hàng chờ hiện tại trước khi đổi VOX workspace."),
      { code: "VOX_WORKSPACE_BUSY" },
    );
  }
  await clearItems((item) => isVoxQueueItem(item));
  await clearPromptDraft();
}

async function importVoxBatch(
  batchId,
  {
    run = true,
    executionMode = "auto",
    resetWorkspace = true,
  } = {},
) {
  const normalizedBatchId = String(batchId || "").trim();
  if (!normalizedBatchId) return false;
  if (voxIntakePromise) return voxIntakePromise;
  voxIntakePromise = (async () => {
    let existingTaskIds = currentVoxTaskIds();
    const batch = await sendBackground("GET_VOX_BATCH", {
      batchId: normalizedBatchId,
      knownTaskIds: [...existingTaskIds],
    });
    const validation = validateBatch(batch);
    if (!validation.valid) {
      throw Object.assign(
        new Error(validation.errors.join("; ")),
        { code: "VOX_BATCH_INVALID" },
      );
    }
    await resetVoxWorkspaceForBatch(batch.batchId, resetWorkspace);
    existingTaskIds = currentVoxTaskIds();
    $("#batchId").value = batch.batchId;
    const importedBlobIds = [];
    const newItems = [];
    const newLines = [];
    const resumedItems = [];
    try {
      for (let index = 0; index < batch.tasks.length; index += 1) {
        const task = batch.tasks[index];
        const existingItem = queue.find(
          (item) =>
            isVoxQueueItem(item) &&
            item.integration.taskId === task.taskId,
        );
        if (
          existingItem &&
          !["completed", "canceled"].includes(task.state)
        ) {
          if (["failed", "canceled"].includes(existingItem.status)) {
            existingItem.status = "queued";
            existingItem.stage = "queued";
            existingItem.error = null;
            existingItem.resume = null;
            existingItem.requiresFreshChat = false;
            existingItem.updatedAt = new Date().toISOString();
            existingItem.integration = {
              ...voxIntegration(batch, task, index),
              claimed: false,
              leaseToken: "",
              leaseExpiresAt: "",
            };
            resumedItems.push(existingItem);
          }
          continue;
        }
        if (
          existingTaskIds.has(task.taskId) ||
          ["completed", "canceled"].includes(task.state)
        ) {
          continue;
        }
        const references = [];
        const draftReferences = [];
        for (const reference of [...task.references].sort(
          (left, right) => Number(left.order || 0) - Number(right.order || 0),
        )) {
          if (!reference.blobId) {
            throw Object.assign(
              new Error(`VOX reference ${reference.name || reference.id} chưa có bytes.`),
              { code: "VOX_REFERENCE_BLOB_MISSING" },
            );
          }
          importedBlobIds.push(reference.blobId);
          const handle = {
            blobId: reference.blobId,
            name: reference.name,
            type: reference.type,
            size: reference.size,
            lastModified: Date.now(),
            width: 0,
            height: 0,
            order: Number(reference.order || 0),
            referenceId: reference.id || "",
          };
          references.push(handle);
          if (executionMode === "manual") {
            const record = await getBlob(reference.blobId);
            if (!record?.blob) {
              throw Object.assign(
                new Error(`Không đọc được bytes của ${reference.name}.`),
                { code: "VOX_REFERENCE_BLOB_MISSING" },
              );
            }
            const file = new File([record.blob], reference.name, {
              type: reference.type || record.blob.type,
              lastModified: Date.now(),
            });
            draftReferences.push({
              file,
              blobId: reference.blobId,
              previewUrl: URL.createObjectURL(record.blob),
              width: 0,
              height: 0,
              referenceId: reference.id || "",
            });
          }
        }
        const integration = voxIntegration(batch, task, index);
        const item = {
          id: crypto.randomUUID(),
          prompt: task.prompt,
          aspectRatio: task.aspectRatio || "9:16",
          outputName: task.expectedOutputName || `vox-${task.taskId}.png`,
          references,
          referenceMode: references.length ? "vox-ordered" : "none",
          status: "queued",
          stage: "queued",
          attempts: Math.max(0, Number(task.attempt || 1) - 1),
          createdAt: task.createdAt || batch.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          resultBlobId: "",
          result: null,
          pendingVoxResult: null,
          error: null,
          integration,
        };
        if (executionMode === "manual") {
          const line = createPromptLine(task.prompt);
          line.references = draftReferences;
          line.integration = integration;
          line.outputName = item.outputName;
          line.aspectRatio = item.aspectRatio;
          newLines.push(line);
        } else {
          newItems.push(item);
        }
      }
      const firstResumedGeneration = resumedItems.find(
        (item) => !item.pendingVoxResult?.blobId,
      );
      if (firstResumedGeneration) {
        firstResumedGeneration.requiresFreshChat = true;
      }
    } catch (error) {
      for (const blobId of importedBlobIds) {
        await deleteBlob(blobId).catch(() => {});
      }
      throw error;
    }

    if (newLines.length) {
      promptLines = newLines;
      $("#bulkPrompts").value = newLines
        .map((line) => line.prompt)
        .join("\n\n");
      $("#aspectRatio").value = newLines[0].aspectRatio || "9:16";
      $("#outputPrefix").value = `VOX-${batch.projectId.slice(0, 8)}`;
      renderPromptLines();
      scheduleDraftSave();
      activateTab("create");
      toast(
        `Đã nạp ${newLines.length} task VOX · kiểm tra rồi bấm Thêm và chạy`,
      );
    } else if (newItems.length || resumedItems.length) {
      queue = [...newItems, ...queue];
      await persistQueue();
      renderQueue();
      toast(
        `Đã nạp ${newItems.length} task mới` +
        `${resumedItems.length ? ` · tiếp tục ${resumedItems.length} task chưa có ảnh` : ""}`,
      );
    } else if (batch.state === "completed") {
      toast("VOX batch đã hoàn tất");
    }
    if (executionMode !== "manual") activateTab("queue");
    if (executionMode !== "manual" && run && queue.some((item) =>
      item.status === "queued" &&
      isVoxQueueItem(item) &&
      item.integration.batchId === batch.batchId
    )) {
      void runQueue();
    }
    return true;
  })().finally(() => {
    voxIntakePromise = null;
  });
  return voxIntakePromise;
}

async function claimVoxQueueItem(item) {
  if (!isVoxQueueItem(item) || item.integration.claimed) return;
  let task = null;
  let emptyClaimCount = 0;
  while (!task?.taskId) {
    await pauseBoundary();
    const claimed = await sendBackground("CLAIM_VOX_TASK", {
      batchId: item.integration.batchId,
    });
    task = claimed?.task || null;
    if (task?.taskId) break;

    emptyClaimCount += 1;
    const batch = await sendBackground("GET_VOX_BATCH_STATUS", {
      batchId: item.integration.batchId,
    });
    const remoteTask = batch?.tasks?.find(
      (candidate) => candidate.taskId === item.integration.taskId,
    );
    const leaseExpiresAt = Date.parse(remoteTask?.lease?.expiresAt || "");
    const leaseWaitMs = Number.isFinite(leaseExpiresAt)
      ? Math.max(0, leaseExpiresAt - Date.now() + 350)
      : 0;
    const activeRemoteStates = new Set([
      "claiming",
      "uploading_references",
      "submitting",
      "waiting",
      "collecting",
      "returning",
    ]);

    if (activeRemoteStates.has(remoteTask?.state) && leaseWaitMs > 0) {
      const boundedWaitMs = Math.min(leaseWaitMs, 5_000);
      if (emptyClaimCount === 1 || emptyClaimCount % 6 === 0) {
        logSession("warn", "vox_claim_lease_wait", {
          code: "VOX_CLAIM_LEASE_ACTIVE",
          message:
            `Task ${item.integration.taskId} còn lease từ phiên trước; ` +
            `tự thử lại sau ${Math.ceil(leaseWaitMs / 1000)} giây, không gửi prompt trùng.`,
          details: {
            taskId: item.integration.taskId,
            remoteState: remoteTask.state,
            leaseExpiresAt: remoteTask.lease?.expiresAt || "",
            emptyClaimCount,
          },
        });
      }
      await waitPausable(boundedWaitMs);
      continue;
    }

    if (
      ["queued", "failed"].includes(remoteTask?.state) &&
      emptyClaimCount < 4
    ) {
      await waitPausable(500);
      continue;
    }

    throw Object.assign(
      new Error(
        remoteTask
          ? `VOX chưa thể cấp task ${item.integration.taskId} (remote=${remoteTask.state}).`
          : "VOX không còn nhận diện task đang chờ của extension.",
      ),
      {
        code: "VOX_CLAIM_EMPTY",
        diagnostics: {
          batchId: item.integration.batchId,
          expectedTaskId: item.integration.taskId,
          remoteState: remoteTask?.state || "missing",
          leaseExpiresAt: remoteTask?.lease?.expiresAt || "",
          emptyClaimCount,
        },
      },
    );
  }
  if (task.taskId !== item.integration.taskId) {
    throw Object.assign(
      new Error(
        `VOX cấp task ${task.taskId}, nhưng queue đang chờ ${item.integration.taskId}.`,
      ),
      {
        code: "VOX_CLAIM_ORDER_MISMATCH",
        diagnostics: {
          expectedTaskId: item.integration.taskId,
          claimedTaskId: task.taskId,
        },
      },
    );
  }
  item.integration.claimed = true;
  item.integration.attempt = Number(task.attempt || item.integration.attempt || 1);
  item.integration.idempotencyKey =
    task.idempotencyKey || item.integration.idempotencyKey;
  item.integration.promptHash = task.promptHash || item.integration.promptHash;
  item.integration.taskRevision = Number(task.revision || 0);
  item.integration.leaseToken = task.lease?.token || "";
  item.integration.leaseExpiresAt = task.lease?.expiresAt || "";
  item.integration.remoteState = task.state || "claiming";
  await persistQueue();
  logSession("info", "vox_task_claimed", {
    message: `VOX task ${task.taskId} · beat ${task.beatId} · attempt ${item.integration.attempt}.`,
    details: {
      batchId: item.integration.batchId,
      taskId: task.taskId,
      beatId: task.beatId,
      leaseExpiresAt: item.integration.leaseExpiresAt,
    },
  });
}

function voxTaskPayload(item, state, details = {}) {
  return {
    batchId: item.integration.batchId,
    projectId: item.integration.projectId,
    beatId: item.integration.beatId,
    attempt: item.integration.attempt,
    idempotencyKey: item.integration.idempotencyKey,
    taskRevision: item.integration.taskRevision,
    leaseToken: item.integration.leaseToken,
    state,
    details,
  };
}

async function reportVoxProgress(item, state, details = {}, { required = true } = {}) {
  if (!isVoxQueueItem(item)) return null;
  try {
    const response = await sendBackground("VOX_TASK_PROGRESS", {
      taskId: item.integration.taskId,
      payload: voxTaskPayload(item, state, details),
    });
    item.integration.remoteState = state;
    item.integration.taskRevision = Number(
      response?.revision || item.integration.taskRevision,
    );
    item.integration.leaseExpiresAt =
      response?.lease?.expiresAt || item.integration.leaseExpiresAt;
    await persistQueue();
    return response;
  } catch (error) {
    if (required) throw error;
    logSession("warn", "vox_progress_deferred", {
      code: "VOX_PROGRESS_DEFERRED",
      message: `${state}: ${error.message}`,
    });
    return null;
  }
}

async function reportVoxFailure(item, error, stopped) {
  if (!isVoxQueueItem(item) || !item.integration.claimed) return;
  if (item.pendingVoxResult?.blobId) {
    logSession("warn", "vox_result_return_pending", {
      message: "Giữ bytes đã tạo để retry trả về VOX; không đánh dấu remote task failed.",
    });
    return;
  }
  try {
    if (stopped) {
      await sendBackground("VOX_TASK_CANCEL", {
        taskId: item.integration.taskId,
      });
      item.integration.remoteState = "canceled";
    } else {
      await sendBackground("VOX_TASK_FAIL", {
        taskId: item.integration.taskId,
        payload: {
          ...voxTaskPayload(item, "failed"),
          code: error.code || "INTERNAL_ERROR",
          message: error.message || String(error),
        },
      });
      item.integration.remoteState = "failed";
    }
    item.integration.claimed = false;
    item.integration.leaseToken = "";
    item.integration.leaseExpiresAt = "";
    await persistQueue();
  } catch (reportError) {
    logSession("warn", "vox_failure_report_deferred", {
      code: "VOX_FAILURE_REPORT_DEFERRED",
      message: reportError.message,
    });
  }
}

function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    void chrome.storage.local.set({
      [SESSIONS_KEY]: sessions.slice(0, 40).map((session) => ({
        ...session,
        logs: session.logs.slice(-250),
      })),
    });
  }, 180);
}

async function persistPromptLineReferences() {
  const result = [];
  for (const line of promptLines) {
    const handles = [];
    for (let index = 0; index < line.references.length; index += 1) {
      const entry = line.references[index];
      if (!entry.blobId) {
        entry.blobId = await putBlob(entry.file, {
          kind: "queue-reference",
          name: entry.file.name,
        });
      }
      handles.push({
        blobId: entry.blobId,
        name: entry.file.name,
        type: entry.file.type,
        size: entry.file.size,
        lastModified: entry.file.lastModified,
        width: entry.width,
        height: entry.height,
        order: index,
      });
    }
    result.push(handles);
  }
  return result;
}

async function addDraftToQueue({ run = false } = {}) {
  if (!promptLines.some((line) => line.prompt?.trim())) {
    toast("Hãy nhập ít nhất một prompt");
    return false;
  }

  const addButton = $("#addToQueue");
  const runButton = $("#addAndRun");
  addButton.disabled = true;
  runButton.disabled = true;
  try {
    const referencesByLine = await persistPromptLineReferences();
    const rows = promptLines.map((line, index) => ({
      line,
      prompt: line.prompt?.trim() || "",
      references: referencesByLine[index] || [],
    }));
    const missingIndex = rows.findIndex((row) => !row.prompt);
    if (missingIndex >= 0) {
      toast(`Line ${missingIndex + 1} chưa có prompt`);
      return false;
    }
    const now = new Date().toISOString();
    const newItems = rows.map((row, index) => ({
      id: crypto.randomUUID(),
      prompt: row.prompt,
      aspectRatio: row.line.aspectRatio || $("#aspectRatio").value,
      outputName:
        row.line.outputName ||
        buildOutputName($("#outputPrefix").value, index, rows.length),
      references: row.references,
      referenceMode: row.line.integration
        ? (row.references.length ? "vox-ordered" : "none")
        : (row.references.length ? "line-references" : "none"),
      status: "queued",
      stage: "queued",
      attempts: row.line.integration
        ? Math.max(0, Number(row.line.integration.attempt || 1) - 1)
        : 0,
      createdAt: now,
      updatedAt: now,
      resultBlobId: "",
      result: null,
      pendingVoxResult: null,
      error: null,
      ...(row.line.integration
        ? { integration: { ...row.line.integration } }
        : {}),
    }));
    queue = [...newItems, ...queue];
    await persistQueue();
    renderQueue();
    renderRunner();
    toast(`Đã thêm ${newItems.length} tác vụ`);
    if (rows.some((row) => row.line.integration)) {
      for (const row of rows) {
        for (const reference of row.line.references) {
          if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
        }
      }
      promptLines = [];
      $("#bulkPrompts").value = "";
      await chrome.storage.local.remove(DRAFT_KEY);
      renderPromptLines();
    }
    if (run) {
      activateTab("queue");
      void runQueue();
    }
    return true;
  } finally {
    addButton.disabled = false;
    runButton.disabled = false;
  }
}

function queueCounts() {
  return {
    pending: queue.filter((item) => item.status === "queued").length,
    completed: queue.filter((item) => item.status === "completed").length,
    failed: queue.filter((item) => ["failed", "canceled"].includes(item.status)).length,
  };
}

function orderedQueueItems() {
  const priority = (item) => {
    if (item.id === runner.currentItemId || item.status === "running") return 0;
    if (item.status === "queued") return 1;
    if (item.status === "completed") return 2;
    return 3;
  };
  return [...queue].sort((left, right) => {
    const stateDifference = priority(left) - priority(right);
    if (stateDifference) return stateDifference;
    if (
      isVoxQueueItem(left) &&
      isVoxQueueItem(right) &&
      left.integration.batchId === right.integration.batchId
    ) {
      const orderDifference =
        Number(left.integration.taskOrder || 0) -
        Number(right.integration.taskOrder || 0);
      if (orderDifference) return orderDifference;
    }
    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  });
}

function queueResultMarkup(item) {
  if (item.status !== "completed" || !item.resultBlobId) return "";
  const dimensions = item.result
    ? `${item.result.width || "?"}×${item.result.height || "?"} · ${Math.round((item.result.size || 0) / 1024)} KB`
    : "Đã lưu ảnh";
  return `
    <div class="queue-result">
      <img data-result-id="${escapeHtml(item.resultBlobId)}" alt="Kết quả ${escapeHtml(item.outputName)}">
      <div class="queue-result-copy">
        <strong>${escapeHtml(item.outputName)}</strong>
        <span>${escapeHtml(dimensions)}</span>
        <button class="button secondary" data-action="download" data-id="${escapeHtml(item.id)}" type="button">Tải ảnh</button>
      </div>
    </div>
  `;
}

function renderQueue() {
  const counts = queueCounts();
  $("#queueTabCount").textContent = queue.length;
  $("#queuePendingCount").textContent = counts.pending;
  $("#queueCompletedCount").textContent = counts.completed;
  $("#queueFailedCount").textContent = counts.failed;

  const list = $("#queueList");
  if (!queue.length) {
    list.innerHTML = '<div class="empty-state">Hàng chờ đang trống. Tạo prompt ở tab “Tạo ảnh hàng loạt”.</div>';
  } else {
    const displayQueue = orderedQueueItems();
    list.innerHTML = displayQueue.map((item, index) => {
      const active = runner.currentItemId === item.id;
      const canChange = !active && !runner.running;
      return `
        <article class="queue-item ${escapeHtml(item.status)}" data-id="${escapeHtml(item.id)}">
          <div class="queue-item-head">
            <strong>#${index + 1} · ${escapeHtml(item.outputName)}</strong>
            <span class="state">${escapeHtml(stateLabel(active ? item.stage : item.status))}</span>
          </div>
          <p class="queue-item-prompt">${escapeHtml(item.prompt)}</p>
          <div class="queue-item-meta">
            <span>${escapeHtml(item.aspectRatio)}</span>
            <span>${item.references.length} ảnh ref</span>
            <span>lần chạy ${item.attempts || 0}</span>
            ${isVoxQueueItem(item)
              ? `<span>VOX · beat ${escapeHtml(item.integration.beatId)}</span>`
              : ""}
          </div>
          ${item.error ? `<p class="queue-error">${escapeHtml(item.error.code)}: ${escapeHtml(item.error.message)}</p>` : ""}
          <div class="queue-item-actions">
            ${["failed", "canceled"].includes(item.status) ? `<button class="button secondary" data-action="retry" data-id="${escapeHtml(item.id)}" type="button">Thử lại</button>` : ""}
            <button class="button danger" data-action="remove" data-id="${escapeHtml(item.id)}" type="button" ${!canChange ? "disabled" : ""}>Xóa</button>
          </div>
          ${queueResultMarkup(item)}
        </article>
      `;
    }).join("");
  }
  void hydrateResultImages();
  renderRunner();
}

async function hydrateResultImages() {
  for (const image of $$("img[data-result-id]")) {
    const blobId = image.dataset.resultId;
    if (resultUrls.has(blobId)) {
      image.src = resultUrls.get(blobId);
      continue;
    }
    const record = await getBlob(blobId);
    if (!record?.blob) continue;
    const url = URL.createObjectURL(record.blob);
    resultUrls.set(blobId, url);
    if (image.isConnected) image.src = url;
  }
}

function renderRunner() {
  const current = queue.find((item) => item.id === runner.currentItemId);
  const counts = queueCounts();
  const badge = $("#statusBadge");
  badge.classList.toggle("running", runner.running);
  badge.classList.toggle("failed", !runner.running && counts.failed > 0);
  badge.textContent = runner.running
    ? runner.paused
      ? "Tạm dừng"
      : "Đang chạy"
    : counts.failed
      ? `${counts.failed} lỗi`
      : counts.pending
        ? `${counts.pending} chờ`
        : "Sẵn sàng";

  $("#activeTaskTitle").textContent = current
    ? current.outputName
    : runner.running
      ? "Đang chuẩn bị tác vụ"
      : "Chưa có tác vụ";
  $("#activeTaskState").textContent = current
    ? stateLabel(current.stage)
    : runner.paused
      ? "tạm dừng"
      : "idle";
  $("#activeTaskDetail").textContent = current
    ? `${current.prompt.slice(0, 150)}${current.prompt.length > 150 ? "…" : ""}`
    : counts.pending
      ? `${counts.pending} tác vụ đang chờ.`
      : "Thêm prompt vào hàng chờ để bắt đầu.";
  const stageIndex = current ? STAGES.indexOf(current.stage) : -1;
  $("#progressBar").style.width =
    `${stageIndex < 0 ? 0 : ((stageIndex + 1) / STAGES.length) * 100}%`;

  for (const id of ["startQueue", "startQueueCreate"]) {
    $(id.startsWith("#") ? id : `#${id}`).disabled = runner.running || counts.pending === 0;
  }
  for (const id of ["pauseQueue", "pauseQueueCreate"]) {
    const button = $(`#${id}`);
    button.disabled = !runner.running;
    button.textContent = runner.paused ? "Tiếp tục" : "Tạm dừng";
  }
  for (const id of ["stopQueue", "stopQueueCreate"]) {
    $(`#${id}`).disabled = !runner.running;
  }
}

function startSession(item) {
  const session = {
    id: crypto.randomUUID(),
    taskId: item.id,
    outputName: item.outputName,
    prompt: item.prompt,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: "",
    logs: [],
  };
  sessions.unshift(session);
  sessions = sessions.slice(0, 40);
  currentSessionId = session.id;
  renderSessions();
  scheduleSessionSave();
  return session;
}

function activeSession() {
  return sessions.find((session) => session.id === currentSessionId) || null;
}

function logSession(level, event, details = {}) {
  const session = activeSession();
  if (!session) return;
  session.logs.push({
    at: new Date().toISOString(),
    level,
    event,
    code: details.code || "",
    message: details.message || "",
    details: details.details || null,
  });
  session.logs = session.logs.slice(-250);
  renderSessions();
  scheduleSessionSave();
}

function finishSession(status) {
  const session = activeSession();
  if (!session) return;
  session.status = status;
  session.endedAt = new Date().toISOString();
  currentSessionId = "";
  renderSessions();
  scheduleSessionSave();
}

function formatSession(session) {
  const header = [
    `SESSION ${session.id}`,
    `STATUS ${session.status}`,
    `OUTPUT ${session.outputName}`,
    `STARTED ${session.startedAt}`,
    session.endedAt ? `ENDED ${session.endedAt}` : "",
    `PROMPT\n${session.prompt}`,
    "",
  ].filter(Boolean);
  const lines = session.logs.flatMap((entry) => {
    const first =
      `${entry.at}  ${entry.level.toUpperCase()}  ${entry.event}` +
      `${entry.code ? ` · ${entry.code}` : ""}`;
    const output = [first];
    if (entry.message) output.push(entry.message);
    if (entry.details) output.push(JSON.stringify(entry.details, null, 2));
    output.push("");
    return output;
  });
  return [...header, ...lines].join("\n");
}

function renderSessions() {
  const container = $("#sessionLogs");
  const openIds = new Set(
    $$("details[open][data-session-id]", container).map((details) => details.dataset.sessionId),
  );
  const scrollPositions = new Map(
    $$("details[data-session-id] pre", container).map((pre) => [
      pre.closest("details").dataset.sessionId,
      pre.scrollTop,
    ]),
  );
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state">Chưa có phiên chạy nào.</div>';
    return;
  }

  container.replaceChildren();
  for (const session of sessions) {
    const details = document.createElement("details");
    details.className = `session-log ${session.status}`;
    details.dataset.sessionId = session.id;
    details.open = session.status === "running" || openIds.has(session.id);

    const summary = document.createElement("summary");
    const title = document.createElement("div");
    title.className = "session-title";
    const strong = document.createElement("strong");
    strong.textContent = session.outputName;
    const meta = document.createElement("span");
    meta.textContent =
      `${stateLabel(session.status)} · ${new Date(session.startedAt).toLocaleString("vi-VN")} · ${session.logs.length} event`;
    title.append(strong, meta);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "session-copy";
    copy.dataset.copySession = session.id;
    copy.textContent = "Copy";
    summary.append(title, copy);

    const pre = document.createElement("pre");
    pre.textContent = formatSession(session);
    details.append(summary, pre);
    container.append(details);
    if (scrollPositions.has(session.id)) pre.scrollTop = scrollPositions.get(session.id);
    if (session.status === "running" && !scrollPositions.has(session.id)) {
      pre.scrollTop = pre.scrollHeight;
    }
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

async function updateQueueItem(item, patch) {
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  await persistQueue();
  renderQueue();
}

async function pauseBoundary() {
  while (runner.paused && !runner.stopRequested) {
    await sleep(200);
  }
  if (runner.stopRequested) {
    throw Object.assign(new Error("Đã dừng theo yêu cầu người dùng."), {
      code: "USER_STOPPED",
    });
  }
}

async function waitPausable(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    await pauseBoundary();
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function loadTaskReferences(item) {
  const references = [];
  for (let index = 0; index < item.references.length; index += 1) {
    const handle = item.references[index];
    const record = await getBlob(handle.blobId);
    if (!record?.blob) {
      throw Object.assign(
        new Error(`Không tìm thấy dữ liệu ảnh tham chiếu ${index + 1}: ${handle.name}.`),
        { code: "REFERENCE_BLOB_MISSING" },
      );
    }
    references.push({
      name: handle.name,
      type: handle.type || record.blob.type,
      size: handle.size || record.blob.size,
      lastModified: handle.lastModified || Date.now(),
      dataUrl: await blobToDataUrl(record.blob),
    });
    logSession("info", "reference_loaded", {
      message: `${index + 1}/${item.references.length} · ${handle.name} · ${Math.round(record.blob.size / 1024)} KB`,
    });
  }
  return references;
}

async function downloadTaskResult(item, { manual = false } = {}) {
  const folder = normalizeFolder(runnerSettings.downloadFolder);
  const filename = [folder, normalizeFilename(item.outputName)]
    .filter(Boolean)
    .join("/");
  const started = await sendBackground("DOWNLOAD_STORED_RESULT", {
    blobId: item.resultBlobId,
    filename,
    saveAs: runnerSettings.downloadMode === "ask",
  });
  const downloadId = started.downloadId;
  if (!manual) {
    logSession("success", "download_started", {
      message:
        `${filename} · downloadId=${downloadId} · ` +
        `${runnerSettings.downloadMode === "ask" ? "Save As có thể đổi thư mục" : "service worker ép đường dẫn thư mục"}`,
    });
  }
  const completed = await waitForDownload(downloadId);
  const actualParts = String(completed.filename || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  const folderParts = folder.split("/").filter(Boolean);
  const actualFolderTail = folderParts.length
    ? actualParts.slice(-(folderParts.length + 1), -1).join("/")
    : "";
  const actualTail = actualParts.slice(-(folderParts.length + 1)).join("/");
  const folderVerified = !folderParts.length || actualFolderTail === folder;
  if (!manual) {
    logSession(folderVerified ? "success" : "warn", folderVerified
      ? "download_completed"
      : "download_folder_mismatch", {
      message: folderVerified
        ? `Chrome đã lưu đúng đường dẫn ${filename}.`
        : `Yêu cầu ${filename}, Chrome báo đuôi đường dẫn ${actualTail || "(không xác định)"}.`,
    });
  }
  return { downloadId, filename: completed.filename, folderVerified };
}

async function waitForDownload(downloadId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const download = await sendBackground("GET_RESULT_DOWNLOAD_STATUS", { downloadId });
    if (download?.state === "complete") return download;
    if (download?.state === "interrupted") {
      throw Object.assign(
        new Error(`Chrome download bị gián đoạn: ${download.error || "unknown"}.`),
        { code: "DOWNLOAD_INTERRUPTED" },
      );
    }
    await sleep(300);
  }
  throw Object.assign(
    new Error("Chrome chưa xác nhận tải xong sau 120 giây."),
    { code: "DOWNLOAD_TIMEOUT" },
  );
}

async function openConversationRecoveryTab(conversationUrl) {
  let url;
  try {
    url = new URL(conversationUrl);
  } catch {
    throw Object.assign(new Error("URL conversation Gemini không hợp lệ."), {
      code: "RECOVERY_CHAT_URL_INVALID",
    });
  }
  if (
    url.origin !== "https://gemini.google.com" ||
    !/^\/app\/[a-z0-9]+/i.test(url.pathname)
  ) {
    throw Object.assign(
      new Error("Không thể recovery vì chưa có URL conversation Gemini hợp lệ."),
      { code: "RECOVERY_CHAT_URL_INVALID" },
    );
  }
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  if (!tab?.id) {
    throw Object.assign(new Error("Chrome không tạo được tab recovery Gemini."), {
      code: "RECOVERY_TAB_CREATE_FAILED",
    });
  }
  if (tab.status !== "complete") await waitForTab(tab.id);
  return chrome.tabs.get(tab.id);
}

async function completeVoxResultReturn(item) {
  const pending = item.pendingVoxResult;
  if (!isVoxQueueItem(item) || !pending?.blobId) {
    throw Object.assign(
      new Error("Không tìm thấy VOX result bytes đang chờ trả về."),
      { code: "VOX_RESULT_BYTES_MISSING" },
    );
  }
  const confirmation = await sendBackground("VOX_TASK_RESULT", {
    taskId: item.integration.taskId,
    blobId: pending.blobId,
    metadata: {
      batchId: item.integration.batchId,
      projectId: item.integration.projectId,
      beatId: item.integration.beatId,
      attempt: item.integration.attempt,
      idempotencyKey: item.integration.idempotencyKey,
      taskRevision: item.integration.taskRevision,
      leaseToken: item.integration.leaseToken,
      expectedOutputName: item.outputName,
      checksum: pending.checksum,
      mimeType: pending.type,
      byteLength: pending.size,
      width: pending.width,
      height: pending.height,
    },
  });
  if (!confirmation?.saved) {
    throw Object.assign(
      new Error("VOX chưa xác nhận đã lưu và gắn ảnh vào task."),
      { code: "RESULT_SAVE_UNCONFIRMED" },
    );
  }
  item.integration.remoteState = "completed";
  item.integration.confirmation = confirmation;
  await updateQueueItem(item, {
    status: "completed",
    stage: "completed",
    resultBlobId: pending.blobId,
    result: {
      name: item.outputName,
      width: pending.width,
      height: pending.height,
      size: pending.size,
      type: pending.type,
    },
    pendingVoxResult: null,
    error: null,
    resume: null,
  });
  logSession("success", "vox_result_confirmed", {
    message:
      `VOX đã lưu task ${item.integration.taskId} cho beat ` +
      `${item.integration.beatId}${confirmation.duplicate ? " · idempotent replay" : ""}.`,
    details: {
      saved: confirmation.saved,
      duplicate: Boolean(confirmation.duplicate),
      taskId: confirmation.taskId || item.integration.taskId,
      beatId: confirmation.beatId || item.integration.beatId,
    },
  });
  if (runnerSettings.autoDownload) {
    try {
      await downloadTaskResult(item);
    } catch (error) {
      item.downloadError = error.message;
      await persistQueue();
      logSession("warn", "download_failed", { message: error.message });
    }
  }
  finishSession("completed");
  return true;
}

async function executeQueueItem(item) {
  startSession(item);
  const isRecovery = Boolean(item.resume?.baseline);
  await updateQueueItem(item, {
    status: "running",
    stage: isRecovery ? "waiting" : "claiming",
    attempts: isRecovery ? item.attempts || 1 : (item.attempts || 0) + 1,
    error: null,
  });
  logSession("info", "session_start", {
    message: isRecovery
      ? "Tiếp tục theo dõi prompt đã gửi trước khi side panel reload; không gửi lại."
      : item.requiresFreshChat
        ? "Task retry sẽ mở New Chat mới; không dùng lại tab Gemini đã lỗi."
        : "Dùng tab Gemini hiện có, không reload trang.",
  });

  try {
    if (isVoxQueueItem(item) && item.pendingVoxResult?.blobId) {
      logSession("info", "vox_result_retry", {
        message: "Đã có image bytes; chỉ retry trả về VOX, không submit lại Gemini.",
      });
      await updateQueueItem(item, { stage: "returning" });
      return await completeVoxResultReturn(item);
    }
    if (isVoxQueueItem(item)) {
      await claimVoxQueueItem(item);
    }
    const config = await getSelectorConfig();
    let tab;
    let submission;
    if (isRecovery) {
      tab = await chrome.tabs.get(item.resume.tabId).catch(() => null);
      if (
        (!tab?.id || tab.url !== item.resume.baseline.pageUrl) &&
        item.resume.baseline.pageUrl
      ) {
        const matching = await chrome.tabs.query({ url: "https://gemini.google.com/app*" });
        tab = matching.find((candidate) => candidate.url === item.resume.baseline.pageUrl) || null;
      }
      if (!tab?.id || !tab.url?.startsWith("https://gemini.google.com/app")) {
        tab = await openConversationRecoveryTab(item.resume.baseline.pageUrl);
        await updateQueueItem(item, {
          resume: {
            ...item.resume,
            tabId: tab.id,
            reopenedAt: new Date().toISOString(),
          },
        });
        logSession("warn", "recovery_tab_reopened", {
          message:
            "Tab conversation cũ không còn; đã mở lại conversation trong tab mới, submit count=0.",
          details: {
            tabId: tab.id,
            conversationUrl: item.resume.baseline.pageUrl,
          },
        });
      }
      if (tab.status !== "complete") await waitForTab(tab.id);
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      submission = { ok: true, baseline: item.resume.baseline };
      logSession("info", "submission_recovered", {
        message: `Tiếp tục scanner tại ${item.resume.baseline.pageUrl}; submit count=0.`,
      });
    } else {
      const references = await loadTaskReferences(item);
      await pauseBoundary();
      if (item.requiresFreshChat) {
        tab = await sendBackground("OPEN_FRESH_GEMINI", {
          reason: isVoxQueueItem(item) ? "vox-retry" : "queue-retry",
        });
        await updateQueueItem(item, { requiresFreshChat: false });
        logSession("warn", "retry_new_chat_opened", {
          message:
            "Task chạy lại trong New Chat mới; không sử dụng tab Gemini đã lỗi.",
          details: {
            tabId: tab.id,
            previousErrorAvoided: true,
          },
        });
      } else {
        tab = await getCurrentOrExistingGeminiTab();
      }
      if (tab.status !== "complete") await waitForTab(tab.id);
      await pauseBoundary();

      await updateQueueItem(item, {
        stage: references.length ? "uploading_references" : "submitting",
      });
      await reportVoxProgress(
        item,
        references.length ? "uploading_references" : "submitting",
        { referenceCount: references.length },
      );
      logSession("info", "task_injection_start", {
        message: `${references.length} ảnh tham chiếu · prompt chỉ gửi một lần.`,
      });
      const submittedPrompt = item.aspectRatio
        ? `${item.prompt}\n\nGenerate the final image in ${item.aspectRatio} aspect ratio.`
        : item.prompt;
      submission = await submitGeminiTask(
        tab.id,
        { prompt: submittedPrompt, references },
        config,
      );
      for (const entry of submission?.trace || []) {
        logSession(submission.ok ? "info" : "error", `[Gemini +${entry.elapsedMs}ms] ${entry.step}`, {
          message: entry.message,
          details: entry.details || null,
        });
      }
      if (!submission?.ok) {
        throw Object.assign(new Error(`${submission.step}: ${submission.message}`), {
          code: submission.code || "INJECTION_FAILED",
          diagnostics: submission.diagnostics,
        });
      }
    }

    await updateQueueItem(item, {
      stage: "waiting",
      resume: {
        tabId: tab.id,
        baseline: submission.baseline,
        submittedAt: item.resume?.submittedAt || new Date().toISOString(),
        tabRecoveryCount: Number(item.resume?.tabRecoveryCount) || 0,
      },
    });
    await reportVoxProgress(
      item,
      "waiting",
      { conversationUrl: submission.baseline.pageUrl },
      { required: false },
    );
    logSession("info", "scanner_started", {
      message:
        "Theo dõi DOM mỗi giây; nhận ảnh mới đã tải đủ và ổn định, kể cả khi nút Stop của Gemini còn hiển thị.",
    });
    const timeoutMs = Math.max(2, Number(runnerSettings.timeoutMinutes) || 10) * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    let scanCount = 0;
    let candidate = null;
    let stability = { key: "", count: 0, required: 2, candidate: null };
    let stagnation = { fingerprint: "", count: 0 };
    let tabRecoveryCount = Number(item.resume?.tabRecoveryCount) || 0;
    while (Date.now() < deadline && !candidate) {
      await pauseBoundary();
      let scan;
      try {
        scan = await scanGeminiResult(tab.id, submission.baseline, config);
      } catch (error) {
        if (tabRecoveryCount >= 1) throw error;
        logSession("warn", "scanner_tab_unavailable", {
          message: `Tab scanner không phản hồi: ${error.message}. Đang mở tab recovery.`,
        });
        tab = await openConversationRecoveryTab(submission.baseline.pageUrl);
        tabRecoveryCount += 1;
        stability = { key: "", count: 0, required: 2, candidate: null };
        stagnation = { fingerprint: "", count: 0 };
        await updateQueueItem(item, {
          resume: {
            ...item.resume,
            tabId: tab.id,
            tabRecoveryCount,
            recoveredAt: new Date().toISOString(),
          },
        });
        logSession("warn", "scanner_recovered", {
          message:
            "Đã chuyển scanner sang tab conversation mới; không gửi lại prompt.",
          details: {
            tabId: tab.id,
            reason: "scan-error",
            submitCount: 0,
          },
        });
        continue;
      }
      scanCount += 1;
      stability = advanceCandidateStability(stability, scan);
      stagnation = advanceScanStagnation(stagnation, scan);
      candidate = stability.candidate;
      if (scanCount === 1 || scanCount % 10 === 0) {
        logSession("info", "scanner_heartbeat", {
          message:
            `scan=${scanCount}, turns=${scan.turnCount}, candidates=${scan.candidateCount}, ` +
            `candidateReady=${Boolean(scan.candidate?.ready)}, ` +
            `globalGenerating=${scan.generating}, stable=${stability.count}/${stability.required}`,
        });
      }
      if (isVoxQueueItem(item) && scanCount % 30 === 0) {
        await reportVoxProgress(
          item,
          "waiting",
          {
            scanCount,
            candidateCount: scan.candidateCount,
            generating: scan.generating,
            candidateReady: Boolean(scan.candidate?.ready),
            stableCount: stability.count,
            stableRequired: stability.required,
          },
          { required: false },
        );
      }
      if (
        !candidate &&
        stagnation.count >= 60 &&
        tabRecoveryCount < 1
      ) {
        const previousTabId = tab.id;
        logSession("warn", "scanner_stalled", {
          message:
            "DOM Gemini không thay đổi trong 60 lần quét; đang mở lại conversation trong tab mới.",
          details: {
            previousTabId,
            conversationUrl: submission.baseline.pageUrl,
            submitCount: 0,
          },
        });
        tab = await openConversationRecoveryTab(submission.baseline.pageUrl);
        tabRecoveryCount += 1;
        stability = { key: "", count: 0, required: 2, candidate: null };
        stagnation = { fingerprint: "", count: 0 };
        await updateQueueItem(item, {
          resume: {
            ...item.resume,
            tabId: tab.id,
            tabRecoveryCount,
            recoveredAt: new Date().toISOString(),
          },
        });
        logSession("warn", "scanner_recovered", {
          message:
            "Đã chuyển scanner sang tab conversation mới; tiếp tục nhận ảnh mà không gửi lại prompt.",
          details: {
            previousTabId,
            tabId: tab.id,
            reason: "60-unchanged-scans",
            submitCount: 0,
          },
        });
        continue;
      }
      if (!candidate) await sleep(1000);
    }
    if (!candidate) {
      throw Object.assign(
        new Error(`Không thấy ảnh Gemini mới sau ${runnerSettings.timeoutMinutes} phút.`),
        { code: "GENERATION_TIMEOUT" },
      );
    }

    await updateQueueItem(item, { stage: "collecting" });
    await reportVoxProgress(
      item,
      "collecting",
      { width: candidate.width, height: candidate.height },
      { required: false },
    );
    logSession("info", "result_found", {
      message: `${candidate.width}×${candidate.height} · ${String(candidate.src).slice(0, 240)}`,
      details: {
        imageKey: candidate.imageKey || "",
        turnId: candidate.turnId || "",
        turnIndex: candidate.turnIndex,
      },
    });
    const result = await collectGeminiResult(tab.id, candidate);
    if (!result?.ok) {
      throw Object.assign(
        new Error(result?.message || "Không thể lấy bytes của ảnh đã tạo."),
        { code: "RESULT_FETCH_FAILED" },
      );
    }

    await updateQueueItem(item, { stage: "returning" });
    const blob = await (await fetch(result.dataUrl)).blob();
    const resultBlobId = await putBlob(blob, {
      kind: isVoxQueueItem(item) ? "vox-result" : "standalone-result",
      taskId: item.id,
      outputName: item.outputName,
    });
    if (isVoxQueueItem(item)) {
      const checksum = await sha256(await blob.arrayBuffer());
      await updateQueueItem(item, {
        stage: "returning",
        pendingVoxResult: {
          blobId: resultBlobId,
          checksum,
          width: candidate.width,
          height: candidate.height,
          size: result.size,
          type: result.type,
        },
      });
      await reportVoxProgress(
        item,
        "returning",
        { checksum, byteLength: result.size },
        { required: false },
      );
      return await completeVoxResultReturn(item);
    }
    await updateQueueItem(item, {
      status: "completed",
      stage: "completed",
      resultBlobId,
      result: {
        name: item.outputName,
        width: candidate.width,
        height: candidate.height,
        size: result.size,
        type: result.type,
      },
      error: null,
      resume: null,
    });
    logSession("success", "task_completed", {
      message: `Đã thu thập ảnh ${candidate.width}×${candidate.height} · ${Math.round(result.size / 1024)} KB.`,
    });

    if (runnerSettings.autoDownload) {
      try {
        await downloadTaskResult(item);
      } catch (error) {
        item.downloadError = error.message;
        await persistQueue();
        logSession("warn", "download_failed", { message: error.message });
      }
    }
    finishSession("completed");
    return true;
  } catch (error) {
    const code = error.code || "INTERNAL_ERROR";
    const stopped = code === "USER_STOPPED";
    await reportVoxFailure(
      item,
      { code, message: error.message || String(error) },
      stopped,
    );
    await updateQueueItem(item, {
      status: stopped ? "canceled" : "failed",
      stage: stopped ? "canceled" : "failed",
      error: { code, message: error.message },
    });
    logSession("error", "task_failed", {
      code,
      message: error.message,
      details: error.diagnostics || null,
    });
    finishSession(stopped ? "canceled" : "failed");
    return false;
  }
}

async function runQueue() {
  if (runner.running) return;
  if (!queue.some((item) => item.status === "queued")) {
    toast("Không có tác vụ đang chờ");
    return;
  }
  runner.running = true;
  runner.paused = false;
  runner.stopRequested = false;
  renderQueue();

  try {
    while (!runner.stopRequested) {
      await pauseBoundary();
      const item = orderedQueueItems().find((candidate) => candidate.status === "queued");
      if (!item) break;
      runner.currentItemId = item.id;
      renderQueue();
      await executeQueueItem(item);
      runner.currentItemId = "";
      renderQueue();
      if (runner.stopRequested) break;
      if (queue.some((candidate) => candidate.status === "queued")) {
        const delayMs = Math.max(0, Number(runnerSettings.delaySeconds) || 0) * 1000;
        if (delayMs) await waitPausable(delayMs);
      }
    }
  } catch (error) {
    if (error.code !== "USER_STOPPED") toast(error.message);
  } finally {
    runner.running = false;
    runner.paused = false;
    runner.stopRequested = false;
    runner.currentItemId = "";
    renderQueue();
    toast(queue.some((item) => item.status === "failed")
      ? "Hàng chờ đã kết thúc, có tác vụ lỗi"
      : "Hàng chờ đã kết thúc");
  }
}

function togglePause() {
  if (!runner.running) return;
  runner.paused = !runner.paused;
  logSession("warn", runner.paused ? "queue_paused" : "queue_resumed", {
    message: runner.paused ? "Tạm dừng tại ranh giới an toàn." : "Tiếp tục xử lý.",
  });
  renderRunner();
}

function requestStop() {
  if (!runner.running) return;
  runner.stopRequested = true;
  runner.paused = false;
  logSession("warn", "stop_requested", {
    message: "Sẽ dừng ở ranh giới thao tác an toàn kế tiếp.",
  });
  renderRunner();
}

async function removeQueueItem(item) {
  if (
    isVoxQueueItem(item) &&
    (item.status === "queued" || item.integration.claimed)
  ) {
    await sendBackground("VOX_TASK_CANCEL", {
      taskId: item.integration.taskId,
    }).catch(() => {});
  }
  const referenceBlobIds = (item.references || []).map((reference) => reference.blobId);
  if (item.resultBlobId) {
    await deleteBlob(item.resultBlobId).catch(() => {});
    const url = resultUrls.get(item.resultBlobId);
    if (url) URL.revokeObjectURL(url);
    resultUrls.delete(item.resultBlobId);
  }
  queue = queue.filter((candidate) => candidate.id !== item.id);
  await cleanupReferenceBlobs(referenceBlobIds);
  await persistQueue();
  renderQueue();
}

async function cleanupReferenceBlobs(blobIds) {
  const retained = new Set([
    ...promptLines.flatMap((line) =>
      line.references.map((entry) => entry.blobId),
    ),
    ...queue.flatMap((item) =>
      (item.references || []).map((reference) => reference.blobId),
    ),
  ]);
  for (const blobId of new Set(blobIds.filter(Boolean))) {
    if (!retained.has(blobId)) await deleteBlob(blobId).catch(() => {});
  }
}

async function clearItems(predicate) {
  const removed = queue.filter(predicate);
  for (const item of removed) {
    if (
      isVoxQueueItem(item) &&
      (item.status === "queued" || item.integration.claimed)
    ) {
      await sendBackground("VOX_TASK_CANCEL", {
        taskId: item.integration.taskId,
      }).catch(() => {});
    }
  }
  const referenceBlobIds = removed.flatMap((item) =>
    (item.references || []).map((reference) => reference.blobId),
  );
  for (const item of removed) {
    if (item.resultBlobId) {
      await deleteBlob(item.resultBlobId).catch(() => {});
      const url = resultUrls.get(item.resultBlobId);
      if (url) URL.revokeObjectURL(url);
      resultUrls.delete(item.resultBlobId);
    }
  }
  queue = queue.filter((item) => !predicate(item));
  await cleanupReferenceBlobs(referenceBlobIds);
  await persistQueue();
  renderQueue();
}

async function loadLocalState() {
  const stored = await chrome.storage.local.get({
    [QUEUE_KEY]: [],
    [SETTINGS_KEY]: DEFAULT_SETTINGS,
    [SESSIONS_KEY]: [],
    [DRAFT_KEY]: {},
  });
  queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  let queueChanged = false;
  const legacyGroups = new Map();
  for (const item of queue) {
    if (
      item.status !== "completed" &&
      item.referenceMode === "shared" &&
      (item.references || []).length > 1
    ) {
      const key =
        `${item.createdAt || ""}|` +
        item.references.map((reference) => reference.blobId).join(",");
      const group = legacyGroups.get(key) || [];
      group.push(item);
      legacyGroups.set(key, group);
    }
  }
  for (const group of legacyGroups.values()) {
    const references = group[0].references;
    if (group.length !== references.length) continue;
    group.forEach((item, index) => {
      item.references = references[index] ? [references[index]] : [];
      item.referenceMode = "one-to-one";
      item.error = {
        code: "QUEUE_MIGRATED_ONE_TO_ONE",
        message: `Đã đổi tác vụ cũ sang ảnh ${index + 1}–prompt ${index + 1}; bấm Thử lại để chạy.`,
      };
    });
    queueChanged = true;
  }
  for (const item of queue) {
    if (TRANSIENT_STATES.has(item.status) || TRANSIENT_STATES.has(item.stage)) {
      item.status = "queued";
      item.stage = "queued";
      item.error = item.resume?.baseline
        ? {
            code: "RESUME_SCANNER_READY",
            message: "Prompt đã được gửi; lần chạy tiếp theo chỉ tiếp tục tìm ảnh, không submit lại.",
          }
        : {
            code: "RECOVERED_AFTER_RELOAD",
            message: "Tác vụ chưa submit được đưa về hàng chờ để chạy lại an toàn.",
          };
      queueChanged = true;
    }
  }
  runnerSettings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  sessions = Array.isArray(stored[SESSIONS_KEY]) ? stored[SESSIONS_KEY] : [];
  for (const session of sessions) {
    if (session.status === "running") {
      session.status = "failed";
      session.endedAt = new Date().toISOString();
      session.logs.push({
        at: new Date().toISOString(),
        level: "warn",
        event: "session_recovered_after_reload",
        code: "PANEL_RELOADED",
        message: "Phiên cũ bị ngắt khi side panel đóng; queue đã được khôi phục.",
        details: null,
      });
    }
  }
  if (queueChanged) await persistQueue();
  scheduleSessionSave();

  const draft = stored[DRAFT_KEY] || {};
  $("#bulkPrompts").value = draft.prompts || "";
  $("#aspectRatio").value = draft.aspectRatio || "9:16";
  $("#outputPrefix").value = draft.outputPrefix || "gemini-image";
  promptLines = [];
  const draftPrompts = parsePrompts(draft.prompts || "");
  const storedLines = Array.isArray(draft.lines)
    ? draft.lines
    : (Array.isArray(draft.references) ? draft.references : []).map((reference, index) => ({
        id: crypto.randomUUID(),
        prompt: reference.prompt || draftPrompts[index] || "",
        references: [reference],
      }));
  for (const storedLine of storedLines) {
    const line = createPromptLine(storedLine.prompt || "");
    line.id = storedLine.id || line.id;
    line.integration = storedLine.integration || null;
    line.outputName = storedLine.outputName || "";
    line.aspectRatio = storedLine.aspectRatio || "";
    for (const handle of Array.isArray(storedLine.references) ? storedLine.references : []) {
      const record = await getBlob(handle.blobId);
      if (!record?.blob) continue;
      const file = new File([record.blob], handle.name, {
        type: handle.type || record.blob.type,
        lastModified: handle.lastModified || Date.now(),
      });
      line.references.push({
        file,
        blobId: handle.blobId,
        previewUrl: URL.createObjectURL(record.blob),
        width: handle.width || 0,
        height: handle.height || 0,
      });
    }
    promptLines.push(line);
  }
  while (promptLines.length < draftPrompts.length) {
    promptLines.push(createPromptLine(draftPrompts[promptLines.length]));
  }

  $("#timeoutMinutes").value = runnerSettings.timeoutMinutes;
  $("#delaySeconds").value = runnerSettings.delaySeconds;
  $("#autoDownload").checked = Boolean(runnerSettings.autoDownload);
  $("#downloadMode").value = runnerSettings.downloadMode;
  $("#downloadFolder").value = runnerSettings.downloadFolder;
}

async function sendBackground(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    scope: "auto-gemini-images:background",
    type,
    ...payload,
  });
  if (!response?.ok) {
    const error = new Error(
      response?.error?.message || "Extension request failed.",
    );
    error.code = response?.error?.code || "EXTENSION_REQUEST_FAILED";
    throw error;
  }
  return response.data;
}

async function loadVoxStatus() {
  try {
    const data = await sendBackground("GET_STATUS");
    $("#voxBaseUrl").value = data.settings?.voxBaseUrl || "";
    $("#apiToken").value = data.settings?.apiToken || "";
    $("#batchId").value ||= data.runtime?.activeBatchId || "";
    $("#voxRuntimeStatus").textContent = data.runtime?.activeTask
      ? `${data.runtime.activeTask.state} · task ${data.runtime.activeTask.taskId}`
      : data.runtime?.activeBatchId
        ? `${data.runtime.status} · batch ${data.runtime.activeBatchId}`
        : "VOX chưa có batch đang chạy.";
    return data;
  } catch (error) {
    $("#voxRuntimeStatus").textContent = `Không đọc được VOX: ${error.message}`;
    return null;
  }
}

function bindEvents() {
  $$(".tab-button").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  $("#moveToGemini").addEventListener("click", () => void moveToGemini());

  $("#bulkPrompts").addEventListener("input", () => {
    syncPromptLinesFromBulk();
    scheduleDraftSave();
  });
  for (const id of ["aspectRatio", "outputPrefix"]) {
    $(`#${id}`).addEventListener("input", () => {
      scheduleDraftSave();
    });
  }
  $("#importPrompts").addEventListener("click", () => $("#promptFileInput").click());
  $("#promptFileInput").addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    $("#bulkPrompts").value = await file.text();
    event.target.value = "";
    syncPromptLinesFromBulk();
    scheduleDraftSave();
  });
  $("#referenceInput").addEventListener("change", (event) => {
    void addPrimaryFiles(event.target.files || []);
    event.target.value = "";
  });
  $("#addPromptLine").addEventListener("click", () => {
    promptLines.push(createPromptLine());
    renderPromptLines();
    scheduleDraftSave();
  });
  $("#addToQueue").addEventListener("click", () => void addDraftToQueue());
  $("#addAndRun").addEventListener("click", () => void addDraftToQueue({ run: true }));

  for (const id of ["startQueue", "startQueueCreate"]) {
    $(`#${id}`).addEventListener("click", () => void runQueue());
  }
  for (const id of ["pauseQueue", "pauseQueueCreate"]) {
    $(`#${id}`).addEventListener("click", togglePause);
  }
  for (const id of ["stopQueue", "stopQueueCreate"]) {
    $(`#${id}`).addEventListener("click", requestStop);
  }

  $("#queueList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = queue.find((candidate) => candidate.id === button.dataset.id);
    if (!item) return;
    const action = button.dataset.action;
    if (action === "download") {
      try {
        await downloadTaskResult(item, { manual: true });
        toast("Đã bắt đầu tải ảnh");
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (action === "retry") {
      await updateQueueItem(item, {
        status: "queued",
        stage: "queued",
        error: null,
        resume: null,
        requiresFreshChat: true,
      });
      return;
    }
    if (action === "remove") {
      await removeQueueItem(item);
    }
  });

  $("#retryFailed").addEventListener("click", async () => {
    const freshChatGroups = new Set();
    for (const item of queue) {
      if (["failed", "canceled"].includes(item.status)) {
        const group = isVoxQueueItem(item)
          ? `vox:${item.integration.batchId}`
          : "standalone";
        item.status = "queued";
        item.stage = "queued";
        item.error = null;
        item.resume = null;
        item.requiresFreshChat =
          !item.pendingVoxResult?.blobId &&
          !freshChatGroups.has(group);
        freshChatGroups.add(group);
      }
    }
    await persistQueue();
    renderQueue();
  });
  $("#clearFinished").addEventListener("click", () => {
    if (runner.running) return;
    void clearItems((item) => ["completed", "failed", "canceled"].includes(item.status));
  });
  $("#clearQueue").addEventListener("click", () => {
    if (runner.running) return;
    if (!confirm("Xóa toàn bộ hàng chờ và kết quả đã lưu trong extension?")) return;
    void clearItems(() => true);
  });

  $("#sessionLogs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-copy-session]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const session = sessions.find((candidate) => candidate.id === button.dataset.copySession);
    if (!session) return;
    void copyText(formatSession(session)).then(() => toast("Đã copy session log"));
  });
  $("#copyLatestSession").addEventListener("click", () => {
    if (!sessions[0]) return toast("Chưa có session log");
    void copyText(formatSession(sessions[0])).then(() => toast("Đã copy session mới nhất"));
  });
  $("#clearLogs").addEventListener("click", async () => {
    if (runner.running) return toast("Không thể xóa log khi đang chạy");
    sessions = [];
    await chrome.storage.local.set({ [SESSIONS_KEY]: [] });
    renderSessions();
  });

  $("#saveRunnerSettings").addEventListener("click", async () => {
    runnerSettings = {
      timeoutMinutes: Math.min(30, Math.max(2, Number($("#timeoutMinutes").value) || 10)),
      delaySeconds: Math.min(120, Math.max(0, Number($("#delaySeconds").value) || 0)),
      autoDownload: $("#autoDownload").checked,
      downloadMode: $("#downloadMode").value === "ask" ? "ask" : "auto",
      downloadFolder: normalizeFolder($("#downloadFolder").value),
    };
    $("#timeoutMinutes").value = runnerSettings.timeoutMinutes;
    $("#delaySeconds").value = runnerSettings.delaySeconds;
    $("#downloadFolder").value = runnerSettings.downloadFolder;
    await chrome.storage.local.set({ [SETTINGS_KEY]: runnerSettings });
    toast("Đã lưu cài đặt chạy");
  });
  $("#openDownloadSettings").addEventListener("click", () => {
    void sendBackground("OPEN_DOWNLOAD_SETTINGS");
  });

  $("#saveVoxSettings").addEventListener("click", async () => {
    try {
      await sendBackground("SAVE_SETTINGS", {
        settings: {
          voxBaseUrl: $("#voxBaseUrl").value.trim(),
          apiToken: $("#apiToken").value.trim(),
        },
      });
      toast("Đã lưu kết nối VOX");
      await loadVoxStatus();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#startVoxBatch").addEventListener("click", async () => {
    const batchId = $("#batchId").value.trim();
    if (!batchId) return toast("Hãy nhập VOX batch ID");
    try {
      await sendBackground("START_BATCH", { batchId });
      await importVoxBatch(batchId, {
        run: true,
        executionMode: "auto",
        resetWorkspace: true,
      });
      toast("Đã nạp và bắt đầu VOX batch");
      await loadVoxStatus();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function initialize() {
  await loadLocalState();
  bindEvents();
  renderPromptCount();
  renderPromptLines();
  renderQueue();
  renderSessions();
  await updatePageGate();
  const voxStatus = await loadVoxStatus();
  panelInitialized = true;
  const request =
    pendingVoxRequest ||
    (!voxStatus?.runtime?.voxPreparing &&
    voxStatus?.runtime?.executorMode === "sidepanel" &&
    voxStatus.runtime.activeBatchId
      ? {
          batchId: voxStatus.runtime.activeBatchId,
          executionMode: voxStatus.runtime.voxExecutionMode || "auto",
          resetWorkspace: voxStatus.runtime.voxResetWorkspace !== false,
        }
      : null);
  pendingVoxRequest = null;
  if (request?.batchId) {
    await importVoxBatch(request.batchId, {
      run: request.executionMode !== "manual",
      executionMode: request.executionMode,
      resetWorkspace: request.resetWorkspace,
    });
  }
}

void initialize().catch((error) => toast(error.message));
chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.scope !== "auto-gemini-images:sidepanel" ||
    message?.type !== "VOX_BATCH_AVAILABLE"
  ) {
    return;
  }
  const batchId = String(message.batchId || "").trim();
  if (!batchId) return;
  const request = {
    batchId,
    executionMode: message.executionMode === "manual" ? "manual" : "auto",
    resetWorkspace: message.resetWorkspace !== false,
  };
  if (!panelInitialized) {
    pendingVoxRequest = request;
    return;
  }
  void importVoxBatch(batchId, {
    run: request.executionMode !== "manual",
    executionMode: request.executionMode,
    resetWorkspace: request.resetWorkspace,
  }).catch((error) => {
    toast(`Không nạp được VOX batch: ${error.message}`);
  });
});
chrome.tabs.onActivated.addListener(() => void updatePageGate());
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === "complete") void updatePageGate();
});
