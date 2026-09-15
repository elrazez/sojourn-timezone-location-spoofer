# R2: How far the CDP Emulation overrides reach

Scope: what `Emulation.setTimezoneOverride`, `Emulation.setGeolocationOverride`, `Target.setAutoAttach` and `Runtime.runIfWaitingForDebugger` actually cover when a `chrome.debugger` client attaches to a tab, read from Chromium `main`, V8 `main`, Puppeteer `main` and Playwright `main` as fetched on 2026-09-14. Line numbers refer to those snapshots. Paths without a host are Chromium `src/` paths; `v8:` paths are V8 `src/`. The question is whether every context a covered page can reach observes the Override, and which calls would add a Trace. `OPEN:` marks what source alone does not settle.

## Emulation.setTimezoneOverride

### Where it lives

- Protocol: `third_party/blink/public/devtools_protocol/domains/Emulation.pdl:526-532`: "Overrides default host system timezone with the specified one." One required parameter, `string timezoneId`.
- No browser-side handler. The content browser handles only the Emulation methods listed in `content/browser/devtools/protocol_config.json:37-64` (`setGeolocationOverride` is there, `setTimezoneOverride` is not). Anything else falls through to the renderer: `content/browser/devtools/devtools_session.cc:428-452` `DevToolsSession::FallThrough` stores the message in `pending_messages_` and calls `DispatchToAgent`.
- Renderer: `third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc:1063-1089` `InspectorEmulationAgent::setTimezoneOverride` calls `TimeZoneController::SetTimeZoneOverride(timezone_id)` and keeps the returned RAII handle in `timezone_override_`. The requested id is also stored in agent state: `timezone_id_override_.Set(timezone_id);` (1087).

### Scope: one renderer process

- `third_party/blink/renderer/core/timezone/timezone_controller.cc:124`: `DEFINE_THREAD_SAFE_STATIC_LOCAL(TimeZoneController, instance, ());`. It is a process singleton.
- The override is applied as the ICU process default: `timezone_controller.cc:236` `icu::TimeZone::adoptDefault(timezone.release());`.
- `timezone_controller.h:22-26`: "Time zone override mode allows clients to temporarily override host system time zone with the one specified by the client. The client can change the time zone, however no other client will be allowed to set another override until the existing override is removed."
- So the Override is per renderer process, not per frame or per page. Every frame and worker in that process sees it, including frames that belong to other tabs sharing the process, whether or not those tabs are attached.

### Effect on Date, Intl, Temporal

- `timezone_controller.cc:44-47` `NotifyTimezoneChangeToV8` calls `isolate->DateTimeConfigurationChangeNotification();`. On the main thread this runs for every isolate (`:87-93`, `ForEachMainThreadIsolate(&NotifyTimezoneChangeToV8)`), then `DispatchTimeZoneChangeEventToFrames()`.
- `v8:api/api.cc:11197-11212`: the notification calls `i_isolate->date_cache()->ResetDateCache(...)` and `clear_cached_icu_object(...)` for `kDefaultSimpleDateFormat`, `kDefaultSimpleDateFormatForTime` and `kDefaultSimpleDateFormatForDate`.
- `Date`: `v8:date/date.cc:32-39` builds the `DateCache` timezone cache from `Intl::CreateTimeZoneCache()` when ICU is on, so local-time offsets come from ICU's default zone.
- `Intl`: `v8:objects/intl-objects.cc:3154-3157` `Intl::DefaultTimeZone()` does `std::unique_ptr<icu::TimeZone> tz(icu::TimeZone::createDefault());`.
- `Temporal`: `v8:objects/js-temporal-objects.cc:2156-2157` `temporal_rs::TimeZone SystemTimeZoneIdentifier() { auto tz_str = Intl::DefaultTimeZone();` (also used by `Temporal.Now.timeZoneId` at `:7017`). All three read the ICU default that `adoptDefault` replaced.
- Side effect: `timezone_controller.cc:53-55` dispatches a `timezonechange` event on worker global scopes "if `RuntimeEnabledFeatures::TimeZoneChangeEventEnabled()`". Frames get the same through `DispatchTimeZoneChangeEventToFrames()`. `OPEN:` whether that feature is on in stable. If it is, an override applied after page script has started fires an event the Baseline never fires. Cheapest experiment: page registers `addEventListener('timezonechange', ...)` on `window` and in a worker, extension attaches late, check whether the event fires.

