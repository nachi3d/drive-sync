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
| `<appId>.att.<sha256>.<ext>` | an attachment (e.g. a book cover), once per content. See [Attachments](#attachments). |

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

**Known limit (upload race):** Drive has no compare-and-swap. There is a
short window between the second `meta.json` read and the write. If another
device uploads inside it, the last writer wins on Drive. The loser finds out on
its next sync: each device remembers the snapshot file of its base, so "same
rev, other snapshot" means its upload was overwritten → **conflict** (scenario
T-SYNC-11). Two gaps remain:

- until the loser syncs again, Drive holds only the winner's data;
- if the winner (or a third device) uploads again before that, the rev moves
  on and the loser, clean, imports it. Its overwritten change survives only in
  the app's `beforeImport` safety backup.

For one active device at a time, that is acceptable; two devices editing
simultaneously is not a supported usage.

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
   - `webClientId` must be this **Web application** client's ID, **never the
     Android client's ID** (the Android client is matched by package name +
     SHA-1 and its ID goes nowhere in the app).
   - Sign-in error **code 10 (`DEVELOPER_ERROR`)** = a mismatch: the SHA-1 of
     the signing key, the package name, or the web client ID.

## Integrating into an app

```sh
npm install github:nachi3d/drive-sync#v0.3.0
npx expo install @react-native-google-signin/google-signin
```

- **Android needs no config plugin.** The google-signin plugin is only for iOS
  without Firebase (it requires `iosUrlScheme`). Without options it expects a
  Firebase `google-services.json`, so do not add it on Android-only apps.
- Native module → a **development build** (`eas build --profile development`),
  not Expo Go. Importing the package is safe in Expo Go (the native module
  is loaded only by `createDriveSync()` / `createGoogleAuth()`), so an app
  can simply not create the sync there.
- The package ships TypeScript sources. In Jest (jest-expo), let them be
  transformed:

  ```json
  "transformIgnorePatterns": [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@react-navigation/.*|@nachi3d/.*))"
  ]
  ```

  and mock `@react-native-google-signin/google-signin` in tests (or use the
  engine directly with `FakeDrive` / `FakeAuth` from `@nachi3d/drive-sync/testing`).
