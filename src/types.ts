/** A whole-app snapshot as the app exports it. Strings are uploaded as UTF-8 text. */
export type Snapshot = Uint8Array | string;

export type SnapshotEncoding = 'text' | 'binary';

/**
 * What `<appId>.meta.json` in the Drive app folder holds: which snapshot is
 * current and who wrote it. `rev` grows by one on every upload.
 */
export interface RemoteMeta {
  format: 'drive-sync-meta';
  appId: string;
  rev: number;
  deviceId: string;
  deviceName: string;
  /** UTC ISO timestamp of the upload. */
  savedAt: string;
  appVersion: string;
  schemaVersion: number;
  /** Drive file id of the snapshot this meta points to. */
  snapshotFileId: string;
  encoding: SnapshotEncoding;
}

/** What the app provides. The package never looks inside a snapshot. */
export interface SyncAdapter {
  /**
   * Namespaces the Drive files. The app folder is shared by every app of the
   * same Google Cloud project, so each app needs its own id.
   */
  appId: string;
  /** Shown on other devices ("Synced 3 min ago from <deviceName>"). */
  deviceName: string;
  appVersion: string;
  /** Data format version. A remote snapshot with a newer one is refused. */
  schemaVersion: number;
  exportSnapshot(): Promise<Snapshot>;
  /** Replaces the local data with a remote snapshot (an older schema must be accepted). */
  importSnapshot(data: Snapshot, meta: RemoteMeta): Promise<void>;
  /**
   * True if local data changed since the last markSynced(). `rev` is the last
   * synced rev, or null if this device never synced.
   */
  isDirtySince(rev: number | null): boolean | Promise<boolean>;
  /**
   * Called after a successful upload (data = the last exportSnapshot()) or
   * import (data = what importSnapshot() just wrote).
   */
  markSynced(rev: number): void | Promise<void>;
  /** Runs before every import, e.g. to keep a safety backup of the local data. */
  beforeImport?(meta: RemoteMeta): void | Promise<void>;
  /** Keeps both versions on the device ("export both" conflict choice). */
  saveConflictCopies?(copies: ConflictCopies): Promise<void>;
}

export interface ConflictCopies {
  local: Snapshot;
  remote: Snapshot;
  remoteMeta: RemoteMeta;
}

/** Small persistent key-value store for the package's own state (not the app data). */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type ConflictChoice = 'keepLocal' | 'keepRemote' | 'exportBoth';

export interface ConflictInfo {
  remote: RemoteMeta;
  /** This device's name, for the conflict prompt. */
  localDeviceName: string;
}

/**
 * Asked when both sides changed. Resolves with the user's choice, or null to
 * decide later (sync stays paused in 'conflict'). Never answered silently.
 */
export type ConflictHandler = (info: ConflictInfo) => Promise<ConflictChoice | null>;

export type SyncPhase =
  /** Not connected to a Google account on this device. */
  | 'disconnected'
  | 'idle'
  | 'syncing'
  /** Network unavailable; changes stay queued (local data stays dirty). */
  | 'offline'
  /** Both sides changed; waiting for the user's choice. */
  | 'conflict'
  /** Drive holds data from a newer app version; this app must be updated. */
  | 'needsAppUpdate'
  | 'error';

export type SyncErrorCode = 'auth' | 'drive' | 'app';

export interface SyncStatus {
  phase: SyncPhase;
  /** Google account email, when connected. */
  account: string | null;
  /** UTC ISO time of the last successful upload or import. */
  lastSyncedAt: string | null;
  /** Device the local data last came from (this device after an upload). */
  lastSyncedFrom: string | null;
  /** Set in 'conflict' and 'needsAppUpdate'. */
  remote: RemoteMeta | null;
  /** Set in 'error'. */
  error: { code: SyncErrorCode; message: string } | null;
}

export type SyncResult =
  | 'disconnected'
  | 'unchanged'
  | 'uploaded'
  | 'imported'
  | 'conflict'
  | 'needsAppUpdate'
  | 'offline'
  | 'error';

export type RestoreResult =
  | { kind: 'restored'; meta: RemoteMeta }
  | { kind: 'nothing' }
  | { kind: 'needsAppUpdate'; meta: RemoteMeta }
  | { kind: 'disconnected' }
  | { kind: 'offline' };
