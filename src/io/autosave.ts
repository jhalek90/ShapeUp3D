// Crash recovery: the current document is kept in the browser's IndexedDB so a
// reload, crash or closed tab doesn't lose work. It never leaves this browser.

const DB_NAME = 'shapeup3d';
const STORE = 'autosave';
const KEY = 'current';

export interface AutosaveRecord {
  /** Serialized document. */
  text: string;
  /** File name it was opened from / saved as, if any. */
  name: string | null;
  /** True if it had changes not saved to a file. */
  dirty: boolean;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function writeAutosave(record: AutosaveRecord): Promise<void> {
  await run('readwrite', (s) => s.put(record, KEY));
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  const r = await run<AutosaveRecord | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<AutosaveRecord | undefined>);
  return r ?? null;
}

export async function clearAutosave(): Promise<void> {
  await run('readwrite', (s) => s.delete(KEY));
}
