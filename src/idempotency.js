export async function sha256(value) {
  const bytes = value instanceof ArrayBuffer
    ? value
    : ArrayBuffer.isView(value)
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createIdempotencyKey({ projectId, beatId, prompt, promptHash, attempt }) {
  const hash = promptHash || await sha256(prompt);
  return sha256([projectId, beatId, hash, attempt].join(":"));
}
