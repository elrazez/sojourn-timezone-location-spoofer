// Interface: the only seam onto chrome.action, which is the toolbar icon and its badge.
//   setBadge(text, color) -> the badge reads that text on that background; an empty text hides it
// Invariants: text and colour are set together, so the badge is never a stale colour with a new
// count. The colour is a CSS hex string; Chrome reads it back as [r, g, b, a].
// Errors: rejects with Chrome's message, which the caller records like any other failure.

export type ActionAdapter = {
  setBadge(text: string, color: string): Promise<void>;
};

export const chromeAction: ActionAdapter = {
  async setBadge(text, color) {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  },
};
