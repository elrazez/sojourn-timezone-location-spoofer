// Interface: the Audit page. It runs the probes in every context it can reach and resolves one flat
// report, keyed <context>.<probe>, through the global promise the runner awaits.
//   window.__audit -> Promise<Record<string, string>>
// Invariants: every context carries every probe name the main page produced. A context that cannot
// be created, or that does not answer in time, reads 'unavailable' under each of those names rather
// than being left out, so the Baseline and the covered report line up key for key.
// The popup needs a user gesture, so the runner clicks the button and the page waits for what it
// reports; nothing else here needs driving.

(() => {
  'use strict';

  const OTHER = new URLSearchParams(location.search).get('other') || location.href;
  const PROBES = new URL('probes.js', location.href).href;
  const UNAVAILABLE = 'unavailable';
  // Longer than the geolocation timeout every context waits on, which is the slowest probe.
  const PATIENCE = 25000;

  // Contexts report by postMessage, and a popup can answer before the page asks for it.
  const arrived = new Map();
  const waiting = new Map();
  addEventListener('message', (event) => {
    const said = event.data;
    if (!said || said.spoofer !== 'audit') return;
    arrived.set(said.context, said.report);
    const tell = waiting.get(said.context);
    if (tell) tell(said.report);
  });

  const posted = (context) =>
    new Promise((done) => {
      if (arrived.has(context)) done(arrived.get(context));
      else waiting.set(context, done);
    });

  const after = (ms) => new Promise((done) => setTimeout(() => done(null), ms));

  const framed = (context, src, allow) => {
    const frame = document.createElement('iframe');
    if (allow) frame.allow = 'geolocation';
    frame.src = src;
    document.body.appendChild(frame);
    return posted(context);
  };

  const heard = (target) => new Promise((done) => target.addEventListener('message', (event) => done(event.data)));

  const CONTEXTS = [
    ['same-origin-iframe', () => framed('same-origin-iframe', new URL('audit-frame.html?context=same-origin-iframe', location.href).href, false)],
    ['cross-origin-iframe', () => framed('cross-origin-iframe', `${OTHER}audit-frame.html?context=cross-origin-iframe`, true)],
    ['srcdoc-iframe', () => {
      const frame = document.createElement('iframe');
      frame.srcdoc =
        `<!doctype html><script src="${PROBES}"><\/script>` +
        `<script>__probes('srcdoc-iframe').then((report) =>` +
        ` parent.postMessage({ spoofer: 'audit', context: 'srcdoc-iframe', report }, '*'));<\/script>`;
      document.body.appendChild(frame);
      return posted('srcdoc-iframe');
    }],
    ['about-blank-iframe', () => {
      // Appended and read in the same task, so this is what the frame observes before anything
      // outside it could have touched it.
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      return __probes('about-blank-iframe', frame.contentWindow);
    }],
    ['blob-worker', () => {
      const body = `importScripts(${JSON.stringify(PROBES)});\n__probes('blob-worker').then((report) => postMessage(report));`;
      return heard(new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))));
    }],
    ['module-worker', () => {
      const body = `import(${JSON.stringify(PROBES)}).then(() => __probes('module-worker')).then((report) => postMessage(report));`;
      const url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
      return heard(new Worker(url, { type: 'module' }));
    }],
    ['shared-worker', () => {
      const worker = new SharedWorker('shared-worker.js');
      worker.port.start();
      return heard(worker.port);
    }],
    ['service-worker', async () => {
      await navigator.serviceWorker.register('audit-sw.js');
      const registration = await navigator.serviceWorker.ready;
      const answer = heard(navigator.serviceWorker);
      registration.active.postMessage('report');
      return answer;
    }],
    ['popup', () => posted('popup')],
  ];

  document.getElementById('open-popup').addEventListener('click', () => {
    window.open(new URL('audit-frame.html?context=popup', location.href).href, 'spoofer-audit-popup');
  });

  async function run() {
    const report = {};
    // The main page first, so its key list is the one every other context is lined up against.
    const page = await __probes('page');
    const names = Object.keys(page);
    merge(report, 'page', page, names);
    for (const [context, make] of CONTEXTS) {
      let answered = null;
      try {
        answered = await Promise.race([make(), after(PATIENCE)]);
      } catch {
        answered = null;
      }
      merge(report, context, answered, names);
    }
    return report;
  }

  function merge(report, context, answered, names) {
    for (const name of names) {
      const value = answered && answered[name];
      report[`${context}.${name}`] = value === undefined ? UNAVAILABLE : String(value);
    }
  }

  window.__audit = run();
})();
