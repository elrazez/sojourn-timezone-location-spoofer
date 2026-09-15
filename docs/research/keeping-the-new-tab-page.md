# R6: Keeping Chrome's stock New Tab Page

Scope: whether Spoofer can drop `chrome_url_overrides.newtab` (ADR-0003) and still cover a site's first script when the user opens a new tab and types a url. The answer decides whether the install prompt's "changed the page shown on new tabs" line is a price Spoofer has to pay.

Sources and versions. Chromium source is read at the current stable tag **154.0.8037.17** (newest on `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=3` and the Windows endpoint on 2026-09-15), fetched as `https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/<path>`; every line number below refers to that tag. Experiments ran on this machine: Playwright 1.63.0 with its bundled **Chromium 153.0.8010.12** for everything driven through the harness pattern in `test/e2e/fixtures.ts`, and installed **Google Chrome 151.0.7922.138** for the macOS policy measurement, on an unmanaged Mac (`profiles status -type enrollment` reports `Enrolled via DEP: No`, `MDM enrollment: No`, and there is no `/Library/Managed Preferences/com.google.Chrome.plist`). Scratch specs and scratch extension copies live in the session scratchpad, never under `test/`. `OPEN:` marks what neither source nor experiment settled.

Known going in, not re-derived: `chrome.debugger.attach` is refused while a `chrome://` url is committed; with the override the tab keeps the url `chrome://newtab/`, the session attached in the 10 to 22 ms window after creation survives (Sealed), and Chrome replays the Override into the next document; without the override, phase 06 measured 20 of 20 New Tab Page loads running the site's first script before the zone landed.

## 1. Which url the attach permission check reads

**All three, in layers: the tab's virtual last committed url, the pending entry's real url, and every frame's committed url.**

`ExtensionMayAttachToWebContents`, `chrome/browser/extensions/api/debugger/debugger_api.cc` 353-382:

```cpp
  // This is *not* redundant to the checks below, as
  // web_contents.GetLastCommittedURL() may be different from
  // web_contents.GetPrimaryMainFrame()->GetLastCommittedURL(), with the
  // former being a 'virtual' URL as obtained from NavigationEntry.
  if (!ExtensionMayAttachToURL(extension, extension_profile,
                               web_contents.GetLastCommittedURL(), error)) {
    return false;
  }
  if (web_contents.GetController().GetPendingEntry() &&
      !ExtensionMayAttachToURL(
          extension, extension_profile,
          web_contents.GetController().GetPendingEntry()->GetURL(), error)) {
    return false;
  }

  return ExtensionMayAttachToRenderFrameHost(
      extension, extension_profile, web_contents.GetPrimaryMainFrame(), error);
```

The three accessors, in that order:

1. `content::WebContents::GetLastCommittedURL()`, which is the **virtual** url of the last committed entry: `const NavigationEntry* entry = GetController().GetLastCommittedEntry(); return entry ? entry->GetVirtualURL() : GURL::EmptyGURL();` (`content/browser/web_contents/web_contents_impl.cc` 1745-1749). An empty url passes: `if (url.is_empty() || url == "about:" || url.IsAboutBlank()) { return true; }` (`debugger_api.cc` 196-199).
2. `NavigationController::GetPendingEntry()->GetURL()`, which is the entry's **real** url, the one that will actually load. The split is made once, at entry creation, `content/browser/renderer_host/navigation_controller_impl.cc` 698-720: `RewriteUrlForNavigation(url, browser_context, &url_to_load, &virtual_url, &reverse_on_redirect);` then `NavigationEntryImpl(nullptr, url_to_load, ...)` and `entry->SetVirtualURL(virtual_url);`.
3. `ExtensionMayAttachToRenderFrameHost`, which walks the whole frame tree (`debugger_api.cc` 278-351), stopping on the first frame with `render_frame_host->GetWebUI()` non-null (314-318) and checking each frame's `GetLastCommittedURL()` **and** its SiteInstance site url, with the comment "We check both the last committed URL and the SiteURL because this method may be called in the middle of a navigation where the SiteURL has been updated but navigation hasn't committed yet" (332-334).

`chrome://` fails at `extensions/common/permissions/permissions_data.cc` 156-162: `if (document_url.SchemeIs(content::kChromeUIScheme) && !allow_on_chrome_urls) { ... *error = manifest_errors::kCannotAccessChromeUrl; return true; }`.

**Consequence: an attach issued during the New Tab Page to site navigation can never succeed before commit.** While the site has not committed, the last committed entry is still the New Tab Page, and layer 1 reads its virtual url, `chrome://newtab/` either way, and refuses. Layer 3 refuses again, because pre-commit `GetPrimaryMainFrame()` is still the old document: for the stock New Tab Page that frame's `GetWebUI()` is non-null. The pending entry check, the one layer that would pass, is never reached. The earliest an attach can land is after the site's own document has committed, which is after its first script has run.

**The same three layers explain the window the override buys, and why the stock page has none.** Before anything commits, layer 1 reads an empty url and passes. Layer 2 reads the pending entry's *real* url, which is `chrome-extension://<id>/newtab.html` under the override and `chrome://new-tab-page/` without it. So the override leaves a few milliseconds where every layer passes, and the stock page is refused from the first instant the tab exists.

Measured on this machine, probing a brand new tab with `chrome.debugger.detach` from `tabs.onCreated` until Chrome refuses, with no Selection so the extension itself attached nothing, 10 tabs each:

