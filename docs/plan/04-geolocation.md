# Phase 04: geolocation

`navigator.geolocation` in every covered context reports coordinates near the selected City, with the Jitter and Accuracy the Selection carries, while the permission flow stays the browser's own.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `docs/research/geolocation-plausibility.md` and `docs/research/playwright-extension-harness.md` in full. Record `git rev-parse HEAD` as the fixed point.

## Step 1: slices

Call the Skill tool with `tdd`. Seams are pre-agreed. One slice at a time, red before green.

**Settings seam** (Vitest, the storage fake):

1. Selecting a City generates a Jitter whose great-circle distance from the City's coordinates is greater than `0` and at most `2000` metres, and an Accuracy that is an integer in `[20, 100]`. Write the haversine in the test with Earth radius `6371000` as the independent oracle.
2. Selecting the same City again keeps the Jitter and Accuracy; selecting a different City regenerates both.
3. A Selection saved and loaded round-trips exactly, and a load with nothing saved yields no Selection and Enabled true.

**Browser seam** (Playwright, geolocation granted through `context.grantPermissions(['geolocation'])` only; never `setGeolocation`):

4. `getCurrentPosition` in a covered page resolves with `latitude` and `longitude` equal to the Selection's jittered coordinates and `accuracy` equal to its Accuracy, read back from storage through the service worker; `altitude`, `altitudeAccuracy`, `heading`, and `speed` are `null`.
5. The position is a genuine object: `position instanceof GeolocationPosition`, `position.coords instanceof GeolocationCoordinates`, and `JSON.stringify(position)` (`toJSON` ships since Chrome 126) carries the same numbers and all seven coordinate keys.
6. `watchPosition` delivers the same coordinates on its first callback, and two tabs agree with each other.
7. **Iframe `allow` attribute.** A cross-origin iframe with `allow="geolocation"` observes the same coordinates as the top page, and the same iframe without `allow` gets the same outcome as it does in a Baseline context.
8. With no permission granted, `getCurrentPosition` fails with `PERMISSION_DENIED`, exactly as in a Baseline context without the extension.
9. `navigator.permissions.query({ name: 'geolocation' }).state` equals the Baseline's in both the granted and the default case.
10. Changing the City makes the next `getCurrentPosition` in an open tab return the new City's coordinates.
11. Time zone and coordinates agree: with Tokyo selected the page observes `Asia/Tokyo` and a position within `3000` metres of the literal `35.6762, 139.6503`.
12. **Re-send without error.** A page with an active `watchPosition` receives the new City's coordinates after a City change and no error callback across that re-send.
13. **Timestamp age.** In a covered page left open for 35 s, a fresh `getCurrentPosition` resolves with `Date.now() - position.timestamp` at most `31000`.

If slice 12 is red, a re-send delivers `POSITION_UNAVAILABLE`: drop the 30 s refresh, keep the loading re-send, mark slice 13 skipped with that reason, and add the timestamp staleness to the brief's Residual Traces.

Rules for the green code:

- The runner sends `Emulation.setGeolocationOverride` with only `latitude`, `longitude`, and `accuracy`, to tab sessions only, never to child sessions (a child session's detach would clear the tab's position).
- It sends when a tab is attached, when the tab starts loading, when that tab's last geolocation send is older than 30 s, and when the Selection changes.
- Disabled and Paused detach, which clears it.
- Jitter and Accuracy are generated in Settings and nowhere else, so every context reads one number.

## Step 2: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix hard violations and spec gaps; note judgement calls you leave.

Call the Skill tool with `domain-modeling` if a term crystallised.

## Done when

- [ ] `npm test` is green and includes the thirteen slices above, with at most slice 13 skipped, with its reason.
- [ ] `grep -rn "setGeolocation\|timezoneId" test/` prints nothing.
- [ ] `grep -rn "Math.random" src/ | grep -v settings` prints nothing.
- [ ] Committed on `main` with the message `phase 04: geolocation`.
