# Phase 04: geolocation

`navigator.geolocation` in every covered context reports coordinates near the selected City, with the Jitter and Accuracy the Selection carries, while the permission flow stays the browser's own.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `docs/research/geolocation-plausibility.md` and `docs/research/playwright-extension-harness.md` in full. Record `git rev-parse HEAD` as the fixed point.

## Step 1: slices

Call the Skill tool with `tdd`. Seams are pre-agreed. One slice at a time, red before green.

**Settings seam** (Vitest, the storage fake):

1. Selecting a City generates a Jitter whose great-circle distance from the City's coordinates is greater than `0` and at most `2000` metres, and an Accuracy in `[20, 100]`. Write the haversine in the test with Earth radius `6371000` as the independent oracle.
2. Selecting the same City again keeps the Jitter and Accuracy; selecting a different City regenerates both.
3. A Selection saved and loaded round-trips exactly, and a load with nothing saved yields no Selection and Enabled true.

**Browser seam** (Playwright, geolocation granted through `context.grantPermissions(['geolocation'])` only; never `setGeolocation`):

4. `getCurrentPosition` in a covered page resolves with `latitude` and `longitude` equal to the Selection's jittered coordinates and `accuracy` equal to its Accuracy, read back from storage through the service worker; `altitude`, `altitudeAccuracy`, `heading`, and `speed` are `null`.
5. The position is a genuine object: `position instanceof GeolocationPosition`, `position.coords instanceof GeolocationCoordinates`, and, if the research found `toJSON` shipped, `JSON.stringify(position)` carries the same numbers.
6. `watchPosition` delivers the same coordinates on its first callback, and two tabs agree with each other.
7. A cross-origin iframe with `allow="geolocation"` observes the same coordinates.
8. With no permission granted, `getCurrentPosition` fails with `PERMISSION_DENIED`, exactly as in a Baseline context without the extension.
9. `navigator.permissions.query({ name: 'geolocation' }).state` equals the Baseline's in both the granted and the default case.
10. Changing the City makes the next `getCurrentPosition` in an open tab return the new City's coordinates.
11. Time zone and coordinates agree: with Tokyo selected the page observes `Asia/Tokyo` and a position within `3000` metres of the literal `35.6762, 139.6503`.

Rules for the green code: the runner sends `Emulation.setGeolocationOverride` with the Selection's jittered coordinates and Accuracy wherever it sends the time zone override; Disabled and Paused clear it. Jitter and Accuracy are generated in Settings and nowhere else, so every context reads one number.

## Step 2: review

Call the Skill tool with `code-review`. Fixed point: the SHA from the start. Spec: this file, with the brief behind it. Standards: `CLAUDE.md`. Fix hard violations and spec gaps; note judgement calls you leave.

Call the Skill tool with `domain-modeling` if a term crystallised.

## Done when

- [ ] `npm test` is green and includes the eleven slices above.
- [ ] `grep -rn "setGeolocation\|timezoneId" test/` prints nothing.
- [ ] `grep -rn "Math.random" src/ | grep -v settings` prints nothing.
- [ ] Committed on `main` with the message `phase 04: geolocation`.