### Workers

- Same process: `timezone_controller.cc:246` `WorkerThread::CallOnAllWorkerThreads(&NotifyTimezoneChangeOnWorkerThread, ...)`. Every worker thread in the process resets its V8 date configuration. Dedicated, shared and service workers that share the page's renderer process follow the page's override without a command of their own.
- Other process: the override has to be set in that process, through a session attached to a target living there.
- Worker targets do expose Emulation. `third_party/blink/renderer/core/inspector/worker_inspector_controller.cc:135-141`: for any `WorkerGlobalScope` (dedicated, shared, service), `session->CreateAndAppend<InspectorEmulationAgent>(nullptr, *virtual_time_controller);`. `setTimezoneOverride` does not call `AssertPage()` (compare `setSmallViewportHeightDifferenceOverride` at `inspector_emulation_agent.cc:1234`), so it works with a null frame.
- The browser worker hosts register no `EmulationHandler`: `dedicated_worker_devtools_agent_host.cc:76-87`, `shared_worker_devtools_agent_host.cc:104-120`, `service_worker_devtools_agent_host.cc:252-276`. The command therefore falls through to that Blink agent.
- Worklets that are not `WorkerGlobalScope` get no Emulation agent (the `DynamicTo<WorkerGlobalScope>` guard at `:135-136`). They run inside a renderer process and so read that process's ICU default.
- The Protocol viewer does not list domain availability per target type. The agent registration above is the evidence.

### Cross-process navigation of the same tab

- The Blink agent state is replayed, not re-sent by the client. `content/browser/devtools/devtools_session.cc:206-231` `AttachToAgent` passes `session_state_cookie_.Clone()` to the new renderer's `AttachDevToolsSession`. `third_party/blink/renderer/core/inspector/devtools_session.cc:226-235`: `bool restore = reattach_state && reattach_state->renderer_originating_session_state; ... if (restore) { for (...) agents_[i]->Restore(); }`.
- `inspector_emulation_agent.cc:268-269` (inside `Restore`): `if (!timezone_id_override_.Get().IsNull()) setTimezoneOverride(timezone_id_override_.Get());`.
- Commands sent while a navigation is in flight are queued and re-sent to the new host: `devtools_session.cc:447-449` (`if (suspended_sending_messages_to_agent_ && ShouldSuspendDuringNavigation(method)) return;`) and `:268-277` ("cross-process navigation in the main frame ... we re-send outstanding messages to the new host").
- The tab session itself survives the swap. `render_frame_devtools_agent_host.cc:647-655` `RenderFrameHostChanged` calls `UpdateFrameHost(new_host_impl)` on the same agent host.
- In the old renderer the Blink session detaches (`devtools_session.cc:272-284` calls `agents_[i - 1]->Dispose()`), the agent drops its handle, and `~TimeZoneOverride() { ClearTimeZoneOverride(); }` (`timezone_controller.h:64`) restores the host zone in the process being left.
- Puppeteer does not re-send on navigation. It only pushes emulation state to new prerender sessions (`puppeteer-core/src/cdp/Page.ts:317-329`; `EmulationManager.ts:244-259`).

### Two sessions in one process

- `timezone_controller.cc:154-161`:
  - same id as the active override: `if (timezone_id == instance().TimeZoneIdOverride()) { ... return {TimeZoneOverrideStatus::kSuccess, nullptr}; }`
  - different id: `if (HasTimeZoneOverride()) { ... return {TimeZoneOverrideStatus::kAlreadyInEffect, nullptr}; }`
