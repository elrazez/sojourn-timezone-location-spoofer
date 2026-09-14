// Interface: the only seam onto chrome.tabs.
//   list()        -> every open tab, in every window, as an id and whether it is still loading
//   onCreated(fn) -> fn runs with the new tab's id, before the tab has committed a document
//   onUpdated(fn) -> fn runs with the tab's id whenever it starts or finishes loading
//   onRemoved(fn) -> fn runs with the closed tab's id
// Invariants: ids and loading only, never urls or titles, so the extension needs no "tabs"
// permission. A tab with no id (a devtools-owned tab) is dropped rather than reported.
// Errors: list rejects with Chrome's message; the listeners never fail.

export type TabState = { id: number; loading: boolean };

export type TabsAdapter = {
  list(): Promise<TabState[]>;
  onCreated(listener: (tabId: number) => void): void;
  onUpdated(listener: (tabId: number, loading: boolean) => void): void;
  onRemoved(listener: (tabId: number) => void): void;
};

export const chromeTabs: TabsAdapter = {
  async list() {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) => ({ id: tab.id, loading: tab.status !== 'complete' }));
  },
  onCreated(listener) {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) listener(tab.id);
    });
  },
  onUpdated(listener) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== undefined) listener(tabId, changeInfo.status !== 'complete');
    });
  },
  onRemoved(listener) {
    chrome.tabs.onRemoved.addListener(listener);
  },
};
