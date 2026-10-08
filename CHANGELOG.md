# Changelog

All notable changes to this project are documented here
(format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

## [0.1.0] - 2026-10-08

### Added
- Single-active-device sync engine: pure `decide()` policy (upload, import,
  conflict, refuse newer schema), upload race check, snapshot rotation (5).
- Drive v3 REST store on `appDataFolder`, files namespaced by `appId`.
- Google sign-in (`drive.appdata` only) via
  `@react-native-google-signin/google-signin`.
- Triggers: startup, debounced change (10 s), foreground, background.
- `useSyncStatus` React hook; `FakeDrive` / `FakeAuth` test helpers.
