# R5: What a real desktop position looks like

Scope: the fields, nullability, Accuracy, timestamp, `toJSON`, permission and timing behaviour of a Geolocation fix in current stable desktop Chrome, compared with what `Emulation.setGeolocationOverride` (sent through `chrome.debugger`) produces. The aim is to find which parts of an Override a covered page could tell apart from a real fix (a Trace). Current stable is Chrome 154 (chromiumdash `fetch_releases?channel=Stable&platform=Mac` returns `"version": "154.0.8037.17"`). Citation bases:
- **S:** Chromium at tag `154.0.8037.17`, `https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/<path>`. Every S file cited here was diffed against main `1bb227d3`, and the geolocation code is identical.
- **M:** Chromium main at `1bb227d33816ce7fa3faf43a27001676197335d1`.
- **ED:** the w3c/geolocation `index.html` at commit `4aebf6e750ff5f40cf032d96b457a149582c9ecc`. Line numbers are HTML source lines.
- **TR:** `https://www.w3.org/TR/2026/CR-geolocation-20260326/`.

Blink's geolocation code moved from `modules/` to `core/`, in the commit titled "[PEPC] Moving geolocation code from modules to core" (2025-08-01). `GeolocationPosition` is implemented by the class `Geoposition`. There is no `geolocation_position.h/.cc`.

## 1. The W3C interfaces

- **Status.** TR is "W3C Candidate Recommendation Snapshot 26 March 2026". ED line 60 says: "In March 2026, the specification returned to Candidate Recommendation". The TR and the ED carry the same IDL (TR text: `interface GeolocationCoordinates { readonly attribute double accuracy; ...`).
- **`GeolocationPosition`** (ED 1112-1117):
  `[Exposed=Window, SecureContext] interface GeolocationPosition { readonly attribute GeolocationCoordinates coords; readonly attribute EpochTimeStamp timestamp; [Default] object toJSON(); };`
- **`GeolocationCoordinates`** (ED 1198-1208):
  `readonly attribute double accuracy; readonly attribute double latitude; readonly attribute double longitude; readonly attribute double? altitude; readonly attribute double? altitudeAccuracy; readonly attribute double? heading; readonly attribute double? speed; [Default] object toJSON();`
  Non-nullable: `accuracy`, `latitude`, `longitude`. Nullable: `altitude`, `altitudeAccuracy`, `heading`, `speed`.
- **`accuracy`.** ED 916-919, in the acquire-a-position steps: "A non-negative {{double}} that represents the accuracy value indicating the 95% confidence level in meters. Accuracy measures how close the measured coordinates are to the true position." The attribute definition (ED 1220-1221) says: "The accuracy attribute denotes the position accuracy radius in meters."
- **Nullable fields.**
  - `altitude` (ED 907-909): "or `null` if not available".
  - `altitudeAccuracy` (ED 925-927): "A non-negative {{double?}} ... or `null` if not available, indicating the 95% confidence level in meters."
  - `speed` (ED 935-937): "A non-negative {{double?}} ... or `null` if not available."
  - `heading` (ED 944-946): "or `null` if not available or the device is stationary". The attribute range is "0° ≤ heading < 360°" (ED 1243-1244).
- **`timestamp`.**
  - ED 1132-1133: "The timestamp attribute represents the time when the geographic position of the device was acquired."
  - The steps take "|acquisitionTime:EpochTimeStamp| be a new {{EpochTimeStamp}} that represents now" (ED 773-774), and build the position "passing |positionData|, |acquisitionTime|" (ED 951-953).
  - An emulated position is also built with `acquisitionTime` (ED 819-821). The spec therefore gives every fix, emulated or real, the time of that request.
- **Caching.**
  - `maximumAge` "indicates that the web application is willing to accept a cached position whose age is no greater than the specified time in milliseconds" (ED 1101-1103). Its default is `[Clamp] unsigned long maximumAge = 0;` (ED 1049).
  - A cached position is used only "If |cachedPosition|'s {{GeolocationPosition/timestamp}}'s value is greater than |cacheTime|" (ED 842-846).

