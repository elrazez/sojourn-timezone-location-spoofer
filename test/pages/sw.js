// First line of the service worker: the zone it observes before it does anything else.
const first = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() };

addEventListener('message', (event) => {
  event.source.postMessage(first);
});
