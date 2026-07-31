(() => {
  const CONFIG_URL = chrome.runtime.getURL("config/gemini-selectors.json");
  let configPromise;

  function getConfig() {
    configPromise ||= fetch(CONFIG_URL).then((response) => {
      if (!response.ok) throw new Error(`Selector config failed: ${response.status}`);
      return response.json();
    });
    return configPromise;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function findByLabels(selector, labels) {
    return [...document.querySelectorAll(selector)].find((element) => {
      const text = `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return labels.some((label) => text.includes(label.toLowerCase()));
    });
  }

  function fingerprint(element, index) {
    const imageSources = [...element.querySelectorAll("img")]
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean);
    return {
      index,
      role: element.getAttribute("data-message-author-role") || "unknown",
      text: (element.innerText || "").trim().slice(0, 500),
      images: imageSources
    };
  }

  async function detectBlockedState(config) {
    const text = document.body?.innerText || "";
    if (config.labels.verification.some((label) => text.includes(label))) {
      return { code: "VERIFICATION_REQUIRED", message: "Gemini requires browser verification." };
    }
    if (config.labels.usageLimit.some((label) => text.toLowerCase().includes(label.toLowerCase()))) {
      return { code: "USAGE_LIMIT_REACHED", message: "Gemini reports a usage limit." };
    }
    const composer = document.querySelector(config.selectors.composer);
    if (!composer && config.labels.login.some((label) => text.includes(label))) {
      return { code: "AUTH_REQUIRED", message: "Log in to Gemini to continue." };
    }
    return null;
  }

  async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function recordBaseline(config) {
    const messages = [...document.querySelectorAll(config.selectors.conversationArticle)];
    const fingerprints = messages.map(fingerprint);
    return {
      capturedAt: new Date().toISOString(),
      messageCount: messages.length,
      imageSources: [...new Set(messages.flatMap((message) =>
        [...message.querySelectorAll("img")].flatMap((image) => {
          const source = image.currentSrc || image.src;
          const link = image.closest("a[href]")?.href;
          return [source, link].filter(Boolean);
        }),
      ))],
      lastMessages: fingerprints.slice(-5)
    };
  }

  async function uploadReferences(config, references) {
    let input = document.querySelector(config.selectors.fileInput);
    if (!input) {
      const attachmentButton = document.querySelector(config.selectors.attachmentButton);
      attachmentButton?.click();
      await sleep(250);
      input = document.querySelector(config.selectors.fileInput);
      if (!input) {
        const controls = [...document.querySelectorAll("button, [role='menuitem']")];
        const addFilesControl = controls.find((control) => {
          const label = `${control.getAttribute("aria-label") || ""} ${control.innerText || ""}`.trim();
          return config.labels.addFiles.some((expected) =>
            label.toLowerCase().includes(expected.toLowerCase()),
          );
        });
        addFilesControl?.click();
        input = await waitFor(
          () => document.querySelector(config.selectors.fileInput),
          { timeoutMs: 5000 },
        );
      }
    }
    if (!input) throw Object.assign(new Error("Gemini file input was not found."), { code: "GEMINI_UI_UNSUPPORTED" });

    const initialAttachments = document.querySelectorAll(config.selectors.attachment).length;
    const uploaded = [];
    for (const reference of [...references].sort((a, b) => a.order - b.order)) {
      let response;
      try {
        response = await fetch(reference.url, { credentials: "include" });
      } catch (error) {
        throw Object.assign(new Error(`Could not fetch reference ${reference.id || reference.order}: ${error.message}`), {
          code: "REFERENCE_FETCH_FAILED"
        });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`Reference ${reference.id || reference.order} returned ${response.status}.`), {
          code: "REFERENCE_FETCH_FAILED"
        });
      }
      const blob = await response.blob();
      const filename = reference.name || `reference-${reference.order + 1}.${blob.type.split("/")[1] || "png"}`;
      const file = new File([blob], filename, { type: reference.type || blob.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const expectedCount = initialAttachments + uploaded.length + 1;
      const verified = await waitFor(() => {
        const busy = document.querySelector(config.selectors.uploadBusy);
        const count = document.querySelectorAll(config.selectors.attachment).length;
        return !busy && count >= expectedCount;
      }, { timeoutMs: 120000, intervalMs: 500 });
      if (!verified) {
        throw Object.assign(new Error(`Reference ${filename} was not visibly confirmed after upload.`), {
          code: "REFERENCE_VERIFICATION_FAILED"
        });
      }
      uploaded.push({ id: reference.id, order: reference.order, name: filename, size: blob.size });
    }
    return uploaded;
  }

  function setComposerValue(composer, prompt) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value");
      descriptor?.set?.call(composer, prompt);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    document.execCommand?.("selectAll", false);
    const inserted = document.execCommand?.("insertText", false, prompt);
    if (!inserted) {
      composer.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = prompt;
      composer.append(paragraph);
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  }

  async function submitPrompt(config, prompt, promptHash) {
    const blocked = await detectBlockedState(config);
    if (blocked) throw Object.assign(new Error(blocked.message), { code: blocked.code });
    const composer = document.querySelector(config.selectors.composer);
    if (!composer) throw Object.assign(new Error("Gemini composer was not found."), { code: "GEMINI_UI_UNSUPPORTED" });
    if (composer.dataset.autoChatgptSubmitted === promptHash) {
      return { alreadySubmitted: true, evidence: composer.dataset.autoChatgptSubmittedAt };
    }

    document.querySelector(config.selectors.attachmentButton)?.click();
    const createImage = await waitFor(
      () => findByLabels(config.selectors.createImageMenuItem, config.labels.createImage),
      { timeoutMs: 3000 },
    );
    if (!createImage) {
      throw Object.assign(new Error("Gemini Create image mode was not found."), {
        code: "GEMINI_UI_UNSUPPORTED"
      });
    }
    if (createImage.getAttribute("aria-checked") !== "true") createImage.click();

    setComposerValue(composer, prompt);
    await sleep(100);
    const button = document.querySelector(config.selectors.sendButton);
    if (!button || button.disabled) {
      throw Object.assign(new Error("Gemini send button is unavailable."), { code: "SUBMISSION_REJECTED" });
    }
    composer.dataset.autoChatgptSubmitted = promptHash;
    composer.dataset.autoChatgptSubmittedAt = new Date().toISOString();
    button.click();

    const userMessage = await waitFor(() => {
      const messages = [...document.querySelectorAll(config.selectors.userMessage)];
      return messages.findLast((message) => (message.innerText || "").trim() === prompt.trim());
    }, { timeoutMs: 15000 });
    if (!userMessage) {
      throw Object.assign(new Error("Could not confirm whether Gemini accepted the prompt."), {
        code: "SUBMISSION_AMBIGUOUS"
      });
    }
    return {
      alreadySubmitted: false,
      evidence: {
        submittedAt: composer.dataset.autoChatgptSubmittedAt,
        userText: (userMessage.innerText || "").trim().slice(0, 500)
      }
    };
  }

  function imageCandidates(config, baseline) {
    const oldSources = new Set(baseline.imageSources || []);
    const messages = [...document.querySelectorAll(config.selectors.assistantMessage)];
    return messages
      .flatMap((message, messageIndex) => [...message.querySelectorAll(config.selectors.image)]
        .map((image, imageIndex) => ({
          src: image.closest("a[href]")?.href || image.currentSrc || image.src,
          width: image.naturalWidth || image.width || 0,
          height: image.naturalHeight || image.height || 0,
          messageIndex,
          imageIndex
        })))
      .filter((candidate) =>
        candidate.src &&
        !oldSources.has(candidate.src) &&
        (candidate.width >= 256 || candidate.height >= 256),
      )
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  }

  async function waitForResult(config, baseline, timeoutMs) {
    const candidate = await waitFor(async () => {
      const blocked = await detectBlockedState(config);
      if (blocked) throw Object.assign(new Error(blocked.message), { code: blocked.code });
      if (document.querySelector(config.selectors.stopButton)) return null;
      return imageCandidates(config, baseline)[0] || null;
    }, { timeoutMs, intervalMs: 1000 });
    if (!candidate) {
      throw Object.assign(new Error("No new assistant image appeared before the timeout."), {
        code: "GENERATION_TIMEOUT"
      });
    }
    return candidate;
  }

  async function inspectSubmission(config, { prompt, baseline }) {
    const userMessages = [...document.querySelectorAll(config.selectors.userMessage)];
    const submitted = userMessages.some((message) => (message.innerText || "").trim() === prompt.trim());
    const candidate = imageCandidates(config, baseline)[0] || null;
    return { submitted, candidate };
  }

  const handlers = {
    async PING(config) {
      return { url: location.href, blocked: await detectBlockedState(config) };
    },
    RECORD_BASELINE: recordBaseline,
    async UPLOAD_REFERENCES(config, payload) {
      return uploadReferences(config, payload.references);
    },
    async SUBMIT_PROMPT(config, payload) {
      return submitPrompt(config, payload.prompt, payload.promptHash);
    },
    async WAIT_FOR_RESULT(config, payload) {
      return waitForResult(config, payload.baseline, payload.timeoutMs);
    },
    async INSPECT_SUBMISSION(config, payload) {
      return inspectSubmission(config, payload);
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.scope !== "auto-gemini-images:page") return;
    const handler = handlers[message.type];
    if (!handler) return;
    getConfig()
      .then((config) => handler(config, message.payload || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({
        ok: false,
        error: { code: error.code || "INTERNAL_ERROR", message: error.message || String(error) }
      }));
    return true;
  });
})();
