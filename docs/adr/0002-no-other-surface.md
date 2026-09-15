# No surface beyond the Override

Spoofer changes the time zone and the geolocation position a page observes and nothing else, and its own footprint is only what ADR-0001's mechanism needs. Each item below will look like a cheap consistency win later ("we already set the zone, why not the language"), and each is refused on purpose: every added surface is a new place for a Trace, a new line on the install prompt, or a new way to expose the user.

- No network requests from any extension context.
- No change to `navigator.language`, `Accept-Language`, the user agent, screen, canvas, fonts, WebRTC, IP, DNS, or any other fingerprint surface. The README pairs Spoofer with a VPN instead.
- No permissions beyond `debugger` and `storage`, and no host permissions.
- No content scripts, no `web_accessible_resources`, no `externally_connectable`.
- One manifest capability beyond the two permissions, the New Tab Page override ADR-0003 records, and no other.
- No protocol method beyond the ones the brief allows.
- No telemetry, no logging about the user, and nothing stored beyond the Selection, the Enabled switch, and the Paused flag.