- The client sees `inspector_emulation_agent.cc:1078-1080`: `return protocol::Response::ServerError("Timezone override is already in effect");`. An unknown id gives `InvalidParams("Invalid timezone id")` (1082).
- Playwright ignores that error for every frame session: `playwright-core/src/server/chromium/crPage.ts:1216-1222` `if (exception.message.includes('Timezone override is already in effect')) return;`.
- Ownership hazard. A second session that sends the same id gets `kSuccess` with a null handle, so it owns nothing. When the owning session goes away (tab closed, frame navigated to another process, detach), the handle destructor clears the override for the whole process while the second session is still attached. Nothing in the agent re-acquires it. That is a silent fallback to real values. `OPEN:` confirm. Cheapest experiment: two tabs on the same `127.0.0.1` origin forced into one process (`--renderer-process-limit=1`), set the override on both, close the first, read `Intl.DateTimeFormat().resolvedOptions().timeZone` in the second.
- `SetTimeZoneOverride` compares strings, not canonical ids (`:154`), so `Asia/Calcutta` and `Asia/Kolkata` conflict.

### Empty string

- PDL `Emulation.pdl:531`: "If empty, disables the override and restores default host system timezone."
- Code `inspector_emulation_agent.cc:1065-1066`: `if (timezone_id.empty()) { timezone_override_.reset(); }`. It releases only this session's handle. If this session owns the override, `ClearTimeZoneOverride` (`timezone_controller.cc:190-201`) calls `SetIcuTimeZoneAndNotifyV8(instance().GetHostTimezoneId())`. If another session owns it, nothing changes. Puppeteer sends `''` for "reset" (`EmulationManager.ts:378-380`).

## Emulation.setGeolocationOverride

### Browser side, scoped to the WebContents

- Listed as browser-handled in `protocol_config.json:54`.
- `content/browser/devtools/protocol/emulation_handler.cc:586-632` `EmulationHandler::SetGeolocationOverride`:
  - `auto* geolocation_context = GetWebContents()->GetGeolocationContext();` (598)
  - ... `geolocation_context->SetOverride(std::move(override_result));` (629)
- `content/browser/web_contents/web_contents_impl.cc:6511-6525`: one context per `WebContents`, lazily bound: `if (!geolocation_context_) { GetDeviceService().BindGeolocationContext(geolocation_context_.BindNewPipeAndPassReceiver()); }`. An installed web app's delegate context replaces it (6513-6518).
- `services/device/geolocation/geolocation_context.cc:68-74` `SetOverride` stores `geoposition_override_` and calls `impl->SetOverride(...)` on every live `GeolocationImpl`. `BindGeolocation` (28-39) applies it to later binds: `if (geoposition_override_) { impl->SetOverride(*geoposition_override_); }`.
- `GeolocationServiceImpl` resolves the context from the requesting frame's `WebContents` (`content/browser/geolocation/geolocation_service_impl.cc:335-343`).
- Result: one call on any frame session covers the whole tab, including cross-process iframes. An iframe session does not need its own call.
- Every frame session has an `EmulationHandler` (`render_frame_devtools_agent_host.cc:416-417`), so a call from an iframe session would also override the whole tab. That handler's `Disable` would then clear it for the whole tab (see detach below).
- A `window.open` popup is a separate `WebContents` with its own `geolocation_context_`, so it needs its own call on its own session.

### Permission

- The override does not bypass permission. `geolocation_service_impl.cc:180` `CreateGeolocation` checks permissions policy, then `RequestPermission` calls `PermissionController::RequestPermissionFromCurrentDocument` (137).
- The result is checked before any bind: `:216-219` `if (permission_level == GeolocationPermissionLevel::kDenied || !geolocation_context) { std::move(callback).Run(blink::mojom::PermissionStatus::DENIED); return; }`. `BindGeolocation`, where the override is applied, runs only after that (232, 251).
- The prompt and denial therefore behave as without the extension. Revocation still unbinds through `GeolocationContext::OnPermissionUpdated` (`geolocation_context.cc:44-59`).

### Parameters and validation

