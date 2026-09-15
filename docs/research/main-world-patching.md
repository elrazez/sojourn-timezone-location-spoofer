# R3: MAIN-world patching (mechanism A) and its cost

Scope: what a MAIN-world content script at `document_start` can and cannot guarantee in current stable Chrome (154.0.8037.17 on 2026-09-14, chromiumdash `fetch_releases?channel=Stable`: `"milestone":154`, chromium `62d2fcb4`, v8 `e71d6958`). It covers how the Selection would reach that script, every CreepJS check that would see a replaced `Date`, `Intl` or geolocation function, whether `Temporal` ships, and which workers A leaves showing real values. Chromium paths are cited at `main`. The quotes marked (stable) were re-checked at the 154 commit and match. CreepJS is cited at `master` (last push 2026-06-11).

## 1. `world: "MAIN"` at `document_start`: ordering and frame coverage

**Documented guarantee.** The content scripts guide, `run_at` table, says: `document_start`: "Scripts are injected after any files from css, but before any other DOM is constructed or any other script is run." [CS]

**Chromium path (settles the ordering and `documentElement`).**
- The parser inserts `<html>`, and Blink runs extension scripts right there, before any `<head>` content is parsed. `third_party/blink/renderer/core/html/html_html_element.cc` L58-61: `GetDocument().Parser()->DocumentElementAvailable();` then `GetDocument().GetFrame()->Loader().RunScriptsAtDocumentElementAvailable();`. So `document.documentElement` exists (the `<html>` element) and inline `<head>` scripts have not run.
- `content/renderer/render_frame_impl.cc` L4278-4284: `RunScriptsAtDocumentElementAvailable()` calls `GetContentClient()->renderer()->RunScriptsAtDocumentStart(this);`. That reaches `extensions/renderer/dispatcher.cc` L856-861 and then `extension_frame_helper.cc` L296-299: `RunCallbacksWhileFrameIsValid(weak_ptr_factory_.GetWeakPtr(), &document_element_created_callbacks_);`.
- Those callbacks are queued by `script_injection_manager.cc` L142-147 (`ScheduleAtDocumentStart(... mojom::RunLocation::kDocumentStart)`). They run `StartInjectScripts` (L319-356), whose first run location must be document_start (L336, stable: `invalid_run_order = (run_location != mojom::RunLocation::kDocumentStart);`), and then `InjectScripts` (L359-397), which injects in a loop on the same stack.
- Execution is synchronous at document_start. `extensions/renderer/script_injection.cc` L286-300: "We don't do this for kDocumentStart scripts, because there's no UI to jank until after those run, so we run them as soon as we can." Only `kDocumentEnd`/`kDocumentIdle` content scripts get `EvaluationTiming::kAsynchronous`.
- Main-world CSP: "When a content script is injected into the main world, the CSP of the page applies." [CS] The patch must not rely on `eval`/`new Function`.

**Child frames and the initial empty document.**
- `dispatcher.cc` L390-393 (stable): "The RenderFrame comes with the initial empty document already created." It then calls `DidCreateDocumentElement(render_frame->GetWebFrame());` and, under the comment "We run scripts on the empty document.", `RunScriptsAtDocumentStart(render_frame);`.
- `script_injection_manager.cc` L122-129 (stable): "scripts in child frames are expected to be run inside the initial empty document", then `if (!render_frame()->IsMainFrame()) { DidCreateDocumentElement(); }`.
- So a matched script runs synchronously in a new child frame's initial `about:blank` while the RenderFrame is being created. Chromium issue 40480216 (secondary pointer) describes the same behaviour: content scripts "running synchronously while the iframe is being created".

**`all_frames`.** "If set to false it will only inject into the topmost frame." [MCS] For `registerContentScripts`, `allFrames`: "Each frame is checked independently for URL requirements; it will not inject into child frames if the URL requirements are not met." [SCR]

