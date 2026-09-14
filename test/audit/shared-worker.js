// The shared worker context, and the one reading a tab session cannot pause: what its first line
// observed goes to the server before anything else runs, which is the residual measurement.
const first = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() };
fetch(`record?zone=${encodeURIComponent(first.zone)}&offset=${first.offset}&where=shared-worker`);

importScripts('probes.js');

onconnect = (event) => {
  const port = event.ports[0];
  port.start();
  __probes('shared-worker').then((report) => port.postMessage(report));
};