- PDL `Emulation.pdl:404-421`: "Omitting latitude, longitude or accuracy emulates position unavailable." All seven parameters are optional: `latitude`, `longitude`, `accuracy`, `altitude`, `altitudeAccuracy`, `heading`, `speed`.
- Handler `emulation_handler.cc:600`: `if (latitude.has_value() && longitude.has_value() && accuracy.has_value())` builds a position. Otherwise (623-627) it sets `GeopositionErrorCode::kPositionUnavailable`. At the CDP level, `accuracy` is required in practice: omitting it gives the page a `POSITION_UNAVAILABLE` error, not a default accuracy. Puppeteer defaults it client-side to 0 (`EmulationManager.ts:555` `const {longitude, latitude, accuracy = 0} = options;`).
- Validation `services/device/public/cpp/geolocation/geoposition.cc:9-13`: `position.latitude >= -90. && position.latitude <= 90. && position.longitude >= -180. && position.longitude <= 180. && position.accuracy >= 0. && !position.timestamp.is_null();`. Failure returns `ServerError("Invalid geolocation")` (`emulation_handler.cc:619`). `altitude`, `altitudeAccuracy`, `heading` and `speed` are not validated there.
- When omitted, those four keep the mojom sentinels (`services/device/public/mojom/geoposition.mojom:14-17`, `kBadAltitude = -10000`, `kBadAccuracy = -1`, `kBadHeading = -1`, `kBadSpeed = -1`). Blink maps the sentinels to `null` (`third_party/blink/renderer/core/geolocation/geolocation.cc:69-82`, e.g. `position.altitude > -10000. ? std::make_optional(position.altitude) : std::nullopt`).
- Timestamp Trace candidate:
  - The position is stamped once, at command time: `emulation_handler.cc:617` `position->timestamp = base::Time::Now();`. Blink passes it through (`geolocation.cc:84` `ConvertTimeToEpochTimeStamp(position.timestamp)`), and every later fix repeats the same stored result (`geolocation_impl.cc:117-118`).
  - `GeolocationPosition.timestamp` stops advancing, and Blink's `maximumAge` cache check compares that timestamp with now (`geolocation.cc:447-451`).
  - `OPEN:` how fresh the Baseline's timestamps are. Cheapest experiment: call `getCurrentPosition` twice, 60 s apart, in the Baseline and in a covered tab, and compare `Date.now() - pos.timestamp`.
- Applying an override pushes an update to active watchers immediately (`geolocation_impl.cc:142-162`, ends with `OnLocationUpdate(*position_override_);`).

### Clear and detach

- `Emulation.clearGeolocationOverride` (`emulation_handler.cc:634-641`) calls `geolocation_context->ClearOverride()`. Each impl then does `position_override_.reset(); StartListeningForUpdates();` (`geolocation_impl.cc:164-166`), which returns it to the real provider.
- Detach clears it automatically. `devtools_session.cc:177-180` `Dispose` runs `for (auto& pair : handlers_) pair.second->Disable();`, and `EmulationHandler::Disable` (187) contains `if (geolocation_overridden_) { ClearGeolocationOverride(); }` (221-223). `geolocation_overridden_` belongs to the handler, so only the session that set the override clears it.

## Target.setAutoAttach on the tab session

### What a chrome.debugger tab session is

- `chrome/browser/extensions/api/debugger/debugger_api.cc:953` attaches `{tabId}` to `DevToolsAgentHost::GetOrCreateFor(web_contents)`. `render_frame_devtools_agent_host.cc:177-186` resolves that to the `RenderFrameDevToolsAgentHost` of the primary main frame (a `page` target), not the `tab` target.
- Extensions are untrusted unless they are Perfetto (`debugger_api.cc:270-277` `ExtensionIsTrusted`). The frame session gets `TargetHandler::AccessMode::kAutoAttachOnly` (`render_frame_devtools_agent_host.cc:450`, `:456-460`).
- In that mode these return `"Not allowed"` (`target_handler.cc:76`): `SetDiscoverTargets` (1085-1089), `AttachToTarget` (1195-1198), `GetTargetInfo` (1263-1267), `ActivateTarget` (1281-1282), `CloseTarget` (1295-1302), `CreateTarget` (1354-1369), `GetTargets` (1447-1450). `SetAutoAttach` (1114) is allowed.
- Child sessions are addressed through `DebuggerSession.sessionId` (`chrome/common/extensions/api/debugger.json:21-28`).
- `debugger_api.cc:590-600`: attaching shows a warning infobar unless `kSilentDebuggerExtensionAPI` or `Manifest::IsPolicyLocation`. That is user-visible, not page-visible.

### Child types a page session receives