**`match_about_blank`.**
- The manifest reference says: "Whether the script should inject into an about:blank frame where the parent URL matches one of the patterns declared in "matches"." [MCS]
- Code maps it to `kMatchForAboutSchemeAndClimbTree` (`extensions/common/manifest_handlers/content_scripts_handler.cc` L83-85). That mode matches any `about:` URL: `content_script_injection_url_getter.cc` L57 (stable) `result = document_url.SchemeIs(url::kAboutScheme);`. So it covers `about:blank` and `about:srcdoc`, and it climbs to the nearest same-origin non-about ancestor (L146-147).
- `chrome.scripting` has no `matchAboutBlank`. `content_scripts_handler.cc` L77-78: "Manifest content scripts support `match_about_blank` (unlike `SerializedUserScript`)".

**`match_origin_as_fallback`.**
- `kAlways` considers exactly these schemes. `content_script_injection_url_getter.cc` L32-37 (stable): `url::kAboutScheme, url::kBlobScheme, url::kDataScheme, url::kFileSystemScheme`. It then matches against the origin or precursor origin (L126-133: `return origin_or_precursor_origin.GetURL();`).
- Sandboxed iframes are included. `extensions/renderer/script_context.cc` L430-433: "We explicitly allow inaccessible parents here. Extensions should still be able to inject into a sandboxed iframe if it has access to the embedding origin."
- The docs add two constraints. Chrome "requires any content scripts specified with "match_origin_as_fallback" set to true to also specify a path of `*`", and "When both "match_origin_as_fallback" and "match_about_blank" are specified, "match_origin_as_fallback" takes priority." [CS] The manifest key landed in "Chrome 99: match_origin_as_fallback in Canary". [WN]
- Known gap: `content_script_injection_url_getter.cc` L148-149, "TODO(crbug.com/40753677): This can return the incorrect result, e.g. if a parent frame navigates a grandchild frame to about:blank."

**Race with the parent frame.**
- For the initial empty document, the code above injects before the parent can touch the child.
- A different window exists after a same-origin `src` navigation commits: a new global the parent can reach through `iframe.contentWindow` or `frames[i]`, before the child's parser has inserted `<html>` and fired document_start.
- `OPEN:` whether parent script can run in that gap and read the child's real `Date`. Settle with an Audit probe (parent polls `frames[0].Date.prototype.getTimezoneOffset` while a slow same-origin iframe loads), or by reading Blink `DocumentLoader::CommitNavigation` against `HTMLDocumentParser` first-chunk handling.
- `OPEN:` whether `document.open()`/`document.write()` on a same-origin frame, or a `javascript:` URL iframe, produces a global without a fresh document_start run. Settle by reading `third_party/blink/renderer/core/dom/document.cc` `Document::open` and `docs/special_case_urls.md`, or with an Audit probe.

## 2. `chrome.scripting.registerContentScripts` / `updateContentScripts`

**Versions and fields.**
- Dynamic registration arrived in "Chrome 96: dynamic content scripts", with "registering, updating, unregistering, and getting a list of content scripts at runtime". [WN] `RegisteredContentScript` is "Chrome 96+". [SCR]
- `world`: "Chrome 102+ The JavaScript "world" to run the script in. Defaults to ISOLATED." [SCR], and "Chrome 102: Dynamic content scripts in main world". [WN]
- `matchOriginAsFallback`: "Chrome 119+". [SCR] IDL: `extensions/common/api/scripting.webidl` L158 `boolean matchOriginAsFallback;`.
- `persistAcrossSessions`: "Specifies if this content script will persist into future sessions. The default is true." [SCR] Code: `extensions/browser/api/scripting/scripting_api.cc` L665-667, "Scripts will persist across sessions by default." `bool persist_across_sessions = script.persist_across_sessions.value_or(true);`.

**Already-open tabs: no.**
- Injection starts only from per-document run-location signals (section 1). When the renderer receives an updated script set, it only drops queued injections. `script_injection_manager.cc` L288-295: `OnUserScriptsUpdated` does `std::erase_if(pending_injections_, ...)` and nothing else.
- The docs say "Unregistering content scripts will not remove scripts or styles that have already been injected." [SCR]
- At browser or extension startup, navigations are deferred until scripts load. `chrome/browser/extensions/user_script_listener.cc` L50-54: "Only defer requests if Resume has not yet been called." `return DEFER;`.
- `OPEN:` whether `registerContentScripts`/`updateContentScripts` resolves only after every renderer holds the new set, or a navigation started right after a Selection change can still get the old script. Settle by reading `extensions/browser/user_script_loader.cc` and `extension_user_script_loader.cc`.