## 2. What desktop Chrome reports, per platform

**Pipeline from provider to page.**
- `device.mojom.Geoposition` fields default to sentinels (S `services/device/public/mojom/geoposition.mojom` 12-17): `kBadLatitudeLongitude = 200`, `kBadAltitude = -10000`, `kBadAccuracy = -1`, `kBadHeading = -1`, `kBadSpeed = -1`. The accuracy field is documented as "Accuracy of horizontal position in meters" (38).
- Blink turns sentinels into `null` in `CreateGeoposition` (S `third_party/blink/renderer/core/geolocation/geolocation.cc` 68-85):
  - `position.altitude > -10000. ? std::make_optional(position.altitude) : std::nullopt`
  - `position.altitude_accuracy >= 0. ? ... : std::nullopt`
  - `position.heading >= 0. && position.heading <= 360. ? ... : std::nullopt`
  - `position.speed >= 0. ? std::optional(position.speed) : std::nullopt`

  Any negative value means `null`. Zero is a real `0`.
- A fix is dropped unless `position.accuracy >= 0. && !position.timestamp.is_null()` and latitude/longitude are in range (S `services/device/public/cpp/geolocation/geoposition.cc` 9-13; the same check is in Blink `geolocation.cc` 121-125).

**Which source each platform uses.**
- `services/device/public/cpp/device_features.cc` (S 111-115): "`BASE_FEATURE(kLocationProviderManager, base::FEATURE_ENABLED_BY_DEFAULT)`" on Mac and Windows, `FEATURE_DISABLED_BY_DEFAULT` elsewhere.
- The default mode (S 148-166) is `kHybridPlatform` on Mac, `kPlatformOnly` on Windows, and `kNetworkOnly` otherwise (Linux).
- Windows falls back to `kNetworkOnly` when `!IsWindowsLocationPlatformSupported()`, meaning older than Windows 10 19H1 (S 203-211).
- In `kHybridPlatform`, the Mac switches to the network provider only on `kWifiDisabled` (S `services/device/geolocation/location_provider_manager.cc` 261-275).

| Platform (default) | Source | `accuracy` | `altitude` | `altitudeAccuracy` | `heading` | `speed` | `timestamp` |
|---|---|---|---|---|---|---|---|
| Linux | Network provider (Google API) | API `accuracy` | null | null | null | null | Wi-Fi scan time; re-stamped to now when reused |
| macOS | Core Location | `horizontalAccuracy` | `ellipsoidalAltitude` (see below) | `verticalAccuracy` | `course` | `speed` | `CLLocation.timestamp` |
| Windows 10 19H1+ | WinRT `Geolocator` | `Geocoordinate.Accuracy` | null unless altitude accuracy is known and ellipsoid-referenced | null if not provided | null if not provided | null if not provided | `Time::Now()` at the fix |

**Network provider** (Linux default, Mac fallback, old Windows).
- It posts to `"https://www.googleapis.com/geolocation/v1/geolocate"` (S `services/device/geolocation/network_location_request.cc` 49).
- `CreateGeoposition` sets only latitude, longitude, timestamp and accuracy (S 520-533): `position->timestamp = wifi_timestamp;` then "`// Other fields are optional.`" then `std::optional<double> accuracy = response_body.FindDouble(kAccuracyString); if (accuracy) { position->accuracy = *accuracy;`. Altitude, altitudeAccuracy, heading and speed stay at their sentinels and reach the page as `null`. The Accuracy value is the server's number, passed through unchanged.
- Google's Geolocation API documentation (requests-geolocation) defines the response field as: "The accuracy of the estimated location, in meters. This represents the radius of a circle around the given `location`."
- The same page says `considerIp` "Specifies whether to fall back to IP geolocation if WiFi and cell tower signals are missing, empty, or not sufficient" and defaults to `true`. It says IP fallback "provides the lowest accuracy, with radii that can be thousands of meters."
- Chrome's request body is built by `FormUploadData` / `AddWifiData` (S 362-376) and contains no `considerIp` key (inferred from the absence of the string in the file), so the default applies.
- `OPEN:` Google's page gives no confidence level for its radius, while the W3C spec says 95%. Settled by a Google statement of the confidence level.
- Reuse and re-stamping: `const int kLastPositionMaxAgeSeconds = 10 * 60;` (S `network_location_provider.cc` 42). A cached network fix younger than that is re-reported with "`// Update the timestamp to the current time.`" and `result->get_position()->timestamp = now;` (S 264-271). When the Wi-Fi scan is unchanged, `position_cache_->FindPosition(wifi_data_)` returns the same cached position, re-stamped with `wifi_timestamp_` (S 280-288).

