# Spoofer

A Chrome extension that presents websites with the geolocation and time zone of a City the user picks, and leaves no other observable difference.

## Language

**City**:
One entry in the Catalog: a name, a country, an IANA time zone, and coordinates.
_Avoid_: location, place, region

**Catalog**:
The static list of Cities bundled with the extension.
_Avoid_: database, city list, dataset

**Selection**:
The City the user chose plus the Jitter and Accuracy generated for it. There is at most one Selection, and it always carries both: a Selection without them would leave a tab reporting its real position while the popup said it was covered.
_Avoid_: profile, persona, config

**Jitter**:
A small random offset added to a City's coordinates when it is selected, so no two installs report the same point.
_Avoid_: noise, fuzz

**Accuracy**:
The accuracy radius, in metres, reported alongside the coordinates.
_Avoid_: precision, radius

**Override**:
The time zone and coordinates a covered page observes in place of the real ones.
_Avoid_: spoofed values, fake values

**Covered**:
A tab whose pages currently observe the Override. The count of covered tabs is what the popup shows.
_Avoid_: attached, patched, protected

**Not Covered**:
A tab showing a web page that should observe the Override but does not, whatever the reason. The badge counts these.
_Avoid_: uncovered, exposed, leaking

**Pending**:
A tab that is due the Override and has not observed it yet, because it is still loading or a send is in flight. It is neither Covered nor Not Covered and never counts on the badge.
_Avoid_: in progress, waiting, unknown

**Restricted**:
A tab whose top-level page no extension may touch, such as a browser settings page, another extension's page, or the Chrome Web Store. It is neither Covered nor Not Covered and never counts on the badge.
_Avoid_: blocked, excluded, skipped

**Paused**:
The state after the user dismisses Chrome's debugging bar: no tab is Covered until the user presses Resume or switches Enabled back on. Distinct from Disabled, which the user chose in the popup.
_Avoid_: stopped, suspended, cancelled

**Enabled**:
The user-set switch. Disabled means every tab observes real values and the badge says so. The Badge and the Popup write that state `Off`, which names what the Override is doing and is not a second name for the switch.
_Avoid_: active, on/off, running

**Badge**:
The text Chrome shows on Spoofer's toolbar icon: `OFF` when the Override is off, the number of Not Covered tabs in red when there are any, and nothing at all otherwise.
_Avoid_: counter, indicator, icon

**Popup**:
Spoofer's one screen: a search over the Catalog, the Selection, the Enabled switch, what is Covered, and the Paused notice with its Resume. A window a page opened for itself is not this, even where the brief calls that a popup too.
_Avoid_: panel, dialog, options page

**Trace**:
Any observable difference between a covered page and the same page in an unmodified browser, other than the Override itself.
_Avoid_: leak, tell, fingerprint, artifact

**Residual Trace**:
A Trace the mechanism cannot close, bounded and measured by the Audit and named in the README.
_Avoid_: known leak, accepted artifact

**Audit**:
The differential test that compares a covered page against a Baseline and asserts the only differences are the Override.
_Avoid_: leak test, detection test

**Baseline**:
The Audit's report from a browser without the extension.
_Avoid_: control, reference run

**Probe**:
One named reading the Audit takes, carried under the same name in every Context of both reports, so a value that moved can be named.
_Avoid_: check, vector, assertion

**Context**:
One JavaScript global the Audit reads its Probes in: the page, a frame, a worker, or a window a page opened. A Context that cannot be created reads `unavailable` rather than going unreported.
_Avoid_: realm, scope, environment