**`executeScript` timing (for open tabs).** "By default, the script will be run at document_idle, or immediately if the page has already loaded. If the injectImmediately property is set, the script will inject without waiting, even if the page has not finished loading." `injectImmediately` (Chrome 102+): "this is not a guarantee that injection will occur prior to page load". [SCR] A tab patched this way has already let page scripts read the real values.

## 3. `chrome.userScripts`

- Availability: "Chrome 120+ MV3+", with the `"userScripts"` permission plus `host_permissions`. [US]
- `register` takes `js: ScriptSource[]`. `ScriptSource.code`: "A string containing the JavaScript code to inject. Exactly one of file or code must be specified." [US] IDL: `extensions/common/api/user_scripts.webidl` L19-22 `DOMString code;`. Package validation skips inline code: `extensions/common/utils/content_script_utils.cc` L436-440, "Don't validate scripts with inline code source, since they don't have file sources."
- `world`: `"MAIN"` is "the execution environment shared with the host page's JavaScript"; the default is `USER_SCRIPT`. [US] `extensions/browser/api/user_scripts/user_scripts_api.cc` L97-98: `case api::user_scripts::ExecutionWorld::kMain: return mojom::ExecutionWorld::kMain;`.
- `runAt` and `allFrames` exist. The `RegisteredUserScript` fields are `allFrames, excludeGlobs, excludeMatches, id, includeGlobs, js, matches, runAt, world, worldId`, with no `matchOriginAsFallback` or `matchAboutBlank`. [US] `user_scripts.webidl` has no such field, `user_scripts_api.cc` never references `match_origin_as_fallback`, and the default is `extensions/common/user_script.h` L371-372 `match_origin_as_fallback_ = mojom::MatchOriginAsFallbackBehavior::kNever;`.
  - `OPEN:` confirm at runtime that a MAIN-world user script does not reach `about:blank`, `srcdoc`, `data:` or `blob:` frames (Audit probe).
- `configureWorld` "Configures the `USER_SCRIPT` execution environment" (`csp`, `messaging`, `worldId`). [US] "World ID can only be specified for USER_SCRIPT worlds." (`user_scripts_api.cc` L61-63.) It does nothing for `MAIN`.
- Enabling requirement, quoted from [US]:
  - Detection code: `if (version >= 138) { // Allow User Scripts toggle will be used. } else { // Developer mode toggle will be used. }`
  - "Chrome versions prior to 138 (Developer mode toggle) ... Your users must also enable Developer mode."
  - "Chrome versions 138 and newer (Allow User Scripts toggle) The Allow User Scripts toggle is on each extension's details page".
  - "If the Allow User Scripts toggle is not enabled, browser.userScripts is undefined."
  - The brief's 138 is confirmed.
- "User scripts are cleared when an extension updates. You can add them back by running code in the runtime.onInstalled event handler". [US]

## 4. Synchronous configuration

- **No synchronous channel into the MAIN world.** A main-world context is classified as a web page, not a content script. `extensions/renderer/script_context_set.cc` L265-281 assigns `kContentScript`/`kUserScript` only to isolated worlds (`world_id >= ...GetLowestIsolatedWorldId()`); everything else falls to L358 `return mojom::ContextType::kWebPage;`. The `ExecutionWorld` definition: "the main world of the DOM which is shared with the page's JavaScript" (`extensions/common/api/extension_types.json` L198). So a MAIN-world script has no `chrome.*` bindings.
- An ISOLATED companion script cannot fetch the Selection synchronously either: "The Storage API is asynchronous with bulk read and write operations." [ST] Any isolated-to-main hand-off also goes through the shared DOM ("they share access to the page's DOM" [CS]), which the page can observe.
- **`registerContentScripts` accepts packaged file paths only: yes.**
  - `scripting.webidl` L140-142: "The list of JavaScript files to be injected into matching pages." `sequence<DOMString> js;`.
  - The docs: "Files are specified as strings that are paths relative to the extension's root directory." [SCR]
  - Registration validates the files on the file thread (`scripting_api.cc` L688-695, `ValidateParsedScriptsOnFileThread`), resolving each against the extension root and failing with `IDS_EXTENSION_LOAD_JAVASCRIPT_FAILED` (`content_script_utils.cc` L452-461).
  - There is no `js: [{code}]` form in `chrome.scripting`. The only code-carrying form is `executeScript({func, args})`, which is one-shot: "Exactly one of 'func' and 'files' must be specified" and "'args' may not be used with file injections." (`scripting_api.cc` L288, L293).
