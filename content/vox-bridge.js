(() => {
  const REQUEST_SOURCE = "vox-style-video";
  const RESPONSE_SOURCE = "auto-gemini-images";
  const PROTOCOL = "vox-gemini/2";
  const BRIDGE_STATE_KEY = "__autoGeminiImagesVoxBridgeV2";

  function isTrustedLocalPage() {
    return (
      location.protocol === "http:" &&
      (location.hostname === "127.0.0.1" || location.hostname === "localhost")
    );
  }

  function extensionRuntime() {
    const runtime = globalThis.chrome?.runtime;
    return runtime?.id && typeof runtime.sendMessage === "function"
      ? runtime
      : null;
  }

  function respond(type, requestId, {
    ok,
    data,
    error = "",
    code = "",
  }) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      protocol: PROTOCOL,
      type,
      requestId,
      ok,
      ...(data === undefined ? {} : { data }),
      ...(error ? { error } : {}),
      ...(code ? { code } : {}),
    }, location.origin);
  }

  const previousBridge = globalThis[BRIDGE_STATE_KEY];
  if (previousBridge?.listener) {
    window.removeEventListener("message", previousBridge.listener, true);
  }

  const listener = async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (
      !isTrustedLocalPage() ||
      message?.source !== REQUEST_SOURCE ||
      message?.protocol !== PROTOCOL ||
      ![
        "CHECK_GEMINI_EXTENSION",
        "OPEN_GEMINI_EXTENSION",
        "START_GEMINI_BATCH"
      ].includes(message?.type)
    ) {
      return;
    }
    // An unpacked-extension reload leaves the old listener attached to the VOX
    // document, but its chrome.runtime is invalid. It must yield so the freshly
    // injected listener can own the request.
    const runtime = extensionRuntime();
    if (!runtime) return;
    event.stopImmediatePropagation();

    const requestId = String(message.requestId || "");
    if (message.type === "CHECK_GEMINI_EXTENSION") {
      if (!requestId) return;
      if (typeof runtime.getManifest !== "function") {
        respond("CHECK_GEMINI_EXTENSION_RESULT", requestId, {
          ok: false,
          code: "EXTENSION_CONTEXT_INVALIDATED",
          error:
            "Extension vừa được reload nhưng bridge trong tab VOX đã cũ. Hãy thử lại; extension đang tự kết nối lại.",
        });
        return;
      }
      respond("CHECK_GEMINI_EXTENSION_RESULT", requestId, {
        ok: true,
        data: {
          installed: true,
          connected: true,
          connectionMode: "local-development",
          extensionVersion: runtime.getManifest().version
        },
      });
      return;
    }

    if (message.type === "OPEN_GEMINI_EXTENSION") {
      if (!requestId) return;
      try {
        const response = await runtime.sendMessage({
          scope: "auto-gemini-images:background",
          type: "OPEN_SIDE_PANEL"
        });
        respond("OPEN_GEMINI_EXTENSION_RESULT", requestId, {
          ok: Boolean(response?.ok),
          data: response?.data || { opened: false },
          error: response?.error?.message || "",
          code: response?.error?.code || "",
        });
      } catch (error) {
        respond("OPEN_GEMINI_EXTENSION_RESULT", requestId, {
          ok: false,
          error: error?.message || String(error),
          code: error?.code || "OPEN_SIDE_PANEL_FAILED",
        });
      }
      return;
    }

    const batchId = String(message.batchId || "").trim();
    const voxBaseUrl = String(message.voxBaseUrl || "").trim();
    if (!requestId || !batchId || !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(voxBaseUrl)) {
      respond("START_GEMINI_BATCH_RESULT", requestId, {
        ok: false,
        error: "Invalid local VOX bridge request.",
        code: "INVALID_VOX_BRIDGE_REQUEST",
      });
      return;
    }

    try {
      const response = await runtime.sendMessage({
        scope: "auto-gemini-images:background",
        type: "START_BATCH",
        batchId,
        settings: { voxBaseUrl, apiToken: "" },
        initiatedByVox: true,
        executionMode: message.executionMode === "manual" ? "manual" : "auto",
        openNewChat: message.openNewChat !== false,
        resetWorkspace: message.resetWorkspace !== false
      });
      respond("START_GEMINI_BATCH_RESULT", requestId, {
        ok: Boolean(response?.ok),
        error: response?.error?.message || "",
        code: response?.error?.code || "",
      });
    } catch (error) {
      respond("START_GEMINI_BATCH_RESULT", requestId, {
        ok: false,
        error: error?.message || String(error),
        code: error?.code || "START_BATCH_FAILED",
      });
    }
  };

  globalThis[BRIDGE_STATE_KEY] = { listener };
  window.addEventListener("message", listener, true);

  window.postMessage({
    source: RESPONSE_SOURCE,
    protocol: PROTOCOL,
    type: "VOX_BRIDGE_READY"
  }, location.origin);
})();
