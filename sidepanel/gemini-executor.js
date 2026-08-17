const GEMINI_URL = "https://gemini.google.com/app";

export async function createGeminiTab() {
  return chrome.tabs.create({ url: GEMINI_URL, active: true });
}

export async function getCurrentOrExistingGeminiTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && active.url?.startsWith("https://gemini.google.com/")) return active;
  const existing = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
    }
    return chrome.tabs.get(existing[0].id);
  }
  return createGeminiTab();
}

export async function waitForTab(tabId, timeoutMs = 60000) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Gemini did not finish loading within 60 seconds."));
    }, timeoutMs);
    function onUpdated(updatedId, change, tab) {
      if (updatedId !== tabId || change.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function execute(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  if (!results?.[0]) throw new Error("Gemini injection returned no result.");
  if (results[0].error) throw new Error(results[0].error.message || String(results[0].error));
  if (results[0].result == null) {
    throw new Error("Gemini injection returned an empty result.");
  }
  return results[0].result;
}

/**
 * Self-contained because Chrome serializes this function into Gemini's MAIN
 * world. It follows the same pattern as the working Flow reference executor:
 * wait for concrete controls, dispatch each upload once, verify visible media,
 * write through native editor input, click once, then verify acceptance.
 */
async function prepareAndSubmitOnPage(task, config) {
  const startedAt = Date.now();
  const trace = [];
  const record = (step, message, details) =>
    trace.push({ step, message, elapsedMs: Date.now() - startedAt, details });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (find, timeoutMs = 15000, intervalMs = 150) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = find();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  };
  const fail = (code, step, message, diagnostics = {}) => ({
    ok: false,
    code,
    step,
    message,
    diagnostics,
    trace,
  });
  const selectors = config.selectors;
  const pageText = () => document.body?.innerText || "";
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const findByLabels = (selector, labels) =>
    [...document.querySelectorAll(selector)].find((element) => {
      const label = normalize(
        `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`,
      ).toLowerCase();
      return labels.some((expected) => label.includes(expected.toLowerCase()));
    });
  const stableImageKey = (source) => {
    const value = String(source || "").trim();
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return url.href;
    } catch {
      return value;
    }
  };
  const dataUrlToBlob = (dataUrl, fallbackType = "application/octet-stream") => {
    const value = String(dataUrl || "");
    const comma = value.indexOf(",");
    if (comma < 0 || !value.startsWith("data:")) {
      throw new Error("Reference payload is not a data URL.");
    }
    const metadata = value.slice(5, comma);
    const payload = value.slice(comma + 1);
    const base64 = /;base64(?:;|$)/i.test(metadata);
    const mediaType = metadata.split(";")[0] || fallbackType;
    const decoded = base64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return new Blob([bytes], { type: mediaType });
  };

  if (/verify it'?s you|unusual traffic|recaptcha/i.test(pageText())) {
    return fail("VERIFICATION_REQUIRED", "session", "Gemini requires verification.");
  }
  if (!document.querySelector(selectors.composer)) {
    return fail("AUTH_REQUIRED", "session", "Gemini composer is unavailable. Sign in first.");
  }

  // Gemini can briefly keep the previous conversation DOM under `/app` while
  // its router is still committing the real conversation URL. Starting the
  // next queue item during that transition can make the first Send click land
  // on a composer that Angular is replacing.
  if (
    new URL(location.href).pathname === "/app" &&
    document.querySelector(selectors.userMessage)
  ) {
    await waitFor(
      () =>
        new URL(location.href).pathname !== "/app" ||
        !document.querySelector(selectors.userMessage),
      5000,
      100,
    );
  }

  // A failed/aborted run can leave its attachment in Gemini's next draft.
  // Clear that stale draft state before establishing this task's baseline so
  // references can never leak into or be duplicated in the next queue item.
  const staleAttachments = [...document.querySelectorAll(selectors.attachmentClose)];
  for (const closeButton of staleAttachments) closeButton.click();
  if (
    staleAttachments.length &&
    !await waitFor(() => !document.querySelector(selectors.attachment), 5000, 100)
  ) {
    return fail(
      "STALE_ATTACHMENT_CLEAR_FAILED",
      "upload",
      "A reference image from the previous Gemini draft could not be removed.",
      { count: staleAttachments.length },
    );
  }
  if (staleAttachments.length) {
    record("draft-reset", "Removed stale reference images from the previous Gemini draft.", {
      count: staleAttachments.length,
    });
  }

  const generatedImages = () =>
    [...document.querySelectorAll(selectors.generatedImage)]
      .flatMap((image) => [
        image.currentSrc || image.src,
        image.closest("a[href]")?.href || "",
      ])
      .filter(Boolean);
  const baselineImageSources = [...new Set(generatedImages())];
  const baselineTurns = [
    ...document.querySelectorAll(selectors.conversationTurn),
  ];
  const baselineUserMessages = [...document.querySelectorAll(selectors.userMessage)];
  const baselineUserCount = baselineUserMessages.length;
  const baseline = {
    capturedAt: new Date().toISOString(),
    pageUrl: location.href,
    imageSources: baselineImageSources,
    imageKeys: [...new Set(baselineImageSources.map(stableImageKey))],
    turnIds: baselineTurns
      .map((turn) => turn.getAttribute("data-testid") || "")
      .filter(Boolean),
    turnCount: baselineTurns.length,
    userCount: baselineUserCount,
  };
  record("baseline", "Recorded existing assistant images.", baseline);

  // Enable image generation before uploading references. Gemini replaces its
  // composer when this mode changes; doing it after upload can leave the
  // reference in the next draft while the text prompt is submitted alone.
  let imageModeEnabled = Boolean(document.querySelector(selectors.imageModeEnabled));
  if (!imageModeEnabled) {
    const toolsButton = document.querySelector(selectors.attachmentButton);
    toolsButton?.click();
    const createImage = await waitFor(
      () => findByLabels(selectors.createImageMenuItem, config.labels.createImage),
      3000,
    );
    if (!createImage) {
      return fail("IMAGE_MODE_MISSING", "mode", "Gemini Create image mode was not found.");
    }
    const menuItemEnabled =
      createImage.getAttribute("aria-checked") === "true" ||
      createImage.getAttribute("data-state") === "checked";
    if (!menuItemEnabled) createImage.click();
    imageModeEnabled = Boolean(
      await waitFor(
        () =>
          document.querySelector(selectors.imageModeEnabled) ||
          createImage.getAttribute("aria-checked") === "true" ||
          createImage.getAttribute("data-state") === "checked",
        5000,
        100,
      ),
    );
  }
  if (!imageModeEnabled) {
    return fail("IMAGE_MODE_NOT_READY", "mode", "Gemini Create image mode did not become ready.");
  }
  record("image-mode", "Gemini Create image mode is enabled.", {
    alreadyEnabled: Boolean(document.querySelector(selectors.imageModeEnabled)),
  });

  if (task.references.length) {
    const attachmentPreviews = () =>
      [...document.querySelectorAll(selectors.attachment)].filter(
        (image) => image.tagName === "IMG",
      );
    const attachmentKeys = () =>
      new Set(
        attachmentPreviews()
          .map((image) => image.currentSrc || image.src || "")
          .filter(Boolean),
      );
    const uploadErrorText = () =>
      [...document.querySelectorAll("[data-sonner-toast], [role='alert']")]
        .map((node) => normalize(node.textContent))
        .filter((text) => /upload|file|image|photo/i.test(text) && /fail|error|unable|too large/i.test(text))
        .join(" ");

    for (let index = 0; index < task.references.length; index += 1) {
      const reference = task.references[index];
      const before = attachmentKeys();
      let blob;
      try {
        blob = dataUrlToBlob(reference.dataUrl, reference.type);
      } catch (error) {
        return fail(
          "REFERENCE_READ_FAILED",
          "upload",
          `Could not read reference ${index + 1}: ${reference.name}.`,
          { index, name: reference.name, error: error.message },
        );
      }
      if (!blob.size || !String(reference.type || blob.type).startsWith("image/")) {
        return fail(
          "REFERENCE_INVALID",
          "upload",
          `Reference ${index + 1} is not a valid image: ${reference.name}.`,
          { index, name: reference.name, size: blob.size, type: reference.type || blob.type },
        );
      }

      const transfer = new DataTransfer();
      transfer.items.add(
        new File([blob], reference.name, {
          type: reference.type || blob.type,
          lastModified: reference.lastModified || Date.now(),
        }),
      );
      let uploadMethod = "paste";
      const uploadComposer = document.querySelector(selectors.composer);
      if (!uploadComposer) {
        return fail(
          "COMPOSER_MISSING_BEFORE_UPLOAD",
          "upload",
          "Gemini composer disappeared before the reference image could be pasted.",
        );
      }
      uploadComposer.focus();
      uploadComposer.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: transfer,
        }),
      );
      record("upload-dispatch", `Pasted reference ${index + 1}/${task.references.length}.`, {
        index,
        name: reference.name,
        size: blob.size,
        method: uploadMethod,
      });

      let stablePreviewKey = "";
      let stablePreviewCount = 0;
      const inspectReadyPreview = () => {
        const errorText = uploadErrorText();
        if (errorText) return { errorText };
        const readyPreviews = attachmentPreviews().filter(
          (image) =>
            !before.has(image.currentSrc || image.src || "") &&
            image.complete &&
            image.naturalWidth > 0 &&
            image.naturalHeight > 0,
        );
        const preview = readyPreviews.at(-1);
        if (!preview) return null;
        const previewContainer = preview.closest("uploader-file-preview");
        const previewBusy = Boolean(
          previewContainer?.querySelector(
            "mat-progress-spinner, [role='progressbar'], [aria-busy='true'], [class*='loading']",
          ),
        );
        if (previewBusy) return null;
        const previewKey = `${preview.currentSrc || preview.src}|${preview.naturalWidth}x${preview.naturalHeight}`;
        stablePreviewCount = previewKey === stablePreviewKey ? stablePreviewCount + 1 : 1;
        stablePreviewKey = previewKey;
        return stablePreviewCount >= 3
          ? {
              count: attachmentPreviews().length,
              previewKey,
              width: preview.naturalWidth,
              height: preview.naturalHeight,
              stableScans: stablePreviewCount,
              uploadMethod,
            }
          : null;
      };
      let verified = await waitFor(inspectReadyPreview, 8000, 250);
      if (!verified) {
        const dropZone = document.querySelector(selectors.fileDropZone);
        if (dropZone) {
          uploadMethod = "drop";
          stablePreviewKey = "";
          stablePreviewCount = 0;
          transfer.dropEffect = "copy";
          transfer.effectAllowed = "copy";
          for (const eventType of ["dragenter", "dragover", "drop", "dragleave"]) {
            dropZone.dispatchEvent(new DragEvent(eventType, {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: transfer,
            }));
          }
          record("upload-fallback", `Dropped reference ${index + 1}/${task.references.length}.`, {
            index,
            name: reference.name,
            size: blob.size,
            method: uploadMethod,
            dropZone: dropZone.getAttribute("file-drop-zone") || dropZone.className || "",
          });
          verified = await waitFor(inspectReadyPreview, 42000, 400);
        }
      }
      if (!verified || verified.errorText) {
        return fail(
          verified?.errorText ? "UPLOAD_REJECTED" : "UPLOAD_VERIFICATION_FAILED",
          "upload",
          verified?.errorText
            ? `Gemini rejected reference ${index + 1}: ${reference.name}.`
            : `Reference ${index + 1} never became visibly ready: ${reference.name}.`,
          {
            index,
            name: reference.name,
            visible: attachmentPreviews().length,
            errorText: verified?.errorText || "",
          },
        );
      }
      record(
        "upload-ready",
        `Reference ${index + 1}/${task.references.length} is visibly ready.`,
        { index, name: reference.name, ...verified },
      );
    }
  }

  // Uploading a reference can cause Gemini to replace the entire composer.
  // Reacquire it after image mode is enabled instead of retaining a stale or
  // temporarily missing node from before the upload.
  const composer = await waitFor(
    () => document.querySelector(selectors.composer),
    15000,
    100,
  );
  if (!composer) {
    return fail(
      "COMPOSER_MISSING_AFTER_UPLOAD",
      "composer",
      "Gemini composer did not return after the reference image was uploaded.",
      { referenceCount: task.references.length },
    );
  }
  composer.focus();
  const selection = window.getSelection();
  if (!selection) {
    return fail("PROMPT_WRITE_FAILED", "composer", "Browser selection is unavailable.");
  }
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  if (!document.execCommand("insertText", false, task.prompt)) {
    return fail("PROMPT_WRITE_FAILED", "composer", "Native prompt insertion failed.");
  }
  composer.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: task.prompt }),
  );
  const promptReady = await waitFor(
    () => normalize(composer.innerText || composer.textContent) === normalize(task.prompt),
    3000,
    50,
  );
  if (!promptReady) {
    return fail("PROMPT_SYNC_FAILED", "composer", "Gemini editor did not retain the exact prompt.");
  }
  const readyReferenceCount = [...document.querySelectorAll(selectors.attachment)].filter(
    (image) =>
      image.tagName === "IMG" &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0,
  ).length;
  if (readyReferenceCount !== task.references.length) {
    return fail(
      "REFERENCE_COUNT_MISMATCH",
      "upload",
      "The number of visibly ready reference images does not match the task before submission.",
      { expected: task.references.length, ready: readyReferenceCount },
    );
  }
  record("prompt-ready", "Exact prompt is present in the composer.");

  const send = await waitFor(() => {
    const button = document.querySelector(selectors.sendButton);
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true"
      ? button
      : null;
  }, 10000);
  if (!send) return fail("SEND_BUTTON_MISSING", "submit", "Enabled send button was not found.");

  send.click();
  record("submit-click", "Clicked send exactly once.");
  const userMessageText = (message) => {
    const lines = [...message.querySelectorAll(".query-text-line")]
      .map((line) => line.textContent || "")
      .join("\n");
    return normalize(lines || message.innerText || message.textContent);
  };
  const matchesSubmittedPrompt = (message) => {
    const expected = normalize(task.prompt);
    const extracted = userMessageText(message);
    const fallback = normalize(message.innerText || message.textContent);
    return extracted === expected || fallback === expected || fallback.endsWith(expected);
  };
  const newUserMessages = () => {
    const users = [...document.querySelectorAll(selectors.userMessage)];
    const byIdentity = users.filter((message) => !baselineUserMessages.includes(message));
    return users.length > baselineUserCount
      ? users.slice(baselineUserCount)
      : byIdentity;
  };
  const inspectSubmission = () => {
    const users = newUserMessages();
    const exactUser = users.find(
      (message) => matchesSubmittedPrompt(message),
    );
    const liveComposer = document.querySelector(selectors.composer);
    const cleared = normalize(liveComposer?.innerText || liveComposer?.textContent) === "";
    const referenceInUserTurn = Boolean(
      exactUser?.querySelector(selectors.submittedAttachment),
    );
    const referencesSubmitted =
      task.references.length === 0 ||
      referenceInUserTurn;
    return exactUser && referencesSubmitted
      ? {
          exactUserMessage: true,
          composerCleared: cleared,
          referenceInUserTurn,
          remainingComposerReferences:
            document.querySelectorAll(selectors.attachment).length,
        }
      : null;
  };
  let accepted = await waitFor(inspectSubmission, 2500, 100);
  if (!accepted) {
    const liveComposer = document.querySelector(selectors.composer);
    const stillDrafted =
      normalize(liveComposer?.innerText || liveComposer?.textContent) === normalize(task.prompt);
    const draftReferenceCount = document.querySelectorAll(selectors.attachment).length;
    const noSubmissionEvidence =
      newUserMessages().length === 0 &&
      !document.querySelector(selectors.stopButton);
    const retrySend = document.querySelector(selectors.sendButton);
    if (
      stillDrafted &&
      noSubmissionEvidence &&
      draftReferenceCount === task.references.length &&
      retrySend &&
      !retrySend.disabled &&
      retrySend.getAttribute("aria-disabled") !== "true"
    ) {
      retrySend.click();
      record(
        "submit-retry",
        "The first click produced no submission evidence; clicked the live Send button once more.",
        { draftReferenceCount },
      );
    }
    accepted = await waitFor(inspectSubmission, 15000, 100);
  }
  if (!accepted) {
    const newUsers = newUserMessages();
    const submittedTextWithoutReference = newUsers.some(
      (message) =>
        matchesSubmittedPrompt(message) &&
        !message.querySelector(selectors.submittedAttachment),
    );
    if (task.references.length && submittedTextWithoutReference) {
      return fail(
        "REFERENCE_NOT_SUBMITTED",
        "submit",
        "Gemini submitted the text without the reference image.",
        { remaining: document.querySelectorAll(selectors.attachment).length },
      );
    }
    return fail(
      "SUBMISSION_AMBIGUOUS",
      "submit",
      "Could not prove whether Gemini accepted the prompt.",
    );
  }
  record("submission-accepted", "Gemini accepted the prompt.", accepted);
  const submittedFromNewChat = new URL(baseline.pageUrl).pathname === "/app";
  if (submittedFromNewChat) {
    await waitFor(() => new URL(location.href).pathname !== "/app", 5000, 100);
  }
  baseline.pageUrl = location.href;
  record("conversation-ready", "Recorded the post-submission conversation URL.", {
    pageUrl: baseline.pageUrl,
  });
  return { ok: true, baseline, trace };
}