- So the Selection must be in the script text. Either a packaged file per City registered with `registerContentScripts`, which must exist at build time for every City in the Catalog and so cannot carry a Jitter generated at selection time, or `userScripts.register` with inline `code`, which needs the toggle.
- **Tricks, all forbidden.**
  - Sync XHR or `fetch` of a web-accessible resource is a network request, and declaring the resource web-accessible "also exposes the resources to any first-party or third-party scripts running on the same site". [CS]
  - Cookies are readable by the page and sent in requests.
  - `window.name` is readable by the page.
  - Each is a Trace or a network request under the privacy rules.

## 5. CreepJS detection vectors

**How the checks are wired.**
- `src/lies/index.ts` runs `queryLies` (probes 1-26) on every targeted prototype member. The targets:
  - `Date` (L518-544): `getDate, getDay, getFullYear, getHours, getMinutes, getMonth, getTime, getTimezoneOffset, setDate, setFullYear, setHours, setMilliseconds, setMonth, setSeconds, setTime, toDateString, toJSON, toLocaleDateString, toLocaleString, toLocaleTimeString, toString, toTimeString, valueOf`
  - `Intl.DateTimeFormat` (L557-564): `format, formatRange, formatToParts, resolvedOptions`
  - `Intl.RelativeTimeFormat` (L738-742): `resolvedOptions`
  - `HTMLIFrameElement` (L626-631): `contentDocument, contentWindow`
  - `Function` (L472-480): `toString`
  - `Permissions` (L726-730): `query`
- Getters are fetched as `Object.getOwnPropertyDescriptor(proto, name).get` (L413).
- CreepJS does not target `Date` itself, `Date.parse`, `Temporal`, or the `Geolocation*` prototypes. The Audit should run probes 1-26 on those anyway.

