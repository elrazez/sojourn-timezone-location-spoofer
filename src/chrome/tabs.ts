// Interface: the only seam onto chrome.tabs.
//   listIds()     -> the ids of every open tab, in every window, including incognito once allowed
//   onCreated(fn) -> fn runs with the new tab's id, before the tab has committed a document
//   onRemoved(fn) -> fn runs with the closed tab's id
// Invariants: ids only, never urls or titles, so the extension needs no "tabs" permission.
// A tab with no id (a devtools-owned tab) is dropped rather than reported.
// Errors: listIds rejects with Chrome's message; the listeners never fail.

export type TabsAdapter = {
  listIds(): Promise<number[]>;
  onCreated(listener: (tabId: number) => void): void;
  onRemoved(listener: (tabId: number) => void): void;
};

export const chromeTabs: TabsAdapter = {
  async listIds() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
  },
  onCreated(listener) {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) listener(tab.id);
    });
  },
  onRemoved(listener) {
    chrome.tabs.onRemoved.addListener(listener);
  },
};