| New Tab Page | create to `onCreated` | create to first refusal | probes answered before the refusal |
|---|---|---|---|
| Spoofer's own (`chrome_url_overrides.newtab`) | 15 to 20 ms | 21 to 27 ms, and 379 ms for the first tab of the session | **4 to 7** |
| Chrome's stock `chrome://new-tab-page/` | 15 to 25 ms | 15 to 25 ms | **0 in every one of the 10** |

The refusal is `Cannot access a chrome:// URL` in both. For the stock page the very first probe, issued inside the `tabs.onCreated` listener, was already refused: the window is not small, it is absent.

## 2. Why an attached session survives Spoofer's New Tab Page and not the stock one

**Because the revalidation path never looks at the tab's virtual url. It looks only at the `RenderFrameHost`.**

`ShouldAllowSession`, `content/browser/devtools/render_frame_devtools_agent_host.cc` 1126-1140, in full:

```cpp
bool RenderFrameDevToolsAgentHost::ShouldAllowSession(
    RenderFrameHost* frame_host,
    DevToolsSession* session) {
  // There's not much we can say if there's not host yet, but we'll
  // check again when host is updated.
  if (!frame_host) {
    return true;
  }
  DevToolsManager* manager = DevToolsManager::GetInstance();
  if (manager->delegate() &&
      !manager->delegate()->AllowInspectingRenderFrameHost(frame_host)) {
    return false;
  }
  return session->GetClient()->MayAttachToRenderFrameHost(frame_host);
}
```

It is called from `UpdateFrameHost`, which is what fires the detach, same file 613-623:

```cpp
  std::vector<DevToolsSession*> restricted_sessions;
  for (DevToolsSession* session : sessions()) {
    if (!ShouldAllowSession(frame_host, session)) {
      restricted_sessions.push_back(session);
    }
  }
  scoped_refptr<RenderFrameDevToolsAgentHost> protect;
  if (!restricted_sessions.empty()) {
    protect = this;
    ForceDetachRestrictedSessions(restricted_sessions);
  }
```

`UpdateFrameHost` is reached from `ReadyToCommitNavigation` (558), `DidFinishNavigation` (587) and `RenderFrameHostChanged` (656). The second detach path runs before the request even goes out, same file 783-796:

```cpp
void RenderFrameDevToolsAgentHost::OnNavigationRequestWillBeSent(
    const NavigationRequest& navigation_request) {
  GURL url = navigation_request.common_params().url;
  if (url.SchemeIs(url::kJavaScriptScheme) && frame_host_)
    url = frame_host_->GetLastCommittedURL();
  std::vector<DevToolsSession*> restricted_sessions;
  bool is_webui = frame_host_ && frame_host_->web_ui();
  for (DevToolsSession* session : sessions()) {
    if (!session->GetClient()->MayAttachToURL(url, is_webui))
      restricted_sessions.push_back(session);
  }
  if (!restricted_sessions.empty())
    ForceDetachRestrictedSessions(restricted_sessions);
}
```

The client override an extension supplies, `debugger_api.cc` 819-827, refuses WebUI outright and without looking at the url at all:

```cpp
bool ExtensionDevToolsClientHost::MayAttachToURL(const GURL& url,
                                                 bool is_webui) {
  if (is_webui) {
    return false;
  }
  std::string error;
  return ExtensionMayAttachToURLOrInnerURL(*extension_, profile_, url, nullptr,
                                           &error);
}
```

Declared as "Returns true if the client is allowed to attach to the given URL. Note: this method may be called before navigation commits." (`content/public/browser/devtools_agent_host_client.h` 33-35). `is_webui` is read off the frame being navigated **away from**, `frame_host_->web_ui()` (line 789).

And `ForceDetachRestrictedSessions` itself, `content/browser/devtools/devtools_agent_host_impl.cc` 494-503:

```cpp
void DevToolsAgentHostImpl::ForceDetachRestrictedSessions(
    const std::vector<DevToolsSession*>& restricted_sessions) {
  scoped_refptr<DevToolsAgentHostImpl> protect(this);

  for (DevToolsSession* session : restricted_sessions) {
    DevToolsAgentHostClient* client = session->GetClient();
    DetachClient(client);
    client->AgentHostClosed(this);
  }
}
```

`AgentHostClosed` never touches `detach_reason_` (`debugger_api.cc` 681-687), so the extension is told `target_closed`, the field's initializer (539-540), which is the same word Chrome uses when the tab really closed.

**The two commits, side by side.** The override is a `BrowserURLHandler` pair whose reverse slot is `BrowserURLHandler::null_handler()` (`chrome/browser/extensions/chrome_content_browser_client_extensions_part.cc` 857-864), registered before the stock New Tab Page rewriter (`chrome/browser/chrome_content_browser_client.cc` 4999-5014), and the first matching handler wins (`content/browser/browser_url_handler_impl.cc` 145-152). So:

- **Spoofer's New Tab Page.** The entry's real url is `chrome-extension://<id>/newtab.html` and its virtual url stays `chrome://newtab/`, because the null reverse handler leaves `update_virtual_url_with_url()` false. The committed `RenderFrameHost` is an ordinary extension document: `GetWebUI()` is null, and its `GetLastCommittedURL()` host equals the extension's own id, which passes `debugger_api.cc` 213-220. `ShouldAllowSession` returns true and nothing is detached. The tab is Sealed only because the *other* check, the one for a fresh attach, reads the virtual url.
- **The stock New Tab Page.** `search::HandleNewTabURLRewrite` produces a real `chrome://new-tab-page/` WebUI document (`chrome/browser/search/search.cc` 386-406). It is killed twice over: `MayAttachToURL` refuses the `chrome://` scheme before the request is sent, and at commit `ShouldAllowSession` fails on `GetWebUI()` being non-null (`debugger_api.cc` 314-318).