- `iframe`: out-of-process iframes only.
  - `content/browser/devtools/protocol/target_auto_attacher.cc:51` `bool needs_host_attached = new_host->is_local_root_subframe();`.
  - `frame_auto_attacher.cc:245-257` creates hosts only for local roots and skips their children: "We don't search through children of local roots as they will be handled by a FrameAutoAttacher that is created for the local root."
  - Same-process iframes get no target. They belong to the parent's session and share its process-wide timezone.
  - Fenced frames are reported as `iframe` (`render_frame_devtools_agent_host.cc:889-893`).
- `worker` (dedicated): `RendererAutoAttacherBase::UpdateAutoAttach` asks the renderer to report children (`renderer_channel_->SetReportChildTargets(...)`), and `ChildWorkerCreated` calls `DispatchAutoAttach` (`target_auto_attacher.cc`, end of file). Nested workers come from the worker's own attacher (`dedicated_worker_devtools_agent_host.cc:44`).
- `service_worker`:
  - The main frame's attacher observes the service worker manager only when `!render_frame_host_->GetParent()` (`frame_auto_attacher.cc:179-183`). It attaches workers whose scope matches a URL in the frame tree (`GetFrameUrls`, `GetMatchingServiceWorkers`).
  - Only newly starting versions are paused (`:208` `*should_pause_on_start = DispatchAutoAttach(host, wait_for_debugger_on_start());`). Already-running workers are attached without a pause by `ReattachServiceWorkers` (`:216-230`).
  - Service worker sessions do not auto-attach further service workers (`target_handler.cc:947`, set by `DisableAutoAttachOfServiceWorkers` at `service_worker_devtools_agent_host.cc:274`).
- `shared_worker`: not from a page session. Only `BrowserDevToolsAgentHost::BrowserAutoAttacher` observes `SharedWorkerDevToolsManager` (`browser_devtools_agent_host.cc:70-73`, `:92` `SharedWorkerCreated`), and an untrusted extension cannot attach to the browser target (`debugger_api.cc:978-979` requires `ExtensionIsTrusted` for `kBrowserTargetId`).
  - `ExtensionMayAttachToAgentHost` does handle `kTypeSharedWorker` targets by `targetId` (`debugger_api.cc:407-441`).
  - `OPEN:` whether `chrome.debugger.getTargets()` lists shared and service workers in current stable (its `TargetInfoType` enum is `page, background_page, worker, other`, `debugger.json:32-36`), and whether such an attach can land before the worker's first script runs, since no pause is possible without browser-level auto-attach. Experiment: extension lists targets while a page starts a `SharedWorker` that posts `Intl.DateTimeFormat().resolvedOptions().timeZone` from its first line.
- Prerender (`page` with `subtype: "prerender"`, `Target.pdl:36-38`): attached by the tab target, not the page.
  - `web_contents_devtools_agent_host.cc:66-71` `WillInitiatePrerender` calls `DispatchAutoAttach` on the `WebContentsDevToolsAgentHost` attacher.
  - Prerender navigation throttles come from that same host: `devtools_instrumentation.cc:1508-1517` "For prerender, perform auto-attach to tab target at the point of initial navigation."
  - Activation calls `UpdateChildFrameTrees(ftn, /* update_target_info= */ true)` on the tab host (`:1080-1085`).
  - A `chrome.debugger` page session therefore never gets a prerender child. Puppeteer covers prerenders from the tab level and pushes emulation into them explicitly (`Page.ts:317-329`).
  - `OPEN:` what a page-level session does across activation (continue with `Restore()` on the activated page, or detach). Also whether a prerendered page ran script with real values before activation; it usually shares the initiator's process, but that is not guaranteed. Experiment: speculation-rules prerender of a same-site and a cross-site page, log `document.prerendering` and the time zone from its first inline script, and listen to `chrome.debugger.onDetach`.
- `auction_worklet` and `worklet` types exist (`devtools_agent_host_impl.cc:146`, `:150`) but are not produced by `FrameAutoAttacher`. `OPEN:` which attacher reports them and whether page-visible output depends on their time zone. Experiment: FLEDGE `runAdAuction` page with a bidding script that encodes `new Date().getTimezoneOffset()` into its bid.

### Popups