1. **Illegal invocation on getters**. `src/lies/index.ts` L159-161. Reading a getter off the prototype must throw TypeError. `['failed illegal error']: !!obj && failsTypeError({ spawnErr: () => obj.prototype[name], }),`
2. **call interface**. L170-175. `new` then `.call(proto)` must throw TypeError. `new apiFunction(); apiFunction.call(proto)`
3. **apply interface**. L176-181. Same check through `.apply`. `new apiFunction(); apiFunction.apply(proto)`
4. **`new` on a non-constructor**. L182-185. A replaced method must not be constructible. `['failed new instance error']: failsTypeError({ spawnErr: () => new apiFunction(), }),`
5. **class extends**. L186-191. Extending must throw TypeError (no `prototype`). `class Fake extends apiFunction { }`
6. **null prototype conversion**. L192-195. After `setPrototypeOf(fn, null)`, `.toString()` must throw TypeError. `spawnErr: () => Object.setPrototypeOf(apiFunction, null).toString(),`
7. **`Function.prototype.toString`, cross-realm**. L196-199 with L818. Native source is required for the function and for its `toString`, read through the phantom iframe realm's `Function.prototype.toString` (`scope`). `!hasKnownToString(name)[scope.Function.prototype.toString.call(apiFunction)] || !hasKnownToString('toString')[scope.Function.prototype.toString.call(apiFunction.toString)]`
8. **`prototype` presence**. L200. `['failed "prototype" in function']: 'prototype' in apiFunction,`
9. **Own descriptors**. L201-210. No own `arguments`, `caller`, `prototype` or `toString` descriptor. `Object.getOwnPropertyDescriptor(apiFunction, 'arguments') ||`
10. **hasOwnProperty**. L211-216. `apiFunction.hasOwnProperty('arguments') ||`
11. **Descriptor keys**. L217-219. Own keys must be exactly `length,name`. `Object.keys(Object.getOwnPropertyDescriptors(apiFunction)).sort().toString() != 'length,name'`
12. **getOwnPropertyNames**. L220-222. `Object.getOwnPropertyNames(apiFunction).sort().toString() != 'length,name'`
13. **Reflect.ownKeys**. L223-225. `Reflect.ownKeys(apiFunction).sort().toString() != 'length,name'`
14. **Object toString stack shape**. L227-236. The TypeError from `Object.create(fn).toString()` must have stack line 1 matching `at Function.toString`, and through a Proxy `at Object.toString` (Blink). `withStack: (err: any) => IS_BLINK && !hasValidStack(err, AT_FUNCTION),` with `return reg.test(err.stack.split('\n')[i])` (L120).
15. **arguments/caller access**. L237-242. Must throw TypeError, so a replacement written as a sloppy-mode `function` fails. `apiFunction.arguments; apiFunction.caller`
16. **toString arguments/caller**. L243-248. `apiFunction.toString.arguments; apiFunction.toString.caller`
17. **Cyclic prototype**. L249-254. It must throw TypeError, not recurse. `Object.setPrototypeOf(apiFunction, Object.create(apiFunction)).toString()`
18. **Escalated: `__proto__` recursion**. L271-277. Probes 18-24 run only when `name == 'toString'` or when `Function.toString`/`Permissions.query` already lied (L258-262). `apiFunction.__proto__ = proxy; apiFunction++`
19. **Escalated: chain cycle on Proxy**. L278-283. `Object.setPrototypeOf(proxy1, Object.create(proxy1)).toString()`
20. **Escalated: `__proto__` chain cycle on Proxy**. L284-290. `proxy2.__proto__ = proxy2; proxy2++`
21. **Escalated: `Reflect.setPrototypeOf`**. L291-298. `Reflect.setPrototypeOf(apiFunction, Object.create(apiFunction))` then `RAND in apiFunction`
22. **Escalated: `Reflect.setPrototypeOf` on Proxy**. L299-305. `Reflect.setPrototypeOf(proxy3, Object.create(proxy3))`
23. **Escalated: instanceof stack shape**. L306-320. Stack must match `/at (Function\.)?\[Symbol.hasInstance\]/` (L125). `apiFunction instanceof apiFunction`
24. **Escalated: defineProperty round-trip**. L321-324. `Object.defineProperty(apiFunction, '', { configurable: true }).toString()`
25. **Non-function value where a method was**. L400-409. `const lie = ['failed descriptor.value undefined']`
26. **Getter probe throws**. L427-432. Any exception while probing a member (for example a getter turned into a data property) is a lie. ``const lie = `failed prototype test execution` ``
27. **Phantom nested realm**. L47-72, L443-462. Lies run with `scope` set to an iframe inside an iframe, reached by indexed window access, not `contentWindow`, so a `contentWindow` getter hook never sees it. `const iframeWindow = self[numberOfIframes]` and `const phantomWindow = getBehemothIframe(iframeWindow)`
28. **`Function.prototype.toString` itself**. L472-480. Probes 1-26 run on `toString`, and a lie there escalates every other API. `searchLies(() => Function, { target: [ 'toString', ],`
29. **Time zone rejected on any lie**. `src/timezone/index.ts` L546-550. `lieProps['Date.getTimezoneOffset'] || lieProps['Intl.DateTimeFormat.resolvedOptions'] || lieProps['Intl.RelativeTimeFormat.resolvedOptions']`
30. **Local-time string parse vs `getTimezoneOffset`**. L469-479, L563-564. An offset is computed from `new Date('MM/DD/YYYY')` (local) minus `new Date('YYYY-MM-DD')` (UTC) and shown when it differs (L604). `offset: new Date().getTimezoneOffset(), offsetComputed: getTimezoneOffset(),`
31. **Historical offset (year 1113) vs `Intl` with an explicit zone**. L481-533, L552-555. It compares the local parse of `7/1/1113` with `Intl.DateTimeFormat('en', {timeZone})`. On mismatch it binary-searches the zone list, so the patch needs pre-standard LMT offsets, not today's. `system == resolvedOptions ? [timeZone] : binarySearch(cities, filter)`
32. **Zone name in `Date.prototype.toString`**. L556-559. `zone: (''+new Date()).replace(notWithinParentheses, ''),`
33. **`Intl.DateTimeFormat` called without `new`**. L553-554. The replaced constructor must support call form. `const { timeZone } = Intl.DateTimeFormat().resolvedOptions()`
34. **Long zone name at a fixed instant**. `src/intl/index.ts` L47-52. `new Intl.DateTimeFormat(undefined, { month: 'long', timeZoneName: 'long', }).format(963644400000)`
35. **Intl locale set and resolvedOptions lies**. L7-32, L37-45. Locale from seven constructors; a lie on any `resolvedOptions` marks Intl. `lieProps['Intl.DateTimeFormat.resolvedOptions'] ||`
36. **Worker-scope time zone**. `src/worker/index.ts` L106-118, L157-159, L324-326; `src/creep.ts` L253, L282. The zone and offset are read in a service worker first (then shared, then dedicated) and folded into the fingerprint next to the window `location`. There is no named mismatch lie for time zone (L369-371 limits those to navigator fields). `const timezoneLocation = Intl.DateTimeFormat().resolvedOptions().timeZone`, `const scriptSource = './creep.js'`, `WORKER_NAME = 'ServiceWorkerGlobalScope'`
37. **Worker `toString` lies**. L24-38, L386-394. Probes 1-26 run inside the worker on `Function.toString` and are reported as `WorkerGlobalScope.*`. ``const api = `WorkerGlobalScope.${key}` ``
38. **Worker location check**. L207-213. The worker's own `self.location` must be the real script path, which flags a wrapper or `blob:` worker. `!/^\/(docs|creepjs|public)|\/creep.js$/.test(pathname) ||`
39. **Worker locale trust**. L185-205. `const localeIntlEntropyIsTrusty = new Set((''+language).split(',')).has(''+locale)`
40. **Default voice language vs `Intl` locale**. `src/speech/index.ts` L69-76. `defaultVoiceLang.split('-')[0] !== localeLang.split('-')[0]` sets `LowerEntropy.TIME_ZONE = true`.
41. **Unattached iframe `contentWindow`**. `src/headless/index.ts` L112-120. It must be null, so a patched getter that returns a window or throws is flagged as `hasIframeProxy`. `iframe.srcdoc = instanceId` then `return !!iframe.contentWindow`
42. **iframe getter lie signature**. `src/resistance/index.ts` L276-277. The set of failed lie types on `contentWindow`/`contentDocument` is hashed and matched against known extensions (L340-433). `contentWindowHash: hashMini(prototypeLies['HTMLIFrameElement.contentWindow']),`
43. **Global litter**. `src/status/index.ts` L43-56. Window own property names are diffed against a fresh iframe's. `const clientKeys = windowKeys.filter((x) => !iframeKeys.includes(x))`
44. **Non-native recent globals**. L58-77. The last 50 window keys must stringify as native. `return key === 'chrome' ? names.includes(key) : !isEngine(d.get || d.value)`
45. **Geolocation permission state and `Permissions.query` lies**. `src/navigator/index.ts` L336-352; `src/lies/index.ts` L726-730. `getPermissionState('geolocation'),`