**Experiment.** A scratch copy of the extension with `chrome_url_overrides` removed and `newtab.html` deleted, driven through the harness pattern in `test/e2e/fixtures.ts`: persistent Chromium 153.0.8010.12, `TZ=Pacific/Kiritimati` as the Baseline zone, Tokyo selected, the site served from a local server as `test/pages/index.html`, whose first script records `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getTimezoneOffset()`. Two runs of ten.

*End to end, the fast lane exactly as Coverage runs it:*

| Build | New Tab Page url Playwright reports | `spoofer.status()` on the new tab | `onDetach` | first script of the site |
|---|---|---|---|---|
| without the override | `chrome://new-tab-page/` | covered 1, **restricted 1** | none | `Pacific/Kiritimati`, `-840`, **0 of 10 covered** |
| with the override | `chrome-extension://<id>/newtab.html` | covered 2, restricted 0 | none | `Asia/Tokyo`, `-540`, **10 of 10 covered** |

Without the override no session is ever detached, because none is ever made: the attach is refused, the tab reads Restricted, and the badge never counts it, so the miss is silent. That is the shape of the failure, not a race lost.

*The detach question on its own,* forcing a session to exist first: no Selection, so Spoofer attached nothing, and the scratch spec attached by hand to a tab at `about:blank`, sent `Emulation.setTimezoneOverride` with `Asia/Tokyo` and `Target.setAutoAttach`, confirmed the page read `Asia/Tokyo`, then navigated the tab onto the New Tab Page and watched. Ten runs each:

| New Tab Page committed under the session | `onDetach` | probe after the commit | zone the New Tab Page itself read | first script of the site after that |
|---|---|---|---|---|
| `chrome://new-tab-page/` | **`target_closed`, 10 of 10** | `Cannot access a chrome:// URL` | `Pacific/Kiritimati` | `Pacific/Kiritimati`, **0 of 10** |
| `chrome://newtab/`, Spoofer's page | **none, 0 of 10** | `Cannot access a chrome:// URL` | `Asia/Tokyo` | `Asia/Tokyo`, **10 of 10** |

The middle column is the Sealed state in both rows: Chrome refuses every `chrome.debugger` call about the tab either way. The difference is entirely in whether the session behind that wall is still alive. With the override it is, and Chrome replays it into the next document. Without it, it was force-detached at the commit and there is nothing left to replay.

## 3. The third-party search engine New Tab Page

**Both pages exist in current stable, the engine decides which, and neither changes the url the attach check reads.**

`NewTabURLDetails::ForProfile`, `chrome/browser/search/search.cc` 166-209, does not stop at the WebUI page for a non-Google engine:

```cpp
    const bool default_is_google = DefaultSearchProviderIsGoogle(profile);
    const GURL local_url(default_is_google
                             ? chrome::ChromeUINewTabPageURLAsGURL()
                             : GURL(chrome::kChromeUINewTabPageThirdPartyURL));
    if (default_is_google) {
      return NewTabURLDetails(local_url, NEW_TAB_URL_VALID);
    }
...
    GURL search_provider_url(template_url->new_tab_url_ref().ReplaceSearchTerms(
        TemplateURLRef::SearchTermsArgs(std::u16string()),
        UIThreadSearchTermsData()));

    if (!search_provider_url.is_valid()) {
      return NewTabURLDetails(local_url, NEW_TAB_URL_NOT_SET);
    }
    if (!search_provider_url.SchemeIsCryptographic()) {
      return NewTabURLDetails(local_url, NEW_TAB_URL_INSECURE);
    }
...
    return NewTabURLDetails(search_provider_url, NEW_TAB_URL_VALID);
```

So `chrome://new-tab-page-third-party/` is the **fallback**, taken only when the engine ships no `new_tab_url`. It is a live Mojo WebUI: `kChromeUINewTabPageThirdPartyURL[] = "chrome://new-tab-page-third-party/"` (`chrome/common/webui_url_constants.h` 218-228), registered as `map.AddWebUIConfig(std::make_unique<NewTabPageThirdPartyUIConfig>());` under `BUILDFLAG(ENABLE_WEBUI_NTP)` (`chrome/browser/ui/webui/chrome_web_ui_configs.cc` 368-372).

Engines that do ship one get their own remote https page. From `third_party/search_engines_data` at the DEPS-pinned revision `b9f48dc46a8172cbdd9c3923bd5a85c04458e49f` (`DEPS` 3056-3057), `definitions/prepopulated_engines.json` carries `new_tab_url` for bing (`https://www.bing.com/chrome/newtab`), duckduckgo (`https://duckduckgo.com/chrome_newtab`), ecosia, kagi, karma, lilo, mail_ru, oceanhero, privacywall, qwant, seznam, yahoo, yahoo_jp, and yandex by/kz/ru/tr. Brave, Startpage, Baidu, Naver, Mojeek, Yep, You.com and yandex_com ship none, so they land on the WebUI page.

**Nothing was removed.** Both halves ship in M154: the fall-through above and live `new_tab_url` values in the current data. There is no chromestatus entry to cite because there is no deprecation in the tree; no feature flag guards the fall-through and no deprecation comment sits on it. `OPEN:` whether a removal is planned. An intent-to-remove thread or a chromestatus entry would settle it; nothing in the M154 tree flags one.