**macOS Core Location.**
- `S services/device/public/cpp/geolocation/location_manager_delegate.mm` 55-71: `position.altitude = location.ellipsoidalAltitude;` (when `kEllipsoidalAltitude` is on, which is the default per `device_features.cc` S 243), `position.accuracy = location.horizontalAccuracy; position.altitude_accuracy = location.verticalAccuracy; position.speed = location.speed; position.heading = location.course;`. Chromium passes these through with no validity checks.
- Desired accuracy (S `system_geolocation_source_apple.mm` 122-127): `kCLLocationAccuracyBest` when high accuracy is requested, otherwise "`// Using kCLLocationAccuracyHundredMeters for consistency with Android.`".
- Apple's CLLocation reference (first-party for Core Location):
  - `speed`: "A negative value indicates an invalid speed."
  - `course`: "A negative value indicates that the course information is invalid."
  - `verticalAccuracy`: "If `verticalAccuracy` is 0 or a negative number, `altitude` and `ellipsoidalAltitude` values are invalid" and it "represents an uncertainty that's approximately 68 percent".
  - `ellipsoidalAltitude`: "If `verticalAccuracy` is 0 or below, `ellipsoidalAltitude` is invalid and contains the value 0.0."
- What that means for the page:
  - Invalid speed and course become `null`.
  - An invalid altitude is `0.0`, which passes Blink's `> -10000.` test. From source, a Mac fix without a vertical solution may therefore report `altitude: 0` instead of `null`, with `altitudeAccuracy` `null` (if -1) or `0` (if 0).
  - `OPEN:` settled by logging `JSON.stringify(pos)` from `navigator.geolocation.getCurrentPosition` in stable Chrome on a real Mac on Wi-Fi.
- Chromium does not rescale Apple's 68% vertical figure to the spec's 95%. The confidence level of `horizontalAccuracy` is not stated on Apple's page.

**Windows WinRT** (S `services/device/geolocation/win/location_provider_winrt.cc` 560-587).
- Accuracy: `coordinate->get_Accuracy(value) ... .value_or(device::mojom::kBadAccuracy)`.
- AltitudeAccuracy, Heading and Speed are read as `IReference` values with `.value_or(kBadAccuracy|kBadHeading|kBadSpeed)`, so a null WinRT value becomes a page `null`.
- `location_data->timestamp = base::Time::Now();`
- Altitude is forced to `kBadAltitude` "if the accuracy is known to be bad or it is not using ellipsoid altitude reference system".
- Microsoft's Geocoordinate reference: Altitude, AltitudeAccuracy, Heading and Speed "are only provided when the positioning system can determine them."
- `DesiredAccuracy` is `PositionAccuracy_High` or `PositionAccuracy_Default` (S 288-290).

**Typical Accuracy values.** The source records them only as UMA histograms: `Geolocation.NetworkLocationRequest.Accuracy`, `Geolocation.CoreLocationProvider.Accuracy` (bucket cap comment: "Values above 10000 meters are considered very inaccurate") and `Geolocation.LocationProviderWinrt.Accuracy`. No distribution is published in source.
- `OPEN:` the typical `accuracy` on each platform. Settled by running `getCurrentPosition` (default options, and again with `enableHighAccuracy: true`) in stable Chrome on a Wi-Fi Mac, a Wi-Fi Windows 11 PC and a Wi-Fi Linux desktop, across several locations, or by Google publishing those histograms.

## 3. `toJSON`

