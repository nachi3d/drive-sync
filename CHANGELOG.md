# Changelog

All notable changes to this project are documented here
(format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

## [0.2.0] - 2026-10-09

### Added
- Two-device test harness in `@nachi3d/drive-sync/testing`:
  `createSyncWorld()` (shared fake Drive, simulated devices with their own
  storage, account and network, `VirtualClock`), `createMemoryApp()`, and
  `syncScenarios` (T-SYNC-02, -03, -04, -05, -07, -11, -12, -13) for each
  app's contract test with its real adapter.
- `FakeDrive.failWhen`, `FakeDrive.latencyMs`, `FakeDrive.inFlight`.

### Fixed
- Upload race: a device whose upload was overwritten by another device's
  upload of the same rev now gets a conflict on its next sync, instead of
  silently treating Drive as in sync. The device remembers its base snapshot
  file id (state saved by 0.1.x has none: rev-only check until the next sync).

## [0.1.1] - 2026-10-08

### Fixed
- Importing the package no longer loads the Google sign-in native module;
  it is loaded by `createGoogleAuth()` / `createDriveSync()` only. Apps that
  also run in Expo Go (no native module) no longer crash at startup.

## [0.1.0] - 2026-10-08

### Added
- Single-active-device sync engine: pure `decide()` policy (upload, import,
  conflict, refuse newer schema), upload race check, snapshot rotation (5).
- Drive v3 REST store on `appDataFolder`, files namespaced by `appId`.
- Google sign-in (`drive.appdata` only) via
  `@react-native-google-signin/google-signin`.
- Triggers: startup, debounced change (10 s), foreground, background.
- `useSyncStatus` React hook; `FakeDrive` / `FakeAuth` test helpers.
