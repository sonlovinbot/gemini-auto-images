import { PROTOCOL } from "./constants.js";

export class VoxAdapter {
  constructor({ voxBaseUrl, baseUrl, apiToken = "" }) {
    const resolvedBaseUrl = String(voxBaseUrl || baseUrl || "").trim();
    if (!resolvedBaseUrl) {
      throw new Error("VOX API URL is not configured.");
    }
    this.baseUrl = resolvedBaseUrl.replace(/\/$/, "");
    this.apiToken = apiToken;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "X-Vox-Extension-Protocol": PROTOCOL,
        ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`VOX ${response.status}: ${detail || response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  }

  getBatch(batchId) {
    return this.request(`/api/extension/batches/${encodeURIComponent(batchId)}`);
  }

  claim(batchId) {
    return this.request(`/api/extension/batches/${encodeURIComponent(batchId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ protocol: PROTOCOL })
    });
  }

  progress(taskId, payload) {
    return this.request(`/api/extension/tasks/${encodeURIComponent(taskId)}/progress`, {
      method: "POST",
      body: JSON.stringify({ protocol: PROTOCOL, ...payload })
    });
  }

  fail(taskId, payload) {
    return this.request(`/api/extension/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      body: JSON.stringify({ protocol: PROTOCOL, ...payload })
    });
  }

  cancel(taskId) {
    return this.request(`/api/extension/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ protocol: PROTOCOL })
    });
  }

  result(taskId, metadata, blob) {
    const form = new FormData();
    form.append("metadata", JSON.stringify({ protocol: PROTOCOL, ...metadata }));
    form.append("image", blob, metadata.expectedOutputName || `${taskId}.png`);
    return this.request(`/api/extension/tasks/${encodeURIComponent(taskId)}/result`, {
      method: "POST",
      body: form
    });
  }
}