- **Spec:** `[Default] object toJSON();` on both interfaces (ED 1116, 1207). TR carries the same lines.
- **Blink IDL:**
  - `third_party/blink/renderer/core/geolocation/geolocation_coordinates.idl` (S 28-36) declares `[CallWith=ScriptState] object toJSON();`.
  - `geolocation_position.idl` (S 28-35) declares `ImplementedAs=Geoposition` with `[CallWith=ScriptState] object toJSON();`.
- **Blink implementation.**
  - `geolocation_coordinates.cc` (S 32-42) adds `accuracy`, `latitude`, `longitude` with `AddNumber`, then `altitude`, `altitudeAccuracy`, `heading`, `speed` with `AddNumberOrNull`. The JSON always has all seven keys, with explicit `null`s.
  - `geoposition.cc` (S 11-15): `builder.AddInteger("timestamp", timestamp_); builder.AddV8Value("coords", coordinates_->toJSON(script_state).V8Object());`
- **Chromestatus** feature 5606741606924288, "toJSON for GeolocationCoordinates and GeolocationPosition": status "Enabled by default", `'desktop': 126, 'android': 126, 'webview': 126`. It is present in stable 154.
- **Implication.** `JSON.stringify(position)` shows the null pattern and the exact timestamp in one string. The Override path uses the same Blink objects, so key set and order are native. Only the values can differ.

## 4. What `Emulation.setGeolocationOverride` produces

- **Protocol** (S `third_party/blink/public/devtools_protocol/domains/Emulation.pdl` 396-411, rendered at chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setGeolocationOverride): "Overrides the Geolocation Position or Error. Omitting latitude, longitude or accuracy emulates position unavailable." All seven parameters are `optional number`.
- **Handler** (S `content/browser/devtools/protocol/emulation_handler.cc` 572-618):
  - `if (latitude.has_value() && longitude.has_value() && accuracy.has_value())` builds a `Geoposition` with a fresh object whose fields start at the sentinels.
  - Each optional field is set only when present: `if (altitude.has_value()) { position->altitude = altitude.value(); }`, and the same for `altitude_accuracy`, `heading`, `speed`.
  - Then `position->timestamp = base::Time::Now();` and `if (!device::ValidateGeoposition(*position)) { return Response::ServerError("Invalid geolocation"); }`.
  - Otherwise it builds `GeopositionErrorCode::kPositionUnavailable` with `/*error_message=*/""`.
- **Omitted optional fields become `null`,** because they stay at the sentinels and Blink maps those to `null`. That matches the network provider and a typical WinRT Wi-Fi fix. Passing `0` would surface as `0`.
- **Scope.** The Override is per tab: `GetWebContents()->GetGeolocationContext()`.
  - `GeolocationContext::SetOverride` applies it to every existing `GeolocationImpl` (S `services/device/geolocation/geolocation_context.cc` 68-74).
  - New connections get it in `BindGeolocation`: `if (geoposition_override_) { impl->SetOverride(*geoposition_override_); } else { impl->StartListeningForUpdates(); }` (S 37-41).
  - `EmulationHandler::Disable` runs `if (geolocation_overridden_) { ClearGeolocationOverride(); }` (S 207-209), so detaching the debugger returns the tab to real values.
- **Timestamp is frozen (settled by source).** The timestamp is set once per CDP call (S 603). `GeolocationImpl` then clones the stored result: `std::move(callback).Run(position_override_.Clone())` (S `services/device/geolocation/geolocation_impl.cc` 117-119), and `position_override_ = result.Clone(); ... OnLocationUpdate(*position_override_);` (S 153-161). Nothing in the Override path re-stamps it.
  - Every fix a covered page receives carries the time of the last `setGeolocationOverride`, so `Date.now() - pos.timestamp` grows for as long as the Override stands.
  - This differs from the spec's emulation (`acquisitionTime`, ED 819-821), from the network provider (re-stamped to now, S 264-271) and from WinRT (`Time::Now()` per fix).
  - Real Chrome also drops its browser-side cache when the last client leaves: "we clear the cached geoposition so that when the next observer is added we will not provide a stale position" (S `services/device/geolocation/geolocation_provider_impl.cc` 267-275).
  - `OPEN:` how stale a real fix's timestamp can be. Settled by calling `getCurrentPosition` repeatedly over minutes on real Mac, Windows and Linux Chrome and logging `Date.now() - timestamp`.
