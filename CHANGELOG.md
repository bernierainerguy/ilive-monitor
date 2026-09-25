# Changelog

All notable changes to iLive Monitor are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0.0 (the first release validated on a real iDR48),
minor versions add features and patch versions fix bugs.

Add entries under **Unreleased** as you go; `npm run release:minor|patch|major` turns them into a dated release.

## [Unreleased]

### Added
- A LICENSE file and a notice in the README: the source is published to be read, and all rights are reserved.
  The app itself is unchanged.

## [0.4.1] - 2026-09-25

### Fixed
- A send pulled below about -53 dB was ghosted after every move. That's the rack's quietest step short of off, so
  its echo came back as -53 and looked like someone else's move. Echoes are now compared in the rack's own
  0.5 dB steps.
- The screen shows the level the rack really holds: a send set to -70 reads -53.5, as it is on the rack.
- Clicking a "?" level to look, then clicking away, sent the guessed level (usually off). The box now starts empty
  on an unknown level, and nothing is sent unless something was typed.
- Connect on the rack already in use no longer drops and remakes the link, which over MIDI made every send unknown
  again. The key reads "Connected" instead.
- A fader no longer jumps if the window, or a banner above it, changes height mid-drag.
- Removing the password when its file can't be deleted keeps the password, instead of it vanishing for the
  session and coming back at the next launch.
- The mix chosen in 0.1 or 0.2 carries over, instead of being asked for again.
- The "no release on the website yet" message only appears for that case, not for every 404 from the site.

## [0.4.0] - 2026-09-25

### Changed
- Settings has a sidebar (Mix bus, Rack, Password, Appearance, Licence, About) and shows one section at a time.
  Before, the Password section was below the bottom of the window and easy to miss.
- The Rack section starts with the rack in use, or the first saved one, selected, so Connect is ready to press.
- An update check before iLive Monitor is on the website says "no release of iLive Monitor is on
  whiteleyevents.co.uk yet", instead of the server's 404.

### Fixed
- Moving a fader no longer leaves its send ghosted ("?"). The check that tells the rack's echo of your move from
  someone else's move compared levels exactly, but iLive MIDI rounds to 0.5 dB, so nearly every drag on real
  hardware was marked unknown. Echoes of any level sent in the last 200 ms, allowing for the rounding, now count
  as yours. Only a level you didn't send marks the send unknown.
- A tap on a ghosted fader no longer changes the send: nothing is sent until the finger moves, and then the level
  is where the finger is. ↑/↓ on a ghosted fader no longer scrolls the page.
- One failed write of the Settings lock (a full disk, say) no longer stops every later one. A new password is only
  used once it's saved, so it can't vanish at the next launch.
- A half-typed rack or password in Settings survives a look at another section.
- The last move before quitting is given time to reach the rack.

## [0.3.0] - 2026-09-25

### Added
- Settings password. Once one is set, Settings shows an unlock prompt, and the main process refuses every
  Settings change while locked: the mix, racks, connect and disconnect, theme, the password itself and the licence
  details. The faders keep working.
  - Settings locks again when you leave it, after 10 minutes there, and at every launch. There's also a
    **Lock now** key.
  - After 5 wrong passwords, each further try waits 30 s longer.
  - A forgotten password is removed by deleting settings-lock.json (in ~/Library/Application Support/iLive
    Monitor) while the app is closed. Nothing else is lost.
  - Settings shows a padlock in the title bar while locked.

### Changed
- The mix is no longer shouted on the Mix screen. The coloured plate, the coloured edge on the faders and the
  coloured fader caps are gone. A small grey "Aux 2 · name" at the right of the bank keys says which mix it is.

### Fixed
- A send level the rack hasn't confirmed is no longer nudged from the guess. ↑/↓ and the scroll wheel do nothing
  on a ghosted fader, and touching it sets the level where you touch. Before, after a reconnect a single ↑ could
  send a real -40 dB send straight to -4 dB. Typed levels, Home (0 dB) and End (off) still work.
- A fader held when the rack drops stops sending, and nothing is sent while the app is still reading from the rack.
- A different level from the rack in the instant after your own move (someone at FOH moving the same send) is no
  longer taken as confirmed: the send shows "?" until it's known.
- Saving the rack in use with a new address, port, MIDI channel or protocol reconnects to it, instead of
  retrying the old one.
- Escape in the level box cancels without sending what was typed.
- A rack save the app refuses now says why.
- The last move before quitting still reaches the rack.

## [0.2.1] - 2026-09-25

### Fixed
- The mix is saved as its aux number, not as a mix channel. A mix chosen before connecting, or before the rack's
  mix configuration was entered, could otherwise become a different aux once the rack's layout applied. Aux 2 is
  now always the rack's Aux 2.
- Settings offers the rack's own auxes before connecting: those of the last rack used, or of a rack whose mix
  configuration was just saved.
- Switching from a real rack to the simulator goes back to the simulator's layout, instead of keeping the real
  rack's.
- Disconnecting now stops the app reconnecting to that rack at the next launch. Quitting still keeps the
  reconnect.
- A failed first connection no longer says the rack was "lost".
- A typed level abandoned because the rack dropped no longer reappears when it comes back.
- The tests are now typechecked too.

## [0.2.0] - 2026-09-25

### Changed
- The faders no longer scroll sideways. The inputs come in banks sized to fit the window (32, 16, 8 or 4
  channels), and the bank keys (Ch 1–16, Ch 17–32…) choose which one is on the faders. Strips widen to fill the
  bank. After a resize, the bank holding the same channels stays on screen.

### Removed
- FX returns. iLive Monitor mixes input channels only, and now refuses FX return sends.

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

[Unreleased]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bernierainerguy/ilive-monitor/releases/tag/v0.1.0
