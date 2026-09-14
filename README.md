# Spoofer

A Chrome extension with one job: websites see the geolocation and time zone of a city you pick, and nothing else about your browser changes.

Status: in development. The build is driven by the numbered prompts under [docs/plan/](docs/plan/).

## What it does

- You pick a city in the popup. Every tab then reports that city's IANA time zone (`Date`, `Intl`, workers, iframes, all of it) and coordinates near that city (`navigator.geolocation`).
- Coordinates carry a small per-install jitter so no two installs report the same point.
- The popup shows how many tabs are covered. When a tab cannot be covered, the badge says so. It never falls back to your real values silently.

## What it deliberately does not do

- It does not touch your IP address. Pair it with a VPN exit in the same city, or the mismatch is the first thing a site notices.
- It does not change `navigator.language`, the user agent, canvas, fonts, or anything else. Scope creep is how privacy tools become fingerprints.
- It makes no network requests, collects nothing, and has no accounts.

## How it works

[ADR-0001](docs/adr/0001-override-mechanism.md) records the override mechanism, the alternative it rejected, and what it costs: a visible "started debugging this browser" bar while any tab is covered.

## Development

Requires Node 22+ and Chrome 125+.

```
npm install
npm test          # unit + end-to-end (Playwright launches Chromium with the extension loaded)
npm run build     # compiles src/ into extension/dist/
```

Load `extension/` as an unpacked extension from `chrome://extensions` with Developer mode on.

## Documents

- [CLAUDE.md](CLAUDE.md): rules for agents working in this repo.
- [CONTEXT.md](CONTEXT.md): the glossary.
- [docs/plan/](docs/plan/): the build plan, one prompt per phase.
- [docs/research/](docs/research/): cited findings from primary sources.
- [docs/adr/](docs/adr/): decisions that are hard to reverse.