- **Repeated calls return identical coordinates** (clones of one struct).
  - Real network provider: identical coordinates are expected while the Wi-Fi scan is unchanged (`FindPosition(wifi_data_)`, S `network_location_provider.cc` 280-288).
  - `OPEN:` whether Core Location and WinRT vary between fixes on a stationary desktop. Settled by the same repeated-call measurement comparing `coords`.
- **`watchPosition` and re-sending.**
  - The spec says "User agents MUST consider invoking [=set emulated position data=] as a significant change" (ED 726-728).
  - In Chrome, a re-sent Override meets Blink's pending `QueryNextPosition`, and `GeolocationImpl::SetOverride` first flushes it: `if (!position_callback_.is_null()) { if (!current_result_) { current_result_ = ...NewError(...kPositionUnavailable, /*error_message=*/"", ...); } ReportCurrentPosition(); }` (S 142-151).
  - Blink hands non-fatal errors to watchers: `if (error->IsFatal() || !notifier->UseCachedPosition()) notifier->RunErrorCallback(error);` (S `geolocation.cc` 557-560), then re-queries and receives the new Override.
  - From source, each re-send during an active watch delivers a `POSITION_UNAVAILABLE` (code 2, empty message) error callback before the new position. The same applies to a query already pending on the real provider when the first Override lands.
  - `OPEN:` confirm with a Playwright run: page with an active `watchPosition`, send `setGeolocationOverride` twice, record callbacks.
- **`maximumAge`.** Blink's cache test is `options->maximumAge() && last_position_->timestamp() > current_time_millis - options->maximumAge()` (S `geolocation.cc` 449-451). With a frozen timestamp this misses once the Override is older than `maximumAge`, and the fresh query returns the same frozen timestamp.
- **`enableHighAccuracy`.** Under an Override, `SetHighAccuracyHint` just re-delivers the Override (`if (position_override_) { OnLocationUpdate(*position_override_); return; }`, S `geolocation_impl.cc` 89-95). The same Accuracy is returned for both hints. A real Mac switches between `kCLLocationAccuracyBest` and `kCLLocationAccuracyHundredMeters`.
  - `OPEN:` whether real Accuracy differs between the two hints. Settled by the section 2 measurement.

## 5. Permissions, errors, timing

- **Permission states.** The Permissions spec (`w3c/permissions` `index.html` 1067-1071) defines `enum PermissionState { "granted", "denied", "prompt" };`. Geolocation "is a [=default powerful feature=] identified by the [=powerful feature/name=] "geolocation"" (ED 451-453).
- **Spec permission flow.** The request steps "Set |permission| to [=request permission to use=] |descriptor|. If |permission| is "denied", then: ... [=Call back with error=] passing |errorCallback| and {{GeolocationPositionError/PERMISSION_DENIED}}" (ED 692-710). Emulated data is consulted only after "If |permission| is "granted"" (ED 798-806).
- **The Override does not bypass the permission check (settled).**
  - `GeolocationServiceImpl::CreateGeolocation` checks the permissions policy, then `RequestPermission(...)` (S `content/browser/geolocation/geolocation_service_impl.cc` 180-205).
  - `CreateGeolocationWithPermissionResult` returns early with `if (permission_level == GeolocationPermissionLevel::kDenied || !geolocation_context) { std::move(callback).Run(blink::mojom::PermissionStatus::DENIED); return; }` (S 216-220), before `geolocation_context->BindGeolocation(...)` (S 232-236, 251-254), which is the only place the Override is applied to a new connection.
  - `emulation_handler.cc` contains no permission call (the string "permission" does not occur in the file).
  - The prompt still appears. `navigator.permissions.query({name:'geolocation'})` reports the real content setting. A denial yields `PERMISSION_DENIED`.