- Not children of the opener's session. `devtools_instrumentation.cc:1631-1640` `ShouldWaitForDebuggerInWindowOpen()` iterates only `BrowserDevToolsAgentHost::Instances()` and their `ShouldThrottlePopups()` (`target_handler.cc:1045`). Its caller is `RenderFrameHostImpl` new-window creation (`render_frame_host_impl.cc:10776-10777`).
- `target_handler.cc:860-867`: "window.open() navigations are throttled on the renderer side and the main request will not be sent until runIfWaitingForDebugger is received from the client".
- First-party clients catch popups with a browser-level `Target.setAutoAttach` and read `openerId`:
  - Puppeteer `TargetManager.ts:154-166` (connection-level `setAutoAttach` with `waitForDebuggerOnStart: true, flatten: true`).
  - Playwright `crBrowser.ts:84`, and `:192-194` `const opener = targetInfo.openerId ? this._crPages.get(targetInfo.openerId) || null : null;`.
- An extension has no browser target, so a popup is neither paused nor auto-attached. It must be attached as a new tab, and until then it runs with the real geolocation (separate `WebContents`) and, if it lands in another process, the real time zone.
- `OPEN:` the size of that window. Experiment: `window.open` to a page whose first inline script records the time zone and calls `getCurrentPosition` (permission pre-granted), with the extension attaching on `chrome.webNavigation.onCreatedNavigationTarget` or `chrome.tabs.onCreated`.

### Pausing and resuming

- PDL `Target.pdl:241-243`: "Whether to pause new targets when attaching to them. Use `Runtime.runIfWaitingForDebugger` to run paused targets."
- Browser side: `devtools_session.cc:95` `kResumeMethod[] = "Runtime.runIfWaitingForDebugger"`. `:382-387` runs `runtime_resume_` (releases the navigation or worker throttle) and then forwards the command.
- V8 side: `v8:inspector/v8-runtime-agent-impl.cc:650-660` `runIfWaitingForDebugger` has no enabled check, unlike its neighbours (`:665` `if (!m_enabled) return Response::ServerError("Runtime agent is not enabled");`). Blink resumes the page wait at `main_thread_debugger.cc:329-332` and `web_dev_tools_agent_impl.cc:276-291`. `Runtime.enable` is not required.
- Where the pause happens:
  - iframes: `ResponseThrottle::WillProcessResponse` (`target_handler.cc:416`).
  - workers: before start (`worker_thread.cc:729` `worker_inspector_controller_->WaitForDebuggerIfNeeded();`, then `debugger_->PauseWorkerOnStart(thread_)`, `worker_inspector_controller.cc:183-188`).
  - Subframes whose navigation started before attach cannot be paused (`frame_auto_attacher.cc:158`).
- Order: overrides and the child's own `setAutoAttach` go first, resume last.
  - Playwright `crPage.ts:493-497`: "Note that we cannot send Target.setAutoAttach after Runtime.runIfWaitingForDebugger".
  - Puppeteer `EmulationManager.ts:250-251`: "We don't await here because we want to register all state changes before the target is unpaused."

### Recursion and filter

- PDL `Target.pdl:235-236`: "You might want to call this recursively for auto-attached targets to attach to all available targets." Each OOPIF has its own `FrameAutoAttacher` (above) and each worker its own `RendererAutoAttacherBase`, so every child session needs its own `setAutoAttach`.
  - Puppeteer: `TargetManager.ts:432-444` sends `setAutoAttach` then `runIfWaitingForDebugger` on each child.
  - Playwright: `crPage.ts:793-796` does the same for workers, and `FrameSession._initialize` does it for iframes (`:545`).
- `filter` (`Target.pdl:248-249`, experimental): "Only targets matching filter will be attached." Default `TargetFilter::CreateDefault` (`target_handler.cc:720-734`) excludes `browser` and `tab` and allows everything else, so omitting it is correct for Sojourn.

## Detection vectors

