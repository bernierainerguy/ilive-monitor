# iLive Monitor

[![CI](https://github.com/bernierainerguy/ilive-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/bernierainerguy/ilive-monitor/actions/workflows/ci.yml)

> **All rights reserved.** © 2026 Whiteley Events Ltd. The source is published to be read, not reused: it is not
> open source, and no licence is granted to copy, modify or distribute it or anything built from it. See
> [LICENSE](LICENSE). To use the app, download it from [whiteleyevents.co.uk](https://whiteleyevents.co.uk/software/);
> its use is governed by the [EULA](legal/WEIM-EULA.md).

A monitor-only companion to iLive Touch for the Allen & Heath iDR48 MixRack, for macOS.

It does one thing: it sets the level sent from each input channel to **one aux**. The aux is chosen in
Settings and kept between launches. There are no channel faders, mutes, pan, send mutes, PAFL, FX returns,
processing, routing, scenes, shows or other mixes, and the main process refuses any change that isn't a send level to that aux
(`src/shared/monitorPolicy.ts`, enforced in `src/main/services/MixerService.ts`), even one sent straight over IPC.

```bash
npm install
npm run dev          # launches Electron with hot reload
npm test             # unit + integration + UI
npm run test:e2e     # builds, then drives the real app with Playwright
npm run ci           # exactly what GitHub Actions runs; also runs automatically on git push
```

To try it without hardware: **Settings → Rack → iDR48 Simulator → Connect**, then pick a mix.

To use a real rack, add it in Settings with the MixRack's IP, port 51325, the MIDI channel set on the rack, and the
rack's **mix configuration**. The rack numbers its send buses by that configuration and MIDI can't report it, so the
faders stay locked until it's entered.

## How it behaves on the rack

- The inputs come in banks sized to fit the window (32, 16, 8 or 4 channels). The bank keys choose which one
  is on the faders; nothing scrolls.

- Every connect reads from the rack. Nothing is ever pushed except the send levels you move.
- Over iLive MIDI the rack can't report send levels. Each one is ghosted, with a level of "?", until it moves here
  or on the console, and the banner counts them.
- The faders lock while offline, while reconnecting, and until the mix configuration is entered.

The rack, protocol, transport and licensing code started as a copy of iLive Touch 0.6.1. The
two apps are separate products and separate repositories. Fixes to the shared parts need making in both.

## Releasing

1. Add notes under **Unreleased** in `CHANGELOG.md`, commit, then `npm run release:minor` (or `:patch`) and `git push --follow-tags`.
2. `npm run release:site` builds, signs, notarises and uploads that tagged version to whiteleyevents.co.uk, then prunes older ones.
   Use `npm run release:site -- --build-only` to stop before uploading.

Needs, outside git: `.env` with `WELM_APP_USER` / `WELM_APP_PASSWORD`, the Developer ID certificate in the login
keychain, the `WESC_NOTARY` notarytool profile, and a **`weim` product ("Whiteley Events A&H iLive Monitor")** in
wp-admin → Software → Products.
