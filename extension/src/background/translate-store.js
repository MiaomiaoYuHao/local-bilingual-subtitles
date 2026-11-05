// IndexedDB cache for translated lines: the same sentence never runs the model twice (spec §9).
import "../shared/protocol.js";

const DB_NAME = "st-translations";
const DB_VERSION = 1;
const STORE = "zh";

const DEFAULT_MODEL_TAG = "qwen2.5-0.5b-instruct-v1";
let activeTag = DEFAULT_MODEL_TAG;

/** 缓存按「引擎 + 模型」隔离：本地与云端译文不会互相覆盖 */
export function setCacheModelTag(tag) {
  activeTag = tag ? String(tag) : DEFAULT_MODEL_TAG;
}
export function getCacheModelTag() { return activeTag; }
const MODEL_TAG = DEFAULT_MODEL_TAG;

export const CACHE_MODEL_TAG = MODEL_TAG;

/** Case/whitespace-insensitive cache key so " Hello  world " and "hello world" share an entry. */
export function normalizeKey(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().toLowerCase();
}

export function cacheKey(text) {
  return `${activeTag}::${normalizeKey(text)}`;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("事务被中止"));
      })
  );
}

export async function getCached(text) {
  const key = cacheKey(text);
  const row = await tx("readonly", (store) => ({ __req: store.get(key) }));
  return row || null;
}

export async function getMany(texts) {
  const out = new Map();
  if (!texts || !texts.length) return out;
  await Promise.all(
    texts.map(async (text) => {
      const row = await getCached(text).catch(() => null);
      if (row && row.zh) out.set(text, row.zh);
    })
  );
  return out;
}

export async function putCached(text, zh, extra) {
  const row = {
    key: cacheKey(text),
    en: String(text),
    zh: String(zh),
    model: MODEL_TAG,
    createdAt: Date.now(),
    hits: 0,
    ...(extra || {}),
  };
  await tx("readwrite", (store) => {
    store.put(row);
    return null;
  });
  return row;
}

export async function touchCached(text) {
  try {
    await tx("readwrite", (store) => {
      const req = store.get(cacheKey(text));
      req.onsuccess = () => {
        const row = req.result;
        if (row) { row.hits = (row.hits || 0) + 1; store.put(row); }
      };
      return null;
    });
  } catch { /* stats only */ }
}

export async function stats() {
  try {
    const count = await tx("readonly", (store) => ({ __req: store.count() }));
    return { count: Number(count) || 0, model: activeTag, db: DB_NAME };
  } catch (err) {
    return { count: 0, model: MODEL_TAG, error: String(err && err.message ? err.message : err) };
  }
}

export async function clearAll() {
  await tx("readwrite", (store) => {
    store.clear();
    return null;
  });
  return true;
}