Not present anywhere under CreepJS `src/` (all 39 files grepped): `chrome-extension://` stack inspection (the only hit is an icon class, `src/resistance/index.ts` L527), `Temporal`, reads of geolocation coordinates, and time zone vs `navigator.language` or vs geolocation. Sojourn-owned probes for those vectors:

46. **Extension URL in `Error.stack`**. Registered files compile with their resource URL as script URL (`extensions/renderer/user_script_injector.cc` L274, L284-286: `const GURL& script_url = file->url();` then `sources.emplace_back(..., script_url, ...)`). Inline `userScripts` code gets a random resource URL (`content_script_utils.cc` L355-358: `GURL url = extension->GetResourceURL(base::Uuid::GenerateRandomV4().AsLowercaseString());`). Any frame inside the patch names `chrome-extension://<id>/...`.
47. **`Temporal.Now` zone and `Date.prototype.toTemporalInstant`**. See section 6. `Temporal.Now.timeZoneId()` and the `*ISO()` methods must report the Override.
48. **`GeolocationCoordinates` getters and `GeolocationPosition.prototype.toJSON`** must pass probes 1-26 and 41-44 (README skeleton patches them; CreepJS has no target).
49. **Cross-signal consistency**. The Override zone vs `navigator.language`, and vs the coordinates' expected zone for the City. There is no CreepJS source; the Audit compares against Baseline.
50. **Frame coverage**. Same-origin iframe commit-before-`<html>` window (section 1 `OPEN`), plus `srcdoc`, `data:`, `blob:`, sandboxed and `javascript:` frames. Each must show the Override on first synchronous access.

