# Phase 07: release

Ship `v0.1.0`: a wizard for the checks only a human can run, a packaged zip, a README that tells the truth, a final review of the whole build, and a tag.

Start by reading `CLAUDE.md`, `CONTEXT.md`, `docs/plan/00-brief.md`, every file under `docs/adr/`, and `README.md`. Record `git rev-parse HEAD` as the fixed point, and `git rev-list --max-parents=0 HEAD` as the root commit.

## Step 1: the manual-check wizard

Call the Skill tool with `wizard`. Author `scripts/manual-check.sh` from the skill's template with one stage per check that Playwright could not drive. Read the brief's Manual verification line and phase 03's skipped tests for the list; it includes at least:

1. Build, then load `extension/` unpacked at `chrome://extensions` with Developer mode on.
2. Allow the extension in incognito, open an incognito window, and confirm the badge and a page's zone match a normal window.
3. Pick Tokyo in the popup and open a third-party geolocation and time zone check page of the human's choosing; confirm the zone, the coordinates, and that the site raised its own permission prompt.
4. Observe the "started debugging this browser" bar and press its Cancel: the badge reads `OFF`, the popup shows Paused, and Resume restores coverage.
5. Open DevTools on a covered tab and confirm the behaviour matches the ADR.
6. Leave the browser idle for two minutes, open a new tab, and confirm it is covered (the service worker restart path).
7. Turn the switch off and on and confirm an open tab follows without reload.

Each stage confirms before moving on; no stage captures a secret, so `write_env` and `set_secret` stay unused. The wizard is a repeatable path, so commit it and link it from the README.

Step 1 is complete when `bash -n scripts/manual-check.sh` passes, the user has run it once, and the commit message records the date of that run and any stage that failed.

## Step 2: packaging

Add a `package` script that builds, then zips `extension/` (with `dist/` inside it and nothing from `src/` or `test/`) to `spoofer-<version>.zip` using the system `zip`. The version is `package.json`'s and `manifest.json`'s, and a test asserts they are equal.

## Step 3: README

Rewrite `README.md` for a stranger deciding whether to install it: what it does in three lines, the mechanism and the bar in plain words, the non-goals (IP, language, user agent) and the VPN pairing, install from the zip or unpacked, the incognito toggle, development commands, and the documents map. Keep the honest sentence about what the Audit proves and what it does not. Every claim in it must be something a test or the wizard checks.

## Step 4: final review

Call the Skill tool with `code-review` twice: once with the fixed point at this phase's start (this file as spec), and once from the root commit (the brief as spec) so the whole build is checked against the spec that started it. Fix everything hard; list the judgement calls you leave in the session.

If the `ponytail-audit` skill is available, call it and act on every finding that is a deletion; a deletion never needs a discussion.

Call the Skill tool with `writing-for-agents` and prune `CLAUDE.md`: delete lines the code now makes obvious, sharpen any pointer that fired unreliably during the build, and keep the privacy rules verbatim.

## Step 5: tag

Commit with the message `phase 07: release v0.1.0`, then `git tag v0.1.0`.

## Done when

- [ ] `scripts/manual-check.sh` exists, is executable, and has been run once by the user.
- [ ] `npm run package` produces `spoofer-0.1.0.zip` and `unzip -l` shows `manifest.json` at its root and no `src/` or `test/` entries.
- [ ] Both reviews ran and their remaining judgement calls are listed in the session.
- [ ] `README.md` links the wizard and states the mechanism, the bar, and the non-goals.
- [ ] `git tag --list v0.1.0` prints the tag.
