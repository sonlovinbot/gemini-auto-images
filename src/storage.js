import { LOG_KEY, SETTINGS_KEY, STORAGE_KEY } from "./constants.js";

const get = (key) => chrome.storage.local.get(key).then((value) => value[key]);

export async function getRuntime() {
  return (await get(STORAGE_KEY)) || {
    status: "idle",
    activeBatchId: null,
    activeTask: null,
    chatGPTTabId: null,
    conversationUrl: null,
    pauseRequested: false,
    stopRequested: false,
    updatedAt: new Date().toISOString()
  };
}

export async function saveRuntime(patch) {
  const runtime = { ...(await getRuntime()), ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_KEY]: runtime });
  return runtime;
}

export async function getSettings() {
  return (await get(SETTINGS_KEY)) || {
    voxBaseUrl: "http://127.0.0.1:4174",
    apiToken: "",
    generationTimeoutMs: 600000
  };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const next = { ...current, ...settings };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function appendLog(entry) {
  const logs = (await get(LOG_KEY)) || [];
  logs.push({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-300) });
}

export async function getLogs() {
  return (await get(LOG_KEY)) || [];
}
