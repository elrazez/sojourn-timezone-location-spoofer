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
The City the user chose plus the Jitter and Accuracy generated for it. There is at most one Selection.
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

**Enabled**:
The user-set switch. Disabled means every tab observes real values and the badge says so.
_Avoid_: active, on/off, running

**Trace**:
Any observable difference between a covered page and the same page in an unmodified browser, other than the Override itself.
_Avoid_: leak, tell, fingerprint, artifact

**Audit**:
The differential test that compares a covered page against a Baseline and asserts the only differences are the Override.
_Avoid_: leak test, detection test

**Baseline**:
The Audit's report from a browser without the extension.
_Avoid_: control, reference run