async function scanResultOnPage(baseline, config) {
  const selectors = config.selectors;
  const stableImageKey = (source) => {
    const value = String(source || "").trim();
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return url.href;
    } catch {
      return value;
    }
  };
  const old = new Set(
    (baseline.imageKeys || (baseline.imageSources || []).map(stableImageKey))
      .filter(Boolean),
  );
  const oldTurns = new Set(baseline.turnIds || []);
  const turns = [...document.querySelectorAll(selectors.conversationTurn)];
  const rawCandidates = [...document.querySelectorAll(selectors.generatedImage)]
    .map((image, imageIndex) => {
      const turn = image.closest(selectors.conversationTurn);
      const src =
        image.closest("a[href]")?.href || image.currentSrc || image.src;
      const turnId = turn?.getAttribute("data-testid") || "";
      const turnIndex = turn ? turns.indexOf(turn) : -1;
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      const turnBusy = Boolean(
        turn?.querySelector("[aria-busy='true'], [data-state='loading']"),
      );
      return {
        src,
        imageKey: stableImageKey(src),
        width,
        height,
        imageComplete: image.complete,
        turnBusy,
        ready:
          image.complete &&
          width >= 512 &&
          height >= 512 &&
          !turnBusy,
        alt: image.alt || "",
        turnId,
        turnIndex,
        imageIndex,
      };
    })
    .filter(
      (item) =>
        item.src &&
        item.imageKey &&
        !old.has(item.imageKey) &&
        (item.turnId
          ? !oldTurns.has(item.turnId)
          : item.turnIndex >= Number(baseline.turnCount || 0)) &&
        (item.width >= 256 || item.height >= 256 || /generated/i.test(item.alt)),
    );
  const deduplicated = new Map();
  for (const candidate of rawCandidates) {
    const key = `${candidate.turnId}|${candidate.imageKey}`;
    const current = deduplicated.get(key);
    if (
      !current ||
      candidate.width * candidate.height > current.width * current.height
    ) {
      deduplicated.set(key, candidate);
    }
  }
  const candidates = [...deduplicated.values()].sort(
    (a, b) =>
      b.turnIndex - a.turnIndex ||
      b.width * b.height - a.width * a.height,
  );
  return {
    generating: Boolean(document.querySelector(selectors.stopButton)),
    candidate: candidates[0] || null,
    candidateCount: candidates.length,
    turnCount: turns.length,
  };
}

