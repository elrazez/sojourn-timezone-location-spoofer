// Interface: the only seam onto chrome.runtime messaging, which is the one channel between the
// popup and the service worker.
//   ask(request)   -> the status the service worker holds after it has done what the request asked
//   onAsk(answer)  -> answer runs in the service worker for every request and returns that status
// Invariants: there is one request shape and one answer shape. Every request is answered with the
// whole status, so the popup never tracks what it changed: it asks, and paints what came back.
// Errors: a request sent before the service worker can answer resolves as undefined rather than
// throwing, because the popup's next refresh asks again a second later.

import type { CoverageStatus } from '../coverage.js';

export type Request =
  | { type: 'status' }
  | { type: 'select'; cityId: string }
  | { type: 'enable'; enabled: boolean }
  | { type: 'resume' };

export type MessagingAdapter = {
  ask(request: Request): Promise<CoverageStatus | undefined>;
  onAsk(answer: (request: Request) => Promise<CoverageStatus>): void;
};

export const chromeMessaging: MessagingAdapter = {
  async ask(request) {
    return (await chrome.runtime.sendMessage(request).catch(() => undefined)) as CoverageStatus | undefined;
  },
  onAsk(answer) {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      answer(message as Request).then(respond, () => respond(undefined));
      // The answer comes later, and Chrome keeps the channel open only for a listener that says so.
      return true;
    });
  },
};