- **Error codes.** Spec: `PERMISSION_DENIED = 1; POSITION_UNAVAILABLE = 2; TIMEOUT = 3;` (ED 1302-1304). Blink: `kPermissionDenied = 1, kPositionUnavailable = 2, kTimeout = 3` (S `geolocation_position_error.h` 38-42).
- **Messages in Blink.**
  - Permission denied: `"User denied Geolocation"`. Permissions policy: `"Geolocation has been disabled in this document by permissions policy."` (S `geolocation.cc` 60-62).
  - Timeout: `"Timeout expired"` (S `geo_notifier.cc` 140-142).
  - Position unavailable carries the provider's `error_message`: `""` from the Override path, and "Response was malformed" or "Did not provide a good position fix" from the network provider (`CreateResultFromResponse`, S `network_location_request.cc`).
  - A real network failure with `error_technical` also writes a page console error "Network location provider at '...'" (S `geolocation.cc` 763-769, `network_location_request.cc` `CreateGeopositionErrorResult`).
  - `mojom` still declares `"User denied geolocation permission"` and `"Position update is unavailable"` (S `geoposition.mojom` 22-25), but they are not used on the paths above.
- **Timing (mechanism settled, magnitudes `OPEN`).**
  - Under an Override, `BindGeolocation` calls `SetOverride`, which sets `current_result_` synchronously (S `geolocation_impl.cc` 161, 195-198). `QueryNextPosition` then answers at once: `if (current_result_) { ReportCurrentPosition(); }` (S 109-111). No provider is started.
  - On the real path, `StartListeningForUpdates` subscribes to `GeolocationProviderImpl`. A new subscriber gets a cached result immediately only while another client keeps it alive (S `geolocation_provider_impl.cc` 139-142, 264-275). Otherwise it waits for the provider. The network provider needs Wi-Fi data plus an HTTPS round trip.
  - The spec's `timeout` excludes the permission wait (ED 1083-1087).
  - `OPEN:` the page-observable delay from `getCurrentPosition()` to the success callback with permission already granted, in stable Chrome with no other geolocation client, on real Mac, Windows and Linux on Wi-Fi, against the same measurement with the Override attached. Include first call after page load and a repeat call after the previous one finished.

## 6. Distribution of a Jitter

- **The spec has no coarse or approximate location concept.** ED mentions "approximate" only in "approximate time for when the position was acquired" (ED 86). Its privacy section is about consent and permission lifetimes (ED 344-381). Its only accuracy control is the `enableHighAccuracy` hint, which "can be ignored by the user agent" (ED 102-104).
- **Chrome's approximate location is Android-only in stable.**
  - `BASE_FEATURE(kApproximateGeolocationPermission, #if BUILDFLAG(IS_ANDROID) base::FEATURE_ENABLED_BY_DEFAULT #else base::FEATURE_DISABLED_BY_DEFAULT` (S `components/content_settings/core/common/features.cc` 42-48).
  - `ApproximateGeolocationWebVisibleAPI` has `status: {"Android": "stable", "default": "experimental"}` (S `third_party/blink/renderer/platform/runtime_enabled_features.json5` 680-682). It gates `[RuntimeEnabled=ApproximateGeolocationWebVisibleAPI] AccuracyMode accuracyMode="precise";` in `PositionOptions` (S `core/geolocation/position_options.idl`).
  - Where enabled, approximate updates are throttled: "Approximate location updates are throttled to a 15-minute window" (S `geolocation_provider_impl.cc` 424-428).
  - On desktop stable none of this is active. Every fix has `is_precise = true` (`geoposition.mojom` 50-53).
- **No primary source gives a distribution of real device positions within a metro area,** or a relationship between the reported point and a city centre. The only constraint is the spec's definition of `accuracy` as a 95% confidence radius around the reported coordinates.
- `OPEN:` the Jitter radius and shape. This is a design choice with no source to settle it. At most, measured real-Wi-Fi fixes from section 2 would show how far real fixes scatter.

## Sources