**Neither variant is attachable, and for the same reason as section 1.** A new tab is opened at `chrome://newtab/` (`chrome/browser/ui/browser_tabstrip.cc` 32-51, `return ChromeUINewTabURLAsGURL();`), the rewrite changes only `url_to_load`, and the remote-NTP handler pair does carry a reverse handler (`search::HandleNewTabURLReverseRewrite`, `search.cc` 408-427) whose whole job is to map the committed url back to `chrome://newtab/` for display. Either way `WebContents::GetLastCommittedURL()` reads `chrome://newtab/`, which is what `ExtensionMayAttachToWebContents` checks first. Chrome's own code assumes this: `params->source_contents->GetLastCommittedURL().spec() != chrome::ChromeUINewTabURLAsGURL()` is how it recognises an orphaned New Tab Page (`chrome/browser/ui/navigator/browser_navigator.cc` 1042-1049).

`OPEN:` whether a session attached in the pre-commit window **survives** a commit to a remote https New Tab Page. Source says probably not: the remote page is moved into an Instant process whose site url is `chrome-search://remote-ntp` (`search.cc` 358-384, `GetEffectiveURLForInstant`), `ExtensionMayAttachToRenderFrameHost` checks the SiteInstance site url as well as the committed url (`debugger_api.cc` 335-343), and `chrome-search` is not among the schemes extensions may hold (`extensions/common/url_pattern.cc` 34-41 lists `http, https, file, ftp, chrome, chrome-extension, filesystem, ws, wss, data, uuid-in-package`), which takes the `kCannotAccessPage` branch and force-detaches. Not measured, and it is a four-file chain. Settle it by setting the default search engine to DuckDuckGo, attaching at `tabs.onCreated`, letting the remote page commit, and recording whether `onDetach` fires and whether the site typed next observes the Override. This sub-case matters only for the users whose engine ships a `new_tab_url`, and Spoofer cannot choose their engine, so it changes nothing about the decision below.

## 4. The `NewTabPageLocation` enterprise policy

**It would give a real https page, it beats an extension override, and it is silently dropped on an unmanaged Mac. Measured here: dropped.**

The policy exists since Chrome 58, is dynamically refreshable and per profile. From the published policy list (`https://chromeenterprise.google/static/json/policy_templates_en-US.json`, the data file behind `https://chromeenterprise.google/policies/#NewTabPageLocation`):

> "Setting the policy configures the default New Tab page URL and prevents users from changing it. ... It is a best practice to provide fully canonicalized URL, if the URL is not fully canonicalized Google Chrome will default to https://. ... **On macOS, this policy is only available on instances that are managed via MDM, joined to a domain via MCX or enrolled in Chrome Enterprise Core.**"

with `"features": {"dynamic_refresh": true, "per_profile": true}`, `"sensitive": true` and `"supported_on": ["chrome.*:58-", "chrome_os:58-", "ios:99-"]`. The same definition lives at `components/policy/resources/templates/policy_definitions/Startup/NewTabPageLocation.yaml`, and the pref it drives is `// The URL to open the new tab page to. Only set by Group Policy.` `kNewTabPageLocationOverride` (`chrome/common/pref_names.h` 153-155), mapped at `chrome/browser/policy/configuration_policy_handler_list_factory.cc` 519-521.

**It does load a plain https document**, `chrome/browser/chrome_content_browser_client.cc` 891-920:

```cpp
  std::string ntp_location =
      profile->GetPrefs()->GetString(prefs::kNewTabPageLocationOverride);
  if (ntp_location.empty()) {
    return false;
  }
  url::Component scheme;
  if (!url::ExtractScheme(ntp_location, &scheme)) {
    ntp_location = base::StrCat(
        {url::kHttpsScheme, url::kStandardSchemeSeparator, ntp_location});
  }

  *url = GURL(ntp_location);
  return true;
```

**And it beats an extension's `chrome_url_overrides.newtab`, by design and in a comment**, same file 4991-5005:

```cpp
  // The group policy NTP URL handler must be registered before the other NTP
  // URL handlers below. Also register it before the "parts" handlers, so the
  // NTP policy takes precedence over extensions that override the NTP.
  handler->AddHandlerPair(&HandleNewTabPageLocationOverride,
                          BrowserURLHandler::null_handler());

  for (auto& part : extra_parts_) {
    part->BrowserURLHandlerCreated(handler);
  }
```

The extension override is one of those parts handlers, and the first match wins and stops the iteration (`content/browser/browser_url_handler_impl.cc` 145-152). Ordering, settled: policy, then extension override, then the search rewrite, then WebUI. Note that this handler also passes `null_handler()` as its reverse, so the same virtual-url freeze from section 2 applies: with the policy in force the tab still reports `chrome://newtab/`, and a fresh attach is still refused. The policy gives Spoofer the same Sealed shape as its own New Tab Page, not a freely attachable tab.

**macOS on an unmanaged machine.** Chrome watches the `com.google.Chrome` bundle id whatever its own is (`chrome/browser/policy/chrome_browser_policy_connector.cc` 324-341, `// Explicitly watch the "com.google.Chrome" bundle ID, no matter what this app's bundle ID actually is.`) and reads it through plain CFPreferences, which includes the user domain `defaults write` touches (`components/policy/core/common/preferences_mac.mm` 103-111, `CFPreferencesCopyAppValue` and `CFPreferencesAppValueIsForced`). A non-forced value **is** accepted, at `POLICY_LEVEL_RECOMMENDED` and `POLICY_SCOPE_USER` (`components/policy/core/common/policy_loader_mac.mm` 108-141, and the unit test `PolicyLoaderMacTest.TestNonForcedValue` at `policy_loader_mac_unittest.cc` 210-226).

