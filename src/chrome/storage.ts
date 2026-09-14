// Interface: the only seam onto chrome.storage. Two areas, one shape.
//   chromeStorage -> local, which outlives a browser restart: the Selection and the switch
//   chromeSession -> session, which does not: Paused, so a worker restart keeps it and a browser
//                    restart clears it
//   get(key)        -> the stored value, or undefined when the key was never written
//   set(key, value) -> resolves once the value is durable
//   onChange(fn)    -> fn runs after any write to that area, including its own
// Invariants: values are structured-clonable; listeners are registered once at worker start and
// never removed, because the registration lives exactly as long as the worker's global scope.
// Errors: a rejected promise carries Chrome's message; callers let it propagate.

export type StorageAdapter = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  onChange(listener: () => void): void;
};

function area(store: chrome.storage.StorageArea): StorageAdapter {
  return {
    async get(key) {
      return (await store.get(key))[key];
    },
    async set(key, value) {
      await store.set({ [key]: value });
    },
    onChange(listener) {
      store.onChanged.addListener(() => listener());
    },
  };
}

export const chromeStorage: StorageAdapter = area(chrome.storage.local);
export const chromeSession: StorageAdapter = area(chrome.storage.session);
