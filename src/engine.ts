import { AuthError, type DriveAuth } from './auth';
import { decide } from './decide';
import {
  DriveError,
  metaFileName,
  parseMeta,
  snapshotFileName,
  snapshotPrefix,
  snapshotRev,
  type DriveStore,
} from './drive';
import type {
  ConflictChoice,
  ConflictHandler,
  KeyValueStorage,
  RemoteMeta,
  RestoreResult,
  SyncAdapter,
  SyncResult,
  SyncStatus,
} from './types';

export const DEFAULT_DEBOUNCE_MS = 10_000;
export const DEFAULT_KEEP_SNAPSHOTS = 5;

/** What the package remembers on the device (never inside the app's snapshot). */
interface PersistedState {
  deviceId: string;
  connected: boolean;
  account: string | null;
  baseRev: number | null;
  /** Snapshot file id of baseRev (tells a raced upload apart). */
  baseSnapshotId: string | null;
  lastSyncedAt: string | null;
  lastSyncedFrom: string | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncEngineOptions {
  adapter: SyncAdapter;
  auth: DriveAuth;
  drive: DriveStore;
  storage: KeyValueStorage;
  onConflict?: ConflictHandler;
  /** Delay between the last notifyChange() and the upload. Default 10 s. */
  debounceMs?: number;
  /** Snapshots kept on Drive, newest first. Default 5. */
  keepSnapshots?: number;
  /** UTC ISO timestamp. */
  now?: () => string;
  newDeviceId?: () => string;
  timers?: Timers;
}

export interface ConnectOptions {
  /** Sync right after connecting. False on a new phone that is about to restore. Default true. */
  sync?: boolean;
}

export type PeekResult = { kind: 'found'; meta: RemoteMeta } | { kind: 'nothing' } | { kind: 'offline' };

export interface DriveSync {
  /** Loads saved state and, if connected, signs in silently and syncs. Call once at startup. */
  start(): Promise<void>;
  /** Interactive Google sign-in. False if the user cancelled; throws AuthError on failure. */
  connect(options?: ConnectOptions): Promise<boolean>;
  /** Stops syncing on this device and signs out. Data on Drive is kept. */
  disconnect(): Promise<void>;
  status(): SyncStatus;
  subscribe(listener: () => void): () => void;
  syncNow(): Promise<SyncResult>;
  /** Local data changed: sync after the debounce delay. */
  notifyChange(): void;
  /** Runs a pending debounced sync now (e.g. app going to background). */
  flush(): Promise<SyncResult>;
  /** What is on Drive, without changing anything (new-phone restore prompt). */
  peekRemote(): Promise<PeekResult>;
  /** Replaces local data with the Drive snapshot, whatever the local state. */
  restoreFromDrive(): Promise<RestoreResult>;
  /** Applies the user's choice for the pending conflict. */
  resolveConflict(choice: ConflictChoice): Promise<SyncResult>;
  setConflictHandler(handler: ConflictHandler | null): void;
  /** Cancels timers and listeners. */
  dispose(): void;
}

function defaultDeviceId(): string {
  const random = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${Date.now().toString(16)}-${random()}${random()}`;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isOfflineAuthError(error: unknown): boolean {
  // Android's NETWORK_ERROR status code is 7.
  return error instanceof AuthError && (error.code === '7' || /network/i.test(error.message));
}

function parseState(text: string | null): Partial<PersistedState> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<PersistedState>) : {};
  } catch {
    return {};
  }
}

export function createSyncEngine(options: SyncEngineOptions): DriveSync {
  const { adapter, auth, drive, storage } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const keepSnapshots = Math.max(1, options.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS);
  const now = options.now ?? (() => new Date().toISOString());
  const newDeviceId = options.newDeviceId ?? defaultDeviceId;
  const timers = options.timers ?? defaultTimers;
  const storageKey = `drive-sync:${adapter.appId}`;
  const metaName = metaFileName(adapter.appId);

  let conflictHandler: ConflictHandler | null = options.onConflict ?? null;
  let asking = false;
  let disposed = false;
  let debounce: unknown = null;
  const listeners = new Set<() => void>();

  let current: SyncStatus = {
    phase: 'disconnected',
    account: null,
    lastSyncedAt: null,
    lastSyncedFrom: null,
    remote: null,
    error: null,
  };

  function setStatus(patch: Partial<SyncStatus>): void {
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  }

  // ------------------------------------------------------------ state

  let loaded: Promise<PersistedState> | null = null;
  let saved: PersistedState | null = null;

  async function state(): Promise<PersistedState> {
    loaded ??= load();
    const initial = await loaded;
    return saved ?? initial;
  }

  function load(): Promise<PersistedState> {
    return (async () => {
      const raw = parseState(await storage.getItem(storageKey));
      const value: PersistedState = {
        deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : newDeviceId(),
        connected: raw.connected === true,
        account: typeof raw.account === 'string' ? raw.account : null,
        baseRev: typeof raw.baseRev === 'number' ? raw.baseRev : null,
        baseSnapshotId: typeof raw.baseSnapshotId === 'string' ? raw.baseSnapshotId : null,
        lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
        lastSyncedFrom: typeof raw.lastSyncedFrom === 'string' ? raw.lastSyncedFrom : null,
      };
      if (raw.deviceId !== value.deviceId) await storage.setItem(storageKey, JSON.stringify(value));
      saved = value;
      setStatus({
        phase: value.connected ? 'idle' : 'disconnected',
        account: value.connected ? value.account : null,
        lastSyncedAt: value.lastSyncedAt,
        lastSyncedFrom: value.lastSyncedFrom,
      });
      return value;
    })();
  }

  async function save(patch: Partial<PersistedState>): Promise<PersistedState> {
    const next = { ...(await state()), ...patch };
    await storage.setItem(storageKey, JSON.stringify(next));
    saved = next;
    return next;
  }

  // ------------------------------------------------------------ lock

  // Every Drive operation runs one at a time, in call order.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ Drive steps

  async function readMeta(): Promise<{ meta: RemoteMeta; fileId: string } | null> {
    const file = await drive.findFile(metaName);
    if (file === null) return null;
    const text = await drive.readFile(file.id, 'text');
    if (typeof text !== 'string') throw new DriveError('http', 'meta.json is not text');
    return { meta: parseMeta(text, adapter.appId), fileId: file.id };
  }

  async function rotate(keepFileId: string): Promise<void> {
    const files = (await drive.listFiles(snapshotPrefix(adapter.appId)))
      .map((file) => ({ file, rev: snapshotRev(adapter.appId, file.name) }))
      .filter((entry): entry is { file: typeof entry.file; rev: number } => entry.rev !== null)
      .sort((a, b) => b.rev - a.rev);
    const stale = files.slice(keepSnapshots).filter((entry) => entry.file.id !== keepFileId);
    for (const { file } of stale) await drive.deleteFile(file.id);
  }

  /**
   * Uploads the local snapshot as `rev`. Right before writing meta.json it is
   * read again: if another device wrote meanwhile, the upload is dropped and
   * the result is a conflict.
   */
  async function upload(rev: number, expectedRemoteRev: number | null): Promise<SyncResult> {
    const s = await state();
    const data = await adapter.exportSnapshot();
    const file = await drive.createFile(snapshotFileName(adapter.appId, rev), data);
    const latest = await readMeta();
    if (latest !== null && latest.meta.rev !== expectedRemoteRev) {
      await drive.deleteFile(file.id).catch(() => undefined);
      enterConflict(latest.meta);
      return 'conflict';
    }
    const meta: RemoteMeta = {
      format: 'drive-sync-meta',
      appId: adapter.appId,
      rev,
      deviceId: s.deviceId,
      deviceName: adapter.deviceName,
      savedAt: now(),
      appVersion: adapter.appVersion,
      schemaVersion: adapter.schemaVersion,
      snapshotFileId: file.id,
      encoding: typeof data === 'string' ? 'text' : 'binary',
    };
    const text = JSON.stringify(meta);
    if (latest === null) await drive.createFile(metaName, text);
    else await drive.updateFile(latest.fileId, text);
    await adapter.markSynced(rev);
    const next = await save({
      baseRev: rev,
      baseSnapshotId: file.id,
      lastSyncedAt: meta.savedAt,
      lastSyncedFrom: meta.deviceName,
    });
    // Old snapshots are only housekeeping: a failure here must not fail the sync.
    await rotate(file.id).catch(() => undefined);
    setStatus({ ...syncedStatus(next), phase: 'idle' });
    return 'uploaded';
  }

  async function importRemote(meta: RemoteMeta): Promise<void> {
    const data = await drive.readFile(meta.snapshotFileId, meta.encoding);
    await adapter.beforeImport?.(meta);
    await adapter.importSnapshot(data, meta);
    await adapter.markSynced(meta.rev);
    const next = await save({
      baseRev: meta.rev,
      baseSnapshotId: meta.snapshotFileId,
      lastSyncedAt: now(),
      lastSyncedFrom: meta.deviceName,
    });
    setStatus({ ...syncedStatus(next), phase: 'idle' });
  }

  function syncedStatus(s: PersistedState): Partial<SyncStatus> {
    return { lastSyncedAt: s.lastSyncedAt, lastSyncedFrom: s.lastSyncedFrom, remote: null, error: null };
  }

  function enterConflict(remote: RemoteMeta): void {
    setStatus({ phase: 'conflict', remote, error: null });
    // Asked outside the lock: the user may take their time.
    queueMicrotask(askConflict);
  }

  function askConflict(): void {
    const remote = current.remote;
    if (current.phase !== 'conflict' || remote === null || conflictHandler === null || asking) return;
    asking = true;
    conflictHandler({ remote, localDeviceName: adapter.deviceName })
      .then((choice) => {
        asking = false;
        if (choice !== null) void resolveConflict(choice);
      })
      .catch(() => {
        asking = false;
      });
  }

  function fail(error: unknown): SyncResult {
    if (error instanceof DriveError && error.kind === 'offline') {
      setStatus({ phase: 'offline', error: null });
      return 'offline';
    }
    if (isOfflineAuthError(error)) {
      setStatus({ phase: 'offline', error: null });
      return 'offline';
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof AuthError || (error instanceof DriveError && error.kind === 'auth')
        ? 'auth'
        : error instanceof DriveError
          ? 'drive'
          : 'app';
    setStatus({ phase: 'error', error: { code, message } });
    return 'error';
  }

  // ------------------------------------------------------------ operations

  async function runSync(): Promise<SyncResult> {
    const s = await state();
    if (!s.connected) {
      setStatus({ phase: 'disconnected' });
      return 'disconnected';
    }
    setStatus({ phase: 'syncing', error: null });
    try {
      const remote = await readMeta();
      const dirty = await adapter.isDirtySince(s.baseRev);
      const decision = decide({
        remote: remote?.meta ?? null,
        baseRev: s.baseRev,
        baseSnapshotId: s.baseSnapshotId,
        dirty,
        schemaVersion: adapter.schemaVersion,
      });
      switch (decision.kind) {
        case 'noop':
          setStatus({ ...syncedStatus(s), phase: 'idle' });
          return 'unchanged';
        case 'upload':
          return await upload(decision.rev, decision.expectedRemoteRev);
        case 'import':
          await importRemote(decision.remote);
          return 'imported';
        case 'conflict':
          enterConflict(decision.remote);
          return 'conflict';
        case 'needsAppUpdate':
          setStatus({ phase: 'needsAppUpdate', remote: decision.remote, error: null });
          return 'needsAppUpdate';
      }
    } catch (error) {
      return fail(error);
    }
  }

  let queuedSync: Promise<SyncResult> | null = null;

  function syncNow(): Promise<SyncResult> {
    // Calls made while a sync is waiting for the lock share it.
    if (queuedSync !== null) return queuedSync;
    const run = exclusive(async () => {
      queuedSync = null;
      return runSync();
    });
    queuedSync = run;
    return run;
  }

  function cancelDebounce(): void {
    if (debounce !== null) {
      timers.clearTimeout(debounce);
      debounce = null;
    }
  }

  function resolveConflict(choice: ConflictChoice): Promise<SyncResult> {
    return exclusive(async () => {
      const pending = current.remote;
      if (current.phase !== 'conflict' || pending === null) return 'unchanged';
      setStatus({ phase: 'syncing' });
      try {
        const latest = await readMeta();
        if (latest === null || latest.meta.rev !== pending.rev) {
          // Drive moved again since the question was asked: start over.
          return await runSync();
        }
        switch (choice) {
          case 'keepRemote':
            await importRemote(latest.meta);
            return 'imported';
          case 'keepLocal':
            return await upload(latest.meta.rev + 1, latest.meta.rev);
          case 'exportBoth': {
            const local = await adapter.exportSnapshot();
            const remote = await drive.readFile(latest.meta.snapshotFileId, latest.meta.encoding);
            await adapter.saveConflictCopies?.({ local, remote, remoteMeta: latest.meta });
            // Both kept on the device; the user still has to pick one to sync.
            setStatus({ phase: 'conflict', remote: latest.meta });
            return 'conflict';
          }
        }
      } catch (error) {
        const result = fail(error);
        // Not resolved: the conflict is still there.
        if (result !== 'error') setStatus({ phase: 'conflict', remote: pending });
        return result;
      }
    });
  }

  return {
    async start() {
      const s = await state();
      if (!s.connected) return;
      try {
        const account = await auth.restore();
        if (account === null) {
          setStatus({ phase: 'error', error: { code: 'auth', message: 'Google sign-in required' } });
          return;
        }
        if (account.email !== s.account) await save({ account: account.email });
        setStatus({ account: account.email });
      } catch (error) {
        if (fail(error) === 'error') return;
      }
      await syncNow();
    },

    async connect({ sync = true }: ConnectOptions = {}) {
      const connected = await exclusive(async () => {
        const s = await state();
        const account = await auth.signIn();
        if (account === null) return false;
        // Another account means another Drive: forget the old base.
        const reset =
          account.email !== s.account
            ? { baseRev: null, baseSnapshotId: null, lastSyncedAt: null, lastSyncedFrom: null }
            : {};
        const next = await save({ ...reset, connected: true, account: account.email });
        setStatus({ ...syncedStatus(next), phase: 'idle', account: account.email });
        return true;
      });
      if (connected && sync) void syncNow();
      return connected;
    },

    disconnect() {
      cancelDebounce();
      return exclusive(async () => {
        await auth.signOut().catch(() => undefined);
        await save({ connected: false });
        setStatus({ phase: 'disconnected', account: null, remote: null, error: null });
      });
    },

    status: () => current,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    syncNow,

    notifyChange() {
      if (disposed || (saved !== null && !saved.connected)) return;
      cancelDebounce();
      debounce = timers.setTimeout(() => {
        debounce = null;
        void syncNow();
      }, debounceMs);
    },

    flush() {
      cancelDebounce();
      return syncNow();
    },

    peekRemote() {
      return exclusive(async (): Promise<PeekResult> => {
        const remote = await readMeta().catch((error: unknown) => {
          if (error instanceof DriveError && error.kind === 'offline') return 'offline' as const;
          throw error;
        });
        if (remote === 'offline') return { kind: 'offline' };
        return remote === null ? { kind: 'nothing' } : { kind: 'found', meta: remote.meta };
      });
    },

    restoreFromDrive() {
      return exclusive(async (): Promise<RestoreResult> => {
        const s = await state();
        if (!s.connected) return { kind: 'disconnected' };
        setStatus({ phase: 'syncing', error: null });
        try {
          const remote = await readMeta();
          if (remote === null) {
            setStatus({ phase: 'idle' });
            return { kind: 'nothing' };
          }
          if (remote.meta.schemaVersion > adapter.schemaVersion) {
            setStatus({ phase: 'needsAppUpdate', remote: remote.meta });
            return { kind: 'needsAppUpdate', meta: remote.meta };
          }
          await importRemote(remote.meta);
          return { kind: 'restored', meta: remote.meta };
        } catch (error) {
          if (fail(error) === 'offline') return { kind: 'offline' };
          throw error;
        }
      });
    },

    resolveConflict,

    setConflictHandler(handler) {
      conflictHandler = handler;
      if (handler !== null) askConflict();
    },

    dispose() {
      disposed = true;
      cancelDebounce();
      listeners.clear();
    },
  };
}