- W3C Geolocation, Candidate Recommendation Snapshot 26 March 2026: https://www.w3.org/TR/2026/CR-geolocation-20260326/
- W3C Geolocation editor's draft: https://w3c.github.io/geolocation/ (source https://github.com/w3c/geolocation/blob/4aebf6e750ff5f40cf032d96b457a149582c9ecc/index.html)
- W3C Permissions editor's draft source: https://github.com/w3c/permissions/blob/main/index.html
- Chromium 154.0.8037.17 (https://raw.githubusercontent.com/chromium/chromium/154.0.8037.17/...):
  - `services/device/public/mojom/geoposition.mojom`
  - `services/device/public/cpp/geolocation/geoposition.cc`
  - `services/device/public/cpp/device_features.cc`
  - `services/device/geolocation/network_location_request.cc`
  - `services/device/geolocation/network_location_provider.cc`
  - `services/device/geolocation/location_provider_manager.cc`
  - `services/device/geolocation/geolocation_provider_impl.cc`
  - `services/device/geolocation/geolocation_context.cc`
  - `services/device/geolocation/geolocation_impl.cc`
  - `services/device/geolocation/win/location_provider_winrt.cc`
  - `services/device/public/cpp/geolocation/location_manager_delegate.mm`
  - `services/device/public/cpp/geolocation/system_geolocation_source_apple.mm`
  - `content/browser/devtools/protocol/emulation_handler.cc`
  - `content/browser/geolocation/geolocation_service_impl.cc`
  - `components/content_settings/core/common/features.cc`
  - `third_party/blink/public/devtools_protocol/domains/Emulation.pdl`
  - `third_party/blink/renderer/core/geolocation/{geolocation.cc, geo_notifier.cc, geolocation_coordinates.idl, geolocation_coordinates.cc, geolocation_position.idl, geoposition.cc, geoposition.h, geolocation_position_error.h, position_options.idl}`
  - `third_party/blink/renderer/platform/runtime_enabled_features.json5`
- Chromium main `1bb227d33816ce7fa3faf43a27001676197335d1`, for the diff baseline and the location of the Blink directory move.
- Chrome DevTools Protocol, Emulation.setGeolocationOverride: https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setGeolocationOverride
- Chromestatus, toJSON for GeolocationCoordinates and GeolocationPosition: https://chromestatus.com/feature/5606741606924288
- Chromiumdash stable releases: https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1
- Google Geolocation API, request and response: https://developers.google.com/maps/documentation/geolocation/requests-geolocation
- Apple CLLocation reference (`altitude`, `ellipsoidalAltitude`, `verticalAccuracy`, `horizontalAccuracy`, `speed`, `course`): https://developer.apple.com/documentation/corelocation/cllocation
- Microsoft Geocoordinate class: https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geocoordinate

## Consequences for Sojourn

1. Send only `latitude`, `longitude`, `accuracy`. Omitted fields reach the page as `null`, matching the Linux network provider and typical WinRT Wi-Fi fixes. Never send `0` for them.
2. Accuracy: the only source anchors are Core Location's requested `kCLLocationAccuracyHundredMeters` and Google's "radii that can be thousands of meters" for IP fallback. Pick a provisional per-Selection Accuracy between those, and fix the range only after the section 2 measurement.
3. The `timestamp` is frozen at the last CDP call. A standing Override is a Trace (`Date.now() - pos.timestamp` grows). Re-sending refreshes it, but by source fires `POSITION_UNAVAILABLE` at active watchers. Choose a strategy only after the Playwright confirmation.
4. The Audit must compare `JSON.stringify(position)` against the Baseline (seven keys, null pattern), plus `Date.now() - timestamp` and callback sequences under `watchPosition`. `toJSON` exists since M126.
5. macOS may report `altitude: 0` rather than `null`. If the Mac measurement confirms it, per-platform null patterns become a Trace to decide on.
6. Permission is untouched. The prompt appears and `permissions.query` is real. Sojourn must not grant geolocation through CDP, since the Selection does not imply consent.
7. The Override answers without starting a provider, so the first fix is likely faster than real. The Audit should time `getCurrentPosition` against the Baseline; this stays open until measured.
8. Debugger detach clears the Override and the tab reverts to real values. Coverage must drop the tab from Covered and say so on the badge.
