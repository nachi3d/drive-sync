# @nachi3d/drive-sync

Headless **single-active-device** sync for React Native (Expo) apps: the app's
whole data, as one snapshot, kept in the user's own Google Drive, in the
hidden app folder.

Made for the Nachi3D apps (BookTrack, GameTrack, MangaTrack…). The usage
pattern is **one device at a time with an occasional handoff**: a new phone, a
trip, a dead battery. This is not real-time multi-device editing and there is
no merge. Each app keeps its own UI and database; this package only moves
snapshots and decides what to do with them.

## How it works

In the Drive `appDataFolder` (hidden from the user's Drive UI, readable only by
this Google Cloud project):

| File | Content |
| --- | --- |
| `<appId>.meta.json` | `{ rev, deviceId, deviceName, savedAt, appVersion, schemaVersion, snapshotFileId, encoding }` |
| `<appId>.snapshot-<rev>.json` | the snapshot, as the app exported it. The newest 5 are kept. |

> **Why the `<appId>` prefix:** the app folder belongs to the **Cloud
> project**, not to the app. Every app that uses the same project sees the same
> folder, so each app needs its own `appId`.

`rev` goes up by one on every upload. Each device remembers the rev it last
uploaded or imported (its **base**), and the app says whether its data changed
since then (**dirty**). A sync reads `meta.json` and then:

| Remote | Local | Action |
| --- | --- | --- |
| nothing on Drive | any | upload |
| rev == base | clean | nothing |
| rev == base | dirty | upload rev+1. `meta.json` is read again right before it is written; if it moved → conflict |
| rev != base | clean | import (the app takes a safety backup first, `beforeImport`) |
| rev != base | dirty | **conflict** → `onConflict`: keep local / keep remote / export both. Never silent |
| schemaVersion > app's | any | refuse: the user must update the app |

Sync runs on startup (`start()`), 10 s after the last change (`notifyChange()`),
when the app comes to the foreground and when it goes to the background.
Offline is not an error: changes stay dirty and go up on the next sync.

**Known limit:** Drive has no compare-and-swap. There is a short window between
the second `meta.json` read and the write. For one active device at a time, that
is acceptable; two devices editing simultaneously is not a supported usage.

## Google Cloud setup (once per Cloud project)

1. **Project:** console.cloud.google.com → create a project (or reuse the
   shared Nachi3D one). Enable the **Google Drive API**.
2. **OAuth consent screen:** user type *External*. Add the scope
   `https://www.googleapis.com/auth/drive.appdata` only. It is *non-sensitive*,
   so the app does not need Google's verification.
   - In **Testing** mode only the listed test users can sign in, and their
     access expires after 7 days. **Publish the app (In production) before a
     public release.**
3. **Android OAuth client** (one per app and per signing key): type *Android*,
   package name (e.g. `com.nachi3d.booktrack`), and the **SHA-1 of the key that
   signs the APK**. With EAS-managed credentials: `eas credentials` → Android →
   the build profile → *Keystore* shows the SHA-1. All EAS profiles of an app
   share that keystore by default.
   - A build signed with another key (e.g. `npx expo run:android`, which uses
     the debug keystore) gets `DEVELOPER_ERROR` at sign-in, unless you add a
     second Android client with that key's SHA-1.
4. **Web OAuth client** (one per project): type *Web application*, nothing to
   fill in. Its **client ID** is the `webClientId` below. It is public. **The
   client secret is never used and never goes into an app.**

## Integrating into an app

```sh
npm install github:nachi3d/drive-sync#v0.1.0
npx expo install @react-native-google-signin/google-signin
```

- **Android needs no config plugin.** The google-signin plugin is only for iOS
  without Firebase (it requires `iosUrlScheme`). Without options it expects a
  Firebase `google-services.json`, so do not add it on Android-only apps.
- Native module → a **development build** (`eas build --profile development`),
  not Expo Go.
- The package ships TypeScript sources. In Jest (jest-expo), let them be
  transformed:

  ```json
  "transformIgnorePatterns": [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@react-navigation/.*|@nachi3d/.*))"
  ]
  ```

  and mock `@react-native-google-signin/google-signin` in tests (or use the
  engine directly with `FakeDrive` / `FakeAuth` from `@nachi3d/drive-sync/testing`).

### Adapter

```ts
import { createDriveSync, type SyncAdapter } from '@nachi3d/drive-sync';

const adapter: SyncAdapter = {
  appId: 'booktrack',
  deviceName: 'Pixel 8',
  appVersion: '0.2.0',
  schemaVersion: 7,
  exportSnapshot: async () => exportJson(),
  importSnapshot: async (data) => importJson(String(data)),
  isDirtySince: (rev) => dataVersion() !== syncedDataVersion(),
  markSynced: (rev) => rememberSyncedDataVersion(),
  beforeImport: async () => saveSafetyBackup(exportJson()),
  saveConflictCopies: async ({ local, remote }) => { /* keep both on the device */ },
};

export const sync = createDriveSync({
  adapter,
  webClientId: Constants.expoConfig.extra.googleWebClientId,
  storage, // KeyValueStorage for the package's own state, OUTSIDE the app's database
});

await sync.start();               // once the database is open
sync.notifyChange();              // after every write
```

`markSynced(rev)` must remember the data as of the last `exportSnapshot()`
(after an upload) or `importSnapshot()` (after an import), not "now": a write
made during the upload must stay dirty.

`storage` must not live inside the snapshot. Otherwise a restore would overwrite
the sync state.

### API

| | |
| --- | --- |
| `start()` | load state, silent sign-in, first sync |
| `connect({ sync? })` | interactive sign-in (`false` = cancelled). `sync: false` on a new phone about to restore |
| `disconnect()` | sign out on this device; Drive data is kept |
| `status()` / `subscribe()` / `useSyncStatus(sync)` | `{ phase, account, lastSyncedAt, lastSyncedFrom, remote, error }` |
| `syncNow()` | `'uploaded' \| 'imported' \| 'unchanged' \| 'conflict' \| 'needsAppUpdate' \| 'offline' \| 'error' \| 'disconnected'` |
| `notifyChange()` / `flush()` | debounced sync / run it now |
| `peekRemote()` / `restoreFromDrive()` | new-phone restore |
| `setConflictHandler(fn)` / `resolveConflict(choice)` | conflict UI |

Phases: `disconnected`, `idle`, `syncing`, `offline`, `conflict`,
`needsAppUpdate`, `error` (`error.code`: `auth` → offer to reconnect, `drive`,
`app`).

## Privacy

The data goes **only to the user's own Google Drive**, in the hidden app folder,
straight from the phone. There is no Nachi3D server, no account with us, and no
analytics. The app asks for `drive.appdata` only: it cannot see or touch any
other file in the user's Drive. The user can delete the data at any time:
drive.google.com → Settings → *Manage apps* → the app → *Delete hidden app data*.

## Development

```sh
npm test
npm run typecheck
```

Conventions: TypeScript strict, no `any`, Conventional Commits,
`claude/<feature>` → `dev` → `main` (`--no-ff`); `main` only with approval.
