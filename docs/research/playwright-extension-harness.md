# R4: Driving Chromium with the extension loaded (Playwright harness)

Scope: how the Playwright harness launches Chromium with Spoofer loaded, how Playwright's own CDP connection coexists with the extension's `chrome.debugger` sessions, which Playwright options touch the Override, how to force and verify an out-of-process iframe, and whether the debugger infobar can create a Trace. Versions: Playwright 1.63.0 (npm `latest`, published 2026-09-04), which bundles Chromium 153.0.8010.12 ("Chrome for Testing", browsers revision 1243). Chrome Stable per chromiumdash on 2026-09-14 is 154.0.8037.17 (Mac) and 153.0.8010.36 (Linux). Playwright quotes come from tag `v1.63.0`. Chromium quotes come from `main` as fetched on 2026-09-14. For the Playwright files cited, only `crPage.ts` line numbers differ between `main` and the tag.

## 1. Loading the MV3 extension

**Persistent context, bundled Chromium only.** playwright.dev/docs/chrome-extensions (source `docs/src/chrome-extensions-js-python.md` L9-L11):
> "Extensions only work in Chromium when launched with a persistent context. Use custom browser args at your own risk, as some of them may break Playwright functionality."
> "Google Chrome and Microsoft Edge removed the command-line flags needed to side-load extensions, so use Chromium that comes bundled with Playwright."

The documented recipe (same file L24-L33):
```js
const browserContext = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${pathToExtension}`,
    `--load-extension=${pathToExtension}`
  ]
});
let [serviceWorker] = browserContext.serviceWorkers();
if (!serviceWorker)
  serviceWorker = await browserContext.waitForEvent('serviceworker');