- `Runtime.enable`: forbidden.
  - `enable()` reports all contexts and replays stored console messages (`v8-runtime-agent-impl.cc:1125-1156`, `m_session->reportAllContexts(this);` at 1136). While enabled, every console call is serialised: `:1231-1232` `if (m_enabled) reportMessage(message, true);`, which reaches `V8ConsoleMessage::wrapArguments` and `session->wrapObject(context, m_arguments[i]->Get(isolate), "console", generatePreview)` (`v8:inspector/v8-console-message.cc:259-305`).
  - For errors, `descriptionForError` reads `name` and `stack` through `getErrorProperty` (`v8:inspector/value-mirror.cc:312-334`). Current V8 skips an own accessor whose getter is not a builtin (`:298-300`), which blunts the classic trick of an own `stack` getter. It still calls `object->Get(context, name)` when the property is not own (`:283` `if (!descriptor->IsObject()) return object->Get(context, name);`). A getter placed on the prototype of an `Error` whose own `stack` was deleted would therefore run page JS only when a client has Runtime enabled.
  - `OPEN:` confirm that prototype-getter variant in stable. Experiment: `const e = new Error(); delete e.stack; Object.defineProperty(Object.getPrototypeOf(e), 'stack', {get(){ hit = true; return '' }}); console.log(e);`, with and without `Runtime.enable`.
- `Debugger.enable`: forbidden. `v8:inspector/v8-debugger-agent-impl.cc:475-479` activates breakpoints (`m_breakpointsActive = m_state->booleanProperty(DebuggerAgentState::breakpointsActiveWhenEnabled, true); if (m_breakpointsActive) m_debugger->setBreakpointsActive(true);`). A `debugger;` statement then pauses (`kDebuggerStatementBreakLocation`, `:300`) until the client resumes, which the page can time with `performance.now()` around the statement.
- `Emulation.setAutomationOverride`: forbidden. `third_party/blink/renderer/core/frame/navigator.cc:100-106` `Navigator::webdriver()` returns the probe result, and the agent sets it with `enabled |= automation_override_.Get();` (`inspector_emulation_agent.cc:1271-1272`), so `navigator.webdriver` becomes `true`.
- `Page.enable`: `inspector_page_agent.cc:551-557` only sets state and `instrumenting_agents_->AddInspectorPageAgent(this)`. No page-visible effect found in `enable` itself. `OPEN:` run the Audit with it on. Sojourn does not need it, so forbid it anyway.
- `Log.enable`: `inspector_log_agent.cc:177-178, 195-199` adds the log agent to instrumentation. Violation reports need `Log.startViolationsReport`. No page-visible effect found. `OPEN:` Audit. Not needed, so forbid.
- `Network.enable`: not traced in this pass. `OPEN:` Audit. Not needed, so forbid.
- The four commands Sojourn needs:
  - `setTimezoneOverride`: invisible only if applied before the first script in the process. Late application changes `Date` offsets mid-life and may fire `timezonechange` (above).
  - `setGeolocationOverride`: frozen `timestamp`, and an immediate callback to active watchers when applied (above).
  - `setAutoAttach` with `waitForDebuggerOnStart`: delays OOPIF commits and worker start by one CDP round trip. `OPEN:` whether that is measurable against the Baseline. Experiment: compare the OOPIF's `performance.getEntriesByType('navigation')[0]` (`responseEnd`, `domInteractive`) and a worker's `performance.now()` at its first line, with and without the extension, over many runs.
  - `Runtime.runIfWaitingForDebugger`: no effect beyond ending that pause.
  - Attaching a frame session calls `web_local_frame_impl_->OnDevToolsSessionConnectionChanged(/*attached=*/true)` and adds a task observer (`web_dev_tools_agent_impl.cc`, `AttachSession`). `OPEN:` whether that changes anything page-visible such as back/forward cache eligibility. Experiment: compare `performance.getEntriesByType('navigation')[0].notRestoredReasons` after a back navigation, with and without an attached session.

## Sources