## 6. `Temporal` in stable Chrome

- chromestatus "Temporal in ECMA262", feature id `5668291307634688` ([CHS] API JSON). The ship stage is `"stage_type": 160` with `"desktop_first": 144`, `"android_first": 144`. The summary field still says `"status": {"text": "In development"}`, which is stale relative to the ship stage.
- The Chrome 144 release notes list "Temporal in ECMA262" under JavaScript. [RN144]
- V8 at Chrome 154's commit (`e71d6958`), `src/flags/feature-flags.h` L198-203 (stable): `#define FOREACH_SHIPPED_FEATURE_FLAG(...)` ... `JS_FEATURE(harmony_temporal, "Temporal")`, under the header "Shipped features (enabled by default)." (`main` L191).
- Build support: `gni/v8.gni` L70 `v8_enable_temporal_support = !(defined(build_with_node) && build_with_node)`. Its comment ("still not accessible unless --harmony-temporal is enabled") is outdated against the shipped list.
- Install: `src/init/bootstrapper.cc` L6019-6031 (`if (!v8_flags.harmony_temporal) return;`, then a lazy `Temporal` accessor, `DONT_ENUM`, `set_replace_on_access(true)`), plus lazy `Date.prototype.toTemporalInstant` (L2088-2095).
- Conclusion: `Temporal` is on by default in stable 154. A must patch `Temporal.Now`.
- `OPEN:` whether touching the lazy `globalThis.Temporal` accessor at document_start makes its property descriptor differ from Baseline. Settle with an Audit probe comparing `Object.getOwnPropertyDescriptor(globalThis, 'Temporal')` before any page access.

## 7. Worker coverage

- Content scripts never run in workers. `extensions/renderer/script_context_set.cc` L266-269 (stable): "We don't support injection of content scripts or user scripts into worker contexts." Injection is per frame: `script_injection_manager.cc` L71 (stable) `class ScriptInjectionManager::RFOHelper : public content::RenderFrameObserver`. This applies to `userScripts` too.
- A can only reach workers by wrapping `Worker`/`SharedWorker` in page JavaScript. What that leaves:
  - **Dedicated, classic, same-origin URL.** The patch must be prepended without fetching the source (fetching is a network request). The remaining route is a wrapper script that loads the original, which changes the worker's `self.location`, and probe 38 checks exactly that. A residual Trace either way.
  - **Module workers.** `importScripts` is unavailable in module scope. Wrapping changes `self.location` and `import.meta.url` (probe 38). Residual Trace.
  - **Shared workers.** A wrapper changes the script URL, which is part of the shared worker's identity, so a patched page gets a different instance than unpatched contexts. Residual Trace (inference from the same URL change; confirm with an Audit probe).
  - **Service workers.** They are registered by URL through `navigator.serviceWorker.register`, and nothing in the page can prefix their source. CreepJS tries the service worker first (probe 36), so A shows the real zone there. `OPEN:` whether `register()` rejects `blob:` script URLs; settle with the W3C Service Workers "Register" and "Update" algorithms (script URL scheme check).
  - **Cross-origin workers** (via `data:`, or created inside cross-origin frames the extension does not match) and **`blob:` workers** whose blob text the wrapper cannot read synchronously. Residual Trace.
- Residual Trace for A: `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Date` offsets and `Temporal.Now` inside every service worker, shared worker, module worker, and any unwrapped worker. Also worker-realm `toString`/location probes (37, 38) wherever a wrapper does run.

## Sources