It is then thrown away, because the policy is marked sensitive. `policy_loader_mac.mm` 146-163 calls `FilterSensitivePolicies(&chrome_policy)` when `ShouldFilterSensitivePolicies()`, which is true while the platform's management trustworthiness is below `TRUSTED` (`components/policy/core/common/async_policy_loader.cc` 110-119). The feature that selects that path is on by default (`components/policy/core/common/features.cc` 62-66, `kUseManagementServiceForSensitivePolicies, base::FEATURE_ENABLED_BY_DEFAULT`). The generator's own comment says what the list is: `// The policies that are considered only if the user is part of an AD domain on Windows, managed on Mac, or enrolled in Chrome Enterprise Core.` (`components/policy/tools/generate_policy_source.py` 609-619), and membership comes straight from `sensitive: true` (98, 1444-1452). The filter blocks the entry (`components/policy/core/common/policy_loader_common.cc` 157-163), and a blocked entry is invisible: `PolicyMap::Get` returns `nullptr` for an ignored entry (`policy_map.cc` 276-279, 338-342). "Managed" here means real MDM enrolment or a domain join, checked by shelling out to `/usr/bin/profiles status -type enrollment` (`base/enterprise_util_mac.mm` 22-47), so a hand-installed configuration profile does not qualify.

**Experiment, and exactly what was changed on this machine.** This Mac reports `Enrolled via DEP: No` and `MDM enrollment: No`, and has no `/Library/Managed Preferences/com.google.Chrome.plist`. The `com.google.Chrome` domain held three unrelated keys before and after (`LastRunAppBundlePath`, `NSNavPanelExpandedSizeForOpenMode`, `NSOSPLastRootDirectory`).

Set: `defaults write com.google.Chrome NewTabPageLocation -string 'http://localhost:8731/policy-newtab.html'`, confirmed by `defaults read com.google.Chrome NewTabPageLocation`. Then Google Chrome 151.0.7922.138 was launched through Playwright with a scratch `--user-data-dir` and no other profile, and a local server stood ready on port 8731. Result:

- `chrome://policy/` read **"Chrome Policies chrome No policies set"**.
- three new tabs asked for `chrome://newtab/` all committed **`chrome://new-tab-page/`**.
- the local server logged **zero requests**.

Removed immediately afterwards: `defaults delete com.google.Chrome NewTabPageLocation`, confirmed by `defaults read com.google.Chrome NewTabPageLocation` answering `Error: Could not find key 'NewTabPageLocation' in domain 'com.google.Chrome'.` and by re-reading the whole domain, which is byte for byte the three keys it started with. Nothing else on this machine was changed.

`OPEN:` source says a filtered policy is *blocked* rather than absent, so `chrome://policy` was expected to list it with `IDS_POLICY_BLOCKED`; the page read "No policies set" instead. That is a difference in how the page renders an ignored entry, not in the outcome, and the outcome is the measurement that matters. Settle it, if it ever matters, by reading the `chrome://policy` row list through its Mojo handler rather than the rendered shadow text.

**What the policy route would buy if a machine were managed.** Measured as a stand-in, with the override removed and a plain http page put in the New Tab Page's role: a tab created straight onto that page had its own first script miss 10 of 10 (`Pacific/Kiritimati`), was Covered 0 to 2 ms later, and the site it was then sent to observed `Asia/Tokyo` in its first script **10 of 10**. So an http New Tab Page does carry the Override forward; the page standing in for the New Tab Page is itself uncovered on its first script, which for a third-party policy url is a page reading the user's real zone.

## 5. `chrome_url_overrides` cannot be toggled at runtime, so this is a build variant

**The override is read off the manifest when the extension loads, and no API changes it, so "keep the stock New Tab Page" is a second package, not a setting.**

The rewrite consults the loaded extension's registered overrides on every `chrome://` navigation, `chrome/browser/extensions/extension_url_overrides.cc` 455-470:

```cpp
bool ExtensionUrlOverrides::HandleChromeURLOverride(
    GURL* url,
    content::BrowserContext* browser_context) {
  if (!url->SchemeIs(content::kChromeUIScheme)) {
    return false;
  }
  std::vector<GURL> overrides =
      GetOverridesForChromeURL(*url, browser_context, /*get_all=*/false);
  if (overrides.empty()) {
    return false;
  }
  *url = overrides[0];
  return true;
}
```

The only input is the set of overrides registered for the profile, and that set is written from the manifest at load time and nowhere else.

**The key is read at manifest parse time**, `extensions/common/manifest_handlers/chrome_url_overrides_handler.cc` 58-118: `ChromeUrlOverridesKeys::ParseFromDictionary(extension->manifest()->available_values(), manifest_keys, *error)`, then the one-page rule, `// An extension may override at most one page.` with `errors::kMultipleOverrides`, and then, decisively, the capability is synthesised from the key's presence:

```cpp
  // If this is an NTP override extension, add the NTP override permission.
  if (manifest_keys.chrome_url_overrides->newtab) {
    PermissionsParser::AddAPIPermission(
        extension, mojom::APIPermissionID::kNewTabPageOverride);
  }
```

The key and the permission to override are the same fact, decided before the extension runs a line of code.

**The registration is driven only by the extension's lifecycle**, `chrome/browser/extensions/extension_url_overrides_registrar.cc` 32-68, which is an `ExtensionRegistryObserver` with exactly three hooks: `OnExtensionLoaded` calls `RegisterOrActivateChromeURLOverrides`, `OnExtensionUnloaded` calls `DeactivateChromeURLOverrides`, and `OnExtensionUninstalled` calls `UnregisterChromeURLOverrides`, each passing `URLOverrides::GetChromeURLOverrides(extension)`, which reads the parsed manifest data. The store they write is a profile pref, `kExtensionURLOverrides[] = "extensions.chrome_url_overrides"` (`chrome/browser/extensions/extension_url_overrides.cc` 445-446), not anything an extension can reach. So the only in-product toggle is the user enabling or disabling the whole extension.

