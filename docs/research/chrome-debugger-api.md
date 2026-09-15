# R1: the `chrome.debugger` API in current stable Chrome

Scope: how `chrome.debugger` behaves for a design that attaches from the extension service worker to every tab and sends `Emulation.setTimezoneOverride`, `Emulation.setGeolocationOverride` and `Target.setAutoAttach` (flatten) so pages observe the Override of the selected City. Researched against Chrome stable **154.0.8037.17** (Windows and Mac, released 2026-09-09 per `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows`; Linux stable is still 153.0.8010.36). Unless stated otherwise every source path is read at tag `154.0.8037.17` via `https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/<path>`, and line numbers refer to that revision. `debugger_api.cc` on that tag differs from `main` (2026-09-14) only by one `#include`.

## 1. Attach and detach semantics, error strings, restricted targets

**Attach creates one session per (extension, target).** Attach fails only if *this* extension already has a client host on that agent host: `if (FindClientHost()) { return RespondNow(Error(FormatErrorMessage(kAlreadyAttachedError)));` (`chrome/browser/extensions/api/debugger/debugger_api.cc` 1072-1074), where `FindClientHost` matches `client_host->agent_host() == agent_host && client_host->extension_id() == extension_id` (1034-1036). The string, despite saying "Another debugger":

> `constexpr char kAlreadyAttachedError[] = "Another debugger is already attached to the * with id: *.";` (111-112)

For a tab the placeholders are `kTabTargetType[] = "tab"` and the tab id, so the message reads `Another debugger is already attached to the tab with id: 42.`

**Error strings a tab attach can return** (all in `debugger_api.cc` unless noted):

| Condition | Error string | Source |
|---|---|---|
| Same extension already attached | `Another debugger is already attached to the tab with id: N.` | 111-112, 1072-1074 |
| Tab id not found (includes an incognito tab when the extension lacks incognito access, see section 6) | `No tab with given id N.` (`kNoTargetError[] = "No * with given id *."`) | 113, 1002-1004 |
| `chrome://` URL, or any frame in the tab is WebUI | `Cannot access a chrome:// URL` | `extensions/common/manifest_constants.h` 218-219; `permissions_data.cc` 157-161; `debugger_api.cc` 314-317 |
| Another extension's `chrome-extension://` page or frame | `Cannot access a chrome-extension:// URL of different extension` | `manifest_constants.h` 220-221; `debugger_api.cc` 215-219 |
| `file://` without "Allow access to file URLs" | `Cannot navigate to a file URL without local file access.` | 123-124, 222-225 |
| Chrome Web Store | `The extensions gallery cannot be scripted.` | `manifest_constants.h` 239-240; `chrome/common/extensions/chrome_extensions_client.cc` 153-156 |
| Scheme not valid for extensions (e.g. `devtools://`, `view-source:`) | `Cannot access contents of the page. Extension manifest must request permission to access the respective host.` | `permissions_data.cc` 139-148; `manifest_constants.h` 225-227 |
| Privileged WebContents | same `kCannotAccessPage` string | `debugger_api.cc` 324-329 |
| Tab showing a security interstitial | `Cannot attach to this target.` | 120, 360-363 |
| `AttachClient` refused by content layer | `Cannot attach to this target.` | 1100-1101 |
| Enterprise `runtime_blocked_hosts` set for the extension | `Host access is restricted by policy.` | 129-130, 1055-1057 |
| Enterprise `DisableScreenshots` | `Screenshot capture is restricted by policy.` | 125-126, 1082-1084 |
| DLP restricts screenshots on this target | `Screenshot capture is restricted on this target.` | 127-128, 1090-1094 |

Notes that settle the table:

