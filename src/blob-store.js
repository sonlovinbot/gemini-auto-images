const DB_NAME = "auto-chatgpt-images";
const DB_VERSION = 1;
const STORE_NAME = "blobs";

let databasePromise;

function database() {
  databasePromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function transaction(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = operation(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putBlob(blob, metadata = {}) {
  const id = crypto.randomUUID();
  await transaction("readwrite", (store) =>
    store.put({ id, blob, metadata, createdAt: new Date().toISOString() }),
  );
  return id;
}

export async function getBlob(id) {
  if (!id) return null;
  const record = await transaction("readonly", (store) => store.get(id));
  return record || null;
}

export async function deleteBlob(id) {
  if (!id) return;
  await transaction("readwrite", (store) => store.delete(id));
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