The documentation matches, by shape and by omission. There is no dedicated reference page for the key (`https://developer.chrome.com/docs/extensions/reference/manifest/chrome-url-overrides` answers 404); the canonical page is "Override Chrome pages" (`https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages`), which describes only a manifest declaration, "Extensions can use HTML override pages to replace a page Google Chrome normally provides", with "An extension can contain an override for any of the following pages, but each extension can only override one page", and "In incognito windows, extensions can't override New Tab pages". `chrome.runtime.getManifest()` is a getter, "The object returned is a serialization of the full manifest file", and no API in the reference index sets or clears an override. `declarativeNetRequest` cannot substitute either: its redirect transform allows only `"http"`, `"https"`, `"ftp"` and `"chrome-extension"` as a target scheme, and in any case the override is a `BrowserURLHandler` rewrite in the browser process, before the network stack sees anything.

**Incognito already ships option B, and no extension can change that.** The override is refused for the New Tab Page in an off-the-record profile, unconditionally and for every extension, `chrome/browser/extensions/extension_url_overrides.cc` 402-413:

```cpp
    // We only allow chrome: URL overrides in incognito mode if the extension
    // uses split mode, has been enabled in incognito and this is not a new tab
    // page override (we never allow the new tab page to be overridden in
    // incognito since we need to ensure users see details about what incognito
    // is (and isn't)).
    bool incognito_override_allowed =
        extensions::IncognitoInfo::IsSplitMode(extension) &&
        extensions::util::IsIncognitoEnabled(extension->id(), profile) &&
        url.host() != chrome::kChromeUINewTabHost;
    if (profile->IsOffTheRecord() && !incognito_override_allowed) {
      continue;
    }
```

Split mode and incognito access do not help: the `url.host() != chrome::kChromeUINewTabHost` term makes the New Tab Page a carve-out inside the carve-out. The reference says the same in one line: "In incognito windows, extensions can't override New Tab pages". Spoofer runs in the default `spanning` mode, which fails the first term anyway. So an incognito new tab shows Chrome's own incognito New Tab Page, a `chrome://` page, and everything section 2 measured about the stock New Tab Page applies there today, with the override shipped. `OPEN:` not measured. The harness launches a persistent context and never opens an incognito window, and incognito access is a user setting rather than a switch, so settle it by enabling incognito access on a loaded extension, opening an incognito window, and reading the first script of a site opened from a new incognito tab. Source predicts the same 0 of 10 as option B, which means user story 14 carries this gap now and would carry it either way.

**Both packages, built with the repo's own command.** `npm run package` was run in two scratch copies of the repo, the second with `chrome_url_overrides` deleted from `extension/manifest.json` and `extension/newtab.html` removed. The repo itself was not touched: `git status --porcelain` afterwards lists only this file.

| | files | size | `permissions` | `chrome_url_overrides` |
|---|---|---|---|---|
| with the override | 17 (`newtab.html` at 117 bytes) | 28 560 bytes | `["debugger","storage"]` | `{"newtab":"newtab.html"}` |
| without it | 16 | 28 283 bytes | `["debugger","storage"]` | absent |

The permission set is identical, so the only difference the install prompt shows is the New Tab Page line itself. **Residual for the second package**, measured in section 2 and section 6: every new tab reads **Restricted**, so the badge never counts it; the first script of whatever the user opens from a new tab observes the real zone, **0 of 10**; and the tab then observes the real zone for a further **548 to 1111 ms** before the reconcile tick catches it. Compared with the first package at **10 of 10** covered and no uncovered window at all.

## 6. The other mechanisms inside `debugger` and `storage`

One line each, with the reason it fails or what it costs.

