// Interface: every probe the Audit reads, in whatever context this file is loaded into.
//   __probes(context, scope) -> a promise of one flat object, probe name to string
// The same file is a classic script in the page, an importScripts target in a classic, shared or
// service worker, and an ES module in a module worker, so it declares no import and no export.
// Invariants: every probe name is present in every context. A probe an API is missing for reads
// 'unavailable' rather than being left out, so a context that cannot answer still lines up with the
// Baseline key for key. Every value is a string, because the Audit compares values and prints the
// pair when they differ. No probe throws: one that does records 'threw <message>' as its value.
// Ordering: every synchronous probe is read before the first await, so a context read in the task
// that created it (the about:blank frame) is read whole.
// Pure: no network request, nothing written outside the context it runs in.

(() => {
  'use strict';

  // A fixed instant in the northern summer, so a rendering of it is the same string on any day.
  const FIXED = Date.UTC(2024, 5, 1, 12, 0, 0);
  // The instant CreepJS renders the long zone name of (src/intl/index.ts L47-52).
  const LONG_NAME_INSTANT = 963644400000;
  const UNAVAILABLE = 'unavailable';
  const GEOLOCATION_TIMEOUT = 5000;

  // The two contexts the plan gives a geolocation probe: the main page, and the cross-origin frame
  // that carries allow="geolocation". Every other context reads 'unavailable' in both reports.
  const WITH_GEOLOCATION = ['page', 'cross-origin-iframe'];

  // How many timezonechange events this context has heard since it started, which is the count the
  // Audit compares. Registered at load, so nothing that happens later is missed.
  let timezoneChanges = 0;
  try {
    globalThis.addEventListener('timezonechange', () => {
      timezoneChanges += 1;
    });
  } catch {
    // A scope with no addEventListener has no events to hear either.
  }

  const describe = (error) => (error && error.message ? String(error.message) : String(error));

  // Line and column numbers, blob ids and the server's port are different on every run and say
  // nothing about coverage, and an 'at async' frame names whoever awaited the probe, which is the
  // Audit page's own loop and is there or not depending on how long an earlier probe waited.
  // Everything else in a stack is left exactly as written, and a frame naming the extension is
  // kept whatever else it says, because that frame is the Trace this file exists to catch.
  const normalise = (text) =>
    String(text)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
      .replace(/(localhost|127\.0\.0\.1):\d+/g, '$1')
      .replace(/:\d+:\d+(\)|$)/gm, '$1')
      .split('\n')
      .filter((frame) => frame.includes('extension') || !/^\s*at async /.test(frame))
      .join('\n');

  // What the engine answered: the name of the error it threw, or that it threw nothing at all.
  const outcome = (act) => {
    try {
      act();
      return 'no throw';
    } catch (error) {
      return (error && error.constructor && error.constructor.name) || 'threw';
    }
  };

  const throwsTypeError = (act) => {
    try {
      act();
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  };

  const isNative = (source) => /^function \w*\s?\w*\(\) \{\s*\[native code\]\s*\}$/.test(String(source));

  // The first frame of the stack an act threw with, which is the line CreepJS matches on.
  function firstFrame(act) {
    try {
      act();
      return 'did not throw';
    } catch (error) {
      return String((error && error.stack) || '').split('\n')[1] || 'no frame';
    }
  }

  // The members CreepJS probes, plus the ones the research says it does not probe and the Audit
  // should (Date itself, Date.parse, Temporal.Now, and the three Geolocation prototypes).
  const DATE_METHODS = [
    'getDate', 'getDay', 'getFullYear', 'getHours', 'getMinutes', 'getMonth', 'getTime',
    'getTimezoneOffset', 'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMonth',
    'setSeconds', 'setTime', 'toDateString', 'toJSON', 'toLocaleDateString', 'toLocaleString',
    'toLocaleTimeString', 'toString', 'toTimeString', 'valueOf',
  ];

  function membersOf(s) {
    const at = (path) => {
      try {
        return path.reduce((held, step) => (held == null ? held : held[step]), s);
      } catch {
        return undefined;
      }
    };
    const groups = [
      ['Date', at(['Date']), ['now', 'parse', 'UTC']],
      ['Date.prototype', at(['Date', 'prototype']), DATE_METHODS],
      ['Intl.DateTimeFormat.prototype', at(['Intl', 'DateTimeFormat', 'prototype']),
        ['format', 'formatRange', 'formatToParts', 'resolvedOptions']],
      ['Intl.RelativeTimeFormat.prototype', at(['Intl', 'RelativeTimeFormat', 'prototype']), ['resolvedOptions']],
      ['Function.prototype', at(['Function', 'prototype']), ['toString']],
      ['HTMLIFrameElement.prototype', at(['HTMLIFrameElement', 'prototype']), ['contentDocument', 'contentWindow']],
      ['Permissions.prototype', at(['Permissions', 'prototype']), ['query']],
      ['Geolocation.prototype', at(['Geolocation', 'prototype']), ['getCurrentPosition', 'watchPosition', 'clearWatch']],
      ['GeolocationCoordinates.prototype', at(['GeolocationCoordinates', 'prototype']),
        ['latitude', 'longitude', 'accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed', 'toJSON']],
      ['GeolocationPosition.prototype', at(['GeolocationPosition', 'prototype']), ['coords', 'timestamp', 'toJSON']],
      ['Temporal.Now', at(['Temporal', 'Now']),
        ['timeZoneId', 'instant', 'plainDateISO', 'plainTimeISO', 'zonedDateTimeISO']],
    ];
    const members = [];
    // Vector 25: an audited name whose descriptor holds a value that is not a function. No check
    // below can see one, because every check calls the member, so it is recorded here instead.
    const dataMembers = [];
    for (const [label, holder, names] of groups) {
      if (!holder) continue;
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(holder, name);
        if (!descriptor) continue;
        const fn = descriptor.get || descriptor.value;
        if (typeof fn !== 'function') {
          dataMembers.push(`${label}.${name}:${typeof descriptor.value}[${flagsOf(descriptor)}]`);
          continue;
        }
        members.push({ label: `${label}.${name}`, holder, name, descriptor, fn });
      }
    }
    return { members, dataMembers };
  }

  // The prototype of a function is put back whatever the probe did to it, so one probe cannot
  // change what the next one reads.
  function withPrototype(fn, act) {
    const kept = Object.getPrototypeOf(fn);
    try {
      act();
    } finally {
      Object.setPrototypeOf(fn, kept);
    }
  }

  const POISONED = ['arguments', 'caller', 'prototype', 'toString'];

  // CreepJS src/lies/index.ts probes 1 to 26, in its order. Each answers true when the member lies,
  // which for an engine-produced value is never.
  const CHECKS = [
    ['01-illegal-getter', (m) => !!m.descriptor.get && !throwsTypeError(() => m.holder[m.name])],
    ['02-call-interface', (m) => !throwsTypeError(() => {
      new m.fn();
      m.fn.call(m.holder);
    })],
    ['03-apply-interface', (m) => !throwsTypeError(() => {
      new m.fn();
      m.fn.apply(m.holder);
    })],
    ['04-new-instance', (m) => !throwsTypeError(() => new m.fn())],
    ['05-class-extends', (m) => !throwsTypeError(() => {
      class Fake extends m.fn {}
      return Fake;
    })],
    ['06-null-prototype', (m) => !throwsTypeError(() => withPrototype(m.fn, () => Object.setPrototypeOf(m.fn, null).toString()))],
    ['07-native-tostring', (m, toString) => !isNative(toString.call(m.fn)) || !isNative(toString.call(m.fn.toString))],
    ['08-prototype-in', (m) => 'prototype' in m.fn],
    ['09-own-descriptors', (m) => POISONED.some((key) => !!Object.getOwnPropertyDescriptor(m.fn, key))],
    ['10-has-own', (m) => POISONED.some((key) => Object.prototype.hasOwnProperty.call(m.fn, key))],
    ['11-descriptor-keys', (m) => Object.keys(Object.getOwnPropertyDescriptors(m.fn)).sort().toString() !== 'length,name'],
    ['12-own-names', (m) => Object.getOwnPropertyNames(m.fn).sort().toString() !== 'length,name'],
    ['13-reflect-keys', (m) => Reflect.ownKeys(m.fn).sort().toString() !== 'length,name'],
    ['14-object-tostring-stack', (m) => !/at (Function\.)?toString/.test(firstFrame(() => Object.create(m.fn).toString()))
      || !/at (Object\.)?toString/.test(firstFrame(() => Object.create(new Proxy(m.fn, {})).toString()))],
    ['15-arguments-caller', (m) => !throwsTypeError(() => {
      m.fn.arguments;
      m.fn.caller;
    })],
    ['16-tostring-arguments-caller', (m) => !throwsTypeError(() => {
      m.fn.toString.arguments;
      m.fn.toString.caller;
    })],
    ['17-cyclic-prototype', (m) => !throwsTypeError(() => withPrototype(m.fn, () => Object.setPrototypeOf(m.fn, Object.create(m.fn)).toString()))],
    // 18 to 24 are CreepJS's escalated probes, which it runs on Function.prototype.toString always
    // and on any other member that has already lied. Each of them mutates the function it probes,
    // including through a trapless Proxy, which forwards the write to its target, so every one is
    // put back. They record what the engine answered rather than a verdict: current V8 answers a
    // cyclic prototype chain with a RangeError where CreepJS expects a TypeError, so the answer
    // itself is the probe and the Baseline is what it has to match.
    ['18-proto-recursion', escalated((fn) => outcome(() => withPrototype(fn, () => {
      fn.__proto__ = new Proxy(fn, {});
      fn++;
    })))],
    ['19-proxy-chain-cycle', escalated((fn) => outcome(() => withPrototype(fn, () => {
      const proxy = new Proxy(fn, {});
      Object.setPrototypeOf(proxy, Object.create(proxy)).toString();
    })))],
    ['20-proxy-proto-cycle', escalated((fn) => outcome(() => withPrototype(fn, () => {
      const proxy = new Proxy(fn, {});
      proxy.__proto__ = proxy;
      proxy++;
    })))],
    ['21-reflect-set-prototype', escalated((fn) => outcome(() => withPrototype(fn, () => {
      Reflect.setPrototypeOf(fn, Object.create(fn));
      return 'spoofer' in fn;
    })))],
    ['22-reflect-set-prototype-proxy', escalated((fn) => outcome(() => withPrototype(fn, () => {
      const proxy = new Proxy(fn, {});
      Reflect.setPrototypeOf(proxy, Object.create(proxy));
      return 'spoofer' in proxy;
    })))],
    ['23-hasinstance-stack', escalated((fn) =>
      `${outcome(() => fn instanceof fn)}/${/at (Function\.)?\[Symbol.hasInstance\]/.test(firstFrame(() => fn instanceof fn))}`)],
    ['24-defineproperty-roundtrip', escalated((fn) => {
      try {
        return outcome(() => Object.defineProperty(fn, '', { configurable: true }).toString());
      } finally {
        delete fn[''];
      }
    })],
    // 25 is absent from this list: a member whose descriptor holds a value that is not a function
    // never reaches a check that calls it, so it is read off the prototypes as lies.25 below.
    // 26 is every exception raised while probing, which the runner below records for any check.
    ['26-probe-threw', () => false],
  ];

  function escalated(check) {
    return (m) => (m.label === 'Function.prototype.toString' ? check(m.fn) : false);
  }

  // Every member against every check, once, so the per-check and per-member views below are two
  // readings of one pass.
  function queryLies(s) {
    const { members, dataMembers } = membersOf(s);
    const scope = phantomScope(s);
    const toString = (scope && scope.Function && scope.Function.prototype.toString) || Function.prototype.toString;
    const byCheck = {};
    const byMember = {};
    for (const [name] of CHECKS) byCheck[name] = [];
    for (const member of members) {
      byMember[member.label] = [];
      for (const [name, check] of CHECKS) {
        let lied = false;
        try {
          lied = check(member, toString);
        } catch (error) {
          byCheck['26-probe-threw'].push(`${member.label}:threw ${describe(error)}`);
          byMember[member.label].push('26-probe-threw');
          continue;
        }
        if (lied) {
          const said = typeof lied === 'string' ? `${member.label}=${lied}` : member.label;
          byCheck[name].push(said);
          byMember[member.label].push(typeof lied === 'string' ? `${name}=${lied}` : name);
        }
      }
    }
    return { byCheck, byMember, scope, dataMembers, members: members.map((member) => member.label) };
  }

  // CreepJS reads lies through an iframe inside an iframe, reached by indexed window access rather
  // than contentWindow, so a hooked contentWindow getter never sees it (probe 27).
  // Where a probe hangs an iframe it needs. A document read from its own head scripts, which is
  // what the srcdoc context is, has no body yet, and html is the parent then.
  const rootOf = (s) => s.document && (s.document.body || s.document.documentElement);

  function phantomScope(s) {
    try {
      if (!rootOf(s)) return null;
      const outer = s.document.createElement('iframe');
      outer.style.display = 'none';
      rootOf(s).appendChild(outer);
      const outerWindow = s[s.length - 1];
      const inner = outerWindow.document.createElement('iframe');
      rootOf(outerWindow).appendChild(inner);
      return outerWindow[outerWindow.length - 1];
    } catch {
      return null;
    }
  }

  const flagsFor = (byMember, prefix) =>
    Object.keys(byMember)
      .filter((label) => label.startsWith(prefix))
      .map((label) => `${label}=[${byMember[label].join(' ')}]`)
      .join(' ') || 'no member';

  const flagsOf = (d) => `${d.enumerable ? 'e' : ''}${d.configurable ? 'c' : ''}${d.writable ? 'w' : ''}`;

  // Every own property of a target with the shape of its descriptor, and for a function its source,
  // name, length and whether it carries a prototype.
  function shapeOf(target) {
    if (!target) return UNAVAILABLE;
    return Object.getOwnPropertyNames(target)
      .sort()
      .map((name) => {
        const d = Object.getOwnPropertyDescriptor(target, name);
        const flags = flagsOf(d);
        if (d.get || d.set) return `${name}:accessor[${flags}]${fnShape(d.get)}${fnShape(d.set)}`;
        return `${name}:${typeof d.value}[${flags}]${typeof d.value === 'function' ? fnShape(d.value) : ''}`;
      })
      .join(' ');
  }

  const fnShape = (fn) =>
    typeof fn === 'function'
      ? `{${fn.name}/${fn.length}/${'prototype' in fn}/${Function.prototype.toString.call(fn)}}`
      : '';

  // The zone a frame of each kind reads on first synchronous access (probe 50). A frame the page
  // cannot reach into reads 'blocked', which is what an opaque origin answers with.
  function frameCoverage(s) {
    const kinds = {
      srcdoc: (frame) => {
        frame.srcdoc = '<!doctype html>';
      },
      data: (frame) => {
        frame.src = 'data:text/html,<!doctype html>';
      },
      blob: (frame) => {
        frame.src = URL.createObjectURL(new Blob(['<!doctype html>'], { type: 'text/html' }));
      },
      sandboxed: (frame) => {
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = '<!doctype html>';
      },
      javascript: (frame) => {
        frame.src = 'javascript:""';
      },
    };
    return Object.keys(kinds)
      .map((kind) => {
        try {
          const frame = s.document.createElement('iframe');
          kinds[kind](frame);
          rootOf(s).appendChild(frame);
          const inside = frame.contentWindow;
          return `${kind}=${inside.Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        } catch {
          return `${kind}=blocked`;
        }
      })
      .join(' ');
  }

  // The window's own property names against a fresh iframe's, which is CreepJS's litter check.
  function globalLitter(s) {
    const frame = s.document.createElement('iframe');
    rootOf(s).appendChild(frame);
    const fresh = Object.getOwnPropertyNames(frame.contentWindow);
    return Object.getOwnPropertyNames(s)
      .filter((key) => !fresh.includes(key))
      .sort()
      .join(',');
  }

  async function geolocation(s, context, report) {
    const keys = ['geo.position', 'geo.instanceof', 'geo.json-keys', 'geo.permission-state'];
    const has = WITH_GEOLOCATION.includes(context) && s.navigator && s.navigator.geolocation;
    if (!has) {
      for (const key of keys) report[key] = UNAVAILABLE;
      return;
    }
    report['geo.permission-state'] = await s.navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => status.state, (error) => `threw ${describe(error)}`);
    // Every call passes the timeout, because a browser with no authorised location provider
    // neither resolves nor errors on its own: the Baseline answer is error 3 after it.
    const heard = await new Promise((done) => {
      s.navigator.geolocation.getCurrentPosition(
        (position) => done({ position }),
        (error) => done({ error }),
        { timeout: GEOLOCATION_TIMEOUT },
      );
    });
    if (heard.error) {
      const said = `error ${heard.error.code}`;
      report['geo.position'] = said;
      report['geo.instanceof'] = said;
      report['geo.json-keys'] = said;
      return;
    }
    const { position } = heard;
    const c = position.coords;
    report['geo.position'] = JSON.stringify({
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: c.accuracy,
      altitude: c.altitude,
      altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading,
      speed: c.speed,
    });
    report['geo.instanceof'] = `position=${position instanceof s.GeolocationPosition} coords=${c instanceof s.GeolocationCoordinates}`;
    report['geo.json-keys'] =
      'toJSON' in s.GeolocationPosition.prototype
        ? (() => {
            const json = JSON.parse(JSON.stringify(position));
            return `${Object.keys(json).sort().join(',')}|${Object.keys(json.coords).sort().join(',')}`;
          })()
        : 'absent';
  }

  async function collect(context, scope) {
    const s = scope || globalThis;
    const report = {};
    const put = (name, produce) => {
      try {
        const value = produce();
        report[name] = value === undefined ? UNAVAILABLE : String(value);
      } catch (error) {
        report[name] = `threw ${describe(error)}`;
      }
    };
    const window = !!s.document;

    // Time. Every value is read at a fixed instant, so only the zone can move it.
    put('time.zone', () => new s.Intl.DateTimeFormat().resolvedOptions().timeZone);
    put('time.offset-epoch', () => new s.Date(0).getTimezoneOffset());
    put('time.offset-summer', () => new s.Date(FIXED).getTimezoneOffset());
    put('time.to-string', () => new s.Date(FIXED).toString());
    put('time.to-time-string', () => new s.Date(FIXED).toTimeString());
    put('time.to-locale-long', () => new s.Date(FIXED).toLocaleString('en-US', { timeZoneName: 'long' }));
    put('time.format-to-parts', () => JSON.stringify(new s.Intl.DateTimeFormat().formatToParts(new s.Date(FIXED))));
    // Offset-less, so it is read in the local zone and reveals it.
    put('time.parse-local', () => s.Date.parse('2024-06-01T12:00'));
    put('time.temporal-zone', () => (typeof s.Temporal === 'undefined' ? 'absent' : s.Temporal.Now.timeZoneId()));

    // Integrity.
    put('integrity.global-names', () => Object.getOwnPropertyNames(s).sort().join(','));
    put('integrity.date', () => shapeOf(s.Date));
    put('integrity.date-prototype', () => shapeOf(s.Date && s.Date.prototype));
    put('integrity.intl', () => shapeOf(s.Intl));
    put('integrity.intl-dtf-prototype', () => shapeOf(s.Intl && s.Intl.DateTimeFormat.prototype));
    put('integrity.geolocation-prototype', () => shapeOf(s.Geolocation && s.Geolocation.prototype));
    put('integrity.coordinates-prototype', () => shapeOf(s.GeolocationCoordinates && s.GeolocationCoordinates.prototype));
    put('integrity.position-prototype', () => shapeOf(s.GeolocationPosition && s.GeolocationPosition.prototype));
    put('integrity.throw-stack', () => {
      try {
        s.Date.prototype.getTimezoneOffset.call(null);
        return 'did not throw';
      } catch (error) {
        return `${describe(error)}\n${normalise(error.stack)}`;
      }
    });
    put('integrity.extension-resources', () =>
      s.performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('extension'))
        .join(',') || 'none');
    put('integrity.document-scripts', () => (window ? s.document.scripts.length : UNAVAILABLE));
    put('integrity.webdriver', () => (s.navigator ? String(s.navigator.webdriver) : UNAVAILABLE));

    // The event Chromium does not ship, recorded in both reports so it cancels out.
    put('tzchange.supported', () => 'ontimezonechange' in s);
    put('tzchange.events', () => timezoneChanges);

    const lies = queryLies(s);
    for (const [name] of CHECKS) put(`lies.${name}`, () => lies.byCheck[name].join(',') || 'none');

    // How many audited members were read, and which of them hold a value that is not a function.
    put('lies.25-descriptor-value', () =>
      `checked=${lies.members.length + lies.dataMembers.length} ${lies.dataMembers.join(' ') || 'none'}`);

    // The vectors the research names, one probe each, named after the file that implements it.
    put('lies.27-phantom-realm', () =>
      lies.scope ? `reachable=true zone=${lies.scope.Intl.DateTimeFormat().resolvedOptions().timeZone}` : UNAVAILABLE);
    put('lies.28-function-tostring', () => flagsFor(lies.byMember, 'Function.prototype'));
    put('timezone.29-lie-rejection', () =>
      ['Date.prototype.getTimezoneOffset', 'Intl.DateTimeFormat.prototype.resolvedOptions',
        'Intl.RelativeTimeFormat.prototype.resolvedOptions']
        .map((label) => `${label}=[${(lies.byMember[label] || ['absent']).join(' ')}]`)
        .join(' '));
    put('timezone.30-parse-vs-offset', () => {
      const computed = (s.Date.parse('6/1/2024') - s.Date.parse('2024-06-01')) / 60000;
      return `computed=${computed} reported=${new s.Date(FIXED).getTimezoneOffset()}`;
    });
    put('timezone.31-historical-1113', () => {
      const local = s.Date.parse('7/1/1113');
      const utc = s.Date.parse('1113-07-01T00:00:00Z');
      const zone = new s.Intl.DateTimeFormat().resolvedOptions().timeZone;
      const rendered = new s.Intl.DateTimeFormat('en', { timeZone: zone, timeStyle: 'long', dateStyle: 'short' })
        .format(new s.Date(utc));
      return `offset=${(utc - local) / 60000} intl=${rendered}`;
    });
    put('timezone.32-date-string-zone', () => String(new s.Date(FIXED)).replace(/^.*\((.+)\)$/, '$1'));
    put('timezone.33-dtf-without-new', () => {
      const called = s.Intl.DateTimeFormat().resolvedOptions().timeZone;
      const constructed = new s.Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `callable=${typeof called === 'string'} same=${called === constructed}`;
    });
    put('intl.34-long-zone-name', () =>
      new s.Intl.DateTimeFormat(undefined, { month: 'long', timeZoneName: 'long' }).format(LONG_NAME_INSTANT));
    put('intl.35-locale-set', () =>
      ['Collator', 'DateTimeFormat', 'DisplayNames', 'ListFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat']
        .map((name) => {
          try {
            const options = name === 'DisplayNames' ? [undefined, { type: 'language' }] : [];
            return new s.Intl[name](...options).resolvedOptions().locale;
          } catch (error) {
            return `threw ${describe(error)}`;
          }
        })
        .join('|'));
    put('worker.36-scope-zone', () => {
      const name = s.constructor && s.constructor.name;
      return `${name}=${new s.Intl.DateTimeFormat().resolvedOptions().timeZone}/${new s.Date(FIXED).getTimezoneOffset()}`;
    });
    put('worker.37-tostring-lies', () => `${s.constructor && s.constructor.name} ${flagsFor(lies.byMember, 'Function.prototype')}`);
    put('worker.38-location', () => (s.location ? normalise(s.location.href) : UNAVAILABLE));
    put('worker.39-locale-trust', () => {
      const language = s.navigator ? s.navigator.language : 'absent';
      const languages = s.navigator ? String(s.navigator.languages) : 'absent';
      const locale = new s.Intl.DateTimeFormat().resolvedOptions().locale;
      return `language=${language} languages=${languages} locale=${locale} trusty=${languages.split(',').includes(locale)}`;
    });
    put('speech.40-voice-language', () => {
      if (!s.speechSynthesis) return UNAVAILABLE;
      const voices = s.speechSynthesis.getVoices();
      const spoken = voices.length === 0 ? 'none' : String(voices[0].lang);
      return `voice=${spoken} locale=${new s.Intl.DateTimeFormat().resolvedOptions().locale}`;
    });
    put('headless.41-unattached-contentwindow', () => {
      if (!window) return UNAVAILABLE;
      const frame = s.document.createElement('iframe');
      frame.srcdoc = 'spoofer';
      return `contentWindow=${!!frame.contentWindow}`;
    });
    put('resistance.42-iframe-getter-lies', () => (window ? flagsFor(lies.byMember, 'HTMLIFrameElement.prototype') : UNAVAILABLE));
    put('status.43-global-litter', () => (window ? globalLitter(s) : UNAVAILABLE));
    put('status.44-recent-globals', () => {
      if (!window) return UNAVAILABLE;
      const keys = Object.getOwnPropertyNames(s).slice(-50);
      return keys
        .filter((key) => {
          const d = Object.getOwnPropertyDescriptor(s, key);
          const held = d && (d.get || d.value);
          return typeof held === 'function' && !isNative(Function.prototype.toString.call(held));
        })
        .join(',') || 'all native';
    });
    // The state itself is geo.permission-state, which is read where the plan puts a geolocation
    // probe. This is the other half of the vector: whether Permissions.query lied.
    put('navigator.45-permission-query', () =>
      s.navigator && s.navigator.permissions ? flagsFor(lies.byMember, 'Permissions.prototype') : UNAVAILABLE);
    put('spoofer.46-extension-in-stack', () => {
      const stacks = [];
      const deep = (left) => (left === 0 ? new Error('spoofer').stack : deep(left - 1));
      stacks.push(deep(3));
      try {
        s.Date.prototype.getTimezoneOffset.call(null);
      } catch (error) {
        stacks.push(error.stack);
      }
      const named = String(stacks.join('\n'))
        .split('\n')
        .filter((frame) => frame.includes('extension'));
      return named.length === 0 ? 'none' : normalise(named.join(' '));
    });
    put('spoofer.47-temporal', () => {
      // The descriptor is read before anything touches the lazy accessor, in both reports alike.
      const descriptor = Object.getOwnPropertyDescriptor(s, 'Temporal');
      const shape = descriptor
        ? `${descriptor.enumerable}/${descriptor.configurable}/${descriptor.writable}/${typeof (descriptor.get || descriptor.value)}`
        : 'absent';
      if (typeof s.Temporal === 'undefined') return `descriptor=${shape} zone=absent instant=absent`;
      return `descriptor=${shape} zone=${s.Temporal.Now.timeZoneId()} instant=${typeof s.Date.prototype.toTemporalInstant}`;
    });
    put('spoofer.48-geolocation-prototypes', () =>
      s.Geolocation
        ? ['Geolocation.prototype', 'GeolocationCoordinates.prototype', 'GeolocationPosition.prototype']
            .map((group) => flagsFor(lies.byMember, group))
            .join(' ')
        : UNAVAILABLE);
    put('spoofer.49-cross-signal', () => {
      const zone = new s.Intl.DateTimeFormat().resolvedOptions().timeZone;
      const language = s.navigator ? s.navigator.language : 'absent';
      return `zone=${zone} offset=${new s.Date(FIXED).getTimezoneOffset()} language=${language}`;
    });
    put('spoofer.50-frame-coverage', () => (window ? frameCoverage(s) : UNAVAILABLE));

    // Last, because it is the only probe that waits: everything above is read in the task that
    // called collect, which is what makes the about:blank frame a same-task reading.
    await geolocation(s, context, report);
    return report;
  }

  // The runner asserts the 'at async' guard against a synthetic stack, which needs normalise
  // itself. Hung off collect rather than on the scope, so no context gains a global name.
  collect.normalise = normalise;
  globalThis.__probes = collect;
})();