async function collectResultOnPage(candidate) {
  const source = String(candidate?.src || "");
  const errors = [];
  const dataUrlSize = (dataUrl) => {
    const payload = String(dataUrl).split(",", 2)[1] || "";
    return Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0));
  };

  // Gemini renders generated assets as blob: URLs. Reading the already loaded
  // image through canvas is more reliable than fetching that URL again.
  try {
    const image = [...document.images].find((entry) =>
      (entry.currentSrc || entry.src) === source || entry.src === source,
    );
    if (!image) throw new Error("Rendered image element was not found.");
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
      await image.decode();
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    const size = dataUrlSize(dataUrl);
    if (!dataUrl.startsWith("data:image/") || !size) {
      throw new Error("Canvas returned an empty image.");
    }
    return {
      ok: true,
      dataUrl,
      type: "image/png",
      size,
      method: "canvas",
    };
  } catch (error) {
    errors.push(`canvas: ${error.message || String(error)}`);
  }

  try {
    const response = await fetch(source, { credentials: "include" });
    if (!response.ok) throw new Error(`request returned ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("response body is empty");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("FileReader failed."));
      reader.readAsDataURL(blob);
    });
    if (!dataUrl.startsWith("data:")) throw new Error("FileReader returned invalid data.");
    return {
      ok: true,
      dataUrl,
      type: blob.type.startsWith("image/") ? blob.type : "image/png",
      size: blob.size,
      method: "fetch",
    };
  } catch (error) {
    errors.push(`fetch: ${error.message || String(error)}`);
  }

  // Gemini's rendered blob can be backed by an opaque cross-origin response:
  // it displays correctly but taints canvas and cannot be fetched again. Its
  // own full-size download flow creates a new readable PNG Blob. Intercept
  // that Blob before Gemini turns it into a browser download.
  try {
    const image = [...document.images].find((entry) =>
      (entry.currentSrc || entry.src) === source || entry.src === source,
    );
    if (!image) throw new Error("Rendered image element was not found.");
    const turn = image.closest("model-response");
    const downloadButton = turn?.querySelector(
      "[data-test-id='download-generated-image-button'] button, button[aria-label='Download full size image']",
    );
    if (!downloadButton) throw new Error("Full-size download button was not found.");

    const originalCreateObjectURL = URL.createObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    let finishCapture;
    const capture = new Promise((resolve) => {
      finishCapture = resolve;
    });
    try {
      URL.createObjectURL = function createObjectURL(value) {
        const objectUrl = originalCreateObjectURL.call(URL, value);
        if (value instanceof Blob && value.size && value.type.startsWith("image/")) {
          const reader = new FileReader();
          reader.onload = () =>
            finishCapture({
              dataUrl: String(reader.result || ""),
              type: value.type,
              size: value.size,
            });
          reader.onerror = () => finishCapture(null);
          reader.readAsDataURL(value);
        }
        return objectUrl;
      };
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download && String(this.href || "").startsWith("blob:")) return;
        return originalAnchorClick.call(this);
      };
      downloadButton.click();
      const captured = await Promise.race([
        capture,
        new Promise((resolve) => setTimeout(() => resolve(null), 60000)),
      ]);
      if (!captured?.dataUrl?.startsWith("data:image/") || !captured.size) {
        throw new Error("Gemini did not expose a readable full-size image Blob.");
      }
      return { ok: true, ...captured, method: "download-intercept" };
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
  } catch (error) {
    errors.push(`download: ${error.message || String(error)}`);
  }

  return {
    ok: false,
    message: `Không thể đọc ảnh Gemini (${errors.join("; ")}).`,
  };
}

export async function submitGeminiTask(tabId, task, config) {
  return execute(tabId, prepareAndSubmitOnPage, [task, config]);
}

export async function scanGeminiResult(tabId, baseline, config) {
  return execute(tabId, scanResultOnPage, [baseline, config]);
}

export async function collectGeminiResult(tabId, candidate) {
  return execute(tabId, collectResultOnPage, [candidate]);
}
