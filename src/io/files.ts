import { FILE_EXTENSION } from './document';

// Opening and saving files on the user's computer. Uses the File System Access API
// where available (Chrome/Edge over HTTPS or localhost), which lets Save write back
// to the same file; otherwise falls back to an upload dialog and a download.

// Minimal typings for the File System Access API (not in TypeScript's DOM lib yet).
interface FileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
}
interface PickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
declare global {
  interface Window {
    showOpenFilePicker?: (options?: PickerOptions) => Promise<FileHandle[]>;
    showSaveFilePicker?: (options?: PickerOptions) => Promise<FileHandle>;
  }
}

export type { FileHandle };

export interface PickedFile {
  name: string;
  text: string;
  handle?: FileHandle;
}

export interface FileTypeInfo {
  description: string;
  mime: string;
  extensions: string[];
}

export const MODEL_FILE: FileTypeInfo = { description: 'ShapeUp3d model', mime: 'application/json', extensions: [FILE_EXTENSION] };

/** Lets the user pick a file to open. Resolves to null if they cancel. */
export async function pickFile(type: FileTypeInfo = MODEL_FILE): Promise<PickedFile | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: type.description, accept: { [type.mime]: type.extensions } }] });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, text: await file.text(), handle };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      throw err;
    }
  }
  // Fallback: a hidden <input type="file">.
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = type.extensions.join(',');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Saves data. With a handle (from an earlier open/save) it writes to that file in
 * place; otherwise it asks where to save (or downloads, if the browser can't ask).
 * Resolves to the saved file's name and handle, or null if the user cancelled.
 */
export async function saveFile(
  data: Blob | string,
  suggestedName: string,
  handle?: FileHandle,
  type: FileTypeInfo = MODEL_FILE,
): Promise<{ name: string; handle?: FileHandle } | null> {
  const blob = typeof data === 'string' ? new Blob([data], { type: type.mime }) : data;
  let target = handle;
  if (!target && window.showSaveFilePicker) {
    try {
      target = await window.showSaveFilePicker({ suggestedName, types: [{ description: type.description, accept: { [type.mime]: type.extensions } }] });
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      throw err;
    }
  }
  if (target) {
    const writable = await target.createWritable();
    await writable.write(blob);
    await writable.close();
    return { name: target.name, handle: target };
  }
  // Fallback: download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name: suggestedName };
}