```

**Headless requires `channel: 'chromium'`.**
- Docs L16: "Note the use of the `chromium` channel that allows to run extensions in headless mode. Alternatively, you can launch the browser in headed mode."
- `docs/src/api/params.md` `browser-option-channel`: "Use "chromium" to [opt in to new headless mode]".
- `docs/src/browsers.md` L369-L371 quotes Chrome's own docs: "New Headless on the other hand is the real Chrome browser, ... more suitable for ... browser extension testing."
- The executable is selected in `chromium.ts` `getExecutableName` (L418-L423): `if (options.channel && registry.isChromiumAlias(options.channel)) return 'chromium';` ... `return options.headless ? 'chromium-headless-shell' : 'chromium';`. Headless without a channel therefore runs the headless shell.
- Headless mode itself is just `chromeArguments.push('--headless');` (L380-L381).
- developer.chrome.com/docs/chromium/headless: "Since Chrome 132.0.6793.0 the old Headless mode is only available as a standalone binary named `chrome-headless-shell`".
- developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing says old headless "does not support loading extensions".

**Branded Chrome dropped `--load-extension` in Chrome 137.**
- developer.chrome.com/blog/extension-news-june-2025: "we are removing the flag in Chrome 137 and providing alternatives for any use cases including testing that still need this capability."
- Source, `chrome/browser/extensions/extension_service.cc` L422-L425:
  ```cpp
  #if BUILDFLAG(GOOGLE_CHROME_BRANDING) && !BUILDFLAG(IS_CHROMEOS)
      LOG(WARNING)
          << "--load-extension is not allowed in Google Chrome, ignoring.";
      return;
  ```
- `--disable-extensions-except` is also gated off in branded builds. `extensions/common/extension_features.cc` L214-L216: `BASE_FEATURE(kDisableDisableExtensionsExceptCommandLineSwitch, #if BUILDFLAG(GOOGLE_CHROME_BRANDING) && !BUILDFLAG(IS_CHROMEOS) base::FEATURE_ENABLED_BY_DEFAULT`, consumed at `extension_service.cc` L441-L447.
- OPEN: the Chrome version in which `--disable-extensions-except` went away in branded builds. The only pointer is the chromium-extensions PSA that Playwright's docs link, which is secondary. The harness never uses branded Chrome, so this does not block anything. Cheapest experiment: launch branded Stable with the flag and check `chrome://extensions`.

**Playwright's bundled Chromium is not Google Chrome branded, so the flags still work.**
- `packages/playwright-core/browsers.json` at v1.63.0 names the build `"title": "Chrome for Testing"`.
- `build/config/chrome_build.gni` L80-L81: `assert(!is_chrome_for_testing || !is_chrome_branded, "`is_chrome_for_testing` is incompatible with `is_chrome_branded`")`.
- `build/BUILD.gn` L29-L33: when `is_chrome_branded` is false, `"GOOGLE_CHROME_BRANDING=false"`. The guard above is therefore compiled out.
- Non-branded builds still refuse `--load-extension` in two cases (`extension_service.cc` L427-L438): Enhanced Safe Browsing ("not allowed for users opted into Enhanced Safe Browsing") and the `ExtensionInstallTypeBlocklist::command_line` policy. A fresh temp profile has neither.

**Finding: in Playwright, `--disable-extensions-except` is the flag that actually loads the extension.**
- Playwright always passes `--disable-extensions` (`chromiumSwitches.ts` L66).
- Chromium treats either flag as "extensions disabled". `chrome/browser/extensions/extension_util.cc` L65-L67: `return command_line.HasSwitch(switches::kDisableExtensions) || command_line.HasSwitch(switches::kDisableExtensionsExcept);`.
- That result feeds `ExtensionRegistrar::Init` (`extensions/browser/extension_registrar.cc` L112-L117, `extensions_enabled = false`).
- `ExtensionService::Init` then reads `bool load_command_line_extensions = extension_registrar_->extensions_enabled();` (L353-L354) and runs `LoadExtensionsFromCommandLineFlag(switches::kDisableExtensionsExcept);` unconditionally (L376). The `--load-extension` load happens only `if (load_command_line_extensions)` (L377-L378).
- The except-list is exempted: `extension_registrar_->AddDisableFlagExemptedExtension(extension_id);` (L461).
- Net effect: `--load-extension` is inert here but harmless. `ignoreDefaultArgs` is not needed to remove `--disable-extensions`.

**Service worker and extension id.**
- Persistent contexts auto-attach at browser level: `crBrowser.ts` L89 `session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })`.
- Service-worker targets are wrapped and emitted as events (L199-L202): `if (targetInfo.type === 'service_worker') { const serviceWorker = new CRServiceWorker(context, session, targetInfo.url); ... context.emit(CRBrowserContext.CREvents.ServiceWorker, serviceWorker);`.
- Extension id, from the docs fixture (L173-L177): `const extensionId = serviceWorker.url().split('/')[2];`.
- Idle suspension (docs L106-L108): "Chrome MV3 service workers are automatically suspended after ~30 seconds of inactivity ... Playwright keeps the **same [Worker] object alive**, no new `'serviceworker'` event is emitted."
- Relevant to Spoofer: while an extension debugger session is attached, the worker is kept alive. `debugger_api.cc` L603-L612: `process_manager->IncrementServiceWorkerKeepaliveCount(*extension_service_worker_id_, content::ServiceWorkerExternalRequestTimeoutType::kDoesNotTimeout, Activity::DEBUGGER, ...)`.

**Popup.** Docs L229: `await page.goto(\`chrome-extension://${extensionId}/popup.html\`);`. This renders `popup.html` in a normal tab, not in the toolbar popup window.

## 2. Multi-client CDP: Playwright's pipe session next to `chrome.debugger`

**Design intent (Chrome 63).** developer.chrome.com/blog/new-in-devtools-63:
> "As of Chrome 63, DevTools now supports multiple remote debugging clients by default, no configuration needed."
> "Chrome Extensions using the `chrome.debugger` API can now run at the same time as DevTools."
> "Two separate WebSocket protocol clients ... can now connect to the same tab simultaneously."

The post lists no limits.

**Mechanism.** One agent host holds any number of sessions, and only a duplicate client is refused.
- `content/browser/devtools/devtools_agent_host_impl.cc` L337-L341: `bool DevToolsAgentHostImpl::AttachClient(DevToolsAgentHostClient* client) { if (SessionByClient(client)) return false; return AttachInternal(...`.
- `AttachInternal` then does `sessions_.push_back(session);` (L327).
- Each session gets its own handlers. `render_frame_devtools_agent_host.cc` L416-L417: `session->CreateAndAddHandler<protocol::EmulationHandler>();`.
- On the extension side, "already attached" applies only to the same extension on the same target. `debugger_api.cc` L1073-L1074 returns `kAlreadyAttachedError` when `FindClientHost()` matches, and `FindClientHost` compares `client_host->agent_host() == agent_host && client_host->extension_id() == extension_id` (L1035-L1036). No documented cap on the number of clients was found.

**Extension sessions are restricted.**
- `ExtensionIsTrusted` returns false for every extension except Perfetto (`debugger_api.cc` L270-L273).
- Untrusted clients get `protocol::TargetHandler::AccessMode::kAutoAttachOnly` (`render_frame_devtools_agent_host.cc` L456-L459).
- In that mode `Target.getTargets` fails: `if (access_mode_ == AccessMode::kAutoAttachOnly) { return Response::ServerError(kNotAllowedError);` (`target_handler.cc` L1450-L1451). `Target.setAutoAttach` remains available.

**Conflict 1: the time zone Override is per renderer process, and the first holder wins.**
- The controller is a process-wide singleton. `third_party/blink/renderer/core/timezone/timezone_controller.cc` L123-L124: `DEFINE_THREAD_SAFE_STATIC_LOCAL(TimeZoneController, instance, ());`.
- `SetTimeZoneOverride` (L154-L162):
  ```cpp
  if (timezone_id == instance().TimeZoneIdOverride()) {
    // Do nothing.
    return {TimeZoneOverrideStatus::kSuccess, nullptr};
  }
  if (HasTimeZoneOverride()) {
    ...
    return {TimeZoneOverrideStatus::kAlreadyInEffect, nullptr};
  ```
- `inspector_emulation_agent.cc` L1078-L1080 maps that status to `"Timezone override is already in effect"`.
- Playwright silently swallows the error. `crPage.ts` L1213-L1214: `if (exception.message.includes('Timezone override is already in effect')) return;`.
- Consequence: if `timezoneId` were set and the extension set a City's zone, whichever client came second loses. Playwright would give no signal.
- Hazard for Spoofer itself: a second session setting the *same* zone gets a `nullptr` handle (`if (result.handle) { timezone_override_ = ...` L1074-L1075). The override is released by the first handle: `~TimeZoneOverride() { ClearTimeZoneOverride(); }` (`timezone_controller.h` L64), reached from `disable()` via `timezone_override_.reset();` (`inspector_emulation_agent.cc` L356). So when the first session goes away, a second Covered tab in the same renderer process reverts to the real zone.
- OPEN: whether same-site Covered tabs actually share a renderer process in practice. Cheapest experiment: open two same-site tabs, attach the extension to both with the same zone, detach from the first, then read `Intl.DateTimeFormat().resolvedOptions().timeZone` in the second.

**Conflict 2: the geolocation Override is per WebContents, and the last writer wins.**
- `content/browser/devtools/protocol/emulation_handler.cc` L629: `geolocation_context->SetOverride(std::move(override_result));`. Omitting coordinates installs an error instead (L623-L627: `GeopositionResult::NewError(... kPositionUnavailable ...)`).
- A session's `Disable()` clears the WebContents-wide override if *that* session ever set one (L221-L223 `if (geolocation_overridden_) { ClearGeolocationOverride(); }`; L638-L639 `geolocation_context->ClearOverride();`).
- `DevToolsSession::Dispose` calls `Disable()` on every handler (`devtools_session.cc` L177-L180).
- So a Playwright session that ever sent `Emulation.setGeolocationOverride` wipes the extension's Override when it disposes.

**Conflict 3: `Target.setAutoAttach` with `waitForDebuggerOnStart`.**
- Playwright auto-attaches with `waitForDebuggerOnStart: true` at three levels:
  - browser (`crBrowser.ts` L89)
  - every page and OOPIF session (`crPage.ts` L540)
  - every worker (`crPage.ts` L789)
- Playwright resumes only its own sessions: `this._client.send('Runtime.runIfWaitingForDebugger')` (`crPage.ts` L575) and `crServiceWorker.ts` L70.
- In Chromium each `TargetHandler` defers the child's navigation with its own throttle. `target_handler.cc` L428-L438: `if (new_host && target_handler_->AutoAttach(..., wait_for_debugger_on_start) && wait_for_debugger_on_start) { SetThrottledAgentHost(new_host.get()); } ... return is_deferring_ ? DEFER : PROCEED;`.
- That throttle is released only by the same child session's resume callback (L485-L487 `resume_callback = base::BindOnce(&Session::ResumeIfThrottled, ...)`; L559-L563 `throttle_->Clear();`).
- Reading: neither client can resume the other's pause. If Spoofer auto-attaches with `waitForDebuggerOnStart: true`, it must send `Runtime.runIfWaitingForDebugger` on each child session it gets.
- OPEN: confirm that one un-resumed client stalls the OOPIF load even after Playwright resumes. Cheapest experiment: an extension build that auto-attaches without resuming, plus the two-origin page from section 4. Expect the iframe `load` event never to fire.

**Playwright and the extension service worker.**
- Playwright holds a CDP session on the extension's worker (it is a `service_worker` target in the default context, `crBrowser.ts` L170-L175 and L199-L202).
- On that session it sends `Runtime.enable`, `Runtime.runIfWaitingForDebugger` (`crServiceWorker.ts` L69-L70) and `Emulation.setUserAgentOverride` with `userAgent: options.userAgent || ''` (L103-L104).
- Targets it does not use are detached: `session.detach()` (`crBrowser.ts` L206-L211; `crPage.ts` L776-L777 for non-iframe, non-worker children).
- `chrome.debugger.attach` checks only the *target* (`ExtensionMayAttachToAgentHost`, `debugger_api.cc` L385-L401), not whether the calling worker is itself being debugged.
- OPEN: that nothing else interferes. Cheapest experiment: from `serviceWorker.evaluate`, call `chrome.debugger.attach({tabId}, '1.3')` followed by `Emulation.setTimezoneOverride`, and read the zone in the page.

## 3. Playwright context options versus the extension's Emulation state

| Option | CDP sent | When | Source |
|---|---|---|---|
| `timezoneId` | `Emulation.setTimezoneOverride` | only `if (options.timezoneId)` at page/frame session init | `crPage.ts` L564-L565, L1211 |
| `geolocation` | `Emulation.setGeolocationOverride` | at init only if set: `if (!initial \|\| geolocation) await this._client.send('Emulation.setGeolocationOverride', geolocation \|\| {});` | `crPage.ts` L956-L959 |
| `setGeolocation(x)` | `Emulation.setGeolocationOverride` on every page, `{}` for null | every call (`initial` false) | `crBrowser.ts` L484-L488, `crPage.ts` L191-L192 |
| `permissions` / `grantPermissions` | `Browser.grantPermissions` `{ origin: origin === '*' ? undefined : origin, browserContextId, permissions }` | at context init `if (this._options.permissions)`, or on call | `browserContext.ts` L176-L177, `crBrowser.ts` L467, mapping `['geolocation', 'geolocation']` L439 |
| `clearPermissions` | `Browser.resetPermissions` | on call | `crBrowser.ts` L481 |

- Neither option sends a clearing call when it is unset. `Emulation.setTimezoneOverride` appears only in `emulateTimezone`, and the init-time geolocation call is skipped when `geolocation` is undefined.
- Who wins:
  - Time zone: the first holder in the renderer process wins (section 2).
  - Geolocation: the last `SetOverride` wins, and a disposed Playwright session clears the extension's Override (section 2).
  - `setGeolocation(null)` actively installs "position unavailable" over the Override. playwright.dev class-browsercontext: "Passing `null` or `undefined` emulates position unavailable."
  - `Browser.grantPermissions` changes permission state only. `SetGeolocationOverride` touches only the geolocation context (`emulation_handler.cc` L598-L630), so the two do not interact.

**`TZ` for the Baseline.**
- Playwright forwards `env` to the browser process. `browserType.ts` L206: `const env = options.env ? envArrayToObject(options.env) : process.env;`, used at L217. params.md: "Specify environment variables that will be visible to the browser. Defaults to `process.env`."
- ICU reads `TZ` first on every non-Windows, non-Android platform, macOS included. `third_party/icu/source/common/putil.cpp` `uprv_tzname` L1142-L1156: `tzid = getenv("TZ");` then `if (tzid != nullptr && isValidOlsonID(tzid) ...) { ... return tzid; }`. `isValidOlsonID` accepts IANA ids (non-digits, then at most two trailing digits, L732-L741).
- V8 `Date` uses the ICU zone in Chromium builds. `v8/src/date/date.cc` L33-L34: `#ifdef V8_INTL_SUPPORT Intl::CreateTimeZoneCache()`.
- Blink seeds its host zone from ICU (`timezone_controller.cc` L100 `host_timezone_id_ = GetCurrentTimezoneId();`).
- Linux: `base/i18n/icu_util.cc` L334-L339 populates the ICU default at startup (`icu::TimeZone::createDefault()`). `services/device/time_zone_monitor/time_zone_monitor_linux.cc` L180-L195 skips file watching when TZ is set ("If the TZ environment variable is set, its value specifies the time zone ... in the ... renderer processes." / `if (!getenv("TZ"))`).
- macOS: `time_zone_monitor_mac.mm` L24 re-detects on a system time zone change notification (`UpdateIcuAndNotifyClients(DetectHostTimeZoneFromIcu())`). Detection goes through ICU, so `TZ` still takes precedence.
- OPEN: end-to-end on both OSes, since renderer environment inheritance and the macOS sandbox were not traced. Cheapest experiment: launch with `env: { ...process.env, TZ: 'Pacific/Kiritimati' }`, then assert `Intl.DateTimeFormat().resolvedOptions().timeZone === 'Pacific/Kiritimati'` and `new Date(0).getTimezoneOffset() === -840` in a page, on macOS and on Linux.

**`grantPermissions` and the prompt.**
- A grant skips the prompt entirely, so the prompt path is not exercised.
- Without a grant, Chromium denies in headless without any UI. `components/permissions/permission_request_manager.cc` L223-L232:
  ```cpp
  if (base::CommandLine::ForCurrentProcess()->HasSwitch(switches::kDenyPermissionPrompts)) {
    request->PermissionDenied();
    return;
  }
  if (display::Screen::Get()->IsHeadless()) {
    request->PermissionDenied();
    return;
  }
  ```
- A deny test therefore runs headless with no grant. A test of the real prompt UI needs headed mode, and Playwright's page API cannot click that UI.
- CDP `Browser.setPermission` accepts `granted`, `denied` and `prompt` (`browser_handler.cc` L349-L353). It falls back to the default context when no id is given (L372-L373), and `BrowserHandler` exists on frame sessions (`render_frame_devtools_agent_host.cc` L408-L410). This could set `denied`/`prompt` state per origin through `context.newCDPSession(page)`.
- OPEN: (a) that `Screen::IsHeadless()` is true in `channel: 'chromium'` headless. Cheapest experiment: no grant, call `getCurrentPosition` in headless, expect `error.code === 1` with no hang. (b) That `Browser.setPermission` is accepted from a page CDPSession. Cheapest experiment: send it with `setting: 'denied'`, then read `navigator.permissions.query({name:'geolocation'})`.

## 4. Two local origins and a cross-process iframe

**Site computation.**
- `content/browser/site_info.cc` L1280-L1285:
  ```cpp
  // Only keep the scheme and registered domain of |origin|.
  std::string domain = net::registry_controlled_domains::GetDomainAndRegistry(
      origin, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
  return SchemeAndHostToSite(origin.scheme(),
                             domain.empty() ? origin.host() : domain);
  ```
- IP addresses have no registrable domain. `net/base/registry_controlled_domains/registry_controlled_domain.cc` L344-L346: `if (host.empty() || url::HostIsIPAddress(host)) { return std::string_view(); }` (origin variant L518: `host_info.IsIPAddress()`). The site for `127.0.0.1` is therefore `http://127.0.0.1`.
- `localhost` has no registry (L312-L313 `if (registry_length == 0) { return std::string_view(); // No registry.`), so its site host is `localhost`.
- Ports are not part of the site (`SchemeAndHostToSite` takes scheme and host only).
- Result: `http://localhost:P` and `http://127.0.0.1:P` are different sites.
- Both are potentially trustworthy, so both can call geolocation. `net/base/url_util.cc` L472-L476: `if (ip_address.AssignFromIPLiteral(host)) return ip_address.IsLoopback(); return IsLocalHostname(host);`.

**Site-per-process is on by default on desktop.**
- `content/public/browser/site_isolation_policy.cc` L85-L99: `UseDedicatedProcessesForAllSites()` returns true for `--site-per-process`, false if disabled, and otherwise `GetContentClient()->browser()->ShouldEnableStrictSiteIsolation()`.
- `chrome/browser/chrome_content_browser_client.cc` L2691-L2693: `if (base::FeatureList::IsEnabled(features::kSitePerProcess)) { return true; }`.
- `chrome/common/chrome_features.cc` L1721-L1725: `BASE_FEATURE(kSitePerProcess, #if BUILDFLAG(IS_ANDROID) base::FEATURE_DISABLED_BY_DEFAULT #else base::FEATURE_ENABLED_BY_DEFAULT`.
- The disabling switch is `kDisableSiteIsolation[] = "disable-site-isolation-trials"` (`content_switches.cc` L694). The embedder can also disable isolation "when below a memory threshold" (`site_isolation_policy.cc` L75-L79). The verification step below makes this self-checking.

**Playwright's default switches** (`chromiumSwitches.ts` L20-L97, identical at v1.63.0):
- Site isolation: `--disable-features=` lists `AvoidUnnecessaryBeforeUnloadCheckSync, DestroyProfileOnBrowserClose, DialMediaRouteProvider, GlobalMediaControls, HttpsUpgrades, LensOverlay, MediaRouter, PaintHolding, ThirdPartyStoragePartitioning, BlockOriginHeaderModificationOnRedirect, Translate, AutoDeElevate, OptimizationHints` plus two Edge-only entries. None is `IsolateOrigins` or `SitePerProcess`, and there is no `--disable-site-isolation-trials` or `--site-per-process`.
- Extensions and debugger: `--disable-extensions`, `--disable-component-extensions-with-background-pages`, `--disable-default-apps`, and `--disable-infobars` (commented "This disables Chrome for Testing infobar ... The switch is ignored everywhere else").
- Added by `chromium.ts` L357-L362 and L380-L390: `--remote-debugging-pipe`, `about:blank` (persistent), `--headless`, `--hide-scrollbars`, `--mute-audio`, `--blink-settings=primaryHoverType=2,...`, and `--no-sandbox` unless `chromiumSandbox`.
- There is no `--silent-debugger-extension-api` and no `--enable-automation`.
- Some of these are page-observable (`ThirdPartyStoragePartitioning`, scrollbars, pointer media, `srgb`). They apply equally to the Baseline, so they cancel out in the Audit, but they do make both runs differ from a real user's browser.

**`ignoreDefaultArgs`.**
- params.md: "If an array is given, then filters out the given default arguments. Dangerous option; use with care."
- Matching is exact-string. `browserType.ts` L180: `.filter(arg => ignoreDefaultArgs.indexOf(arg) === -1)`. Removing `--disable-extensions` works that way, but section 1 shows it is unnecessary.

**Verifying the iframe is out-of-process.**
- `page.frames()` merges OOPIFs into one tree. Playwright creates a `FrameSession` for `iframe` targets (`crPage.ts` L747-L766, `if (event.targetInfo.type === 'iframe')`), so the frame list cannot distinguish in-process from out-of-process.
- The target type string is `"iframe"` (`third_party/blink/public/devtools_protocol/domains/Target.pdl` L24: `For example, "iframe" target may have a "page" parent.`).
- Check: `const s = await context.newCDPSession(page); const { targetInfos } = await s.send('Target.getTargets');` then assert one entry with `type === 'iframe'` and a `http://127.0.0.1:` URL. `getTargets` is refused only in `kAutoAttachOnly` mode (`target_handler.cc` L1450).
- OPEN: that a Playwright `CDPSession` is trusted, so the call succeeds. Cheapest experiment: run the snippet once. `chrome://process-internals` is the manual fallback.
- OPEN: whether the cross-origin iframe needs `allow="geolocation"` for `getCurrentPosition`. Blink's permissions-policy feature list moved and was not read. Cheapest experiment: call it in the 127.0.0.1 iframe with and without `allow`.

## 5. The "started debugging this browser" infobar

**When it shows.**
- On every attach, unless a switch or policy install suppresses it. `chrome/browser/extensions/api/debugger/debugger_api.cc` L588-L601:
  ```cpp
  // We allow policy-installed extensions to circumvent the normal
  // infobar warning. See crbug.com/41302695.
  const bool suppress_warning =
      base::CommandLine::ForCurrentProcess()->HasSwitch(
          ::switches::kSilentDebuggerExtensionAPI) ||
      Manifest::IsPolicyLocation(extension_->location());
  if (!suppress_warning) {
  ...
    CreateWarningInfobar();
  ```
- It is global. The legacy path uses `GlobalConfirmInfoBar::Show` (`extension_dev_tools_infobar_delegate.cc` L62); the migrated path uses `browser_infobar_manager->ShowGlobally(` (`debugger_api.cc` L893-L896).
- It has an auto-close timer, `kAutoCloseDelay = base::Seconds(5)` (`extension_dev_tools_infobar_delegate.h` L30; started in `MaybeStartAutocloseTimer`, L141-L145).
- Playwright's `--disable-infobars` does not suppress it, because the check above reads only `kSilentDebuggerExtensionAPI` and the policy location. Playwright never passes `--silent-debugger-extension-api` (switch list above).

**Viewport interference.**
- OPEN: whether the infobar is created in `channel: 'chromium'` headless, and whether it shrinks the page's viewport in headed and headless mode. Cheapest experiment: launch with `viewport: null`, record `innerHeight` and any `resize` events before attach, right after attach, and 6 s later; repeat headed and headless.
- Playwright's default viewport emulation (`Emulation.setDeviceMetricsOverride`, `crPage.ts` L555, L1012) likely masks any size change. That masking is itself a harness divergence.

**Harness flag policy.**
- A real user's browser shows the infobar, so any resize it causes is a real Trace candidate. `--silent-debugger-extension-api` would hide it only in the covered run, so the Audit would stop seeing a difference real users produce.
- The harness should not pass it. At least one Audit configuration should run with `viewport: null`.

## Sources

- playwright.dev/docs/chrome-extensions (`docs/src/chrome-extensions-js-python.md`), playwright.dev/docs/browsers (`docs/src/browsers.md`), playwright.dev/docs/api/class-browsertype and class-browsercontext (`docs/src/api/params.md`, `class-browsercontext.md`), playwright.dev/docs/emulation
- https://registry.npmjs.org/playwright (1.63.0, 2026-09-04); https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/packages/playwright-core/browsers.json
- https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/packages/playwright-core/src/server/chromium/{chromiumSwitches.ts, chromium.ts, crBrowser.ts, crPage.ts, crServiceWorker.ts}; .../src/server/{browserType.ts, browserContext.ts}
- https://chromiumdash.appspot.com/fetch_releases?channel=Stable (Mac, Linux)
- https://developer.chrome.com/blog/new-in-devtools-63; https://developer.chrome.com/blog/extension-news-june-2025; https://developer.chrome.com/docs/chromium/headless; https://developer.chrome.com/blog/chrome-for-testing; https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing
- Chromium `main`: content/browser/devtools/{devtools_agent_host_impl.cc, render_frame_devtools_agent_host.cc, devtools_session.cc, protocol/target_handler.cc, protocol/emulation_handler.cc, protocol/browser_handler.cc}; chrome/browser/extensions/api/debugger/{debugger_api.cc, extension_dev_tools_infobar_delegate.cc, .h}; chrome/browser/extensions/{extension_service.cc, extension_util.cc, chrome_extensions_browser_client.cc}; extensions/browser/extension_registrar.cc; extensions/common/extension_features.cc; build/config/chrome_build.gni; build/BUILD.gn; third_party/blink/renderer/core/timezone/timezone_controller.{cc,h}; third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc; third_party/blink/public/devtools_protocol/domains/Target.pdl; content/browser/site_info.cc; content/public/browser/site_isolation_policy.cc; content/public/common/content_switches.cc; chrome/browser/chrome_content_browser_client.cc; chrome/common/chrome_features.cc; net/base/registry_controlled_domains/registry_controlled_domain.cc; net/base/url_util.cc; base/i18n/icu_util.cc; services/device/time_zone_monitor/{time_zone_monitor_linux.cc, time_zone_monitor_mac.mm}; components/permissions/permission_request_manager.cc
- https://chromium.googlesource.com/chromium/deps/icu/+/main/source/common/putil.cpp; https://chromium.googlesource.com/v8/v8/+/main/src/date/date.cc

## Consequences for Spoofer

- Launch covered runs with `chromium.launchPersistentContext(tmpDir, { channel: 'chromium', args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>'], env: { ...process.env, TZ: 'Pacific/Kiritimati' } })`. Launch the Baseline identically without `args`. Use no `ignoreDefaultArgs`.
- Get the extension id from `(context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')).url().split('/')[2]`; open the popup with `page.goto('chrome-extension://<id>/popup.html')`.
- Forbidden in the harness: `timezoneId`, `geolocation`, `setGeolocation`, `clearPermissions` mid-test, `--silent-debugger-extension-api`, `--disable-site-isolation-trials`. Allow `--deny-permission-prompts` only in a dedicated deny test.
- The Baseline zone is `TZ=Pacific/Kiritimati`, the id the brief pins: no DST, offset -840, and no test City uses it, so a UTC CI host cannot fake a green smoke test. The first harness test asserts the Baseline sees it, which settles the TZ OPEN item.
- Grant with `context.grantPermissions(['geolocation'], { origin })` for each origin used. Test the deny path headless with no grant.
- Force an OOPIF with a parent at `http://localhost:P` and a child at `http://127.0.0.1:P`. Verify with `newCDPSession(page)` and `Target.getTargets`, expecting a `type === 'iframe'` entry at the 127.0.0.1 URL.
- The extension must send `Runtime.runIfWaitingForDebugger` to every child it auto-attaches with `waitForDebuggerOnStart: true`.
- The extension must treat `"Timezone override is already in effect"` and shared-renderer handle release as "not Covered". Silent fallback is a bug.
- Run one Audit configuration headed with `viewport: null` so an infobar-driven resize can show up as a Trace.