- Chromium (https://source.chromium.org/chromium/chromium/src/+/main: , raw via https://raw.githubusercontent.com/chromium/chromium/main/):
  - `third_party/blink/public/devtools_protocol/domains/Emulation.pdl`, `Target.pdl`
  - `third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc`, `.h`
  - `third_party/blink/renderer/core/timezone/timezone_controller.cc`, `.h`
  - `third_party/blink/renderer/core/inspector/worker_inspector_controller.cc`, `devtools_session.cc`, `devtools_agent.cc`, `inspector_page_agent.cc`, `inspector_log_agent.cc`, `main_thread_debugger.cc`
  - `third_party/blink/renderer/core/exported/web_dev_tools_agent_impl.cc`, `core/workers/worker_thread.cc`, `core/frame/navigator.cc`, `core/geolocation/geolocation.cc`
  - `content/browser/devtools/protocol/emulation_handler.cc`, `target_handler.cc`, `target_auto_attacher.cc`
  - `content/browser/devtools/protocol_config.json`, `devtools_session.cc`, `render_frame_devtools_agent_host.cc`, `frame_auto_attacher.cc`, `web_contents_devtools_agent_host.cc`, `browser_devtools_agent_host.cc`
  - `content/browser/devtools/dedicated_worker_devtools_agent_host.cc`, `shared_worker_devtools_agent_host.cc`, `service_worker_devtools_agent_host.cc`, `devtools_agent_host_impl.cc`, `devtools_instrumentation.cc`, `devtools_renderer_channel.cc`
  - `content/browser/renderer_host/render_frame_host_impl.cc`, `content/browser/web_contents/web_contents_impl.cc`, `content/browser/geolocation/geolocation_service_impl.cc`
  - `services/device/geolocation/geolocation_context.cc`, `geolocation_impl.cc`, `services/device/public/mojom/geolocation_context.mojom`, `geoposition.mojom`, `services/device/public/cpp/geolocation/geoposition.cc`
  - `chrome/browser/extensions/api/debugger/debugger_api.cc`, `chrome/common/extensions/api/debugger.json`
- V8 (https://raw.githubusercontent.com/v8/v8/main/): `include/js_protocol.pdl` (Chromium mirror `v8/include/js_protocol.pdl`), `src/api/api.cc`, `src/date/date.cc`, `src/objects/intl-objects.cc`, `src/objects/js-temporal-objects.cc`, `src/inspector/v8-runtime-agent-impl.cc`, `v8-console-message.cc`, `v8-console.cc`, `value-mirror.cc`, `v8-debugger-agent-impl.cc`
- Protocol viewer: https://chromedevtools.github.io/devtools-protocol/tot/Emulation/ , /Target/ , /Runtime/ (generated from the PDLs above)
- Puppeteer (https://raw.githubusercontent.com/puppeteer/puppeteer/main/): `packages/puppeteer-core/src/cdp/EmulationManager.ts`, `TargetManager.ts`, `Page.ts`
- Playwright (https://raw.githubusercontent.com/microsoft/playwright/main/): `packages/playwright-core/src/server/chromium/crPage.ts`, `crBrowser.ts`, `crServiceWorker.ts`

## Consequences for Sojourn

- Time zone is per renderer process. Send `Emulation.setTimezoneOverride` on the tab session and on every auto-attached `iframe`, `worker` and `service_worker` session, before `Runtime.runIfWaitingForDebugger`. "Already in effect" with the same Selection cannot happen, since the same id returns success.
- Geolocation is per `WebContents`. Send `Emulation.setGeolocationOverride` with `latitude`, `longitude` and `accuracy` (all three, or the page gets `POSITION_UNAVAILABLE`) on the tab session only, never on child sessions.
- Nothing needs re-sending on cross-process navigation: Blink `Restore()` replays the time zone, and geolocation state lives in the browser. On every child or tab detach, re-send `setTimezoneOverride` on all remaining sessions, because a released handle clears the whole process (OPEN to confirm).
- Send `Target.setAutoAttach {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}` on the tab session and again on each child session, no filter, then resume. `Runtime.enable` is not required.
- A `chrome.debugger` tab session never reaches shared workers, prerendered pages or `window.open` popups (they need browser or tab targets extensions cannot use). Each is either attached separately with its gap reported as not Covered, or it needs an ADR.
- Only these methods are allowed: `Emulation.setTimezoneOverride`, `Emulation.setGeolocationOverride`, `Target.setAutoAttach`, `Runtime.runIfWaitingForDebugger`. Forbidden: `Runtime.enable`, `Debugger.*`, `Page.enable`, `Log.enable`, `Network.enable`, `Emulation.setAutomationOverride`.
- Audit must cover: frozen `GeolocationPosition.timestamp`, `timezonechange` firing on late attach, pause latency on OOPIF and worker start, `notRestoredReasons`. The debugger infobar is user-visible unless the extension is policy-installed.