- **`webNavigation.onBeforeNavigate`** (outside ADR-0002's boundary). It does not even arrive earlier for a new tab: Chrome holds the event back until the tab is in the tab strip, `chrome/browser/extensions/api/web_navigation/web_navigation_tab_observer.cc` 62-88, `// Only dispatch the onBeforeNavigate event if the associated WebContents is already added to the tab strip. Otherwise the event should be delayed and sent after the addition, to preserve the ordering of events.` For the New Tab Page to site navigation it does arrive before the request, since no tab is created, but that changes nothing: while the New Tab Page is the last committed entry every attach is refused on the url (section 1), so an earlier event only lets Spoofer be refused sooner. Cost for nothing: the permission maps to `IDS_EXTENSION_PROMPT_WARNING_HISTORY_READ` (`chrome/common/extensions/permissions/chrome_permission_message_rules.cc` 480-483), which reads **"Read your browsing history"** (`chrome/app/generated_resources.grd` 5393-5395), the line ADR-0002 already refused for a partial fix.
- **`Target.setAutoAttach` from another tab's session.** There is no path from one tab's session to another tab. An extension client is untrusted unless it is the Perfetto UI extension (`debugger_api.cc` 269-272), and an untrusted page session runs in `AccessMode::kAutoAttachOnly` (`content/browser/devtools/render_frame_devtools_agent_host.cc` 450-460), which answers `"Not allowed"` to `attachToTarget`, `getTargets`, `setDiscoverTargets` and `createTarget` (`content/browser/devtools/protocol/target_handler.cc` 1085-1086, 1195-1196, 1366, 1447). `autoAttachRelated` is "only supported on the Browser target" (1147-1149) and `attachToBrowserTarget` requires `kBrowser` (1214-1215), which only a trusted extension can hold.
- **Attaching by `targetId` instead of `tabId`.** Same wall, same function. `DebuggerFunction::InitAgentHost`'s `target_id` branch calls `ExtensionMayAttachToAgentHost` (`debugger_api.cc` 966-975), (declared at 384), which for anything with a WebContents delegates straight back: `if (WebContents* wc = agent_host.GetWebContents()) { return ExtensionMayAttachToWebContents(extension, extension_profile, *wc, error); }` (394-397). Enumerating the New Tab Page target and attaching to it by id is refused with the same string.
- **A reload after a late attach.** By the time the attach lands the first script has already read the real zone, so nothing is unsent: a reload hides the miss from the Audit while making every such tab load twice. ADR-0003 rejected it for that reason and section 1 makes it worse here, because the attach can only land after the site's own document has committed.
- **Waiting it out.** Measured without the override: after a tab leaves the stock New Tab Page for a site, it observes the real zone for **548 to 1111 ms** (10 runs, median about 845) before the reconcile tick attaches and the zone lands. Every script in that window sees the real zone, not only the first one.
- **`storage` alone.** It holds the Selection and nothing else; no storage key changes what a page observes.

## Sources

Chromium at tag `154.0.8037.17`, read as `https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/<path>`:

- `chrome/browser/extensions/api/debugger/debugger_api.cc`, `chrome/browser/extensions/extension_url_overrides.cc`, `extension_url_overrides.h`, `extension_url_overrides_registrar.cc`, `chrome/browser/extensions/chrome_content_browser_client_extensions_part.cc`
- `extensions/common/manifest_handlers/chrome_url_overrides_handler.cc`, `chrome/browser/extensions/api/web_navigation/web_navigation_tab_observer.cc`
- `chrome/common/extensions/permissions/chrome_permission_message_rules.cc`, `chrome/app/generated_resources.grd`
- `chrome/browser/chrome_content_browser_client.cc`, `chrome/browser/search/search.cc`, `chrome/browser/ui/browser_tabstrip.cc`, `chrome/browser/ui/navigator/browser_navigator.cc`
- `chrome/browser/ui/webui/chrome_web_ui_configs.cc`, `chrome/browser/ui/webui/new_tab_page_third_party/new_tab_page_third_party_ui.h`, `chrome/common/webui_url_constants.h`, `chrome/common/pref_names.h`
- `chrome/browser/policy/chrome_browser_policy_connector.cc`, `chrome/browser/policy/configuration_policy_handler_list_factory.cc`
- `components/policy/core/common/policy_loader_mac.mm`, `policy_loader_mac_unittest.cc`, `preferences_mac.mm`, `async_policy_loader.cc`, `policy_loader_common.cc`, `policy_map.cc`, `features.cc`, `management/management_service.cc`, `management/platform_management_status_provider_mac.cc`
- `components/policy/resources/templates/policy_definitions/Startup/NewTabPageLocation.yaml`, `components/policy/tools/generate_policy_source.py`
- `components/search_engines/template_url.h`, `template_url_data.h`; `base/enterprise_util_mac.mm`
- `content/browser/devtools/render_frame_devtools_agent_host.cc`, `devtools_agent_host_impl.cc`, `devtools_agent_host_impl.h`, `protocol/target_handler.cc`, `protocol/target_handler.h`
- `content/browser/renderer_host/navigation_controller_impl.cc`, `content/browser/web_contents/web_contents_impl.cc`, `content/browser/browser_url_handler_impl.cc`, `content/public/browser/devtools_agent_host_client.h`
- `extensions/common/permissions/permissions_data.cc`, `extensions/common/url_pattern.cc`
- `DEPS` 3056-3057, and `definitions/prepopulated_engines.json` from `chromium.googlesource.com/external/search_engines_data.git` at `b9f48dc46a8172cbdd9c3923bd5a85c04458e49f`

Documentation and release data:

- `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=3` and the Windows endpoint, both newest `154.0.8037.17` on 2026-09-15
- `https://chromeenterprise.google/static/json/policy_templates_en-US.json`, the data behind `https://chromeenterprise.google/policies/#NewTabPageLocation`
- `https://support.google.com/chrome/a/answer/9020077`, which documents only the MCX configuration-profile route for macOS policies, not `defaults write`
- `https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages`, the canonical page for `chrome_url_overrides`; the per-key reference url answers 404
- `https://developer.chrome.com/docs/extensions/reference/api/runtime` (`getManifest`), `https://developer.chrome.com/docs/extensions/reference/api/webNavigation` (`onBeforeNavigate`), and the API reference index

Experiments, all in the session scratchpad, never under `test/`: Chromium 153.0.8010.12 through Playwright 1.63.0 using the harness pattern in `test/e2e/fixtures.ts`, and Google Chrome 151.0.7922.138 for the policy measurement. Prior measurements this builds on are in `docs/research/chrome-debugger-api.md` section 1 and ADR-0003.

## Consequences for Spoofer

1. **The override stays.** Dropping `chrome_url_overrides.newtab` does not narrow the gap, it reopens it whole: 0 of 10 first scripts covered against 10 of 10, plus 548 to 1111 ms of real zone after that, on the most common way a person opens a site.
2. **There is no race left to win.** Without the override, Chrome refuses the first probe a new tab can possibly receive, in 10 tabs out of 10. A faster fast lane, an earlier event, or a tighter tick cannot help, because the refusal is on the url and not on the clock.
3. **A session cannot be smuggled through the stock New Tab Page either.** Force-detached at the commit, 10 of 10, reported as `target_closed`, which is the same word Chrome uses for a closed tab. Any future code that treats `target_closed` as "the tab is gone" would be wrong here too.
4. **The Sealed state is not the cost, it is the mechanism.** Both New Tab Pages refuse every `chrome.debugger` call about the tab, for the same reason: the tab's virtual url is `chrome://newtab/`. Spoofer's page differs only in that the session behind that wall is still alive. Section 2's tables are the evidence, and ADR-0003 already names the consequences.
5. **The stock New Tab Page would fail quietly.** Coverage reads the refused attach as Restricted, which the brief keeps off the badge on purpose, so the user would be told nothing while the site they just opened read their real zone. If the stock page were ever shipped, Restricted would have to stop meaning "no extension may touch this" for that one case, which is a worse change than the manifest key.
6. **Incognito already lives with option B, and the override cannot reach it.** Chrome refuses a New Tab Page override in an off-the-record profile for every extension, split mode or not, by an explicit term in the condition (section 5). So user story 14's incognito windows carry the 0 of 10 gap today, with the override shipped, and this research has no way to close it. It is a Residual Trace the brief does not name and ADR-0003 does not mention. It should be measured and then named, and it is the one finding here that asks for a change rather than confirming one.
7. **Nothing in `debugger` plus `storage` closes it, and `webNavigation` does not either.** Section 6 is exhaustive for the tab the user is on; the only lever that changes the url is a manifest key or an enterprise policy.
8. **The policy is not an option Spoofer can offer.** It needs real MDM enrolment or a domain join, which no ordinary user has, and where it does apply it beats the extension's own override, so a managed fleet would silently lose Spoofer's New Tab Page and get the New Tab Page gap back. That is worth one line in the README rather than a feature.
9. **A second package is possible and costs a Residual Trace, not a permission.** The two zips differ by one manifest key and one 117 byte file; the permission set is identical. What the second package buys is the install prompt's New Tab Page line, and what it costs is item 1.

## Decision table

| Option | Keeps stock New Tab Page | First script covered on the New Tab Page path (measured) | Install-time cost | Runtime cost | Permissions or policy needed |
|---|---|---|---|---|---|
| **A. Keep `chrome_url_overrides.newtab`** (today, ADR-0003) | No | **10 of 10** | Chrome's "changed the page shown on new tabs" prompt, with keep or restore | None. New tab is blank: no search box, no shortcuts, no tiles. Tab is Sealed while shown | `debugger`, `storage`, plus the one manifest key |
| **B. Ship without it, accept the gap** | Yes | **0 of 10** | None beyond `debugger` | Every new tab reads Restricted, so the badge stays silent; the site's first script reads the real zone and keeps reading it for 548 to 1111 ms | `debugger`, `storage` |
| **C. Ship without it, add `webNavigation`** | Yes | **0 of 10**, unchanged: the refusal is on the url, not the timing | A browsing-history line on the prompt, which ADR-0002 refuses | Same as B | `debugger`, `storage`, `webNavigation` |
| **D. Ship without it, rely on `NewTabPageLocation`** | Yes, replaced by the policy's url | Not reachable on an unmanaged Mac: policy dropped, server saw 0 requests, tab stayed `chrome://new-tab-page/`. With an http New Tab Page standing in, the site was **10 of 10** and the New Tab Page's own first script **0 of 10** | None from Spoofer; the user cannot set it | The New Tab Page becomes a third-party page that reads the real zone in its own first script; the policy also overrides option A, so the two cannot be combined | `debugger`, `storage`, **and** MDM enrolment or a domain join, plus the `NewTabPageLocation` policy |
| **E. Ship without it, rely on a third-party search engine** | Yes | Not measured. Tab still reports `chrome://newtab/`, so a fresh attach is refused; whether a pre-commit session survives the remote page is `OPEN:` | None | Depends on the user's search engine, which Spoofer does not choose, and is `chrome://new-tab-page-third-party/` for Brave, Startpage, Baidu, Naver, Mojeek, Yep, You.com and yandex.com, where it is a WebUI and certainly detaches | `debugger`, `storage` |
| **F. Ship without it, reload after a late attach** | Yes | 0 of 10 for the first script; the reload hides the miss rather than closing it | None | Every such tab loads twice, and the Audit stops being able to see the miss | `debugger`, `storage` |
| **G. Two packages, A and B, user picks** | Optional | 10 of 10 or 0 of 10, by package | Two listings, two review queues, two sets of measurements in the README | The B package carries B's Residual Trace, undocumented unless the README carries both | `debugger`, `storage`, plus the manifest key in one package only |

Every row reads the same in incognito, including A: Chrome refuses a New Tab Page override in an off-the-record profile for every extension (section 5), so an incognito new tab is option B whatever Spoofer ships. Not measured; consequence 6.

## Recommendation

Keep `chrome_url_overrides.newtab`. There is no window to attach in on the stock New Tab Page, 0 probes in 10 tabs, and a session that is already attached is force-detached at the commit, 10 in 10, so no amount of Spoofer-side work recovers the first script.

Do not ship option B or G. B trades the biggest measured gap in the product for one line on the install prompt, and it fails silently because a refused attach reads Restricted and never reaches the badge; G doubles the review and measurement surface to offer that trade to users who cannot see its cost.

Say so in the README instead: the New Tab Page line is the price of covering the first script, `NewTabPageLocation` overrides it on a managed machine and brings the gap back, and neither a third-party search engine nor `webNavigation` changes anything.