- Run the shared two-device scenarios against the app's real adapter: one
  contract test (see [Testing](#testing-two-device-scenarios)).

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
| `fetchAttachments()` | download missing attachments now (e.g. the network turned to Wi-Fi): `'done' \| 'pending' \| 'offline' \| 'waitingForWifi' \| 'disconnected'` |

Phases: `disconnected`, `idle`, `syncing`, `offline`, `conflict`,
`needsAppUpdate`, `error` (`error.code`: `auth` → offer to reconnect, `drive`,
`app`).

### Attachments

Binary files the snapshot refers to (book covers first) travel next to it,
**content-addressed**: the key of a file is the sha256 of its bytes, and the
snapshot only lists keys (the app's JSON already does). On Drive each key is
one file, `<appId>.att.<sha256>.<ext>`, so a cover is uploaded once, however
many books and snapshots use it.

```ts
import { sha256Hex } from '@nachi3d/drive-sync';

const adapter: SyncAdapter = {
  // …
  attachments: {
    listLocalAttachments: () => covers.list(),          // { key, ext, size }[]
    readAttachment: (key) => covers.read(key),          // Uint8Array
    writeAttachment: (key, bytes, ext) => covers.write(key, bytes, ext),
    referencedKeys: (snapshot) => coverKeysIn(String(snapshot)),
  },
};

createDriveSync({
  adapter, webClientId, storage,
  attachments: {
    maxBytes: 1024 * 1024,                     // default 1 MB
    concurrency: 3,                            // default 3
    wifiOnlyDownloads: () => settings.coversOnWifiOnly,
    isWifi: async () => (await NetInfo.fetch()).type === 'wifi',
  },
});
```

- **Keys** are `sha256Hex(bytes)` (64 lowercase hex digits; the package
  exports a pure-JS `sha256Hex`, Hermes has no `crypto.subtle`). Store
  attachments under their key, so the same image on two books is one file.
- **Upload:** after each successful snapshot upload, the attachments it
  references that are on the device and not on Drive go up (one listing,
  then a diff). If the network drops, they stay **unsent** and go up on the
  next sync, even when there is no new snapshot.
- **Download:** after an import (sync, restore, *keep remote*), the referenced
  keys missing on the device are fetched **in the background**, 3 at a time;
  every file is checked against its key before `writeAttachment()`. Failures
  are retried after 5 s, 30 s and 2 min, then on the next sync; what arrived
  stays (a restart resumes with what is left). Until a file is there, the app
  shows its fallback (e.g. the placeholder cover).
- **Wi-Fi only** (`wifiOnlyDownloads`, needs `isWifi`): downloads wait for
  Wi-Fi; uploads do not. Call `fetchAttachments()` when the network changes.
- **`maxBytes`:** a bigger attachment stays on its device (not uploaded, not
  downloaded); other devices keep the fallback.
- **Clean-up:** after an upload, at most once a day, attachments that none of
  the kept 5 snapshots references are deleted from Drive (and duplicate copies
  of one key). Every kept snapshot is read (once; they never change); if one
  cannot be read, or another device uploaded meanwhile, nothing is deleted.
- A sync never fails because of an attachment. `status().attachments` gives
  `{ missing, unsent, tooLarge, transferring }` for the UI.

**Known limit (clean-up race):** if another device uploads a snapshot that
reuses an old attachment between this device's clean-up check and its delete,
that attachment can be deleted. The next upload from a device that has the
file sends it again; until then other devices show the fallback.

## Privacy

The data goes **only to the user's own Google Drive**, in the hidden app folder,
straight from the phone. There is no Nachi3D server, no account with us, and no
analytics. The app asks for `drive.appdata` only: it cannot see or touch any
other file in the user's Drive. The user can delete the data at any time:
drive.google.com → Settings → *Manage apps* → the app → *Delete hidden app data*.

## Testing: two-device scenarios

`@nachi3d/drive-sync/testing` simulates one Drive app folder and several
devices running the real engine:

- `createSyncWorld({ app, latencyMs?, debounceMs?, keepSnapshots? })`: a
  `FakeDrive` (`latencyMs`, `failWhen(op)` to inject errors, `beforeCall(op)`),
  a `VirtualClock` (timestamps and the change debounce; `world.advance(ms)`)
  and `world.device(name, { schemaVersionDelta?, app? })`.
- Each device has its own sync storage, Google account, network switch
  (`device.online = false`), conflict answer (`device.conflictAnswer`), and
  records `conflicts`, `imports`, `safetyBackups`, `conflictCopies`.
  `edit(label)` makes a change and calls `notifyChange()`; `foreground()` /
  `background()` play the app-state triggers.
- `syncScenarios`: the scenarios below, each named after its manual case.
  The apps use the same `T-SYNC` ids in their `docs/TESTING.md`.

| Id | Scenario |
| --- | --- |
| T-SYNC-02 | handoff A → B: B restores exactly what A uploaded |
| T-SYNC-03 | back B → A: B's change reaches A on foreground, no prompt, safety backup first |
| T-SYNC-04 | conflict: `onConflict` fired, nothing overwritten, sync paused; then keep local / keep remote / export both |
| T-SYNC-05 | offline: change queued, uploaded when back online |
| T-SYNC-07 | disconnect: the device's changes never reach Drive until it reconnects |
| T-SYNC-11 | upload race: overwritten upload detected as a conflict on the next sync |
| T-SYNC-12 | newer remote `schemaVersion`: refused, local data untouched |
| T-SYNC-13 | rotation keeps the newest 5 per `appId`; another `appId` is never touched |

`attachmentScenarios` (apps with attachments; the app also implements
`setAttachment(label, bytes, ext)`: the item `label` gets this attachment,
created if needed):

| Id | Scenario |
| --- | --- |
| T-ATT-01 | A adds a cover → B receives it; fallback (`missing: 1`) until it is there |
| T-ATT-02 | the same cover on two books is stored once and never uploaded again |
| T-ATT-03 | conflict → keep remote fetches the missing covers; keep local sends B's |
| T-ATT-04 | clean-up keeps a cover while any kept snapshot references it; another `appId` untouched |
| T-ATT-05 | offline: the cover goes up with the next upload; network lost after the snapshot: sent on the next sync |
| T-ATT-06 | a failed download is retried in the background |
| T-ATT-07 | Wi-Fi only: downloads wait for Wi-Fi, uploads do not |
| T-ATT-08 | a cover over `maxBytes` stays on its device |

`attachmentContract` checks the adapter on its own: keys are the sha256 of the
bytes, sizes and extensions are right, `referencedKeys()` reads an exported
snapshot, an import works before its attachments arrive, `writeAttachment()`
then completes it. Devices also have `attach(label, bytes)`,
`attachment(key)`, `wifi` and `attachmentWrites`; the world has
`remoteAttachments(appId)` and an `attachments` option.

Each app runs them with its **real** adapter in one contract test. The app
factory gets `{ deviceName, storage, now }` and returns the adapter, a way to
make one change, and a JSON-comparable view of the data:

```ts
import { attachmentContract, attachmentScenarios, syncScenarios, type AppFactory } from '@nachi3d/drive-sync/testing';

const app: AppFactory = ({ deviceName, storage }) => {
  const env = setupTestDb(); // a fresh database per device
  return {
    adapter: createMyAdapter({ ctx: env, storage, deviceName }),
    edit: (label) => addPerson(env, label),
    setAttachment: (label, bytes, ext) => setCover(env, label, bytes, ext), // apps with attachments
    read: () => listEverything(env),
  };
};

describe('Drive sync contract', () => {
  it.each(syncScenarios.map((s) => [s.id, s.title, s] as const))('%s %s', (_id, _title, s) => s.run(app));
});

// Apps with attachments, and `setAttachment` in the factory's result:
const attachmentChecks = [...attachmentScenarios, ...attachmentContract];
describe('Drive attachments contract', () => {
  it.each(attachmentChecks.map((s) => [s.id, s.title, s] as const))('%s %s', (_id, _title, s) => s.run(app));
});
```

The harness waits with real timers: do not combine it with jest fake timers.

## Backlog

Not implemented yet: these are planned changes, not current behaviour.

- **Planned: attachment clean-up grace period.** Delete an unreferenced attachment
  only once it has been unreferenced for at least 7 days. Track when each key
  was first seen unreferenced in a small `<appId>.gc.json` in the app folder,
  so that the clean-up race (see [Attachments](#attachments)) needs a device
  to reuse a cover after a week, not within seconds.
- **Planned: "export both" keeps the other side's covers.** During a conflict, also
  download the attachments the remote snapshot references, so the saved
  remote copy is complete on the device.

## Development

```sh
npm test
npm run typecheck
```

Conventions: TypeScript strict, no `any`, Conventional Commits,
`claude/<feature>` → `dev` → `main` (`--no-ff`); `main` only with approval.
