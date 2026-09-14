// The service worker context.
importScripts('probes.js');

addEventListener('message', (event) => {
  event.waitUntil(__probes('service-worker').then((report) => event.source.postMessage(report)));
});