- [CS] https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- [MCS] https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- [SCR] https://developer.chrome.com/docs/extensions/reference/api/scripting
- [US] https://developer.chrome.com/docs/extensions/reference/api/userScripts
- [ST] https://developer.chrome.com/docs/extensions/reference/api/storage
- [WN] https://developer.chrome.com/docs/extensions/whats-new
- [RN144] https://developer.chrome.com/release-notes/144
- [CHS] https://chromestatus.com/feature/5668291307634688 (API: https://chromestatus.com/api/v0/features/5668291307634688)
- Stable version: https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1
- Chromium (`https://raw.githubusercontent.com/chromium/chromium/main/<path>`; stable checks at `62d2fcb41a84e4dcefd8c4da7dfa534e6c482854`):
  - `extensions/renderer/script_injection_manager.cc`
  - `extensions/renderer/script_injection.cc`
  - `extensions/renderer/user_script_set.cc`
  - `extensions/renderer/user_script_set_manager.cc`
  - `extensions/renderer/user_script_injector.cc`
  - `extensions/renderer/dispatcher.cc`
  - `extensions/renderer/extension_frame_helper.cc`
  - `extensions/renderer/script_context.cc`
  - `extensions/renderer/script_context_set.cc`
  - `extensions/common/content_script_injection_url_getter.cc`
  - `extensions/common/manifest_handlers/content_scripts_handler.cc`
  - `extensions/common/utils/content_script_utils.cc`
  - `extensions/common/user_script.h`
  - `extensions/common/user_script.cc`
  - `extensions/common/api/scripting.webidl`
  - `extensions/common/api/user_scripts.webidl`
  - `extensions/common/api/extension_types.json`
  - `extensions/common/api/scripts_internal/script_serialization.cc`
  - `extensions/browser/api/scripting/scripting_api.cc`
  - `extensions/browser/api/user_scripts/user_scripts_api.cc`
  - `chrome/browser/extensions/user_script_listener.cc`
  - `chrome/renderer/chrome_content_renderer_client.cc`
  - `content/renderer/render_frame_impl.cc`
  - `third_party/blink/renderer/core/html/html_html_element.cc`
  - `third_party/blink/renderer/core/loader/frame_loader.cc`
- V8 (`https://raw.githubusercontent.com/v8/v8/<main|e71d69585ada35d065257dc623a457062e76e166>/<path>`): `src/flags/feature-flags.h`, `src/flags/flag-definitions.h`, `src/init/bootstrapper.cc`, `gni/v8.gni`
- CreepJS (`https://raw.githubusercontent.com/abrahamjuliot/creepjs/master/<path>`, tree via `https://api.github.com/repos/abrahamjuliot/creepjs/git/trees/master?recursive=1`): `src/lies/index.ts`, `src/timezone/index.ts`, `src/intl/index.ts`, `src/worker/index.ts`, `src/creep.ts`, `src/speech/index.ts`, `src/headless/index.ts`, `src/resistance/index.ts`, `src/status/index.ts`, `src/navigator/index.ts`, `src/utils/helpers.ts`
- Secondary pointer only: https://issues.chromium.org/issues/40480216

## Consequences for Sojourn

1. A cannot cover service, shared, module, cross-origin or unreadable `blob:` workers. CreepJS reads the service worker first (probe 36), so a real time zone stays visible on the most-used probe path.
2. Configuration: MAIN world has no extension APIs and `chrome.storage` is async, so the Selection has to be in the script text. That leaves one packaged file per Catalog City (Jitter fixed at build time, which conflicts with a Jitter generated per selection) or `userScripts.register` inline `code` (needs the "Allow User Scripts" toggle, Chrome 138+).
3. The `userScripts` path has no `matchOriginAsFallback`, so `about:blank`, `srcdoc`, `data:` and `blob:` frames are likely uncovered (`OPEN`). The `scripting` path needs `matchOriginAsFallback: true` with `/*` paths.
4. Open tabs and tabs loaded before a Selection change keep their old values until reload. The badge must count them as not Covered, and reloading is the only fix.
5. Drop the README's `contentWindow`/`contentDocument` getter patch unless the commit-to-`<html>` race is proven. Chromium already injects synchronously into a new frame's initial document, and the getter itself is probed (27, 41, 42).
6. Every replaced function (`Date`, `Intl`, `Temporal.Now`, `Geolocation*`) must pass probes 1-28 in every realm, with `toString` agreeing across realms, and must hold LMT-era offsets (31).
7. Phase 06 probe count: 50 (45 from CreepJS, 5 Sojourn-owned).
