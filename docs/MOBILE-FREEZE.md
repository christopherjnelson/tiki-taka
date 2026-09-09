# Mobile 1.1.1 baseline

Mobile gameplay and the shared engine are frozen while desktop Electron packaging is developed. This baseline includes Android immersive fullscreen and the HUD strip outside the court. Physics, AI, progression, wall passing, Focus, and one-touch behavior remain unchanged from the approved mobile version.

- Android version: **1.1.1**, version code **3**.
- Local installable snapshot: `release/mobile/tiki-taka-1.1.1.apk`.
- Local source snapshot: `release/mobile/tiki-taka-1.1.1-sources.zip`.
- Optional local download copy: `public/downloads/tiki-taka-mobile-1.1.1.apk`.
- Source and APK checksums: `docs/mobile-freeze-1.1.1.json`.

`release/` and `public/downloads/` are ignored local-output directories, so those APK and ZIP snapshots are historical workstation records and are not included in a fresh clone. The tracked JSON manifest is the canonical source-freeze record.

The local APK uses the same debug signing key and app ID as earlier local builds. Install it over the existing app to retain device-local profiles and progress. CI builds use a temporary runner debug key; an APK downloaded from CI may not install over an APK signed with the workstation key. Use the existing locally signed build path for save-preserving phone updates.

Verify the baseline after desktop changes:

```sh
node scripts/check-mobile-freeze.mjs
```

This checks the 47 tracked mobile/shared source files against the saved hashes. It does not automatically reset changed files or silently update the baseline. Do not regenerate the manifest to make an unrelated change pass. Desktop shell/build tooling is outside this freeze; changing shared gameplay or mobile sources requires explicitly reopening that work.

## Reopened on 2026-09-08 for the split-the-press bonus

The user explicitly reopened this freeze on 2026-09-08 to add the split-the-press bonus to shared gameplay, to stop reward popups overlapping each other, and to make the sound effects audible. Three frozen files changed and had their hashes in `docs/mobile-freeze-1.1.1.json` regenerated: `packages/engine/src/game.js` (split-the-press scoring, bonus label precedence), `packages/presentation/src/renderer.js` (popups now stack instead of drawing on top of one another) and `packages/presentation/src/audio.js` (effect gains raised). The other 44 entries are untouched.

The audio change is a mix level, not a behaviour change. Measured with an `OfflineAudioContext`, every effect peaked between -21 and -32 dBFS, roughly 15-20 dB below normal game levels, which is why the game sounded silent at ordinary listening volumes. Effects now peak between -8 and -16 dBFS and the five-voice crowd cheer at -12 dBFS, with no clipping. Mobile gets the same fix.

Mobile gameplay therefore no longer matches the shipped 1.1.1 APK. Scoring, Focus rewards, and the on-court label set all differ from the build in `release/mobile/tiki-taka-1.1.1.apk`. Mobile needs re-verification and a version bump (Android version name and version code) before the next Android release; do not ship the new engine under 1.1.1.

Everything above still applies to the rest of the baseline. This entry authorises one deliberate gameplay change, not a general reopening: further shared-gameplay or mobile edits still require their own explicit reopening, and the manifest must never be regenerated to make an unrelated change pass.

Validation: seven mobile browser groups passed, including HUD/court separation in four viewport sizes and simultaneous touch controls. Android compilation and APK signature/configuration checks passed. Immersive behavior still needs the user's physical-phone confirmation; automated browser checks cannot verify Android system bars.
