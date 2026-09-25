# Changelog

All notable changes to iLive Monitor are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0.0 (the first release validated on a real iDR48),
minor versions add features and patch versions fix bugs.

Add entries under **Unreleased** as you go; `npm run release:minor|patch|major` turns them into a dated release.

## [Unreleased]

## [0.1.0] - 2026-09-25

### Added
- iLive Monitor: a monitor-only companion to iLive Touch for the Allen & Heath iDR48. It adjusts one thing, the
  level sent from each input and FX return to one aux.
  - The aux is chosen in Settings and kept between launches. It can't be changed from the mixing screen.
  - Faders for inputs 1–32, 33–64 and the FX returns, with a typed-level readout under each.
  - No channel faders, mutes, pan, send mutes, PAFL, processing, routing, scenes, shows or other mixes. The main
    process refuses any other change, even one sent straight over IPC.
  - Every connect reads from the rack. Nothing is ever pushed except the send levels you move.
  - Over iLive MIDI the rack can't report send levels, so each one is ghosted with a level of "?" until it moves
    here or on the console. The banner counts them.
  - The faders lock while offline, while reconnecting, and until the rack's mix configuration is entered.
  - Licence registration and check-in, EULA and privacy notice, and update checks against
    whiteleyevents.co.uk (product `weim`).

[Unreleased]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bernierainerguy/ilive-monitor/releases/tag/v0.1.0
