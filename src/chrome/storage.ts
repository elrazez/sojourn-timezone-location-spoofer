// Interface: the only seam onto chrome.storage.
//   get(key)        -> the stored value, or undefined when the key was never written
//   set(key, value) -> resolves once the value is durable
//   onChange(fn)    -> fn runs after any write to this extension's local area, including its own
// Invariants: values are structured-clonable; listeners are registered once at worker start and
// never removed, because the registration lives exactly as long as the worker's global scope.
// Errors: a rejected promise carries Chrome's message; callers let it propagate.

export type StorageAdapter = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  onChange(listener: () => void): void;
};

export const chromeStorage: StorageAdapter = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  onChange(listener) {
    chrome.storage.local.onChanged.addListener(() => listener());
  },
};