- The `debugger` permission bypasses host permissions but not restricted URLs: `// NOTE: The debugger permission implies all URLs access (and indicates such to the user), so we don't check explicit page access. However, we still need to check if it's an otherwise-restricted URL.` (204-206).
- `about:blank`, empty URLs and the error page are allowed: `if (url.is_empty() || url == "about:" || url.IsAboutBlank()) { return true; }` and `if (url == content::kUnreachableWebDataURL) { return true; }` (196-202).
- **The check walks every frame in the tab**, not just the top document: `render_frame_host->ForEachRenderFrameHostWithAction(` (285) stops with an error on the first WebUI frame, privileged frame, or frame failing `ExtensionMayAttachToURLOrInnerURL` (313-346). So a normal page that embeds another extension's `chrome-extension://` iframe cannot be attached at all. Exceptions: frames inside a `MimeHandlerViewGuest` are skipped (292-294), and so are OOPIF PDF extension frames (305-311).
- Web Store matching is by domain: `return url.DomainIs(GetWebstoreLaunchURL().host()) || url.DomainIs(GetNewWebstoreLaunchURL().host());` (`extensions/common/extension_urls.cc` 145-148), with `kChromeWebstoreBaseURL[] = "https://chrome.google.com/webstore"` and `kNewChromeWebstoreBaseURL[] = "https://chromewebstore.google.com/"` (41-42). Consequence: every `chrome.google.com` URL is restricted, not only `/webstore`.
- Valid extension schemes are `http, https, file, ftp, chrome, chrome-extension, filesystem, ws, wss, data, uuid-in-package` (`extensions/common/url_pattern.cc` 34-41). `devtools:` is not in the list, so it takes the `kCannotAccessPage` branch.

**An extension New Tab Page is a `chrome://` URL to this check, and it commits within tens of milliseconds.** Measured, not read out of source: with `chrome_url_overrides.newtab` set, Chrome keeps the tab's url at `chrome://newtab/` while the extension page is the document, so `attach`, `detach` and every `sendCommand` about that tab take the `Cannot access a chrome:// URL` row above once it commits. The measurement probes a brand new tab with `chrome.debugger.detach`, which changes nothing and answers `Debugger is not attached to the tab with id: N.` while the tab is reachable and `Cannot access a chrome:// URL` once it is not:

| From | To | Warm (19 tabs) | First tab of the browser session |
|---|---|---|---|
| `chrome.tabs.create` | first refusal | 10 to 22 ms, median 12 | 389 ms |
| `chrome.tabs.create` | `tabs.onCreated` in the service worker | 6 to 12 ms | 25 ms |
| `tabs.onCreated` | first refusal | 4 to 10 ms, median 6 | 365 ms |

Harness: headless Chromium 153 with the extension loaded and no Selection, so Spoofer itself never attaches; probe resolution is one `detach` round trip, 0.5 to 2 ms warm. Consequences: a new tab has single-digit milliseconds of reach once the worker hears about it, which is why Coverage covers a new tab off the service worker's queue; and a tab already sitting on that page can never be attached, detached or sent anything. The tests that pin the behaviour, all in `test/e2e/lifecycle.spec.ts`: "a new tab shows Spoofer blank New Tab Page and is Covered within one reconcile tick", "a tab already showing the New Tab Page when Spoofer starts covering is Restricted, and what it opens next misses" (attach refused), and "Disabling reaches a tab on the New Tab Page only once that tab goes somewhere" (detach refused). ADR-0003 records the decision that rests on this.

**`runtime_blocked_hosts` is all-or-nothing and new in 154.** The attach code:

> `// Reject if an untrusted extension has any runtime blocked hosts configured by enterprise policy, because attaching the debugger grants raw CDP access that cannot be restricted to specific hosts.` followed by `!extension()->permissions_data()->policy_blocked_hosts().is_empty()` (1051-1057)

- The API reference says the same: "If enterprise policy ExtensionSettings configures blocked hosts ( runtime_blocked_hosts ) for an extension, browser.debugger.attach() is blocked on all targets with the error "Host access is restricted by policy." (even if individual origins are in runtime_allowed_hosts )" (developer.chrome.com debugger reference, "Enterprise policy restrictions").
- It landed in CL 8270219 at `#1683162`, between the M153 branch point (`#1681091`) and the M154 branch point (`#1689415`) per `https://chromiumdash.appspot.com/fetch_milestones`. Grepping the tags finds the check in `154.0.8037.17` and not in `153.0.8010.36`.
- Rollback commit `403b75eb96` (CL 8344410) says: "Aimed to back-merge to M154 to give enterprise users more time to prepare for this breaking change. The changes are planned to be re-landed in M155 after the back-merge." Revert `a487ea676b` re-landed it on main on 2026-09-11.
- `OPEN:` whether a later 154 point release ships without the block. Settle by grepping `kDebuggerDisabledByPolicyBlockedHosts` in the newest 154 tag.

**Detach.** `chrome.debugger.detach` answers every pending `sendCommand` with an error and closes the session: `client_host_->RespondDetachedToPendingRequests(); client_host_->Close();` (1125-1126). The pending error is `"Detached while handling command."` (121-122). `Close()` detaches the client silently (`agent_host_->DetachClient(this); delete this;`, 689-692), so **an explicit detach fires no `onDetach`**. Unloading the extension also calls `Close()` (749-756), again with no event.

## 2. `sessionId`, flattened child sessions, Target domain limits

**Version: Chrome 125, confirmed.**

- The reference marks `DebuggerSession` as "Chrome 125+" and says "Starting in Chrome 125, the browser.debugger API supports flat sessions" (developer.chrome.com debugger reference, "Attach to related targets").
- The change is commit `1326333956e3` "Support flat session mode in chrome.debugger" (https://chromium-review.googlesource.com/c/chromium/src/+/5398119), `Cr-Commit-Position: refs/heads/main@{#1285013}`. That falls after the M124 branch (`#1274542`) and before the M125 branch (`#1287751`).

**How child events are reported.** Every CDP notification becomes `onEvent` with a `DebuggerSession` built from the root Debuggee plus the message's `sessionId`:

> `DebuggerSessionFromDebugee(session, debuggee_, dictionary.FindString("sessionId"));` (791-793), which sets `dst.tab_id = src.tab_id; ... if (maybe_session_id) { dst.session_id = *maybe_session_id; }` (144-153)

So a child event arrives as `source = { tabId, sessionId }`. `Target.attachedToTarget` itself comes on the root session (no `source.sessionId`), with the child id in `params.sessionId`. The IDL: "If sessionId is specified for arguments sent from onEvent, it means the event is coming from a child protocol session within the root debuggee session." (`chrome/common/extensions/api/debugger.json` 23).

**`sendCommand` with `sessionId` works for auto-attached children.**

- `sendCommand` passes `params->target.session_id` through (1147-1149), and the JSON sent to the root agent host carries it: `protocol_request.Set("sessionId", session_id.value());` (708-709).
- The content layer routes by child session id and answers an unknown id with `"Session with given id not found."` (`content/browser/devtools/devtools_session.cc` 362-365).
- Child sessions are held to the root client's rules: commit `de3302be59` (CL 7802063, May 2026) "TargetHandler::Session now overrides MayAttachToRenderFrameHost, MayAttachToURL, and MayAccessAllCookies to delegate these checks to the root client."
- For workers reached by `targetId`, the parent is checked: `// For worker targets, always check the parent's URL to prevent security bypass if the worker was spawned by a restricted page.` (`debugger_api.cc` 404-405).

**Target domain filtering for extensions.**

- An extension client is untrusted unless it is the Perfetto UI extension: `if (extension.id() != extension_misc::kPerfettoUIExtensionId) { return false; }` (269-272).
- An untrusted page session gets `may_attach_to_browser ? protocol::TargetHandler::AccessMode::kRegular : protocol::TargetHandler::AccessMode::kAutoAttachOnly` (`content/browser/devtools/render_frame_devtools_agent_host.cc` 450-460).
- `kAutoAttachOnly` returns `"Not allowed"` (`content/browser/devtools/protocol/target_handler.cc` 76) for these commands:
  - `setDiscoverTargets` (1085-1086)
  - `attachToTarget` (1195-1196)
  - `activateTarget` (1279-1280)
  - `createTarget` (1366)
  - `getTargets` (1447)
  - `getTargetInfo` for any target other than its own (1264-1266)
  - `closeTarget`, except for its own or auto-attached targets (1299-1304)
- `attachToBrowserTarget` requires `kBrowser` (1214-1215). `autoAttachRelated` is "only supported on the Browser target" (1147-1149).
- `SetAutoAttach` has no `kAutoAttachOnly` gate (1111-1140), so `autoAttach`, `waitForDebuggerOnStart` and `flatten` are all accepted.
- Auto-attach is not recursive: "calling Target.setAutoAttach for the target associated with A would result in the session also being attached to B. However, this is not recursive, so Target.setAutoAttach also needs to be called for B to attach the session to C." (reference, "Attach to related targets").
- On a main-frame navigation, child worker sessions are dropped: `GetRendererChannel()->ForceDetachWorkerSessions();` (`render_frame_devtools_agent_host.cc` 557).

**Documented domain allowlist.** The reference lists: "Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, WebAudio, and WebAuthn" ("Restricted domains").

- In source, the content layer creates its handlers for every client (`render_frame_devtools_agent_host.cc` 406-483), and each handler applies its own per-method gates.
- The Chrome layer lets untrusted clients reach only `PageHandler, EmulationHandler, TargetHandler, WebMCPHandler` among its own handlers (`chrome/browser/devtools/chrome_devtools_session.cc` 42-48).
- Emulation and Target are available either way.
- `OPEN:` where the documented list is enforced as a list, if anywhere. This does not affect Spoofer.

## 3. The "started debugging this browser" infobar

**String.** `"<ph name="CLIENT_NAME">$1</ph>" started debugging this browser` (`chrome/app/generated_resources.grd` 4756-4757). The button label is `IDS_APP_CANCEL` (`extension_dev_tools_infobar_delegate.cc` 117).

**When it appears.**

- Every successful attach calls `CreateWarningInfobar()` unless the extension runs with the silent switch or is policy-installed: `const bool suppress_warning = base::CommandLine::ForCurrentProcess()->HasSwitch(::switches::kSilentDebuggerExtensionAPI) || Manifest::IsPolicyLocation(extension_->location());` (`debugger_api.cc` 589-592).
- The switch is `kSilentDebuggerExtensionAPI[] = "silent-debugger-extension-api"` (`chrome/common/chrome_switches.h` 624-625).
- A force-installed (policy) extension shows no bar.

**Global, one per extension, on every tab of every window.**

- The legacy path (the default in 154, see below) keeps one delegate per extension id: `using Delegates = std::map<ExtensionId, ExtensionDevToolsInfoBarDelegate*>;` (`extension_dev_tools_infobar_delegate.cc` 33). A second attach reuses it: `if (it != delegates.end()) { it->second->timer_.Stop(); return it->second->RegisterDestroyedCallback(...)` (49-52).
- The delegate is shown through `GlobalConfirmInfoBar::Show` (62), which adds an infobar to each tab and to tabs inserted later: `OnTabStripModelChanged ... global_info_bar_->MaybeAddInfoBar(contents.contents);` (`chrome/browser/devtools/global_confirm_info_bar.cc` 237-246), using `BrowserTabStripTracker browser_tab_strip_tracker_{this, nullptr};` (256).
- The origin commit is `d06efdfdcd` "Show debugger extension api infobar for every tab in every browser."
- The bar does not expire on navigation: `ShouldExpire(...) const { return false; }` (`extension_dev_tools_infobar_delegate.cc` 77-80).

**Lifetime.**

- The bar stays while any session of that extension is attached.
- When the last session's callback is removed, a timer closes it after `kAutoCloseDelay = base::Seconds(5)` (`extension_dev_tools_infobar_delegate.h` 30; `.cc` 141-146).
- Re-attaching within 5 s stops the timer (49-51).
- The grd description ("does not disappear until the user dismisses it, even if the debugger is detached") is stale since commit `301cdb469a` "Close the infobar 5 seconds after detaching the extension."

**Cancel detaches every session of that extension, on all tabs.**

- Cancel maps to the proxy's `Cancel()`, which calls `info_bar->Close()` (`global_confirm_info_bar.cc` 155-163). `Close()` is `delete this` (303-305), which destroys the delegate.
- The delegate destructor runs `callback_list_.Notify();` (`extension_dev_tools_infobar_delegate.cc` 66-67). Every attached client host of that extension then gets `WarningUiDestroyed()`.
- `WarningUiDestroyed()` does `detach_reason_ = api::debugger::DetachReason::kCanceledByUser; RespondDetachedToPendingRequests(); SendDetachedEvent(); Close();` (`debugger_api.cc` 716-721).
- Result: one `onDetach(source, "canceled_by_user")` per attached Debuggee. The infobar's close (X) runs the same `info_bar->Close()` path (`global_confirm_info_bar.cc` 90-106).
- `OPEN:` whether the desktop bar shows an X at all. Settle with a 5-line experiment.

**Migrated path (flagged off in 154).**

- Commit `d7f912e532` (CL 8277210) adds `ExtensionDevToolsInfoBarController`, used when `infobars::IsInfoBarMigrated(EXTENSION_DEV_TOOLS_INFOBAR_DELEGATE)` (`debugger_api.cc` 641-651).
- Its action handler detaches every active host regardless of extension: `for (ExtensionDevToolsClientHost* host : hosts) { host->WarningUiDestroyed(); }` (876-883). It shows the bar via `ShowGlobally` (885-898).
- It is gated by `BASE_FEATURE(kCentralizedInfoBarFramework, base::FEATURE_DISABLED_BY_DEFAULT);` and `kMigratedExtensionDevTools ... false` (`chrome/browser/infobars/infobar_features.cc` 9, 92-95, 153-171).
- Either way the reason is `canceled_by_user`.

## 4. DevTools and other debuggers on the same tab

**Coexistence, no detach.**

- `DevToolsAgentHostImpl::AttachClient` refuses only a client that is already attached: `if (SessionByClient(client)) return false; return AttachInternal(std::make_unique<DevToolsSession>(client, GetSessionMode()));` (`content/browser/devtools/devtools_agent_host_impl.cc` 337-342).
- The DevTools window attaches as an ordinary client: `agent_host_->AttachClient(this);` (`chrome/browser/devtools/devtools_ui_bindings.cc` 999).
- Multi-client landed in commit `ed41e02276` "[DevTools] Enable multiple sessions" (`#497170`, before the M63 branch `#508578`), which allows "multiple debugging sessions via debugger api from different extensions, but not from the same one; single DevTools window in addition to any other debuggers."
- Opening DevTools therefore fires no `onDetach`. The IDL text "This happens when either the tab is being closed or Chrome DevTools is being invoked for the attached tab" (`debugger.json` 188) is stale.
- Another extension already attached also coexists. The "already attached" error is only for the same extension.

**Conflicts between clients are per override, not per session.**

- *Time zone* is renderer-process-wide and exclusive:
  - `if (HasTimeZoneOverride()) { ... return {TimeZoneOverrideStatus::kAlreadyInEffect, nullptr}; }`. The exception is `if (timezone_id == instance().TimeZoneIdOverride()) { return {TimeZoneOverrideStatus::kSuccess, nullptr}; }` (`third_party/blink/renderer/core/timezone/timezone_controller.cc` 154-162).
  - The agent surfaces the error as `"Timezone override is already in effect"` and keeps the handle only when it created the override (`inspector_emulation_agent.cc` 1067-1079).
  - So if DevTools (Sensors panel) or another extension already holds a time zone override in that renderer, Spoofer's call fails. If Spoofer holds it, theirs fails.
- *Geolocation* is per WebContents and last writer wins: `auto* geolocation_context = GetWebContents()->GetGeolocationContext(); ... geolocation_context->SetOverride(std::move(override_result));` (`content/browser/devtools/protocol/emulation_handler.cc` 584, 615).
- `OPEN:` whether opening DevTools (with persisted Sensors settings) sends any Emulation override without user action. Settle with a 20-line experiment: attach, set both overrides, open DevTools, read `Intl.DateTimeFormat().resolvedOptions().timeZone` and `getCurrentPosition` in the page.

## 5. Service worker lifetime

**Sessions opened by the service worker keep it alive (Chrome 118).**

- Lifecycle doc: "Chrome 118: Active debugger sessions created using the chrome.debugger API now keep the service worker alive. This prevents service workers from timing out during calls for this API." (developer.chrome.com, "The extension service worker lifecycle", Chrome 118 note).
- Source: when attach comes from a worker, the client host takes a keepalive with no timeout: `service_worker_keepalive_ = process_manager->IncrementServiceWorkerKeepaliveCount(*extension_service_worker_id_, content::ServiceWorkerExternalRequestTimeoutType::kDoesNotTimeout, Activity::DEBUGGER, ...)` (`debugger_api.cc` 602-612). It is released in the client host destructor (665-677).
- Commit `b88ab2a959` (CL 4763879, `#1182697`, between the M117 branch `#1181205` and the M118 branch `#1192594`) calls it a strong keepalive for debugger sessions. Per the commit, it "prevents these workers from timing out for these API calls (though they can still be terminated for other cases)".
- The keepalive is tied to the attaching worker (`worker_id()` passed at 1097-1098). An attach made from the popup or an offscreen document takes none.

**Worker termination does not detach.**

- The client host observes only the extension registry, the profile and app termination (554-579).
- Its only worker reference is the keepalive, and the destructor notes `// The worker may have terminated for other reasons. Only decrement the keepalive if it's still around.` (670-671).
- Events go through `EventRouter::Get(profile_)->DispatchEventToExtension(...)` (739-740, 799-800), and the lifecycle doc says "if the service worker has gone dormant, an incoming event will revive them."
- `OPEN:` confirm empirically that a session survives a forced worker stop (stop the worker in `chrome://serviceworker-internals`, then check that `onEvent` still fires and the Override still holds).

**Keep-alive story.** The 30 s idle and 5 min request limits apply ("After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer." and "When a single request ... takes longer than 5 minutes to process.", lifecycle doc "Idle and shutdown"). An attached session from the worker is itself the keep-alive. With zero Covered tabs nothing holds the worker, which is fine.

## 6. Incognito

**Spanning mode can attach to incognito tabs once the user allows incognito.**

- The dispatcher sets `function->set_include_incognito_information(true)` when `CanExtensionCrossIncognito` (`extensions/browser/extension_function_dispatcher.cc` 355-357). That is `IsIncognitoEnabled(extension->id(), context) && !IncognitoInfo::IsSplitMode(extension)`, commented "We allow the extension to see events and data from another profile iff it uses "spanning" behavior and it has incognito access." (`extensions/browser/extension_util.cc` 152-159).
- Tab lookup honours it: `ExtensionTabUtil::GetTabById(*debuggee_.tab_id, browser_context(), include_incognito_information(), &web_contents)` (`debugger_api.cc` 942-944).
- The target-profile check is `return profile == extension_profile || allow_incognito_access;` (186).
- Without incognito access the tab is simply not found: `No tab with given id N.`
- There is no other incognito-specific rule in `debugger_api.cc`. The infobar tracker uses a null browser filter (`global_confirm_info_bar.cc` 256), so the bar is expected in incognito windows too (inference from the null filter, not observed).

## 7. Other behaviour an attach-to-every-tab design must know

**Only two detach reasons.** `"enum": [ "target_closed", "canceled_by_user" ]` (`debugger.json` 41). The default is `api::debugger::DetachReason::kTargetClosed` (`debugger_api.cc` 539-540), and only `WarningUiDestroyed` sets `kCanceledByUser`. Every forced detach other than Cancel reports **`target_closed`, including ones where the tab stays open**.

**Cross-process navigation: the session survives.**

- A tab Debuggee maps to the agent host of the primary frame tree root, `RenderFrameDevToolsAgentHost::GetOrCreateFor(node)` (`render_frame_devtools_agent_host.cc` 177-186). That host is keyed by FrameTreeNode (215-224).
- On a RenderFrameHost swap it calls `UpdateFrameHost` (649-658, 531-560). That function keeps sessions and only force-detaches those failing `ShouldAllowSession` (599-623).
- `ShouldAllowSession` delegates to the extension's `MayAttachToRenderFrameHost` (1126-1140).

**Navigating to a restricted URL detaches with `target_closed`.**

- Before a navigation request is sent, each session is checked: `if (!session->GetClient()->MayAttachToURL(url, is_webui)) restricted_sessions.push_back(session); ... ForceDetachRestrictedSessions(restricted_sessions);` (783-796).
- The check is dispatched upward to every ancestor agent: "dispatches to all agents upwards from the frame, to make sure the security checks are properly applied even if no DevTools session is established for the navigated frame itself" (`content/browser/devtools/devtools_instrumentation.cc` 2030-2039).
- `ForceDetachRestrictedSessions` calls `client->AgentHostClosed(this)` (`devtools_agent_host_impl.cc` 494-503). `AgentHostClosed` does `RespondDetachedToPendingRequests(); SendDetachedEvent();` with the default reason (`debugger_api.cc` 681-687).
- So a Covered tab that navigates to `chrome://`, the Web Store, or a page framing another extension gets `onDetach(target_closed)` while the tab lives on. Re-attach fails until it leaves that URL.

**Tab close / frame gone.** `FrameDeleted` on the root leads to `DestroyOnRenderFrameGone()`, then `ForceDetachAllSessionsImpl()` (`render_frame_devtools_agent_host.cc` 660-669, 684-695, `devtools_agent_host_impl.cc` 480-489), then `target_closed`.

**Renderer crash does not detach.** It notifies `inspector->TargetCrashed()` and sets `render_frame_crashed_ = true` (744-768). After reload it calls `TargetReloadedAfterCrash()` (732-741). `OPEN:` whether the Override is re-applied after crash-reload (Audit case: kill the renderer, reload, compare).

**Override persistence across navigation.**

- Geolocation lives on the WebContents' `GeolocationContext` (`emulation_handler.cc` 584, 615), so it is independent of document or process.
- The Blink agent stores the time zone in `timezone_id_override_(&agent_state_, ...)` (`inspector_emulation_agent.cc` 185) and re-applies it when non-null (268-269).
- `OPEN:` confirm with the Audit that both Overrides hold on the first script of a cross-site, cross-process navigation. The TDZ window (time between commit and re-apply) is a candidate Trace.

**Detach may not restore geolocation.**

- The Blink emulation agent resets the time zone handle on teardown (`timezone_override_.reset();`, `inspector_emulation_agent.cc` 356).
- `EmulationHandler::Disable()` (`emulation_handler.cc` 173) showed no geolocation clear within the lines grepped.
- `OPEN:` whether detach clears the geolocation override. Settle with a 20-line experiment: set it, `chrome.debugger.detach`, call `getCurrentPosition`.

**Same-process tabs share one time zone override.** This follows from section 4's `timezone_controller.cc` 154-162:

- The first session in a renderer process owns the handle. Later sessions setting the same zone get `kSuccess` with a null handle.
- If the owning tab detaches or navigates away, the process-wide override is removed while other Covered tabs in that process keep their sessions and get no event.
- Changing the City from a non-owning session returns `"Timezone override is already in effect"`.
- `OPEN:` confirm with two same-site tabs forced into one process (for example `--renderer-process-limit=1`): attach both, detach the first, read the time zone in the second.

**Prerender.** The auto-attacher attaches prerender targets (`WillInitiatePrerender`, `content/browser/devtools/web_contents_devtools_agent_host.cc` 65-68; subtype `"prerender"`, `render_frame_devtools_agent_host.cc` 1050, 1066-1067). `OPEN:` whether a tab-Debuggee session and its Overrides follow a prerender activation, or the prerendered page must be covered through its auto-attached child session. Settle with an experiment using speculation rules `prerender`, then activate and read the time zone.

**BFCache.** `OPEN:` whether a page restored from BFCache still observes the current Override, especially after a City change while it was cached. Settle with an Audit case: navigate away, change the Selection, go back, read both values.

**Tab discard.** Desktop in-place discard is off: `BASE_FEATURE(kWebContentsDiscard, ... base::FEATURE_DISABLED_BY_DEFAULT` on non-Android (`content/public/common/content_features.cc` 379-387). `OPEN:` what the desktop discard path does to the session. The expected outcome is `target_closed` (WebContents replaced) and a fresh attach on reload. Settle with `chrome.tabs.discard(id)` while logging `onDetach`, then reload.

**Install warning.** `debugger` maps to `IDS_EXTENSION_PROMPT_WARNING_DEBUGGER` under "Full access permission messages" (`chrome/common/extensions/permissions/chrome_permission_message_rules.cc` 368-369), text `Access the page debugger backend` (`generated_resources.grd` 5372-5373).

**Background pages.** Attaching by `extensionId` is "only possible when the --silent-debugger-extension-api command-line switch is used" (`debugger.json` 16). Irrelevant to tab coverage.

## Sources

- Chromium Dash stable releases and branch points: https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows , https://chromiumdash.appspot.com/fetch_milestones
- `chrome.debugger` reference: https://developer.chrome.com/docs/extensions/reference/api/debugger (sections "Enterprise policy restrictions", "Attach to related targets", "Restricted domains", Types, Events)
- Extension service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle ("Idle and shutdown", Chrome 118 note)
- Source at tag 154.0.8037.17 (`https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/<path>`):
  - `chrome/browser/extensions/api/debugger/debugger_api.cc`
  - `chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc`, `.h`
  - `chrome/common/extensions/api/debugger.json`
  - `chrome/app/generated_resources.grd`
  - `chrome/common/extensions/permissions/chrome_permission_message_rules.cc`
  - `chrome/common/chrome_switches.h`
  - `chrome/browser/devtools/global_confirm_info_bar.cc`, `chrome/browser/devtools/devtools_ui_bindings.cc`, `chrome/browser/devtools/chrome_devtools_session.cc`
  - `chrome/browser/infobars/infobar_features.cc`
  - `chrome/common/extensions/chrome_extensions_client.cc`, `chrome/browser/extensions/chrome_extensions_browser_client.cc`
  - `extensions/common/manifest_constants.h`, `extensions/common/extension_urls.cc`, `extensions/common/url_pattern.cc`
  - `extensions/common/permissions/permissions_data.cc`, `.h`
  - `extensions/browser/extension_function.h`, `extensions/browser/extension_function_dispatcher.cc`, `extensions/browser/extension_util.cc`
  - `content/browser/devtools/devtools_agent_host_impl.cc`, `render_frame_devtools_agent_host.cc`, `web_contents_devtools_agent_host.cc`, `devtools_session.cc`, `devtools_instrumentation.cc`, `protocol/target_handler.cc`, `protocol/emulation_handler.cc`
  - `content/public/common/content_features.cc`
  - `third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc`, `third_party/blink/renderer/core/timezone/timezone_controller.cc`
- Commits (messages via `https://api.github.com/repos/chromium/chromium/commits?path=...`):
  - `1326333956e3` CL 5398119 (flat sessions, #1285013)
  - `b88ab2a959` CL 4763879 (worker keepalive, #1182697)
  - `e6e507e001` CL 8270219 (blocked hosts)
  - `403b75eb96` / `a487ea676b` CL 8344410 (rollback and re-land)
  - `d7f912e532` CL 8277210 (infobar migration)
  - `de3302be59` CL 7802063 (child session checks)
  - `ed41e02276` (multi-client)
  - `301cdb469a` (5 s autoclose)
  - `d06efdfdcd` (global infobar)

## Consequences for Spoofer

1. **Chrome floor is 125** (flat `sessionId`), which already covers the 118 worker keepalive. Attach from the service worker so the session itself is the keep-alive; no alarm or port hack is needed.
2. **Covered cannot mean "attached".** `target_closed` fires on restricted navigations with the tab still open, and on same-process time zone loss nothing fires at all. Coverage must be re-verified per tab (the popup count and badge), not inferred from session state.
3. **The bar is global and shows for the whole time Spoofer is Enabled**, on every tab of every window. Cancel detaches every tab with `canceled_by_user`. Treat that reason as the user turning Enabled off, and fail loud, instead of re-attaching.
4. **Restricted and Not Covered tabs are never Covered.** Restricted, never on the badge: `chrome://`, all of `chrome.google.com` and `chromewebstore.google.com`. Not Covered, counted on the badge: `file://` without file access, interstitials, and pages framing another extension.
5. **DevTools coexists** with no detach. Its Sensors time zone collides with Spoofer's (`Timezone override is already in effect`) and its geolocation overwrites Spoofer's. Surface a failed `setTimezoneOverride` as not Covered.
6. **Set the Override on every auto-attached child session and call `Target.setAutoAttach` again in each child**, because auto-attach is not recursive. Only `setAutoAttach` is allowed in the Target domain.
7. **Before relying on the design, run the Audit against the OPEN items:** same-process time zone ownership, geolocation cleanup on detach, prerender and BFCache, discard, and the first-script TDZ after navigation.
8. **Enterprise installs with `runtime_blocked_hosts` or `DisableScreenshots` cannot attach at all in 154.** Report that as not Covered with the policy error.
